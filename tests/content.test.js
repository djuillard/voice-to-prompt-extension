describe('Content Script - Recording Management', () => {
  let ContentLogger, startRecording, stopRecording, cleanupRecording, encodeToMP3, injectText, isEditableElement;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Setup globals
    global.chrome = {
      runtime: {
        sendMessage: jest.fn(() => Promise.resolve({ success: true })),
        onMessage: {
          addListener: jest.fn()
        }
      },
      tabs: {
        sendMessage: jest.fn(() => Promise.resolve())
      }
    };

    global.AudioContext = jest.fn(() => ({
      createScriptProcessor: jest.fn(() => ({
        onaudioprocess: null,
        connect: jest.fn(),
        disconnect: jest.fn()
      })),
      createMediaStreamSource: jest.fn(),
      destination: {},
      state: 'running',
      close: jest.fn(() => Promise.resolve())
    }));

    global.navigator = {
      mediaDevices: {
        getUserMedia: jest.fn(() => Promise.resolve({
          getAudioTracks: jest.fn(() => [{ stop: jest.fn(), getSettings: jest.fn() }]),
          getTracks: jest.fn(() => [])
        }))
      },
      clipboard: {
        writeText: jest.fn(() => Promise.resolve())
      },
      userAgent: 'Mozilla/5.0 Test'
    };

    global.window = {
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      getComputedStyle: jest.fn(() => ({
        visibility: 'visible',
        display: 'block',
        opacity: '1'
      }))
    };

    global.document = {
      querySelectorAll: jest.fn(() => []),
      querySelector: jest.fn(() => null),
      createElement: jest.fn(() => ({
        appendChild: jest.fn(),
        remove: jest.fn(),
        style: {},
        dispatchEvent: jest.fn()
      })),
      body: {
        appendChild: jest.fn(),
        removeChild: jest.fn()
      },
      activeElement: null,
      addEventListener: jest.fn()
    };

    global.getSelection = jest.fn(() => ({
      getRangeAt: jest.fn(() => ({
        deleteContents: jest.fn(),
        insertNode: jest.fn(),
        collapse: jest.fn()
      })),
      removeAllRanges: jest.fn(),
      addRange: jest.fn()
    }));

    global.lamejs = {
      Mp3Encoder: jest.fn(() => ({
        encodeBuffer: jest.fn(() => new Uint8Array(1024)),
        flush: jest.fn(() => new Uint8Array(512))
      }))
    };

    // Load content script after globals are set
    const contentScript = require('../extension/content.js');
    ContentLogger = contentScript.ContentLogger;
    startRecording = contentScript.startRecording;
    stopRecording = contentScript.stopRecording;
    cleanupRecording = contentScript.cleanupRecording;
    encodeToMP3 = contentScript.encodeToMP3;
    injectText = contentScript.injectText;
    isEditableElement = contentScript.isEditableElement;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Encodage MP3', () => {
    it('devrait encoder les chunks en MP3', async () => {
      const chunks = [
        new Float32Array([0.1, 0.2, 0.3]),
        new Float32Array([0.4, 0.5, 0.6])
      ];

      const mp3Base64 = await encodeToMP3(chunks);

      expect(mp3Base64).toBeDefined();
      expect(typeof mp3Base64).toBe('string');
      expect(mp3Base64.length).toBeGreaterThan(0);
    });

    it('devrait lancer une erreur si lamejs n\'est pas disponible', async () => {
      global.lamejs = undefined;

      const chunks = [new Float32Array([0.1, 0.2])];

      await expect(encodeToMP3(chunks)).rejects.toThrow('lamejs non chargé');
    });
  });

  describe('Vérification des éléments', () => {
    it('devrait identifier un textarea comme éditable', () => {
      const element = { tagName: 'TEXTAREA' };

      expect(isEditableElement(element)).toBe(true);
    });

    it('devrait identifier un input text comme éditable', () => {
      const element = { tagName: 'INPUT', type: 'text' };

      expect(isEditableElement(element)).toBe(true);
    });

    it('devrait identifier un contenteditable comme éditable', () => {
      const element = { tagName: 'DIV', isContentEditable: true };

      expect(isEditableElement(element)).toBe(true);
    });

    it('devrait trouver le premier champ éditable', () => {
      const mockElement = { tagName: 'INPUT', type: 'text', getBoundingClientRect: () => ({ width: 100, height: 20 }) };
      global.window.getComputedStyle = jest.fn(() => ({ visibility: 'visible', display: 'block', opacity: '1' }));

      global.document.querySelectorAll = jest.fn(() => [mockElement]);

      const found = require('../extension/content.js').findFirstEditableField();

      expect(found).toBe(mockElement);
    });
  });
});
