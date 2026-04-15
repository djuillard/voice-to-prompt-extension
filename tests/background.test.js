describe('Background Script - Recording State Management', () => {
  let toggleRecording, processAudio, updateBadge, buildHeaders, testConnection;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.useFakeTimers();

    global.chrome = {
      runtime: {
        sendMessage: jest.fn(() => Promise.resolve({ success: true })),
        onMessage: {
          addListener: jest.fn()
        },
        onInstalled: {
          addListener: jest.fn()
        },
        getURL: jest.fn((path) => `chrome-extension://test-id/${path}`),
        id: 'test-extension-id'
      },
      storage: {
        sync: {
          get: jest.fn(() => Promise.resolve({ webhookUrl: 'https://test-n8n.com/webhook', minDuration: 1 })),
          set: jest.fn(() => Promise.resolve())
        },
        local: {
          get: jest.fn(() => Promise.resolve({})),
          set: jest.fn(() => Promise.resolve())
        }
      },
      tabs: {
        query: jest.fn(() => Promise.resolve([{ id: 1, url: 'https://example.com' }])),
        sendMessage: jest.fn(() => Promise.resolve())
      },
      commands: {
        onCommand: {
          addListener: jest.fn()
        }
      },
      action: {
        setBadgeText: jest.fn(),
        setBadgeBackgroundColor: jest.fn()
      }
    };

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ cleanedText: 'Test response' })
      })
    );

    require('../extension/logger.js');
    const backgroundScript = require('../extension/background.js');

    toggleRecording = backgroundScript.toggleRecording;
    processAudio = backgroundScript.processAudio;
    updateBadge = backgroundScript.updateBadge;
    buildHeaders = backgroundScript.buildHeaders;
    testConnection = backgroundScript.testConnection;
    global._backgroundModule = backgroundScript;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('État d\'enregistrement', () => {
    it('devrait basculer l\'état d\'enregistrement', async () => {
      chrome.tabs.sendMessage.mockResolvedValue({ success: true });

      await toggleRecording();

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ action: 'start-recording' })
      );
    });

    it('devrait afficher une erreur si aucun onglet actif', async () => {
      chrome.tabs.query.mockResolvedValue([]);

      await toggleRecording();

      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('ProcessAudio', () => {
    it('devrait envoyer l\'audio au webhook', async () => {
      const audioBase64 = 'dGVzdC1hdWRpbw==';

      await processAudio(audioBase64, 1);

      expect(fetch).toHaveBeenCalledWith(
        'https://test-n8n.com/webhook',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"audio":"dGVzdC1hdWRpbw=="')
        })
      );
    });

    it('devrait injecter le texte nettoyé dans l\'onglet', async () => {
      const audioBase64 = 'dGVzdC1hdWRpbw==';

      await processAudio(audioBase64, 1);

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, {
        action: 'inject-text',
        text: 'Test response'
      });
    });

    it('devrait gérer l\'erreur si l\'audio est vide', async () => {
      await processAudio('', 1);

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          action: 'show-error',
          message: expect.stringContaining('Audio vide')
        })
      );
    });

    it('devrait gérer l\'erreur si le webhook n\'est pas configuré', async () => {
      chrome.storage.sync.get.mockResolvedValue({ webhookUrl: '' });

      await processAudio('dGVzdA==', 1);

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          action: 'show-error',
          message: expect.stringContaining('URL du webhook')
        })
      );
    });

    it('devrait gérer l\'erreur HTTP du webhook', async () => {
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500
        })
      );

      await processAudio('dGVzdA==', 1);

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          action: 'show-error',
          message: expect.stringContaining('Erreur HTTP')
        })
      );
    });

    it('devrait utiliser le champ cleanedText si disponible', async () => {
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ cleanedText: 'Cleaned response' })
        })
      );

      await processAudio('dGVzdA==', 1);

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, {
        action: 'inject-text',
        text: 'Cleaned response'
      });
    });

    it('devrait utiliser le champ text si cleanedText absent', async () => {
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ text: 'Raw response' })
        })
      );

      await processAudio('dGVzdA==', 1);

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, {
        action: 'inject-text',
        text: 'Raw response'
      });
    });

    it('devrait gérer l\'erreur dans la réponse du webhook', async () => {
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ error: 'Processing error' })
        })
      );

      await processAudio('dGVzdA==', 1);

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          action: 'show-error',
          message: expect.stringContaining('Processing error')
        })
      );
    });

    it('devrait mettre à jour le badge en success', async () => {
      await processAudio('dGVzdC1hdWRpbw==', 1);

      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#00FF00' });
      jest.advanceTimersByTime(2000);
    });

    it('devrait mettre à jour le badge en processing pendant le traitement', async () => {
      const mockFetch = jest.fn()
        .mockImplementationOnce(() => {
          // Vérifier que le badge a été mis à jour en processing avant l'appel fetch
          expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '...' });
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ cleanedText: 'Test' })
          });
        });

      global.fetch = mockFetch;

      await processAudio('dGVzdA==', 1);
    });

    it('devrait mettre à jour le badge en error en cas d\'échec', async () => {
      global.fetch = jest.fn(() =>
        Promise.reject(new Error('Network error'))
      );

      await processAudio('dGVzdA==', 1);

      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '!' });
      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#FF0000' });
      jest.advanceTimersByTime(3000);
    });
  });

  describe('BuildHeaders', () => {
    it('devrait retourner Content-Type par défaut', () => {
      const headers = buildHeaders();

      expect(headers).toEqual({
        'Content-Type': 'application/json'
      });
    });

    it('devrait ajouter Authorization header si username/password fournis', () => {
      const headers = buildHeaders('testuser', 'testpass');

      expect(headers).toHaveProperty('Authorization');
      expect(headers.Authorization).toMatch(/^Basic /);
    });

    it('ne devrait pas ajouter Authorization si username seul', () => {
      const headers = buildHeaders('testuser');

      expect(headers).not.toHaveProperty('Authorization');
    });

    it('ne devrait pas ajouter Authorization si password seul', () => {
      const headers = buildHeaders(null, 'testpass');

      expect(headers).not.toHaveProperty('Authorization');
    });

    it('devrait encoder correctement les credentials', () => {
      const headers = buildHeaders('user', 'pass');

      expect(headers.Authorization).toBe('Basic dXNlcjpwYXNz');
    });
  });

  describe('UpdateBadge', () => {
    it('devrait mettre à jour le badge pour idle', () => {
      updateBadge('idle');

      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#666666' });
    });

    it('devrait mettre à jour le badge pour recording', () => {
      updateBadge('recording');

      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'REC' });
      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#FF0000' });
    });

    it('devrait mettre à jour le badge pour processing', () => {
      updateBadge('processing');

      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '...' });
      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#FFA500' });
    });

    it('devrait mettre à jour le badge pour success', () => {
      updateBadge('success');

      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#00FF00' });
    });

    it('devrait mettre à jour le badge pour error', () => {
      updateBadge('error');

      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '!' });
      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#FF0000' });
    });

    it('devrait utiliser idle par défaut pour status inconnu', () => {
      updateBadge('unknown');

      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#666666' });
    });
  });

  describe('Test Connection', () => {
    it('devrait tester la connexion au webhook avec succès', async () => {
      const result = await testConnection('https://test-n8n.com/webhook', 'user', 'pass');

      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
      expect(result.message).toBe('Connexion réussie!');
    });

    it('devrait gérer l\'erreur 401', async () => {
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: false,
          status: 401
        })
      );

      const result = await testConnection('https://test-n8n.com/webhook', 'user', 'pass');

      expect(result.success).toBe(false);
      expect(result.status).toBe(401);
      expect(result.message).toContain('401');
    });

    it('devrait gérer l\'erreur 403', async () => {
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: false,
          status: 403
        })
      );

      const result = await testConnection('https://test-n8n.com/webhook', 'user', 'pass');

      expect(result.success).toBe(false);
      expect(result.status).toBe(403);
      expect(result.message).toContain('403');
    });

    it('devrait gérer les erreurs de réseau', async () => {
      global.fetch = jest.fn(() =>
        Promise.reject(new Error('Network error'))
      );

      const result = await testConnection('https://test-n8n.com/webhook', 'user', 'pass');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Erreur de connexion');
    });

    it('devrait envoyer un test flag au webhook', async () => {
      await testConnection('https://test-n8n.com/webhook');

      expect(fetch).toHaveBeenCalledWith(
        'https://test-n8n.com/webhook',
        expect.objectContaining({
          body: expect.stringContaining('"test":true')
        })
      );
    });

    it('devrait inclure les headers d\'authentification', async () => {
      await testConnection('https://test-n8n.com/webhook', 'user', 'pass');

      expect(fetch).toHaveBeenCalledWith(
        'https://test-n8n.com/webhook',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': expect.stringMatching(/^Basic /)
          })
        })
      );
    });
  });

  describe('Gestion de la configuration', () => {
    it('devrait utiliser la durée minimum configurée', async () => {
      chrome.storage.sync.get.mockResolvedValue({
        webhookUrl: 'https://test-n8n.com/webhook',
        minDuration: 2
      });

      chrome.tabs.sendMessage.mockResolvedValue({ success: true });

      await toggleRecording();

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          minDuration: 2
        })
      );
    });

    it('devrait utiliser 1 seconde par défaut si non configuré', async () => {
      chrome.storage.sync.get.mockResolvedValue({
        webhookUrl: 'https://test-n8n.com/webhook'
      });

      chrome.tabs.sendMessage.mockResolvedValue({ success: true });

      await toggleRecording();

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          minDuration: 1
        })
      );
    });

    it('devrait vérifier la configuration avant de démarrer', async () => {
      chrome.storage.sync.get.mockResolvedValue({ webhookUrl: '' });

      await toggleRecording();

      expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(
        1,
        expect.objectContaining({ action: 'start-recording' })
      );
    });
  });

  describe('Fiabilité - URLs restreintes', () => {
    it('devrait détecter chrome:// comme restreinte', () => {
      const { isRestrictedUrl } = global._backgroundModule;
      expect(isRestrictedUrl('chrome://extensions')).toBe(true);
    });

    it('devrait détecter chrome-extension:// comme restreinte', () => {
      const { isRestrictedUrl } = global._backgroundModule;
      expect(isRestrictedUrl('chrome-extension://abc/popup.html')).toBe(true);
    });

    it('devrait détecter le Chrome Web Store comme restreinte', () => {
      const { isRestrictedUrl } = global._backgroundModule;
      expect(isRestrictedUrl('https://chrome.google.com/webstore/foo')).toBe(true);
      expect(isRestrictedUrl('https://chromewebstore.google.com/category/xyz')).toBe(true);
    });

    it('devrait considérer about:blank comme restreinte', () => {
      const { isRestrictedUrl } = global._backgroundModule;
      expect(isRestrictedUrl('about:blank')).toBe(true);
    });

    it('devrait accepter une URL https normale', () => {
      const { isRestrictedUrl } = global._backgroundModule;
      expect(isRestrictedUrl('https://example.com/page')).toBe(false);
    });

    it('devrait considérer une URL null comme restreinte', () => {
      const { isRestrictedUrl } = global._backgroundModule;
      expect(isRestrictedUrl(null)).toBe(true);
      expect(isRestrictedUrl(undefined)).toBe(true);
      expect(isRestrictedUrl('')).toBe(true);
    });

    it('devrait refuser d\'enregistrer sur une page restreinte', async () => {
      chrome.tabs.query.mockResolvedValue([{ id: 1, url: 'chrome://extensions' }]);
      chrome.tabs.sendMessage.mockResolvedValue({ success: true });

      await toggleRecording();

      expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(
        1,
        expect.objectContaining({ action: 'start-recording' })
      );
      // Badge en erreur
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '!' });
    });
  });

  describe('Fiabilité - Lock anti-concurrence', () => {
    it('devrait ignorer un second toggleRecording pendant qu\'un premier est en cours', async () => {
      // Simuler un délai dans la réponse de sendMessage
      let resolveFirst;
      chrome.tabs.sendMessage.mockImplementation(() => new Promise((resolve) => {
        resolveFirst = resolve;
      }));

      const p1 = toggleRecording();
      const p2 = toggleRecording(); // Devrait être ignoré (lock actif)

      // Laisser l'event loop avancer
      await Promise.resolve();
      await Promise.resolve();

      // Un seul sendMessage de type start-recording envoyé
      const startCalls = chrome.tabs.sendMessage.mock.calls.filter(
        c => c[1] && c[1].action === 'start-recording'
      );
      expect(startCalls.length).toBe(1);

      resolveFirst({ success: true });
      await p1;
      await p2;
    });
  });

  describe('Fiabilité - processAudio race condition', () => {
    it('devrait utiliser le tabId passé même quand l\'état a été réinitialisé', async () => {
      // Simule le scénario où processAudio est appelé avec un tabId après un reset
      await processAudio('dGVzdA==', 42);

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ action: 'inject-text' })
      );
    });

    it('devrait limiter l\'historique des prompts à 200', async () => {
      const { savePromptToHistory } = global._backgroundModule;
      const existing = Array(200).fill(null).map((_, i) => ({ id: `${i}`, text: `t${i}` }));
      chrome.storage.local.get.mockResolvedValue({ vtt_prompts_history: existing });
      chrome.storage.local.set.mockClear();

      await savePromptToHistory({ text: 'nouveau', tabId: 1, processingTimeMs: 10, audioSizeKB: 1 });

      // Chercher l'appel qui contient vtt_prompts_history
      const historyCall = chrome.storage.local.set.mock.calls.find(
        c => c[0] && c[0].vtt_prompts_history
      );
      expect(historyCall).toBeDefined();
      expect(historyCall[0].vtt_prompts_history.length).toBe(200);
      expect(historyCall[0].vtt_prompts_history[0].text).toBe('nouveau'); // En tête
    });
  });

  describe('Fiabilité - Reset state', () => {
    it('devrait réinitialiser tous les champs d\'état', async () => {
      const { resetState, _state } = global._backgroundModule;

      _state.isRecording = true;
      _state.recordingTabId = 42;
      _state.recordingStartTime = Date.now();
      _state.isToggleProcessing = true;

      await resetState('idle');

      expect(_state.isRecording).toBe(false);
      expect(_state.recordingTabId).toBe(null);
      expect(_state.recordingStartTime).toBe(null);
      expect(_state.isToggleProcessing).toBe(false);
    });
  });

  describe('Message listener - onMessage handlers', () => {
    let messageListener;

    beforeEach(() => {
      messageListener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    });

    it('devrait traiter get-status', () => {
      const sendResponse = jest.fn();
      messageListener({ action: 'get-status' }, { tab: { id: 1 } }, sendResponse);
      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          isRecording: expect.any(Boolean),
          recordingDuration: expect.any(Number)
        })
      );
    });

    it('devrait traiter recording-started', () => {
      const { _state } = global._backgroundModule;
      _state.isRecording = false;
      const sendResponse = jest.fn();

      messageListener({ action: 'recording-started' }, { tab: { id: 42 } }, sendResponse);

      expect(_state.isRecording).toBe(true);
      expect(_state.recordingTabId).toBe(42);
      expect(_state.isToggleProcessing).toBe(false);
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
    });

    it('devrait traiter recording-stopped et lancer processAudio', async () => {
      const { _state } = global._backgroundModule;
      _state.isRecording = true;
      _state.recordingTabId = 42;
      const sendResponse = jest.fn();

      messageListener(
        { action: 'recording-stopped', audioBase64: 'dGVzdA==' },
        { tab: { id: 42 } },
        sendResponse
      );

      expect(_state.isRecording).toBe(false);
      expect(_state.recordingTabId).toBe(null);
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
    });

    it('devrait traiter recording-cancelled sans badge d\'erreur', async () => {
      const { _state } = global._backgroundModule;
      _state.isRecording = true;
      _state.recordingTabId = 42;
      const sendResponse = jest.fn();
      chrome.action.setBadgeText.mockClear();

      messageListener(
        { action: 'recording-cancelled', reason: 'Trop court' },
        { tab: { id: 42 } },
        sendResponse
      );

      // resetState est async, flusher les microtâches
      await Promise.resolve();
      await Promise.resolve();

      expect(_state.isRecording).toBe(false);
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' }); // idle, pas '!'
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
    });

    it('devrait traiter recording-error et afficher badge error', async () => {
      const { _state } = global._backgroundModule;
      _state.isRecording = true;
      _state.recordingTabId = 42;
      const sendResponse = jest.fn();

      messageListener(
        { action: 'recording-error', error: 'Microphone refusé' },
        { tab: { id: 42 } },
        sendResponse
      );

      // resetState est async, flusher les microtâches
      await Promise.resolve();
      await Promise.resolve();

      expect(_state.isRecording).toBe(false);
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '!' });
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
    });

    it('devrait traiter log-entry du content script', () => {
      const sendResponse = jest.fn();
      chrome.storage.local.get.mockResolvedValue({ vtt_logs: [] });

      messageListener(
        {
          action: 'log-entry',
          entry: { level: 'INFO', source: 'Content', message: 'Test', data: null }
        },
        {},
        sendResponse
      );

      expect(sendResponse).toHaveBeenCalledWith({ success: true });
    });

    it('devrait traiter toggle-recording via message', () => {
      chrome.tabs.sendMessage.mockResolvedValue({ success: true });
      const sendResponse = jest.fn();

      messageListener({ action: 'toggle-recording' }, { tab: { id: 1 } }, sendResponse);

      expect(sendResponse).toHaveBeenCalledWith({ success: true });
    });

    it('devrait retourner true pour test-connection (async)', () => {
      const sendResponse = jest.fn();
      const result = messageListener(
        { action: 'test-connection', url: 'https://test.com', username: '', password: '' },
        {},
        sendResponse
      );
      expect(result).toBe(true); // Indique réponse asynchrone
    });

    it('devrait retourner true pour get-logs (async)', () => {
      const sendResponse = jest.fn();
      const result = messageListener({ action: 'get-logs' }, {}, sendResponse);
      expect(result).toBe(true);
    });

    it('devrait retourner true pour clear-logs (async)', () => {
      const sendResponse = jest.fn();
      const result = messageListener({ action: 'clear-logs' }, {}, sendResponse);
      expect(result).toBe(true);
    });

    it('devrait retourner true pour export-logs (async)', () => {
      const sendResponse = jest.fn();
      const result = messageListener({ action: 'export-logs' }, {}, sendResponse);
      expect(result).toBe(true);
    });
  });

  describe('Commands listener', () => {
    it('devrait déclencher toggleRecording sur la commande toggle-recording', () => {
      const commandListener = chrome.commands.onCommand.addListener.mock.calls[0][0];
      chrome.tabs.sendMessage.mockResolvedValue({ success: true });

      // Ne devrait pas throw
      expect(() => commandListener('toggle-recording')).not.toThrow();
    });

    it('devrait ignorer les commandes inconnues', () => {
      const commandListener = chrome.commands.onCommand.addListener.mock.calls[0][0];
      expect(() => commandListener('unknown-command')).not.toThrow();
    });
  });

  describe('onInstalled handler', () => {
    it('devrait appliquer la config par défaut si webhookUrl absent', () => {
      const onInstalledListener = chrome.runtime.onInstalled.addListener.mock.calls[0][0];
      chrome.storage.sync.get.mockImplementationOnce((keys, cb) => {
        cb({});
        return Promise.resolve({});
      });

      onInstalledListener();

      expect(chrome.storage.sync.set).toHaveBeenCalled();
    });
  });
});
