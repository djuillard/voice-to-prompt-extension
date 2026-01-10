// Voice to Text - Prompts History Script
// Gère l'historique des prompts générés

const PROMPTS_STORAGE_KEY = 'vtt_prompts_history';

// Initialisation
document.addEventListener('DOMContentLoaded', () => {
  loadPrompts();
  setupEventListeners();
});

// Charger et afficher les prompts
async function loadPrompts() {
  const result = await chrome.storage.local.get([PROMPTS_STORAGE_KEY]);
  const prompts = result[PROMPTS_STORAGE_KEY] || [];
  displayPrompts(prompts);
  updateStats(prompts);
}

// Afficher les prompts (tronqués par défaut)
function displayPrompts(prompts, showFullText = false) {
  const container = document.getElementById('promptsContainer');
  container.innerHTML = '';

  if (prompts.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
          <polyline points="10 9 9 9 8 9"></polyline>
        </svg>
        <p>Aucun prompt sauvegardé</p>
      </div>
    `;
    return;
  }

  prompts.forEach(prompt => {
    const date = new Date(prompt.timestamp);
    const isTest = prompt.isTest || false;
    const entry = document.createElement('div');
    entry.className = 'prompt-entry';
    entry.dataset.id = prompt.id;
    entry.innerHTML = `
      <div class="prompt-header">
        <span class="prompt-timestamp">${formatDate(date)}</span>
        ${isTest ? '<span class="test-badge">TEST</span>' : ''}
        <span class="prompt-actions">
          <button class="copy-btn" data-id="${prompt.id}" title="Copier">📋</button>
          <button class="delete-btn" data-id="${prompt.id}" title="Supprimer">🗑️</button>
        </span>
      </div>
      <div class="prompt-content" data-full-text="${escapeHtml(prompt.text)}">
        ${showFullText ? escapeHtml(prompt.text) : truncateText(prompt.text, 200)}
        ${!showFullText && prompt.text.length > 200 ? 
          `<button class="see-more-btn" data-id="${prompt.id}">Voir tout</button>` : ''}
      </div>
      <div class="prompt-meta">
        <span class="meta-item">⏱ ${prompt.processingTimeMs}ms</span>
        <span class="meta-item">📦 ${prompt.audioSizeKB}KB</span>
        <span class="meta-item">📝 ${prompt.length} car.</span>
        ${isTest ? '<span class="meta-item test-indicator">Mode test</span>' : ''}
      </div>
    `;
    container.appendChild(entry);
  });
}

// Basculer affichage complet/réduit
function toggleFullText(id) {
  const entries = document.querySelectorAll('.prompt-entry');
  entries.forEach(entry => {
    if (entry.dataset.id === id) {
      const contentDiv = entry.querySelector('.prompt-content');
      const seeMoreBtn = entry.querySelector('.see-more-btn');
      const isFull = contentDiv.classList.contains('full-text');

      if (isFull) {
        contentDiv.innerHTML = truncateText(contentDiv.dataset.fullText, 200);
        contentDiv.classList.remove('full-text');
        if (seeMoreBtn) {
          seeMoreBtn.textContent = 'Voir tout';
        }
      } else {
        contentDiv.innerHTML = contentDiv.dataset.fullText;
        contentDiv.classList.add('full-text');
        if (seeMoreBtn) {
          seeMoreBtn.textContent = 'Voir moins';
        }
      }
    }
  });
}

// Copier un prompt
async function copyPrompt(id) {
  const result = await chrome.storage.local.get([PROMPTS_STORAGE_KEY]);
  const prompts = result[PROMPTS_STORAGE_KEY] || [];
  const prompt = prompts.find(p => p.id === id);

  if (prompt) {
    try {
      await navigator.clipboard.writeText(prompt.text);
      showNotification('Prompt copié !', 'success');
    } catch (err) {
      showNotification('Erreur lors de la copie', 'error');
      console.error('Erreur copie prompt:', err);
    }
  }
}

// Supprimer un prompt
async function deletePrompt(id) {
  const result = await chrome.storage.local.get([PROMPTS_STORAGE_KEY]);
  const prompts = result[PROMPTS_STORAGE_KEY] || [];
  const filtered = prompts.filter(p => p.id !== id);

  await chrome.storage.local.set({ [PROMPTS_STORAGE_KEY]: filtered });
  loadPrompts();
  showNotification('Prompt supprimé', 'info');
}

// Effacer tout l'historique
async function clearAllPrompts() {
  const confirmed = confirm('Êtes-vous sûr de vouloir effacer tout l\'historique des prompts ?');
  if (confirmed) {
    await chrome.storage.local.set({ [PROMPTS_STORAGE_KEY]: [] });
    loadPrompts();
    showNotification('Historique effacée', 'info');
  }
}

// Exporter en .txt
async function exportToTxt() {
  const result = await chrome.storage.local.get([PROMPTS_STORAGE_KEY]);
  const prompts = result[PROMPTS_STORAGE_KEY] || [];

  if (prompts.length === 0) {
    showNotification('Aucun prompt à exporter', 'error');
    return;
  }

  let content = '=== Historique des Prompts ===\n';
  content += `Export: ${new Date().toLocaleString('fr-FR')}\n`;
  content += `Total: ${prompts.length} prompt${prompts.length > 1 ? 's' : ''}\n`;
  content += '='.repeat(50) + '\n\n';

  prompts.forEach((prompt, index) => {
    const date = new Date(prompt.timestamp);
    const header = `[${index + 1}] ${date.toLocaleString('fr-FR')}`;
    content += header + '\n';
    content += '-'.repeat(header.length) + '\n\n';

    content += `Texte (${prompt.length} caractères):\n`;
    content += prompt.text + '\n\n';

    content += `Métadonnées:\n`;
    content += `  • Date: ${date.toLocaleString('fr-FR')}\n`;
    content += `  • Durée traitement: ${prompt.processingTimeMs}ms\n`;
    content += `  • Taille audio: ${prompt.audioSizeKB}KB\n`;
    if (prompt.isTest) {
      content += `  • Mode: Test\n`;
    }

    content += '\n' + '='.repeat(50) + '\n\n';
  });

  try {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `prompts-historique-${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showNotification('Export réussi !', 'success');
  } catch (err) {
    showNotification('Erreur lors de l\'export', 'error');
    console.error('Erreur export:', err);
  }
}

// Mettre à jour les statistiques
function updateStats(prompts) {
  document.getElementById('totalPrompts').textContent = prompts.length;

  if (prompts.length > 0) {
    const lastPrompt = new Date(prompts[0].timestamp);
    document.getElementById('lastPrompt').textContent = formatDate(lastPrompt);
  } else {
    document.getElementById('lastPrompt').textContent = '-';
  }

  const totalChars = prompts.reduce((sum, prompt) => sum + prompt.length, 0);
  document.getElementById('totalChars').textContent = totalChars;
}

// Formater une date en français
function formatDate(date) {
  const options = {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  };
  return date.toLocaleString('fr-FR', options);
}

// Échapper HTML pour affichage sécurisé
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Tronquer le texte avec "..."
function truncateText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength) + '...';
}

// Filtrer les prompts
function filterPrompts() {
  const searchInput = document.getElementById('searchInput');
  const searchTerm = searchInput.value.toLowerCase().trim();

  chrome.storage.local.get([PROMPTS_STORAGE_KEY]).then(result => {
    const prompts = result[PROMPTS_STORAGE_KEY] || [];

    let filtered = prompts;
    if (searchTerm) {
      filtered = prompts.filter(prompt =>
        prompt.text.toLowerCase().includes(searchTerm) ||
        formatDate(new Date(prompt.timestamp)).toLowerCase().includes(searchTerm)
      );
    }

    displayPrompts(filtered);
  });
}

// Configurer les écouteurs d'événements
function setupEventListeners() {
  // Exporter
  document.getElementById('exportBtn').addEventListener('click', exportToTxt);

  // Effacer tout
  document.getElementById('clearBtn').addEventListener('click', clearAllPrompts);

  // Recherche
  const searchInput = document.getElementById('searchInput');
  searchInput.addEventListener('input', filterPrompts);

  // Délégation d'événements pour les boutons dynamiques
  document.getElementById('promptsContainer').addEventListener('click', (e) => {
    const target = e.target;

    // Bouton copier
    if (target.classList.contains('copy-btn')) {
      const id = target.dataset.id;
      copyPrompt(id);
    }

    // Bouton supprimer
    if (target.classList.contains('delete-btn')) {
      const id = target.dataset.id;
      deletePrompt(id);
    }

    // Bouton voir tout
    if (target.classList.contains('see-more-btn')) {
      const id = target.dataset.id;
      toggleFullText(id);
    }
  });

  // Raccourci clavier pour rechercher
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      filterPrompts();
    }
  });
}
