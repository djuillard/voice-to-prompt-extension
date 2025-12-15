// Voice to Text - Background Service Worker
// Gère l'enregistrement audio et la communication avec n8n

importScripts('logger.js');

const LOG_SRC = 'Background';

let isRecording = false;
let recordingTabId = null;
let recordingStartTime = null;

// Configuration par défaut
const DEFAULT_CONFIG = {
  webhookUrl: '',
  hotkey: 'Ctrl+Shift+V',
  minDuration: 1 // Durée minimum en secondes
};

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
      const config = await chrome.storage.sync.get(['webhookUrl', 'minDuration']);
      VTTLogger.debug(LOG_SRC, 'Config vérifiée', { hasWebhook: !!config.webhookUrl, minDuration: config.minDuration });

      if (!config.webhookUrl) {
        VTTLogger.warn(LOG_SRC, 'Webhook non configuré');
        chrome.tabs.sendMessage(tab.id, {
          action: 'show-error',
          message: 'Veuillez configurer l\'URL du webhook n8n dans les paramètres de l\'extension.'
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

  try {
    updateBadge('processing');

    if (!audioBase64 || audioBase64.length === 0) {
      throw new Error('Audio vide reçu');
    }

    const config = await chrome.storage.sync.get(['webhookUrl', 'authUsername', 'authPassword']);
    VTTLogger.debug(LOG_SRC, 'Config récupérée pour envoi', {
      hasWebhook: !!config.webhookUrl,
      hasAuth: !!(config.authUsername && config.authPassword)
    });

    if (!config.webhookUrl) {
      throw new Error('URL du webhook non configurée');
    }

    // Envoyer l'audio au webhook n8n
    VTTLogger.info(LOG_SRC, 'Envoi vers webhook...', {
      url: config.webhookUrl.substring(0, 50) + '...',
      audioSizeKB: Math.round(audioBase64.length / 1024)
    });

    const startTime = Date.now();
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: buildHeaders(config.authUsername, config.authPassword),
      body: JSON.stringify({
        audio: audioBase64,
        timestamp: new Date().toISOString()
      })
    });

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
      });
    }
    updateBadge('error');
    setTimeout(() => updateBadge('idle'), 3000);
  } finally {
    // S'assurer que l'état est bien réinitialisé
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
