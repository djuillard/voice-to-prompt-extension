// Voice to Text - Logs Viewer Script

let allLogs = [];
let autoRefreshInterval = null;

// Éléments DOM
const logsContainer = document.getElementById('logsContainer');
const levelFilter = document.getElementById('levelFilter');
const sourceFilter = document.getElementById('sourceFilter');
const searchFilter = document.getElementById('searchFilter');
const autoRefreshCheckbox = document.getElementById('autoRefresh');
const refreshIndicator = document.getElementById('refreshIndicator');
const refreshBtn = document.getElementById('refreshBtn');
const exportBtn = document.getElementById('exportBtn');
const exportJsonBtn = document.getElementById('exportJsonBtn');
const clearBtn = document.getElementById('clearBtn');

// Stats
const totalLogsEl = document.getElementById('totalLogs');
const errorCountEl = document.getElementById('errorCount');
const warnCountEl = document.getElementById('warnCount');
const lastSessionEl = document.getElementById('lastSession');

// Initialisation
document.addEventListener('DOMContentLoaded', () => {
  loadLogs();
  setupEventListeners();
  setupAutoRefresh();
});

function setupEventListeners() {
  refreshBtn.addEventListener('click', loadLogs);
  exportBtn.addEventListener('click', exportLogs);
  exportJsonBtn.addEventListener('click', exportLogsJson);
  clearBtn.addEventListener('click', clearLogs);

  levelFilter.addEventListener('change', renderLogs);
  sourceFilter.addEventListener('change', renderLogs);
  searchFilter.addEventListener('input', renderLogs);

  autoRefreshCheckbox.addEventListener('change', () => {
    if (autoRefreshCheckbox.checked) {
      setupAutoRefresh();
    } else {
      clearInterval(autoRefreshInterval);
      autoRefreshInterval = null;
      refreshIndicator.textContent = '';
    }
  });
}

function setupAutoRefresh() {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
  }

  if (autoRefreshCheckbox.checked) {
    autoRefreshInterval = setInterval(() => {
      loadLogs();
      refreshIndicator.textContent = `Actualisé: ${new Date().toLocaleTimeString()}`;
    }, 5000);
  }
}

async function loadLogs() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'get-logs' });
    allLogs = response.logs || [];
    updateStats();
    renderLogs();
  } catch (error) {
    console.error('Erreur chargement logs:', error);
    logsContainer.innerHTML = `
      <div class="empty-state">
        <p>Erreur de chargement des logs: ${error.message}</p>
      </div>
    `;
  }
}

function updateStats() {
  const errorCount = allLogs.filter(l => l.level === 'ERROR').length;
  const warnCount = allLogs.filter(l => l.level === 'WARN').length;
  const sessions = [...new Set(allLogs.map(l => l.sessionId))];
  const lastSession = sessions[sessions.length - 1] || '-';

  totalLogsEl.textContent = allLogs.length;
  errorCountEl.textContent = errorCount;
  warnCountEl.textContent = warnCount;
  lastSessionEl.textContent = lastSession ? lastSession.substring(0, 8) : '-';
}

function getFilteredLogs() {
  let filtered = [...allLogs];

  // Filtre par niveau
  const level = levelFilter.value;
  if (level) {
    filtered = filtered.filter(l => l.level === level);
  }

  // Filtre par source
  const source = sourceFilter.value;
  if (source) {
    filtered = filtered.filter(l => l.source === source);
  }

  // Filtre par recherche
  const search = searchFilter.value.toLowerCase();
  if (search) {
    filtered = filtered.filter(l =>
      l.message.toLowerCase().includes(search) ||
      (l.data && l.data.toLowerCase().includes(search))
    );
  }

  return filtered;
}

function renderLogs() {
  const filtered = getFilteredLogs();

  if (filtered.length === 0) {
    logsContainer.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
          <polyline points="10 9 9 9 8 9"></polyline>
        </svg>
        <p>${allLogs.length === 0 ? 'Aucun log pour le moment' : 'Aucun log correspondant aux filtres'}</p>
      </div>
    `;
    return;
  }

  // Afficher les logs les plus récents en premier
  const reversedLogs = [...filtered].reverse();

  logsContainer.innerHTML = reversedLogs.map(log => `
    <div class="log-entry">
      <div class="log-header">
        <span class="log-timestamp">${formatTimestamp(log.timestamp)}</span>
        <span class="log-level ${log.level}">${log.level}</span>
        <span class="log-source">[${log.source}]</span>
        <span class="log-session">Session: ${log.sessionId || 'N/A'}</span>
      </div>
      <div class="log-message">${escapeHtml(log.message)}</div>
      ${log.data ? `<div class="log-data">${escapeHtml(log.data)}</div>` : ''}
    </div>
  `).join('');
}

function formatTimestamp(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function exportLogs() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'export-logs' });
    downloadFile(response.text, 'voice-to-text-logs.txt', 'text/plain');
  } catch (error) {
    alert('Erreur export: ' + error.message);
  }
}

async function exportLogsJson() {
  try {
    const data = {
      exportDate: new Date().toISOString(),
      logsCount: allLogs.length,
      logs: allLogs
    };
    downloadFile(JSON.stringify(data, null, 2), 'voice-to-text-logs.json', 'application/json');
  } catch (error) {
    alert('Erreur export: ' + error.message);
  }
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function clearLogs() {
  if (confirm('Voulez-vous vraiment effacer tous les logs ?')) {
    try {
      await chrome.runtime.sendMessage({ action: 'clear-logs' });
      allLogs = [];
      updateStats();
      renderLogs();
    } catch (error) {
      alert('Erreur effacement: ' + error.message);
    }
  }
}
