// Voice to Text - Content Script
// Gère l'enregistrement audio et l'injection de texte dans les champs

let mediaRecorder = null;
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

// Démarrer l'enregistrement audio
async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true
      }
    });

    // Utiliser webm avec opus pour une meilleure compatibilité
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    mediaRecorder = new MediaRecorder(stream, {
      mimeType: mimeType,
      audioBitsPerSecond: 128000
    });

    audioChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      // Arrêter les tracks audio
      stream.getTracks().forEach(track => track.stop());

      // Convertir en base64
      const audioBlob = new Blob(audioChunks, { type: mimeType });
      const base64Audio = await blobToBase64(audioBlob);

      // Envoyer au background script
      chrome.runtime.sendMessage({
        action: 'recording-stopped',
        audioBase64: base64Audio
      });

      hideRecordingIndicator();
    };

    mediaRecorder.start(100); // Collecter les données toutes les 100ms
    isRecording = true;
    showRecordingIndicator();
    showNotification('Enregistrement en cours...', 'info');

  } catch (error) {
    console.error('Erreur lors du démarrage de l\'enregistrement:', error);
    showNotification(`Erreur microphone: ${error.message}`, 'error');
  }
}

// Arrêter l'enregistrement
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    isRecording = false;
    showNotification('Traitement en cours...', 'info');
  }
}

// Convertir un Blob en base64
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // Retirer le préfixe "data:audio/webm;base64,"
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
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
