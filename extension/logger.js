// Voice to Text - Logger Module
// Système de logging pour le diagnostic des bugs

const VTTLogger = {
  // Configuration
  MAX_LOGS: 500,
  STORAGE_KEY: 'vtt_logs',

  // Niveaux de log
  LEVELS: {
    DEBUG: 'DEBUG',
    INFO: 'INFO',
    WARN: 'WARN',
    ERROR: 'ERROR'
  },

  // Créer une entrée de log
  createEntry(level, source, message, data = null) {
    return {
      timestamp: new Date().toISOString(),
      level,
      source,
      message,
      data: data ? JSON.stringify(data, null, 2) : null,
      sessionId: this.getSessionId()
    };
  },

  // Obtenir ou créer un ID de session
  getSessionId() {
    if (!this._sessionId) {
      this._sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    }
    return this._sessionId;
  },

  // Sauvegarder un log
  async log(level, source, message, data = null) {
    const entry = this.createEntry(level, source, message, data);

    // Afficher dans la console avec couleurs
    const colors = {
      DEBUG: '#888',
      INFO: '#2196F3',
      WARN: '#FF9800',
      ERROR: '#F44336'
    };
    console.log(
      `%c[VTT ${level}] %c[${source}] %c${message}`,
      `color: ${colors[level]}; font-weight: bold`,
      'color: #9C27B0',
      'color: inherit',
      data || ''
    );

    // Sauvegarder dans le storage
    try {
      const result = await chrome.storage.local.get([this.STORAGE_KEY]);
      let logs = result[this.STORAGE_KEY] || [];

      logs.push(entry);

      // Limiter le nombre de logs
      if (logs.length > this.MAX_LOGS) {
        logs = logs.slice(-this.MAX_LOGS);
      }

      await chrome.storage.local.set({ [this.STORAGE_KEY]: logs });
    } catch (e) {
      console.error('[VTT Logger] Erreur sauvegarde:', e);
    }

    return entry;
  },

  // Raccourcis pour chaque niveau
  debug(source, message, data = null) {
    return this.log(this.LEVELS.DEBUG, source, message, data);
  },

  info(source, message, data = null) {
    return this.log(this.LEVELS.INFO, source, message, data);
  },

  warn(source, message, data = null) {
    return this.log(this.LEVELS.WARN, source, message, data);
  },

  error(source, message, data = null) {
    return this.log(this.LEVELS.ERROR, source, message, data);
  },

  // Récupérer tous les logs
  async getLogs() {
    try {
      const result = await chrome.storage.local.get([this.STORAGE_KEY]);
      return result[this.STORAGE_KEY] || [];
    } catch (e) {
      console.error('[VTT Logger] Erreur lecture:', e);
      return [];
    }
  },

  // Effacer les logs
  async clearLogs() {
    try {
      await chrome.storage.local.set({ [this.STORAGE_KEY]: [] });
      console.log('[VTT Logger] Logs effacés');
    } catch (e) {
      console.error('[VTT Logger] Erreur effacement:', e);
    }
  },

  // Exporter les logs en texte formaté
  async exportLogs() {
    const logs = await this.getLogs();

    if (logs.length === 0) {
      return '=== Voice to Text - Logs ===\nAucun log enregistré.\n';
    }

    let output = '=== Voice to Text - Logs ===\n';
    output += `Export: ${new Date().toISOString()}\n`;
    output += `Nombre de logs: ${logs.length}\n`;
    output += '='.repeat(50) + '\n\n';

    for (const log of logs) {
      output += `[${log.timestamp}] [${log.level}] [${log.source}] [Session: ${log.sessionId}]\n`;
      output += `  ${log.message}\n`;
      if (log.data) {
        output += `  Data: ${log.data}\n`;
      }
      output += '\n';
    }

    return output;
  },

  // Exporter en JSON
  async exportLogsJSON() {
    const logs = await this.getLogs();
    return JSON.stringify({
      exportDate: new Date().toISOString(),
      logsCount: logs.length,
      logs: logs
    }, null, 2);
  },

  // Logger un événement d'enregistrement avec contexte complet
  logRecordingEvent(source, event, details = {}) {
    return this.info(source, `Recording Event: ${event}`, {
      event,
      ...details,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'N/A'
    });
  },

  // Logger une erreur avec stack trace
  logError(source, error, context = '') {
    return this.error(source, `${context}: ${error.message}`, {
      name: error.name,
      message: error.message,
      stack: error.stack
    });
  }
};

// Export pour les modules ES ou rendre global
if (typeof module !== 'undefined' && module.exports) {
  module.exports = VTTLogger;
}
