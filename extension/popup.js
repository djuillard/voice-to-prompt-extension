// Voice to Text - Popup Script
// Gère l'interface de configuration

document.addEventListener('DOMContentLoaded', () => {
  // Éléments DOM
  const webhookUrlInput = document.getElementById('webhookUrl');
  const authUsernameInput = document.getElementById('authUsername');
  const authPasswordInput = document.getElementById('authPassword');
  const minDurationInput = document.getElementById('minDuration');
  const hotkeyInput = document.getElementById('hotkey');
  const testBtn = document.getElementById('testBtn');
  const testResult = document.getElementById('testResult');
  const saveBtn = document.getElementById('saveBtn');
  const recordBtn = document.getElementById('recordBtn');
  const logsBtn = document.getElementById('logsBtn');
  const statusEl = document.getElementById('status');
  const statusText = statusEl.querySelector('.status-text');

  // Charger la configuration sauvegardée
  loadConfig();

  // Vérifier l'état d'enregistrement
  checkRecordingStatus();

  // Événements
  saveBtn.addEventListener('click', saveConfig);
  testBtn.addEventListener('click', testConnection);
  recordBtn.addEventListener('click', toggleRecording);
  logsBtn.addEventListener('click', openLogs);

  // Charger la configuration depuis le storage
  function loadConfig() {
    chrome.storage.sync.get(['webhookUrl', 'authUsername', 'authPassword', 'minDuration', 'hotkey'], (result) => {
      if (result.webhookUrl) {
        webhookUrlInput.value = result.webhookUrl;
      }
      if (result.authUsername) {
        authUsernameInput.value = result.authUsername;
      }
      if (result.authPassword) {
        authPasswordInput.value = result.authPassword;
      }
      if (result.minDuration !== undefined) {
        minDurationInput.value = result.minDuration;
      }
      if (result.hotkey) {
        hotkeyInput.value = result.hotkey;
      }
    });
  }

  // Sauvegarder la configuration
  function saveConfig() {
    const webhookUrl = webhookUrlInput.value.trim();
    const authUsername = authUsernameInput.value.trim();
    const authPassword = authPasswordInput.value;
    const minDuration = parseFloat(minDurationInput.value) || 1;

    if (!webhookUrl) {
      showTestResult('Veuillez entrer une URL de webhook', false);
      return;
    }

    // Valider l'URL
    try {
      new URL(webhookUrl);
    } catch {
      showTestResult('URL invalide', false);
      return;
    }

    chrome.storage.sync.set({
      webhookUrl: webhookUrl,
      authUsername: authUsername,
      authPassword: authPassword,
      minDuration: minDuration
    }, () => {
      saveBtn.textContent = 'Sauvegardé!';
      saveBtn.classList.add('saved');

      setTimeout(() => {
        saveBtn.textContent = 'Sauvegarder';
        saveBtn.classList.remove('saved');
      }, 2000);
    });
  }

  // Tester la connexion au webhook
  async function testConnection() {
    const webhookUrl = webhookUrlInput.value.trim();
    const authUsername = authUsernameInput.value.trim();
    const authPassword = authPasswordInput.value;

    if (!webhookUrl) {
      showTestResult('Veuillez entrer une URL de webhook', false);
      return;
    }

    testBtn.textContent = 'Test en cours...';
    testBtn.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'test-connection',
        url: webhookUrl,
        username: authUsername,
        password: authPassword
      });

      showTestResult(response.message, response.success);
    } catch (error) {
      showTestResult(`Erreur: ${error.message}`, false);
    } finally {
      testBtn.textContent = 'Tester la connexion';
      testBtn.disabled = false;
    }
  }

  // Afficher le résultat du test
  function showTestResult(message, success) {
    testResult.textContent = message;
    testResult.className = 'test-result ' + (success ? 'success' : 'error');
    testResult.style.display = 'block';

    setTimeout(() => {
      testResult.style.display = 'none';
    }, 5000);
  }

  // Basculer l'enregistrement
  async function toggleRecording() {
    try {
      await chrome.runtime.sendMessage({ action: 'toggle-recording' });
      checkRecordingStatus();
    } catch (error) {
      console.error('Erreur:', error);
    }
  }

  // Vérifier l'état d'enregistrement
  async function checkRecordingStatus() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'get-status' });
      updateUI(response.isRecording);
    } catch (error) {
      console.error('Erreur:', error);
    }
  }

  // Mettre à jour l'interface
  function updateUI(isRecording) {
    if (isRecording) {
      statusEl.className = 'status recording';
      statusText.textContent = 'Enregistrement...';
      recordBtn.classList.add('recording');
      recordBtn.querySelector('.btn-text').textContent = 'Arrêter';
    } else {
      statusEl.className = 'status idle';
      statusText.textContent = 'Prêt';
      recordBtn.classList.remove('recording');
      recordBtn.querySelector('.btn-text').textContent = 'Enregistrer';
    }
  }

  // Ouvrir la page des logs
  function openLogs() {
    chrome.tabs.create({ url: chrome.runtime.getURL('logs.html') });
  }

  // Actualiser le statut périodiquement
  setInterval(checkRecordingStatus, 1000);
});
