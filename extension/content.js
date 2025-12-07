// Voice to Text - Content Script
// Gère l'enregistrement audio et l'injection de texte dans les champs

let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;
let audioChunks = [];
let isRecording = false;
let recordingIndicator = null;

// Écoute des messages du background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'start-recording':
      startRecording();
      sendResponse({ success: true });
      break;
    case 'stop-recording':
      stopRecording();
      sendResponse({ success: true });
      break;
    case 'inject-text':
      injectText(message.text);
      sendResponse({ success: true });
      break;
    case 'show-error':
      showNotification(message.message, 'error');
      sendResponse({ success: true });
      break;
  }
});

// Démarrer l'enregistrement audio (capture PCM pour encodage MP3)
async function startRecording() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 44100,
        echoCancellation: true,
        noiseSuppression: true
      }
    });

    audioContext = new AudioContext({ sampleRate: 44100 });
    const source = audioContext.createMediaStreamSource(mediaStream);

    // Utiliser ScriptProcessorNode pour capturer les échantillons PCM
    scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    audioChunks = [];

    scriptProcessor.onaudioprocess = (event) => {
      if (isRecording) {
        const inputData = event.inputBuffer.getChannelData(0);
        // Copier les données car le buffer est réutilisé
        audioChunks.push(new Float32Array(inputData));
      }
    };

    source.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);

    isRecording = true;
    showRecordingIndicator();
    showNotification('Enregistrement en cours...', 'info');

  } catch (error) {
    console.error('Erreur lors du démarrage de l\'enregistrement:', error);
    showNotification(`Erreur microphone: ${error.message}`, 'error');
  }
}

// Arrêter l'enregistrement
async function stopRecording() {
  if (!isRecording) return;

  isRecording = false;
  showNotification('Conversion en MP3...', 'info');

  // Arrêter les connexions audio
  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor = null;
  }
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  hideRecordingIndicator();

  // Encoder en MP3
  try {
    const mp3Base64 = await encodeToMP3(audioChunks);

    // Envoyer au background script
    chrome.runtime.sendMessage({
      action: 'recording-stopped',
      audioBase64: mp3Base64
    });

    showNotification('Traitement en cours...', 'info');
  } catch (error) {
    console.error('Erreur encodage MP3:', error);
    showNotification(`Erreur encodage: ${error.message}`, 'error');
  }
}

// Encoder les échantillons PCM en MP3 avec lamejs
async function encodeToMP3(audioChunks) {
  return new Promise((resolve, reject) => {
    try {
      // Charger lamejs dynamiquement
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('lame.min.js');
      script.onload = () => {
        try {
          // Fusionner tous les chunks
          const totalLength = audioChunks.reduce((acc, chunk) => acc + chunk.length, 0);
          const mergedFloat32 = new Float32Array(totalLength);
          let offset = 0;
          for (const chunk of audioChunks) {
            mergedFloat32.set(chunk, offset);
            offset += chunk.length;
          }

          // Convertir Float32 [-1, 1] en Int16 [-32768, 32767]
          const samples = new Int16Array(mergedFloat32.length);
          for (let i = 0; i < mergedFloat32.length; i++) {
            const s = Math.max(-1, Math.min(1, mergedFloat32[i]));
            samples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }

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

          // Convertir en base64
          let binary = '';
          for (let i = 0; i < mp3Array.length; i++) {
            binary += String.fromCharCode(mp3Array[i]);
          }
          const base64 = btoa(binary);

          resolve(base64);
        } catch (encodeError) {
          reject(encodeError);
        }
      };
      script.onerror = () => reject(new Error('Impossible de charger lame.min.js'));
      document.head.appendChild(script);
    } catch (error) {
      reject(error);
    }
  });
}

// Injecter le texte dans le champ actif
function injectText(text) {
  const activeElement = document.activeElement;

  // Vérifier si c'est un élément éditable
  if (isEditableElement(activeElement)) {
    insertTextAtCursor(activeElement, text);
    showNotification('Texte inséré!', 'success');
  } else {
    // Chercher le premier champ éditable visible
    const editableField = findFirstEditableField();
    if (editableField) {
      editableField.focus();
      insertTextAtCursor(editableField, text);
      showNotification('Texte inséré!', 'success');
    } else {
      // Copier dans le presse-papier en fallback
      navigator.clipboard.writeText(text).then(() => {
        showNotification('Texte copié dans le presse-papier (aucun champ trouvé)', 'info');
      }).catch(() => {
        showNotification('Impossible d\'insérer le texte', 'error');
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
    // Pour les éléments contenteditable
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);

    // Déclencher un événement input
    element.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    // Pour input et textarea
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const value = element.value;

    element.value = value.substring(0, start) + text + value.substring(end);
    element.selectionStart = element.selectionEnd = start + text.length;

    // Déclencher les événements pour les frameworks JS
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// Afficher l'indicateur d'enregistrement
function showRecordingIndicator() {
  if (recordingIndicator) return;

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
}

// Masquer l'indicateur d'enregistrement
function hideRecordingIndicator() {
  if (recordingIndicator) {
    recordingIndicator.remove();
    recordingIndicator = null;
  }
}

// Afficher une notification
function showNotification(message, type = 'info') {
  // Supprimer les notifications existantes
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

  // Auto-suppression après 3 secondes
  setTimeout(() => {
    notification.remove();
  }, 3000);
}
