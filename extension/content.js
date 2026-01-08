// Voice to Text - Content Script
// Gère l'enregistrement audio et l'injection de texte dans les champs

const LOG_SRC = 'Content';

// Logger simplifié pour content script (pas d'accès direct au storage depuis ici)
const ContentLogger = {
  _logs: [],

  log(level, message, data = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data
    };

    this._logs.push(entry);

    // Garder seulement les 100 derniers logs en mémoire
    if (this._logs.length > 100) {
      this._logs.shift();
    }

    const colors = {
      DEBUG: '#888',
      INFO: '#2196F3',
      WARN: '#FF9800',
      ERROR: '#F44336'
    };

    console.log(
      `%c[VTT ${level}] %c[${LOG_SRC}] %c${message}`,
      `color: ${colors[level]}; font-weight: bold`,
      'color: #9C27B0',
      'color: inherit',
      data || ''
    );

    // Envoyer au background pour stockage persistant
    try {
      chrome.runtime.sendMessage({
        action: 'log-entry',
        entry: {
          ...entry,
          source: LOG_SRC
        }
      }).catch(() => { }); // Ignorer les erreurs si le background n'est pas disponible
    } catch (e) {
      // Silencieux
    }
  },

  debug(message, data = null) { this.log('DEBUG', message, data); },
  info(message, data = null) { this.log('INFO', message, data); },
  warn(message, data = null) { this.log('WARN', message, data); },
  error(message, data = null) { this.log('ERROR', message, data); }
};

let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;
let audioChunks = [];
let isRecording = false;
let recordingIndicator = null;
let recordingStartTime = null;

// Timeout de sécurité pour les enregistrements longs (5 minutes max)
const MAX_RECORDING_DURATION = 5 * 60 * 1000;
// Durée minimum d'enregistrement (configurable, par défaut 1 seconde)
let minRecordingDuration = 1000;
let recordingTimeout = null;

ContentLogger.info('Content script chargé', { url: window.location.href });

// Écoute des messages du background script
if (typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  ContentLogger.debug(`Message reçu: ${message.action}`);

  switch (message.action) {
    case 'start-recording':
      // Mettre à jour la durée minimum si fournie
      if (message.minDuration !== undefined) {
        minRecordingDuration = message.minDuration * 1000; // Convertir en ms
        ContentLogger.debug('Durée minimum configurée', { minDurationMs: minRecordingDuration });
      }
      startRecording()
        .then(() => sendResponse({ success: true }))
        .catch(err => {
          ContentLogger.error('Erreur startRecording', { error: err.message });
          sendResponse({ success: false, error: err.message });
        });
      return true; // Réponse asynchrone

    case 'stop-recording':
      stopRecording()
        .then(() => sendResponse({ success: true }))
        .catch(err => {
          ContentLogger.error('Erreur stopRecording', { error: err.message });
          sendResponse({ success: false, error: err.message });
        });
      return true; // Réponse asynchrone

    case 'inject-text':
      injectText(message.text);
      sendResponse({ success: true });
      break;

    case 'show-error':
      showNotification(message.message, 'error');
      sendResponse({ success: true });
      break;

    case 'get-recording-state':
      sendResponse({
        isRecording,
        duration: recordingStartTime ? Date.now() - recordingStartTime : 0,
        chunksCount: audioChunks.length
      });
      break;
  }
  });
}

// Démarrer l'enregistrement audio (capture PCM pour encodage MP3)
async function startRecording() {
  ContentLogger.info('Démarrage enregistrement demandé', {
    isCurrentlyRecording: isRecording
  });

  // Éviter les démarrages multiples
  if (isRecording) {
    ContentLogger.warn('Enregistrement déjà en cours, ignoré');
    return;
  }

  // Vérifier qu'il n'y a pas de ressources audio orphelines
  if (mediaStream || audioContext || scriptProcessor) {
    ContentLogger.warn('Ressources audio détectées, nettoyage avant démarrage');
    await cleanupRecording();
  }

  try {
    ContentLogger.debug('Demande accès microphone...');

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 44100,
        echoCancellation: true,
        noiseSuppression: true
      }
    });

    ContentLogger.info('Microphone obtenu', {
      tracks: mediaStream.getAudioTracks().length,
      trackSettings: mediaStream.getAudioTracks()[0]?.getSettings()
    });

    audioContext = new AudioContext({ sampleRate: 44100 });
    const source = audioContext.createMediaStreamSource(mediaStream);

    // Utiliser ScriptProcessorNode pour capturer les échantillons PCM
    scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    audioChunks = [];
    recordingStartTime = Date.now();

    scriptProcessor.onaudioprocess = (event) => {
      if (isRecording) {
        const inputData = event.inputBuffer.getChannelData(0);
        audioChunks.push(new Float32Array(inputData));
      }
    };

    source.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);

    isRecording = true;

    // Configurer le timeout de sécurité
    recordingTimeout = setTimeout(() => {
      ContentLogger.warn('Timeout enregistrement atteint (5 min), arrêt automatique');
      stopRecording();
    }, MAX_RECORDING_DURATION);

    showRecordingIndicator();
    showNotification('Enregistrement en cours...', 'info');

    // Confirmer au background que l'enregistrement a bien démarré
    try {
      await chrome.runtime.sendMessage({ action: 'recording-started' });
      ContentLogger.info('Enregistrement démarré avec succès');
    } catch (error) {
      ContentLogger.error('Erreur envoi confirmation recording-started', { error: error.message });
      // Continuer quand même car l'enregistrement est démarré
    }

  } catch (error) {
    ContentLogger.error('Erreur démarrage enregistrement', {
      error: error.message,
      name: error.name,
      stack: error.stack
    });

    // Nettoyer en cas d'erreur
    await cleanupRecording();

    // Informer le background de l'erreur
    chrome.runtime.sendMessage({
      action: 'recording-error',
      error: error.message
    });

    showNotification(`Erreur microphone: ${error.message}`, 'error');
    throw error;
  }
}

// Nettoyer les ressources d'enregistrement
async function cleanupRecording() {
  ContentLogger.debug('Nettoyage des ressources d\'enregistrement');

  // Annuler le timeout de sécurité
  if (recordingTimeout) {
    clearTimeout(recordingTimeout);
    recordingTimeout = null;
  }

  // Déconnecter le processeur audio
  if (scriptProcessor) {
    try {
      scriptProcessor.disconnect();
    } catch (e) {
      ContentLogger.debug('scriptProcessor déjà déconnecté');
    }
    scriptProcessor = null;
  }

  // Fermer le contexte audio
  if (audioContext) {
    try {
      if (audioContext.state !== 'closed') {
        await audioContext.close();
      }
    } catch (e) {
      ContentLogger.debug('audioContext déjà fermé');
    }
    audioContext = null;
  }

  // Arrêter les pistes du microphone (IMPORTANT pour l'icône micro)
  if (mediaStream) {
    const tracks = mediaStream.getTracks();
    ContentLogger.debug('Arrêt des pistes média', { tracksCount: tracks.length });

    for (const track of tracks) {
      track.stop();
      ContentLogger.debug('Piste arrêtée', {
        kind: track.kind,
        label: track.label,
        readyState: track.readyState
      });
    }
    mediaStream = null;
  }

  hideRecordingIndicator();
  isRecording = false;
  recordingStartTime = null;

  ContentLogger.info('Ressources nettoyées');
}

// Arrêter l'enregistrement
async function stopRecording() {
  const recordingDuration = recordingStartTime ? Date.now() - recordingStartTime : 0;

  ContentLogger.info('Arrêt enregistrement demandé', {
    isRecording,
    chunksCount: audioChunks.length,
    duration: recordingDuration
  });

  if (!isRecording) {
    ContentLogger.warn('Pas d\'enregistrement en cours');
    // Nettoyer quand même au cas où il y aurait des ressources orphelines
    await cleanupRecording();
    return;
  }

  // Marquer comme arrêté immédiatement pour éviter les doubles arrêts
  isRecording = false;

  // Sauvegarder les chunks avant nettoyage
  const chunksToProcess = audioChunks;

  // Vérifier la durée minimale
  if (recordingDuration < minRecordingDuration) {
    const minSeconds = (minRecordingDuration / 1000).toFixed(1);
    ContentLogger.warn('Enregistrement trop court, ignoré', {
      duration: recordingDuration,
      minRequired: minRecordingDuration
    });
    await cleanupRecording();
    showNotification(`Enregistrement trop court (< ${minSeconds}s), ignoré`, 'info');
    // Informer le background que l'enregistrement est annulé (pas d'audio à traiter)
    chrome.runtime.sendMessage({
      action: 'recording-error',
      error: `Enregistrement trop court (< ${minSeconds} seconde${minSeconds > 1 ? 's' : ''})`
    });
    return;
  }

  showNotification('Conversion en MP3...', 'info');

  // Nettoyer les ressources
  await cleanupRecording();

  // Encoder en MP3
  try {
    ContentLogger.info('Début encodage MP3', {
      chunksCount: chunksToProcess.length,
      recordingDurationMs: recordingDuration
    });

    if (chunksToProcess.length === 0) {
      throw new Error('Aucun audio capturé');
    }

    const mp3Base64 = await encodeToMP3(chunksToProcess);
    ContentLogger.info('MP3 encodé', {
      base64Length: mp3Base64.length,
      estimatedSizeKB: Math.round(mp3Base64.length * 0.75 / 1024)
    });

    if (!mp3Base64 || mp3Base64.length === 0) {
      throw new Error('MP3 vide - aucun audio capturé');
    }

    // Envoyer au background script
    ContentLogger.info('Envoi au background script...');
    chrome.runtime.sendMessage({
      action: 'recording-stopped',
      audioBase64: mp3Base64
    }, (response) => {
      ContentLogger.debug('Réponse du background', { response });
    });

    showNotification('Traitement en cours...', 'info');

  } catch (error) {
    ContentLogger.error('Erreur encodage MP3', {
      error: error.message,
      stack: error.stack
    });

    showNotification(`Erreur encodage: ${error.message}`, 'error');

    // Informer le background de l'erreur
    chrome.runtime.sendMessage({
      action: 'recording-error',
      error: error.message
    });
  }
}

// Encoder les échantillons PCM en MP3 avec lamejs
async function encodeToMP3(chunks) {
  ContentLogger.debug('encodeToMP3 démarré', { chunksCount: chunks.length });

  // Fusionner tous les chunks
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  ContentLogger.debug('Taille totale PCM', {
    totalSamples: totalLength,
    estimatedDurationSec: totalLength / 44100
  });

  const mergedFloat32 = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    mergedFloat32.set(chunk, offset);
    offset += chunk.length;
  }

  // Convertir Float32 [-1, 1] en Int16 [-32768, 32767]
  const samples = new Int16Array(mergedFloat32.length);
  for (let i = 0; i < mergedFloat32.length; i++) {
    const s = Math.max(-1, Math.min(1, mergedFloat32[i]));
    samples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  // Vérifier que lamejs est disponible
  if (typeof lamejs === 'undefined') {
    ContentLogger.error('lamejs non disponible');
    throw new Error('lamejs non chargé - veuillez recharger la page');
  }

  ContentLogger.debug('Encodage MP3 avec lamejs...');

  // Encoder en MP3
  const mp3encoder = new lamejs.Mp3Encoder(1, 44100, 128);
  const mp3Data = [];

  // Encoder par blocs de 1152 échantillons
  const sampleBlockSize = 1152;
  for (let i = 0; i < samples.length; i += sampleBlockSize) {
    const sampleChunk = samples.subarray(i, i + sampleBlockSize);
    const mp3buf = mp3encoder.encodeBuffer(sampleChunk);
    if (mp3buf.length > 0) {
      mp3Data.push(mp3buf);
    }
  }

  // Finaliser
  const mp3End = mp3encoder.flush();
  if (mp3End.length > 0) {
    mp3Data.push(mp3End);
  }

  // Fusionner en un seul Uint8Array
  const totalMp3Length = mp3Data.reduce((acc, buf) => acc + buf.length, 0);
  const mp3Array = new Uint8Array(totalMp3Length);
  let mp3Offset = 0;
  for (const buf of mp3Data) {
    mp3Array.set(buf, mp3Offset);
    mp3Offset += buf.length;
  }

  ContentLogger.debug('MP3 fusionné', { mp3ByteLength: mp3Array.length });

  // Convertir en base64
  let binary = '';
  for (let i = 0; i < mp3Array.length; i++) {
    binary += String.fromCharCode(mp3Array[i]);
  }

  return btoa(binary);
}

// Injecter le texte dans le champ actif
function injectText(text) {
  ContentLogger.info('Injection de texte', { textLength: text.length });

  const activeElement = document.activeElement;

  if (isEditableElement(activeElement)) {
    insertTextAtCursor(activeElement, text);
    showNotification('Texte inséré!', 'success');
    ContentLogger.info('Texte inséré dans élément actif', {
      tagName: activeElement.tagName
    });
  } else {
    const editableField = findFirstEditableField();
    if (editableField) {
      editableField.focus();
      insertTextAtCursor(editableField, text);
      showNotification('Texte inséré!', 'success');
      ContentLogger.info('Texte inséré dans premier champ éditable', {
        tagName: editableField.tagName
      });
    } else {
      navigator.clipboard.writeText(text).then(() => {
        showNotification('Texte copié dans le presse-papier (aucun champ trouvé)', 'info');
        ContentLogger.info('Texte copié dans le presse-papier');
      }).catch((err) => {
        showNotification('Impossible d\'insérer le texte', 'error');
        ContentLogger.error('Erreur copie presse-papier', { error: err.message });
      });
    }
  }
}

// Vérifier si un élément est éditable
function isEditableElement(element) {
  if (!element) return false;

  const tagName = element.tagName.toLowerCase();
  const isInput = tagName === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio'].includes(element.type);
  const isTextarea = tagName === 'textarea';
  const isContentEditable = element.isContentEditable;

  return isInput || isTextarea || isContentEditable;
}

// Trouver le premier champ éditable visible
function findFirstEditableField() {
  const selectors = [
    'textarea:not([disabled]):not([readonly])',
    'input[type="text"]:not([disabled]):not([readonly])',
    'input[type="search"]:not([disabled]):not([readonly])',
    'input:not([type]):not([disabled]):not([readonly])',
    '[contenteditable="true"]'
  ];

  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    for (const element of elements) {
      if (isVisible(element)) {
        return element;
      }
    }
  }

  return null;
}

// Vérifier si un élément est visible
function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);

  return rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== 'hidden' &&
    style.display !== 'none' &&
    style.opacity !== '0';
}

// Insérer du texte à la position du curseur
function insertTextAtCursor(element, text) {
  if (element.isContentEditable) {
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);

    element.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const value = element.value;

    element.value = value.substring(0, start) + text + value.substring(end);
    element.selectionStart = element.selectionEnd = start + text.length;

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// Afficher l'indicateur d'enregistrement
function showRecordingIndicator() {
  if (recordingIndicator) {
    ContentLogger.debug('Indicateur déjà présent');
    return;
  }

  recordingIndicator = document.createElement('div');
  recordingIndicator.id = 'voice-to-text-recording-indicator';
  recordingIndicator.innerHTML = `
    <div style="
      position: fixed;
      top: 20px;
      right: 20px;
      background: #ff0000;
      color: white;
      padding: 10px 20px;
      border-radius: 25px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 500;
      box-shadow: 0 4px 12px rgba(255, 0, 0, 0.4);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 8px;
      animation: pulse 1.5s ease-in-out infinite;
    ">
      <span style="
        width: 12px;
        height: 12px;
        background: white;
        border-radius: 50%;
        animation: blink 1s ease-in-out infinite;
      "></span>
      Enregistrement en cours...
    </div>
    <style>
      @keyframes pulse {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.02); }
      }
      @keyframes blink {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }
    </style>
  `;

  document.body.appendChild(recordingIndicator);
  ContentLogger.debug('Indicateur d\'enregistrement affiché');
}

// Masquer l'indicateur d'enregistrement
function hideRecordingIndicator() {
  if (recordingIndicator) {
    recordingIndicator.remove();
    recordingIndicator = null;
    ContentLogger.debug('Indicateur d\'enregistrement masqué');
  }
}

// Afficher une notification
function showNotification(message, type = 'info') {
  const existing = document.querySelectorAll('.voice-to-text-notification');
  existing.forEach(el => el.remove());

  const colors = {
    info: { bg: '#2196F3', shadow: 'rgba(33, 150, 243, 0.4)' },
    success: { bg: '#4CAF50', shadow: 'rgba(76, 175, 80, 0.4)' },
    error: { bg: '#f44336', shadow: 'rgba(244, 67, 54, 0.4)' }
  };

  const color = colors[type] || colors.info;

  const notification = document.createElement('div');
  notification.className = 'voice-to-text-notification';
  notification.innerHTML = `
    <div style="
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: ${color.bg};
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      box-shadow: 0 4px 12px ${color.shadow};
      z-index: 2147483647;
      animation: slideIn 0.3s ease-out;
    ">
      ${message}
    </div>
    <style>
      @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
    </style>
  `;

  document.body.appendChild(notification);

  setTimeout(() => {
    notification.remove();
  }, 3000);
}

// Nettoyage si la page est fermée pendant l'enregistrement
window.addEventListener('beforeunload', () => {
  if (isRecording) {
    ContentLogger.warn('Page fermée pendant enregistrement, nettoyage...');
    cleanupRecording();
  }
});

// Nettoyage si le content script est déchargé
window.addEventListener('unload', () => {
  if (isRecording) {
    cleanupRecording();
  }
});

// Export pour les tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ContentLogger,
    startRecording,
    stopRecording,
    cleanupRecording,
    encodeToMP3,
    injectText,
    isEditableElement,
    findFirstEditableField
  };
}
