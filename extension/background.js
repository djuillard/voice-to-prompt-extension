// Voice to Text - Background Service Worker
// Gère l'enregistrement audio et la communication avec n8n

// importScripts n'existe que dans le service worker, pas dans Jest/jsdom
if (typeof importScripts !== 'undefined') {
  try {
    importScripts('logger.js');
  } catch (e) {
    console.error('[VTT] Erreur chargement logger:', e);
  }
}

// En environnement de test (Jest), logger.js est chargé via require avant ce fichier
// et VTTLogger est attaché à globalThis. On récupère une référence locale.
const Logger = (typeof VTTLogger !== 'undefined')
  ? VTTLogger
  : (typeof globalThis !== 'undefined' && globalThis.VTTLogger)
    ? globalThis.VTTLogger
    : require('./logger.js');

const LOG_SRC = 'Background';

// État global (peut être perdu si le service worker redémarre)
const state = {
  isRecording: false,
  recordingTabId: null,
  recordingStartTime: null,
  isToggleProcessing: false,
  watchdogTimer: null,
  lockTimer: null
};

// Configuration par défaut
const DEFAULT_CONFIG = {
  webhookUrl: '',
  hotkey: 'Ctrl+Shift+V',
  minDuration: 1,
  testMode: false,
  // Mode de traitement :
  //  - 'prompt'     : transcription + réécriture en prompt professionnel (défaut)
  //  - 'transcript' : transcription + nettoyage léger (ponctuation, tics), sans réécriture
  mode: 'prompt'
};

// Modes de traitement supportés (envoyés au workflow n8n)
const PROCESSING_MODES = ['prompt', 'transcript'];

function normalizeMode(mode) {
  return PROCESSING_MODES.includes(mode) ? mode : 'prompt';
}

// Constantes
const PROMPTS_STORAGE_KEY = 'vtt_prompts_history';
const STATE_STORAGE_KEY = 'vtt_recording_state';
const INFLIGHT_STORAGE_KEY = 'vtt_inflight';
const MAX_PROMPTS_HISTORY = 200;
const TOGGLE_LOCK_TIMEOUT = 10000;  // 10s: libération de sécurité du lock
const START_ACK_TIMEOUT = 4000;     // 4s max pour que le content script confirme le démarrage
const WEBHOOK_TIMEOUT_MS = 90_000;  // Timeout réseau du webhook (protège contre un n8n qui hang)

// Keepalive du service worker pendant un fetch long (MV3).
// Une promesse fetch en attente ne maintient PAS le SW vivant — il faut un événement périodique.
const KEEPALIVE_ALARM = 'vtt-keepalive';
let keepAliveIntervalId = null;

if (typeof chrome !== 'undefined' && chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    // No-op : le simple fait que ce handler s'exécute réveille le SW.
    if (alarm.name === KEEPALIVE_ALARM) return;
  });
}

function startKeepAlive() {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  } catch (e) { /* chrome.alarms indispo en test */ }
  if (!keepAliveIntervalId) {
    keepAliveIntervalId = setInterval(() => {
      try { chrome.runtime.getPlatformInfo().catch(() => { }); } catch (e) { }
    }, 20_000);
  }
  Logger.debug(LOG_SRC, 'Keepalive SW démarré');
}

function stopKeepAlive() {
  try { chrome.alarms.clear(KEEPALIVE_ALARM); } catch (e) { }
  if (keepAliveIntervalId) {
    clearInterval(keepAliveIntervalId);
    keepAliveIntervalId = null;
  }
  Logger.debug(LOG_SRC, 'Keepalive SW arrêté');
}

// Décode une chaîne base64 en Uint8Array en une seule passe.
function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Préfixes d'URLs où les content scripts ne peuvent PAS être injectés
const RESTRICTED_URL_PATTERNS = [
  /^chrome:\/\//i,
  /^chrome-extension:\/\//i,
  /^edge:\/\//i,
  /^about:/i,
  /^devtools:\/\//i,
  /^view-source:/i,
  /^file:\/\//i,
  /chrome\.google\.com\/webstore/i,
  /chromewebstore\.google\.com/i
];

function isRestrictedUrl(url) {
  if (!url) return true;
  return RESTRICTED_URL_PATTERNS.some(p => p.test(url));
}

// ---------- Persistance de l'état ----------

function getSessionStorage() {
  // chrome.storage.session est préférable (ephémère, MV3), fallback local
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
    return chrome.storage.session;
  }
  return chrome.storage.local;
}

async function persistState() {
  try {
    const snapshot = {
      isRecording: state.isRecording,
      recordingTabId: state.recordingTabId,
      recordingStartTime: state.recordingStartTime
    };
    await getSessionStorage().set({ [STATE_STORAGE_KEY]: snapshot });
  } catch (e) {
    // Non critique
  }
}

async function loadPersistedState() {
  try {
    const result = await getSessionStorage().get([STATE_STORAGE_KEY]);
    const persisted = result[STATE_STORAGE_KEY];
    if (persisted) {
      state.isRecording = !!persisted.isRecording;
      state.recordingTabId = persisted.recordingTabId || null;
      state.recordingStartTime = persisted.recordingStartTime || null;
      Logger.info(LOG_SRC, 'État restauré depuis storage', snapshot());
    }
  } catch (e) {
    Logger.error(LOG_SRC, 'Erreur chargement état persisté', { error: e.message });
  }
}

// Au démarrage du SW, détecter une requête fetch interrompue par la suspension du SW.
async function checkInflightOrphan() {
  try {
    const result = await getSessionStorage().get([INFLIGHT_STORAGE_KEY]);
    const inflight = result[INFLIGHT_STORAGE_KEY];
    if (!inflight) return;

    const elapsedSec = Math.round((Date.now() - inflight.startedAt) / 1000);
    Logger.warn(LOG_SRC, 'Requête in-flight détectée au démarrage du SW (probable suspension)', {
      ...inflight,
      elapsedSec
    });
    await getSessionStorage().remove(INFLIGHT_STORAGE_KEY);

    if (inflight.tabId) {
      try {
        await chrome.tabs.sendMessage(inflight.tabId, {
          action: 'show-error',
          message: `Transcription perdue (extension redémarrée après ${elapsedSec}s). Réessaie ton enregistrement.`
        });
      } catch (e) { /* onglet fermé */ }
    }
    updateBadge('error');
    setTimeout(() => updateBadge('idle'), 5000);
  } catch (e) {
    Logger.error(LOG_SRC, 'Erreur check inflight orphan', { error: e.message });
  }
}

function snapshot() {
  return {
    isRecording: state.isRecording,
    recordingTabId: state.recordingTabId,
    recordingStartTime: state.recordingStartTime,
    isToggleProcessing: state.isToggleProcessing
  };
}

function clearTimers() {
  if (state.watchdogTimer) {
    clearTimeout(state.watchdogTimer);
    state.watchdogTimer = null;
  }
  if (state.lockTimer) {
    clearTimeout(state.lockTimer);
    state.lockTimer = null;
  }
}

async function resetState(badgeStatus) {
  clearTimers();
  state.isRecording = false;
  state.recordingTabId = null;
  state.recordingStartTime = null;
  state.isToggleProcessing = false;
  await persistState();
  if (badgeStatus) {
    updateBadge(badgeStatus);
    if (badgeStatus === 'error') {
      setTimeout(() => updateBadge('idle'), 3000);
    }
  }
}

function releaseLockSoon() {
  if (state.lockTimer) clearTimeout(state.lockTimer);
  state.lockTimer = setTimeout(() => {
    Logger.warn(LOG_SRC, 'Lock toggleRecording libéré par timeout de sécurité');
    state.isToggleProcessing = false;
    state.lockTimer = null;
  }, TOGGLE_LOCK_TIMEOUT);
}

// ---------- Initialisation ----------

chrome.runtime.onInstalled.addListener(() => {
  Logger.info(LOG_SRC, 'Extension installée/mise à jour');
  chrome.storage.sync.get(['webhookUrl', 'hotkey'], (result) => {
    if (!result.webhookUrl) {
      chrome.storage.sync.set(DEFAULT_CONFIG);
      Logger.info(LOG_SRC, 'Configuration par défaut appliquée');
    }
  });
  updateBadge('idle');
});

Logger.info(LOG_SRC, 'Service worker démarré', {
  sessionId: Logger.getSessionId()
});

// Charger état persistant (recouvrement après restart SW)
loadPersistedState();

// Détecter une requête fetch interrompue par une suspension du SW
checkInflightOrphan();

// ---------- Écoutes ----------

chrome.commands.onCommand.addListener((command) => {
  Logger.info(LOG_SRC, `Commande reçue: ${command}`);
  if (command === 'toggle-recording') {
    toggleRecording();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id || 'popup';
  Logger.debug(LOG_SRC, `Message reçu: ${message.action}`, { tabId, action: message.action });

  switch (message.action) {
    case 'toggle-recording':
      toggleRecording();
      sendResponse({ success: true });
      break;

    case 'get-status':
      sendResponse({
        isRecording: state.isRecording,
        recordingTabId: state.recordingTabId,
        recordingDuration: state.recordingStartTime ? Date.now() - state.recordingStartTime : 0
      });
      break;

    case 'test-connection':
      testConnection(message.url, message.username, message.password).then(sendResponse);
      return true;

    case 'recording-started':
      Logger.info(LOG_SRC, 'Enregistrement confirmé par content script', {
        tabId: sender.tab?.id
      });
      if (state.watchdogTimer) {
        clearTimeout(state.watchdogTimer);
        state.watchdogTimer = null;
      }
      state.isRecording = true;
      state.recordingStartTime = Date.now();
      state.recordingTabId = sender.tab?.id ?? state.recordingTabId;
      state.isToggleProcessing = false;
      if (state.lockTimer) {
        clearTimeout(state.lockTimer);
        state.lockTimer = null;
      }
      persistState();
      updateBadge('recording');
      sendResponse({ success: true });
      break;

    case 'recording-stopped': {
      Logger.info(LOG_SRC, 'Audio reçu du content script', {
        audioSize: message.audioBase64?.length || 0,
        tabId: sender.tab?.id
      });
      clearTimers();
      // Sauvegarder l'ID AVANT de réinitialiser l'état
      const tabIdToProcess = sender.tab?.id || state.recordingTabId;
      state.isRecording = false;
      state.recordingStartTime = null;
      state.recordingTabId = null;
      state.isToggleProcessing = false;
      persistState();
      processAudio(message.audioBase64, tabIdToProcess);
      sendResponse({ success: true });
      break;
    }

    case 'recording-cancelled':
      Logger.info(LOG_SRC, 'Enregistrement annulé (non fatal)', {
        reason: message.reason,
        tabId: sender.tab?.id
      });
      resetState('idle');
      sendResponse({ success: true });
      break;

    case 'recording-error':
      Logger.error(LOG_SRC, 'Erreur enregistrement du content script', {
        error: message.error,
        tabId: sender.tab?.id
      });
      resetState('error');
      sendResponse({ success: true });
      break;

    case 'get-logs':
      Logger.getLogs().then(logs => sendResponse({ logs }));
      return true;

    case 'clear-logs':
      Logger.clearLogs().then(() => sendResponse({ success: true }));
      return true;

    case 'export-logs':
      Logger.exportLogs().then(text => sendResponse({ text }));
      return true;

    case 'log-entry':
      if (message.entry) {
        Logger.log(
          message.entry.level,
          message.entry.source || 'Content',
          message.entry.message,
          message.entry.data
        );
      }
      sendResponse({ success: true });
      break;
  }
});

// ---------- Logique principale ----------

async function toggleRecording() {
  Logger.info(LOG_SRC, 'toggleRecording appelé', snapshot());

  // Protection anti-concurrence: ignorer les appels en parallèle
  if (state.isToggleProcessing) {
    Logger.warn(LOG_SRC, 'toggleRecording ignoré (opération déjà en cours)');
    return;
  }

  state.isToggleProcessing = true;
  releaseLockSoon();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      Logger.error(LOG_SRC, 'Aucun onglet actif trouvé');
      await resetState('error');
      return;
    }

    Logger.debug(LOG_SRC, 'Onglet actif trouvé', { tabId: tab.id, url: tab.url });

    // Vérifier si l'URL permet l'injection d'un content script
    if (isRestrictedUrl(tab.url)) {
      Logger.warn(LOG_SRC, 'Page restreinte, content script indisponible', { url: tab.url });
      try {
        await chrome.notifications?.create?.({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'Voice to Text',
          message: "Impossible d'enregistrer sur cette page (chrome://, Web Store ou extension)."
        });
      } catch (e) { /* ignore si chrome.notifications indispo */ }
      await resetState('error');
      return;
    }

    if (state.isRecording) {
      // === Arrêt de l'enregistrement ===
      const duration = state.recordingStartTime ? Date.now() - state.recordingStartTime : 0;
      const targetTabId = state.recordingTabId || tab.id;

      Logger.info(LOG_SRC, 'Arrêt de l\'enregistrement demandé', {
        tabId: targetTabId,
        currentTabId: tab.id,
        duration
      });

      try {
        await chrome.tabs.sendMessage(targetTabId, { action: 'stop-recording' });
        Logger.info(LOG_SRC, 'Message stop-recording envoyé', { targetTabId });
        updateBadge('processing');
        // Le lock sera libéré à la réception de recording-stopped / cancelled / error.
      } catch (error) {
        Logger.error(LOG_SRC, 'Erreur envoi stop-recording, reset complet', {
          error: error.message,
          targetTabId
        });
        await resetState('error');
      }
    } else {
      // === Démarrage de l'enregistrement ===
      const config = await chrome.storage.sync.get(['webhookUrl', 'minDuration', 'testMode']);
      Logger.debug(LOG_SRC, 'Config vérifiée', {
        hasWebhook: !!config.webhookUrl,
        testMode: !!config.testMode,
        minDuration: config.minDuration
      });

      if (!config.webhookUrl && !config.testMode) {
        Logger.warn(LOG_SRC, 'Webhook non configuré et mode test désactivé');
        try {
          await chrome.tabs.sendMessage(tab.id, {
            action: 'show-error',
            message: 'Veuillez configurer l\'URL du webhook n8n ou activer le mode test dans les paramètres de l\'extension.'
          });
        } catch (e) { /* ignore */ }
        await resetState('idle');
        return;
      }

      const minDuration = config.minDuration !== undefined ? config.minDuration : DEFAULT_CONFIG.minDuration;
      Logger.info(LOG_SRC, 'Démarrage enregistrement demandé', { tabId: tab.id, minDuration });

      try {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'start-recording',
          minDuration: minDuration
        });
        // Mémoriser l'onglet même avant l'ack pour permettre un stop en cas d'ack manquant
        state.recordingTabId = tab.id;
        await persistState();

        // Watchdog: si aucun ack après START_ACK_TIMEOUT, reset propre
        if (state.watchdogTimer) clearTimeout(state.watchdogTimer);
        state.watchdogTimer = setTimeout(async () => {
          if (!state.isRecording) {
            Logger.warn(LOG_SRC, 'Aucun ack recording-started reçu, reset');
            await resetState('error');
          }
          state.watchdogTimer = null;
        }, START_ACK_TIMEOUT);
      } catch (error) {
        Logger.error(LOG_SRC, 'Erreur envoi start-recording', {
          error: error.message,
          tabId: tab.id
        });
        await resetState('error');
      }
    }
  } catch (error) {
    Logger.logError(LOG_SRC, error, 'toggleRecording');
    await resetState('error');
  }
}

// Construire les headers HTTP
function buildHeaders(username, password) {
  const headers = {
    'Content-Type': 'application/json'
  };
  if (username && password) {
    headers['Authorization'] = `Basic ${btoa(`${username}:${password}`)}`;
  }
  return headers;
}

// Traiter l'audio enregistré
async function processAudio(audioBase64, tabId) {
  Logger.info(LOG_SRC, 'processAudio démarré', {
    audioSize: audioBase64?.length || 0,
    tabId
  });

  let keepAliveStarted = false;
  let inflightPersisted = false;

  try {
    updateBadge('processing');

    if (!audioBase64 || audioBase64.length === 0) {
      throw new Error('Audio vide reçu');
    }

    const config = await chrome.storage.sync.get(['webhookUrl', 'authUsername', 'authPassword', 'testMode', 'mode']);
    const mode = normalizeMode(config.mode);
    Logger.debug(LOG_SRC, 'Config récupérée pour envoi', {
      hasWebhook: !!config.webhookUrl,
      hasAuth: !!(config.authUsername && config.authPassword),
      testMode: !!config.testMode,
      mode
    });

    // Mode test : simuler une transcription
    if (config.testMode) {
      Logger.info(LOG_SRC, 'Mode test activé, simulation de transcription', { mode });
      await new Promise(resolve => setTimeout(resolve, 1000));

      const modeLabel = mode === 'transcript' ? 'Transcription' : 'Prompt';
      const testText = `[Mode Test - ${modeLabel}] Audio enregistré (${Math.round(audioBase64.length / 1024)}KB). Ceci est un texte de test pour vérifier que l'enregistrement fonctionne correctement.`;

      await savePromptToHistory({
        text: testText,
        tabId,
        processingTimeMs: 1000,
        audioSizeKB: Math.round(audioBase64.length / 1024),
        mode,
        isTest: true
      });

      injectTextOrNotify(tabId, testText);
      return;
    }

    if (!config.webhookUrl) {
      throw new Error('URL du webhook non configurée');
    }

    // Décoder le base64 en bytes une seule fois, puis emballer en multipart.
    // Évite JSON.stringify d'un gros base64 (+33% taille) et permet à n8n
    // de consommer directement le fichier binaire.
    const mp3Bytes = base64ToUint8Array(audioBase64);
    const audioSizeKB = Math.round(mp3Bytes.byteLength / 1024);
    const mp3Blob = new Blob([mp3Bytes], { type: 'audio/mpeg' });

    const formData = new FormData();
    formData.append('audio', mp3Blob, 'recording.mp3');
    formData.append('timestamp', new Date().toISOString());
    // Indique au workflow n8n s'il doit réécrire en prompt ou seulement nettoyer légèrement.
    formData.append('mode', mode);

    // Persister l'état in-flight pour détecter les SW killés pendant l'upload.
    const inflight = {
      tabId,
      startedAt: Date.now(),
      audioSizeKB,
      url: config.webhookUrl
    };
    await getSessionStorage().set({ [INFLIGHT_STORAGE_KEY]: inflight });
    inflightPersisted = true;

    // Démarrer le keepalive AVANT le fetch — sinon le SW peut être suspendu
    // pendant l'upload/traitement (les promesses pendantes ne comptent pas comme activité).
    startKeepAlive();
    keepAliveStarted = true;

    // Authentification optionnelle (FormData gère le Content-Type lui-même).
    const headers = {};
    if (config.authUsername && config.authPassword) {
      headers['Authorization'] = `Basic ${btoa(`${config.authUsername}:${config.authPassword}`)}`;
    }

    Logger.info(LOG_SRC, 'Envoi vers webhook...', {
      url: config.webhookUrl.substring(0, 50) + '...',
      audioSizeKB,
      timeoutMs: WEBHOOK_TIMEOUT_MS
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    let response;
    const startTime = Date.now();
    try {
      response = await fetch(config.webhookUrl, {
        method: 'POST',
        headers,
        body: formData,
        signal: controller.signal
      });
    } catch (fetchError) {
      if (fetchError.name === 'AbortError') {
        throw new Error(`Timeout webhook (${WEBHOOK_TIMEOUT_MS / 1000}s) — le serveur n'a pas répondu à temps`);
      }
      throw fetchError;
    } finally {
      clearTimeout(timeoutId);
    }

    const responseTime = Date.now() - startTime;
    Logger.info(LOG_SRC, 'Réponse webhook reçue', {
      status: response.status,
      ok: response.ok,
      responseTimeMs: responseTime
    });

    if (!response.ok) {
      throw new Error(`Erreur HTTP: ${response.status}`);
    }

    const result = await response.json();
    Logger.info(LOG_SRC, 'Résultat JSON parsé', {
      hasCleanedText: !!result.cleanedText,
      hasText: !!result.text,
      hasError: !!result.error
    });

    if (result.error) {
      throw new Error(result.error);
    }

    const cleanedText = result.cleanedText || result.text || '';
    if (!cleanedText) {
      throw new Error('Aucun texte reçu du serveur');
    }

    await savePromptToHistory({
      text: cleanedText,
      tabId,
      processingTimeMs: responseTime,
      audioSizeKB,
      mode
    });

    injectTextOrNotify(tabId, cleanedText);

  } catch (error) {
    Logger.logError(LOG_SRC, error, 'processAudio');

    if (tabId) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          action: 'show-error',
          message: `Erreur: ${error.message}`
        });
      } catch (e) {
        // Content script peut-être indisponible (navigation, tab fermé)
      }
    }
    updateBadge('error');
    setTimeout(() => updateBadge('idle'), 3000);
  } finally {
    if (keepAliveStarted) stopKeepAlive();
    if (inflightPersisted) {
      try {
        await getSessionStorage().remove(INFLIGHT_STORAGE_KEY);
      } catch (e) { /* non critique */ }
    }
  }
}

function injectTextOrNotify(tabId, text) {
  Logger.info(LOG_SRC, 'Injection du texte', { textLength: text.length, tabId });
  if (tabId) {
    try {
      chrome.tabs.sendMessage(tabId, {
        action: 'inject-text',
        text: text
      });
    } catch (e) {
      Logger.error(LOG_SRC, 'Erreur envoi inject-text', { error: e.message });
    }
  }
  updateBadge('success');
  setTimeout(() => updateBadge('idle'), 2000);
}

async function savePromptToHistory(prompt) {
  const entry = {
    id: Date.now().toString(36),
    timestamp: new Date().toISOString(),
    length: prompt.text.length,
    ...prompt
  };
  try {
    const result = await chrome.storage.local.get([PROMPTS_STORAGE_KEY]);
    const prompts = result[PROMPTS_STORAGE_KEY] || [];
    prompts.unshift(entry);
    if (prompts.length > MAX_PROMPTS_HISTORY) {
      prompts.length = MAX_PROMPTS_HISTORY;
    }
    await chrome.storage.local.set({ [PROMPTS_STORAGE_KEY]: prompts });
    Logger.info(LOG_SRC, 'Prompt sauvegardé dans historique', {
      promptId: entry.id,
      totalPrompts: prompts.length
    });
  } catch (e) {
    Logger.error(LOG_SRC, 'Erreur sauvegarde prompt', { error: e.message });
  }
}

// Tester la connexion au webhook
async function testConnection(url, username, password) {
  Logger.info(LOG_SRC, 'Test connexion webhook', {
    url: url?.substring(0, 50) + '...',
    hasAuth: !!(username && password)
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(username, password),
      body: JSON.stringify({
        test: true,
        timestamp: new Date().toISOString()
      })
    });

    const result = {
      success: response.ok,
      status: response.status,
      message: response.ok ? 'Connexion réussie!' :
        response.status === 401 ? 'Erreur 401: Authentification échouée' :
          `Erreur HTTP: ${response.status}`
    };

    Logger.info(LOG_SRC, 'Résultat test connexion', result);
    return result;
  } catch (error) {
    Logger.logError(LOG_SRC, error, 'testConnection');
    return { success: false, message: `Erreur de connexion: ${error.message}` };
  }
}

// Mettre à jour le badge de l'extension
function updateBadge(status) {
  const badges = {
    idle: { text: '', color: '#666666' },
    recording: { text: 'REC', color: '#FF0000' },
    processing: { text: '...', color: '#FFA500' },
    success: { text: '', color: '#00FF00' },
    error: { text: '!', color: '#FF0000' }
  };

  const badge = badges[status] || badges.idle;
  try {
    chrome.action.setBadgeText({ text: badge.text });
    chrome.action.setBadgeBackgroundColor({ color: badge.color });
  } catch (e) {
    // chrome.action peut ne pas être disponible dans certains contextes de test
  }
  Logger.debug(LOG_SRC, `Badge mis à jour: ${status}`);
}

// Exports pour les tests (Jest / CommonJS)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    toggleRecording,
    processAudio,
    updateBadge,
    buildHeaders,
    testConnection,
    isRestrictedUrl,
    savePromptToHistory,
    resetState,
    normalizeMode,
    _state: state
  };
}
