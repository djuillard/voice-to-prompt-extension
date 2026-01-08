const VTTLogger = require('../extension/logger.js');

describe('VTTLogger', () => {
  beforeEach(() => {
    chrome.storage.sync.get.mockClear();
    chrome.storage.sync.set.mockClear();
    chrome.storage.local.get.mockClear();
    chrome.storage.local.set.mockClear();
  });

  describe('createEntry', () => {
    it('devrait créer une entrée de log avec tous les champs', () => {
      const entry = VTTLogger.createEntry('INFO', 'TestSource', 'Test message', { key: 'value' });

      expect(entry).toHaveProperty('timestamp');
      expect(entry.level).toBe('INFO');
      expect(entry.source).toBe('TestSource');
      expect(entry.message).toBe('Test message');
      expect(entry.data).toBe(JSON.stringify({ key: 'value' }, null, 2));
      expect(entry).toHaveProperty('sessionId');
    });

    it('devrait créer une entrée sans data', () => {
      const entry = VTTLogger.createEntry('DEBUG', 'Source', 'Message');

      expect(entry.data).toBeNull();
    });
  });

  describe('getSessionId', () => {
    it('devrait créer un ID de session', () => {
      const sessionId = VTTLogger.getSessionId();

      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');
      expect(sessionId.length).toBeGreaterThan(0);
    });

    it('devrait retourner le même ID de session sur plusieurs appels', () => {
      const sessionId1 = VTTLogger.getSessionId();
      const sessionId2 = VTTLogger.getSessionId();

      expect(sessionId1).toBe(sessionId2);
    });
  });

  describe('log', () => {
    beforeEach(() => {
      chrome.storage.local.get.mockResolvedValue({ vtt_logs: [] });
      chrome.storage.local.set.mockResolvedValue();
    });

    it('devrait logger un message de niveau INFO', async () => {
      const entry = await VTTLogger.log(VTTLogger.LEVELS.INFO, 'TestSource', 'Test message');

      expect(entry.level).toBe('INFO');
      expect(entry.source).toBe('TestSource');
      expect(entry.message).toBe('Test message');
      expect(chrome.storage.local.set).toHaveBeenCalled();
    });

    it('devrait logger un message avec des données', async () => {
      const testData = { user: 'test', action: 'click' };
      const entry = await VTTLogger.log(VTTLogger.LEVELS.INFO, 'Source', 'Message', testData);

      expect(entry.data).toBe(JSON.stringify(testData, null, 2));
    });

    it('devrait limiter le nombre de logs à MAX_LOGS', async () => {
      const existingLogs = Array(500).fill(null).map((_, i) => ({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        source: 'Test',
        message: `Log ${i}`,
        data: null,
        sessionId: 'test-session'
      }));

      chrome.storage.local.get.mockResolvedValue({ vtt_logs: existingLogs });

      await VTTLogger.log(VTTLogger.LEVELS.INFO, 'Source', 'New message');

      const setCall = chrome.storage.local.set.mock.calls[0];
      const savedLogs = setCall[0].vtt_logs;

      expect(savedLogs.length).toBe(VTTLogger.MAX_LOGS);
      expect(savedLogs[savedLogs.length - 1].message).toBe('New message');
    });
  });

  describe('Raccourcis de niveau de log', () => {
    beforeEach(() => {
      chrome.storage.local.get.mockResolvedValue({ vtt_logs: [] });
      chrome.storage.local.set.mockResolvedValue();
    });

    it('devrait logger en DEBUG', async () => {
      const entry = await VTTLogger.debug('Source', 'Message');

      expect(entry.level).toBe('DEBUG');
    });

    it('devrait logger en INFO', async () => {
      const entry = await VTTLogger.info('Source', 'Message');

      expect(entry.level).toBe('INFO');
    });

    it('devrait logger en WARN', async () => {
      const entry = await VTTLogger.warn('Source', 'Message');

      expect(entry.level).toBe('WARN');
    });

    it('devrait logger en ERROR', async () => {
      const entry = await VTTLogger.error('Source', 'Message');

      expect(entry.level).toBe('ERROR');
    });
  });

  describe('getLogs', () => {
    it('devrait retourner un tableau vide si aucun log', async () => {
      chrome.storage.local.get.mockResolvedValue({ vtt_logs: [] });

      const logs = await VTTLogger.getLogs();

      expect(logs).toEqual([]);
    });

    it('devrait retourner les logs existants', async () => {
      const testLogs = [
        { timestamp: '2024-01-01', level: 'INFO', source: 'Test', message: 'Test message', data: null, sessionId: 'session1' }
      ];

      chrome.storage.local.get.mockResolvedValue({ vtt_logs: testLogs });

      const logs = await VTTLogger.getLogs();

      expect(logs).toEqual(testLogs);
    });
  });

  describe('clearLogs', () => {
    it('devrait effacer tous les logs', async () => {
      await VTTLogger.clearLogs();

      expect(chrome.storage.local.set).toHaveBeenCalledWith({ vtt_logs: [] });
    });
  });

  describe('exportLogs', () => {
    it('devrait retourner un message si aucun log', async () => {
      chrome.storage.local.get.mockResolvedValue({ vtt_logs: [] });

      const exported = await VTTLogger.exportLogs();

      expect(exported).toContain('Aucun log enregistré');
    });

    it('devrait exporter les logs en format texte', async () => {
      const testLogs = [
        {
          timestamp: '2024-01-01T10:00:00.000Z',
          level: 'INFO',
          source: 'TestSource',
          message: 'Test message',
          data: '{"key":"value"}',
          sessionId: 'session1'
        }
      ];

      chrome.storage.local.get.mockResolvedValue({ vtt_logs: testLogs });

      const exported = await VTTLogger.exportLogs();

      expect(exported).toContain('=== Voice to Text - Logs ===');
      expect(exported).toContain('[2024-01-01T10:00:00.000Z] [INFO] [TestSource]');
      expect(exported).toContain('Test message');
      expect(exported).toContain('Data: {"key":"value"}');
      expect(exported).toContain('Session: session1');
    });
  });

  describe('exportLogsJSON', () => {
    it('devrait exporter en JSON', async () => {
      const testLogs = [
        {
          timestamp: '2024-01-01T10:00:00.000Z',
          level: 'INFO',
          source: 'Test',
          message: 'Message',
          data: null,
          sessionId: 'session1'
        }
      ];

      chrome.storage.local.get.mockResolvedValue({ vtt_logs: testLogs });

      const exported = await VTTLogger.exportLogsJSON();
      const parsed = JSON.parse(exported);

      expect(parsed).toHaveProperty('exportDate');
      expect(parsed).toHaveProperty('logsCount');
      expect(parsed).toHaveProperty('logs');
      expect(parsed.logs).toEqual(testLogs);
    });
  });

  describe('logRecordingEvent', () => {
    it('devrait logger un événement d\'enregistrement', async () => {
      chrome.storage.local.get.mockResolvedValue({ vtt_logs: [] });
      chrome.storage.local.set.mockResolvedValue();

      const entry = await VTTLogger.logRecordingEvent('Background', 'recording-started', { duration: 5000 });

      expect(entry.level).toBe('INFO');
      expect(entry.message).toBe('Recording Event: recording-started');
      expect(entry.data).toContain('recording-started');
      expect(entry.data).toContain('duration');
    });
  });

  describe('logError', () => {
    it('devrait logger une erreur avec stack trace', async () => {
      chrome.storage.local.get.mockResolvedValue({ vtt_logs: [] });
      chrome.storage.local.set.mockResolvedValue();

      const error = new Error('Test error');
      const entry = await VTTLogger.logError('Source', error, 'Context');

      expect(entry.level).toBe('ERROR');
      expect(entry.message).toBe('Context: Test error');
      expect(entry.data).toContain('name');
      expect(entry.data).toContain('message');
      expect(entry.data).toContain('stack');
    });
  });
});
