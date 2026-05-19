// Voice to Text - Background Service Worker
// Gère l'enregistrement audio et la communication avec n8n

importScripts('logger.js');

const LOG_SRC = 'Background';

let isRecording = false;
let recordingTabId = null;
let recordingStartTime = null;
let isToggleProcessing = false;

// Configuration par défaut
const DEFAULT_CONFIG = {
  webhookUrl: '',
  hotkey: 'Ctrl+Shift+V',
  minDuration: 1, // Durée minimum en secondes
  testMode: false // Mode test : enregistre sans envoyer au webhook
};

// Historique des prompts
const PROMPTS_STORAGE_KEY = 'vtt_prompts_history';

// Clé de persistance pour détecter les requêtes interrompues par la suspension du SW
const INFLIGHT_STORAGE_KEY = 'vtt_inflight';

// Timeout réseau pour le webhook (le SW MV3 peut être tué après ~30s de fetch en attente,
// le keepalive ci-dessous l'évite ; ce timeout protège contre un webhook qui hang).
const WEBHOOK_TIMEOUT_MS = 90_000;

// Keepalive du service worker pendant un fetch long (MV3).
// Une promesse fetch en attente ne maintient PAS le SW vivant — il faut un événement périodique.
const KEEPALIVE_ALARM = 'vtt-keepalive';
let keepAliveIntervalId = null;

chrome.alarms.onAlarm.addListener((alarm) => {
  // No-op : le simple fait que ce handler s'exécute réveille le SW.
  if (alarm.name === KEEPALIVE_ALARM) return;
});

function startKeepAlive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  if (!keepAliveIntervalId) {
    keepAliveIntervalId = setInterval(() => {
      chrome.runtime.getPlatformInfo().catch(() => { });
    }, 20_000);
  }
  VTTLogger.debug(LOG_SRC, 'Keepalive SW démarré');
}

function stopKeepAlive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
  if (keepAliveIntervalId) {
    clearInterval(keepAliveIntervalId);
    keepAliveIntervalId = null;
  }
  VTTLogger.debug(LOG_SRC, 'Keepalive SW arrêté');
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

// Au démarrage du SW, détecter une éventuelle requête in-flight orpheline.
chrome.storage.session.get(INFLIGHT_STORAGE_KEY).then((result) => {
  const inflight = result[INFLIGHT_STORAGE_KEY];
  if (!inflight) return;

  const elapsedSec = Math.round((Date.now() - inflight.startedAt) / 1000);
  VTTLogger.warn(LOG_SRC, 'Requête in-flight détectée au démarrage du SW (probable suspension)', {
    ...inflight,
    elapsedSec
  });
  chrome.storage.session.remove(INFLIGHT_STORAGE_KEY);

  if (inflight.tabId) {
    chrome.tabs.sendMessage(inflight.tabId, {
      action: 'show-error',
      message: `Transcription perdue (extension redémarrée après ${elapsedSec}s). Réessaie ton enregistrement.`
    }).catch(() => { /* onglet fermé */ });
  }
  updateBadge('error');
  setTimeout(() => updateBadge('idle'), 5000);
});

// Initialisation
chrome.runtime.onInstalled.addListener(() => {
  VTTLogger.info(LOG_SRC, 'Extension installée/mise à jour');
  chrome.storage.sync.get(['webhookUrl', 'hotkey'], (result) => {
    if (!result.webhookUrl) {
      chrome.storage.sync.set(DEFAULT_CONFIG);
      VTTLogger.info(LOG_SRC, 'Configuration par défaut appliquée');
    }
  });
  updateBadge('idle');
});

// Au démarrage du service worker
VTTLogger.info(LOG_SRC, 'Service worker démarré', {
  sessionId: VTTLogger.getSessionId()
});

// Écoute des commandes clavier
chrome.commands.onCommand.addListener((command) => {
  VTTLogger.info(LOG_SRC, `Commande reçue: ${command}`);
  if (command === 'toggle-recording') {
    toggleRecording();
  }
});

// Écoute des messages du popup et content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id || 'popup';
  VTTLogger.debug(LOG_SRC, `Message reçu: ${message.action}`, { tabId, action: message.action });

  switch (message.action) {
    case 'toggle-recording':
      toggleRecording();
      sendResponse({ success: true });
      break;

    case 'get-status':
      sendResponse({
        isRecording,
        recordingTabId,
        recordingDuration: recordingStartTime ? Date.now() - recordingStartTime : 0
      });
      break;

    case 'test-connection':
      testConnection(message.url, message.username, message.password).then(sendResponse);
      return true;

    case 'recording-stopped':
      VTTLogger.info(LOG_SRC, 'Audio reçu du content script', {
        audioSize: message.audioBase64?.length || 0,
        tabId: sender.tab?.id
      });
      // Réinitialiser l'état d'enregistrement
      isRecording = false;
      recordingStartTime = null;
      processAudio(message.audioBase64, sender.tab?.id || recordingTabId);
      sendResponse({ success: true });
      break;

    case 'recording-error':
      VTTLogger.error(LOG_SRC, 'Erreur enregistrement du content script', {
        error: message.error,
        tabId: sender.tab?.id
      });
      isRecording = false;
      recordingStartTime = null;
      recordingTabId = null;
      updateBadge('error');
      setTimeout(() => updateBadge('idle'), 3000);
      sendResponse({ success: true });
      break;

    case 'recording-started':
      VTTLogger.info(LOG_SRC, 'Enregistrement démarré confirmé par content script', {
        tabId: sender.tab?.id
      });
      isRecording = true;
      recordingStartTime = Date.now();
      recordingTabId = sender.tab?.id;
      updateBadge('recording');
      sendResponse({ success: true });
      break;

    case 'get-logs':
      VTTLogger.getLogs().then(logs => sendResponse({ logs }));
      return true;

    case 'clear-logs':
      VTTLogger.clearLogs().then(() => sendResponse({ success: true }));
      return true;

    case 'export-logs':
      VTTLogger.exportLogs().then(text => sendResponse({ text }));
      return true;

    case 'log-entry':
      // Recevoir les logs du content script
      if (message.entry) {
        VTTLogger.log(
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

// Basculer l'état d'enregistrement
async function toggleRecording() {
  VTTLogger.info(LOG_SRC, `toggleRecording appelé, état actuel: ${isRecording}`);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      VTTLogger.error(LOG_SRC, 'Aucun onglet actif trouvé');
      return;
    }

    VTTLogger.debug(LOG_SRC, 'Onglet actif trouvé', { tabId: tab.id, url: tab.url });

    if (isRecording) {
      // Arrêter l'enregistrement
      const duration = recordingStartTime ? Date.now() - recordingStartTime : 0;
      VTTLogger.info(LOG_SRC, 'Arrêt de l\'enregistrement demandé', {
        tabId: recordingTabId,
        currentTabId: tab.id,
        duration
      });

      // IMPORTANT: Marquer comme arrêté IMMÉDIATEMENT pour éviter les doubles déclenchements
      const targetTabId = recordingTabId || tab.id;
      isRecording = false;
      recordingStartTime = null;

      try {
        await chrome.tabs.sendMessage(targetTabId, { action: 'stop-recording' });
        VTTLogger.info(LOG_SRC, 'Message stop-recording envoyé', { targetTabId });
        updateBadge('processing');
      } catch (error) {
        VTTLogger.error(LOG_SRC, 'Erreur envoi stop-recording', {
          error: error.message,
          targetTabId
        });
        // Réinitialiser complètement l'état en cas d'erreur
        recordingTabId = null;
        updateBadge('idle');
      }

    } else {
      // Vérifier la configuration
      const config = await chrome.storage.sync.get(['webhookUrl', 'minDuration', 'testMode']);
      VTTLogger.debug(LOG_SRC, 'Config vérifiée', {
        hasWebhook: !!config.webhookUrl,
        testMode: !!config.testMode,
        minDuration: config.minDuration
      });

      if (!config.webhookUrl && !config.testMode) {
        VTTLogger.warn(LOG_SRC, 'Webhook non configuré et mode test désactivé');
        chrome.tabs.sendMessage(tab.id, {
          action: 'show-error',
          message: 'Veuillez configurer l\'URL du webhook n8n ou activer le mode test dans les paramètres de l\'extension.'
        });
        return;
      }

      // Démarrer l'enregistrement
      const minDuration = config.minDuration !== undefined ? config.minDuration : DEFAULT_CONFIG.minDuration;
      VTTLogger.info(LOG_SRC, 'Démarrage enregistrement demandé', { tabId: tab.id, minDuration });

      try {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'start-recording',
          minDuration: minDuration
        });
        // L'état sera mis à jour quand on recevra 'recording-started'
        // Mais on initialise quand même au cas où le message de confirmation n'arrive pas
        recordingTabId = tab.id;
      } catch (error) {
        VTTLogger.error(LOG_SRC, 'Erreur envoi start-recording', {
          error: error.message,
          tabId: tab.id
        });
        updateBadge('error');
        setTimeout(() => updateBadge('idle'), 3000);
      }
    }
  } catch (error) {
    VTTLogger.logError(LOG_SRC, error, 'toggleRecording');
    updateBadge('error');
    setTimeout(() => updateBadge('idle'), 3000);
  }
}

// Construire les headers avec Basic Auth si configuré
function buildHeaders(username, password) {
  const headers = {
    'Content-Type': 'application/json'
  };

  if (username && password) {
    const credentials = btoa(`${username}:${password}`);
    headers['Authorization'] = `Basic ${credentials}`;
  }

  return headers;
}

// Traiter l'audio enregistré
async function processAudio(audioBase64, tabId) {
  VTTLogger.info(LOG_SRC, 'processAudio démarré', {
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

    const config = await chrome.storage.sync.get(['webhookUrl', 'authUsername', 'authPassword', 'testMode']);
    VTTLogger.debug(LOG_SRC, 'Config récupérée pour envoi', {
      hasWebhook: !!config.webhookUrl,
      hasAuth: !!(config.authUsername && config.authPassword),
      testMode: !!config.testMode
    });

    // Mode test : simuler une transcription
    if (config.testMode) {
      VTTLogger.info(LOG_SRC, 'Mode test activé, simulation de transcription');

      // Simuler un délai de traitement
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Texte de test basé sur la taille de l'audio
      const testText = `[Mode Test] Audio enregistré (${Math.round(audioBase64.length / 1024)}KB). Ceci est un texte de test pour vérifier que l'enregistrement fonctionne correctement.`;

      // Sauvegarder le prompt de test dans l'historique
      const prompt = {
        id: Date.now().toString(36),
        text: testText,
        timestamp: new Date().toISOString(),
        length: testText.length,
        tabId: tabId,
        processingTimeMs: 1000,
        audioSizeKB: Math.round(audioBase64.length / 1024),
        isTest: true
      };

      chrome.storage.local.get([PROMPTS_STORAGE_KEY]).then(result => {
        const prompts = result[PROMPTS_STORAGE_KEY] || [];
        prompts.unshift(prompt);
        chrome.storage.local.set({ [PROMPTS_STORAGE_KEY]: prompts });
        VTTLogger.info(LOG_SRC, 'Prompt test sauvegardé dans historique', {
          promptId: prompt.id,
          totalPrompts: prompts.length
        });
      });

      // Injecter le texte de test
      if (testText) {
        VTTLogger.info(LOG_SRC, 'Injection du texte de test', {
          textLength: testText.length,
          tabId
        });

        chrome.tabs.sendMessage(tabId, {
          action: 'inject-text',
          text: testText
        });
        updateBadge('success');
        setTimeout(() => updateBadge('idle'), 2000);
      } else {
        throw new Error('Erreur lors de la simulation du texte de test');
      }

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

    // Persister l'état in-flight pour détecter les SW killés pendant l'upload.
    const inflight = {
      tabId,
      startedAt: Date.now(),
      audioSizeKB,
      url: config.webhookUrl
    };
    await chrome.storage.session.set({ [INFLIGHT_STORAGE_KEY]: inflight });
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

    VTTLogger.info(LOG_SRC, 'Envoi vers webhook...', {
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
    VTTLogger.info(LOG_SRC, 'Réponse webhook reçue', {
      status: response.status,
      ok: response.ok,
      responseTimeMs: responseTime
    });

    if (!response.ok) {
      throw new Error(`Erreur HTTP: ${response.status}`);
    }

    const result = await response.json();
    VTTLogger.info(LOG_SRC, 'Résultat JSON parsé', {
      hasCleanedText: !!result.cleanedText,
      hasText: !!result.text,
      hasError: !!result.error
    });

    if (result.error) {
      throw new Error(result.error);
    }

    // Envoyer le texte nettoyé au content script pour injection
    const cleanedText = result.cleanedText || result.text || '';

    if (cleanedText) {
      // Sauvegarder le prompt dans l'historique AVANT l'injection
      const prompt = {
        id: Date.now().toString(36),
        text: cleanedText,
        timestamp: new Date().toISOString(),
        length: cleanedText.length,
        tabId: tabId,
        processingTimeMs: responseTime,
        audioSizeKB
      };

      chrome.storage.local.get([PROMPTS_STORAGE_KEY]).then(result => {
        const prompts = result[PROMPTS_STORAGE_KEY] || [];
        prompts.unshift(prompt); // Plus récents en premier
        chrome.storage.local.set({ [PROMPTS_STORAGE_KEY]: prompts });
        VTTLogger.info(LOG_SRC, 'Prompt sauvegardé dans historique', {
          promptId: prompt.id,
          totalPrompts: prompts.length
        });
      });

      VTTLogger.info(LOG_SRC, 'Injection du texte', {
        textLength: cleanedText.length,
        tabId
      });

      chrome.tabs.sendMessage(tabId, {
        action: 'inject-text',
        text: cleanedText
      });
      updateBadge('success');
      setTimeout(() => updateBadge('idle'), 2000);
    } else {
      throw new Error('Aucun texte reçu du serveur');
    }

  } catch (error) {
    VTTLogger.logError(LOG_SRC, error, 'processAudio');

    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        action: 'show-error',
        message: `Erreur: ${error.message}`
      }).catch(() => { /* onglet fermé */ });
    }
    updateBadge('error');
    setTimeout(() => updateBadge('idle'), 3000);
  } finally {
    if (keepAliveStarted) stopKeepAlive();
    if (inflightPersisted) {
      await chrome.storage.session.remove(INFLIGHT_STORAGE_KEY).catch(() => { });
    }
    recordingTabId = null;
  }
}

// Tester la connexion au webhook
async function testConnection(url, username, password) {
  VTTLogger.info(LOG_SRC, 'Test connexion webhook', {
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

    VTTLogger.info(LOG_SRC, 'Résultat test connexion', result);
    return result;

  } catch (error) {
    VTTLogger.logError(LOG_SRC, error, 'testConnection');
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
  chrome.action.setBadgeText({ text: badge.text });
  chrome.action.setBadgeBackgroundColor({ color: badge.color });

  VTTLogger.debug(LOG_SRC, `Badge mis à jour: ${status}`);
}
