// Voice to Text - Background Service Worker
// Gère l'enregistrement audio et la communication avec n8n

let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let recordingTabId = null;

// Configuration par défaut
const DEFAULT_CONFIG = {
  webhookUrl: '',
  hotkey: 'Ctrl+Shift+V'
};

// Initialisation
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(['webhookUrl', 'hotkey'], (result) => {
    if (!result.webhookUrl) {
      chrome.storage.sync.set(DEFAULT_CONFIG);
    }
  });
  updateBadge('idle');
});

// Écoute des commandes clavier
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-recording') {
    toggleRecording();
  }
});

// Écoute des messages du popup et content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'toggle-recording':
      toggleRecording();
      sendResponse({ success: true });
      break;
    case 'get-status':
      sendResponse({ isRecording });
      break;
    case 'test-connection':
      testConnection(message.url, message.username, message.password).then(sendResponse);
      return true; // Indique une réponse asynchrone
    case 'audio-data':
      handleAudioData(message.data, sender.tab.id);
      sendResponse({ success: true });
      break;
    case 'recording-stopped':
      processAudio(message.audioBase64, sender.tab.id);
      sendResponse({ success: true });
      break;
  }
});

// Basculer l'état d'enregistrement
async function toggleRecording() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab) {
    console.error('Aucun onglet actif trouvé');
    return;
  }

  if (isRecording) {
    // Arrêter l'enregistrement
    chrome.tabs.sendMessage(tab.id, { action: 'stop-recording' });
    isRecording = false;
    updateBadge('processing');
  } else {
    // Vérifier la configuration
    const config = await chrome.storage.sync.get(['webhookUrl']);
    if (!config.webhookUrl) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'show-error',
        message: 'Veuillez configurer l\'URL du webhook n8n dans les paramètres de l\'extension.'
      });
      return;
    }

    // Démarrer l'enregistrement
    recordingTabId = tab.id;
    chrome.tabs.sendMessage(tab.id, { action: 'start-recording' });
    isRecording = true;
    updateBadge('recording');
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
  try {
    updateBadge('processing');

    const config = await chrome.storage.sync.get(['webhookUrl', 'authUsername', 'authPassword']);

    if (!config.webhookUrl) {
      throw new Error('URL du webhook non configurée');
    }

    // Envoyer l'audio au webhook n8n
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: buildHeaders(config.authUsername, config.authPassword),
      body: JSON.stringify({
        audio: audioBase64,
        timestamp: new Date().toISOString()
      })
    });

    if (!response.ok) {
      throw new Error(`Erreur HTTP: ${response.status}`);
    }

    const result = await response.json();

    if (result.error) {
      throw new Error(result.error);
    }

    // Envoyer le texte nettoyé au content script pour injection
    const cleanedText = result.cleanedText || result.text || '';

    if (cleanedText) {
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
    console.error('Erreur de traitement:', error);
    chrome.tabs.sendMessage(tabId, {
      action: 'show-error',
      message: `Erreur: ${error.message}`
    });
    updateBadge('error');
    setTimeout(() => updateBadge('idle'), 3000);
  }
}

// Tester la connexion au webhook
async function testConnection(url, username, password) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(username, password),
      body: JSON.stringify({
        test: true,
        timestamp: new Date().toISOString()
      })
    });

    if (response.ok) {
      return { success: true, message: 'Connexion réussie!' };
    } else if (response.status === 401) {
      return { success: false, message: 'Erreur 401: Authentification échouée (vérifiez username/password)' };
    } else {
      return { success: false, message: `Erreur HTTP: ${response.status}` };
    }
  } catch (error) {
    return { success: false, message: `Erreur de connexion: ${error.message}` };
  }
}

// Mettre à jour le badge de l'extension
function updateBadge(status) {
  const badges = {
    idle: { text: '', color: '#666666' },
    recording: { text: 'REC', color: '#FF0000' },
    processing: { text: '...', color: '#FFA500' },
    success: { text: '✓', color: '#00FF00' },
    error: { text: '!', color: '#FF0000' }
  };

  const badge = badges[status] || badges.idle;
  chrome.action.setBadgeText({ text: badge.text });
  chrome.action.setBadgeBackgroundColor({ color: badge.color });
}
