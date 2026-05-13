const STORAGE_KEY = 'graph-notes-mobile-state-v1';
const DB_NAME = 'graph-notes-mobile';
const DB_VERSION = 1;
const STORE_NAME = 'state';

let state = { pages: {}, currentPage: '' };
let saveTimer = null;
let deferredInstallPrompt = null;

const $ = (id) => document.getElementById(id);

function uid() {
  return 'b_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function ordinalSuffix(day) {
  if (day >= 11 && day <= 13) return 'th';
  if (day % 10 === 1) return 'st';
  if (day % 10 === 2) return 'nd';
  if (day % 10 === 3) return 'rd';
  return 'th';
}

function todayTitle(date = new Date()) {
  const month = date.toLocaleString('en-US', { month: 'long' });
  const day = date.getDate();
  return `${month} ${day}${ordinalSuffix(day)}, ${date.getFullYear()}`;
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function dbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function loadStoredState() {
  try {
    const data = await dbGet(STORAGE_KEY);
    if (data) return sanitizeState(data);
  } catch (err) {
    console.warn('IndexedDB load failed; falling back to localStorage', err);
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeState(JSON.parse(raw)) : { pages: {}, currentPage: '' };
  } catch {
    return { pages: {}, currentPage: '' };
  }
}

async function saveStoredState() {
  const data = sanitizeState(state);
  try {
    await dbSet(STORAGE_KEY, data);
    return;
  } catch (err) {
    console.warn('IndexedDB save failed; falling back to localStorage', err);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

async function clearStoredState() {
  try {
    await dbDelete(STORAGE_KEY);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveStoredState().catch((err) => showToast(`Save failed: ${err.message}`));
  }, 220);
}

function sanitizeText(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeBlock(block) {
  const text = sanitizeText(block?.text ?? block?.string);
  const children = Array.isArray(block?.children) ? block.children.map(normalizeBlock) : [];
  return {
    id: sanitizeText(block?.id ?? block?.uid) || uid(),
    text,
    children
  };
}

function normalizePage(title, page) {
  const cleanTitle = sanitizeText(page?.title || title || 'Untitled').trim() || 'Untitled';
  const sourceBlocks = Array.isArray(page?.blocks) ? page.blocks : page?.children;
  const blocks = Array.isArray(sourceBlocks) ? sourceBlocks.map(normalizeBlock) : [];
  return {
    id: sanitizeText(page?.id ?? page?.uid) || uid(),
    title: cleanTitle,
    blocks: blocks.length ? blocks : [{ id: uid(), text: '', children: [] }],
    tags: Array.isArray(page?.tags) ? [...new Set(page.tags.map((tag) => String(tag).replace(/^#/, '').trim()).filter(Boolean))] : []
  };
}

function sanitizeState(value) {
  const pages = {};
  if (value?.pages && typeof value.pages === 'object') {
    for (const [title, page] of Object.entries(value.pages)) {
      const normalized = normalizePage(title, page);
      pages[normalized.title] = normalized;
    }
  }

  const currentPage = pages[value?.currentPage] ? value.currentPage : Object.keys(pages)[0] || '';
  return { pages, currentPage };
}

function importToState(parsed) {
  if (Array.isArray(parsed)) {
    const pages = {};
    for (const page of parsed) {
      const normalized = normalizePage(page?.title, page);
      pages[normalized.title] = normalized;
    }
    return sanitizeState({ pages, currentPage: Object.keys(pages)[0] || '' });
  }

  if (parsed?.pages && typeof parsed.pages === 'object') {
    return sanitizeState(parsed);
  }

  throw new Error('Unsupported JSON. Import the desktop app export or a Roam JSON export array.');
}

function currentPage() {
  return state.pages[state.currentPage] || null;
}

function ensurePage(title) {
  const clean = String(title || '').trim();
  if (!clean) return null;
  if (!state.pages[clean]) {
    state.pages[clean] = normalizePage(clean, { title: clean, blocks: [{ id: uid(), text: '', children: [] }] });
  }
  state.currentPage = clean;
  return state.pages[clean];
}

function walkBlocks(blocks, visitor, depth = 0, pageTitle = '') {
  for (const block of blocks || []) {
    visitor(block, depth, pageTitle);
    walkBlocks(block.children, visitor, depth + 1, pageTitle);
  }
}

function findBlock(blocks, id, parent = null) {
  for (const block of blocks || []) {
    if (block.id === id) return { block, parent, list: blocks };
    const found = findBlock(block.children, id, block);
    if (found) return found;
  }
  return null;
}

function pageStats(page) {
  let count = 0;
  walkBlocks(page.blocks, () => count += 1);
  const tagText = page.tags?.length ? ` · #${page.tags.join(' #')}` : '';
  return `${count} block${count === 1 ? '' : 's'}${tagText}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render() {
  const hasPages = Object.keys(state.pages).length > 0;
  $('emptyState').classList.toggle('hidden', hasPages);
  $('editor').classList.toggle('hidden', !hasPages);
  document.querySelector('.context-panel').classList.toggle('hidden', !hasPages);

  renderPages();
  renderEditor();
  renderBacklinks();
}

function renderPages() {
  const titles = Object.keys(state.pages).sort((a, b) => a.localeCompare(b));
  $('pagesList').innerHTML = titles.map((title) => {
    const page = state.pages[title];
    return `<button class="page-row ${title === state.currentPage ? 'active' : ''}" type="button" data-page="${escapeHtml(title)}">
      ${escapeHtml(title)}
      <small>${escapeHtml(pageStats(page))}</small>
    </button>`;
  }).join('');
}

function renderEditor() {
  const page = currentPage();
  if (!page) return;

  $('pageTitle').value = page.title;
  $('metaRow').textContent = pageStats(page);
  $('blocks').innerHTML = page.blocks.map((block) => renderBlock(block, 0)).join('');
  document.querySelectorAll('.block textarea').forEach(autoResize);
}

function renderBlock(block, depth) {
  const children = (block.children || []).map((child) => renderBlock(child, depth + 1)).join('');
  return `<article class="block" style="--depth:${depth}" data-block="${escapeHtml(block.id)}">
    <span class="bullet"></span>
    <div class="block-body">
      <textarea rows="1" data-edit-block="${escapeHtml(block.id)}" aria-label="Block text">${escapeHtml(block.text)}</textarea>
      <div class="block-actions">
        <button type="button" data-add-after="${escapeHtml(block.id)}">After</button>
        <button type="button" data-add-child="${escapeHtml(block.id)}">Child</button>
        <button type="button" data-indent="${escapeHtml(block.id)}">Indent</button>
        <button type="button" data-outdent="${escapeHtml(block.id)}">Outdent</button>
        <button class="danger" type="button" data-delete="${escapeHtml(block.id)}">Delete</button>
      </div>
      ${children}
    </div>
  </article>`;
}

function renderBacklinks() {
  const page = currentPage();
  if (!page) return;

  const needle = `[[${page.title}]]`.toLowerCase();
  const refs = [];
  for (const [title, otherPage] of Object.entries(state.pages)) {
    if (title === page.title) continue;
    walkBlocks(otherPage.blocks, (block) => {
      if ((block.text || '').toLowerCase().includes(needle)) {
        refs.push({ title, text: block.text });
      }
    });
  }

  $('backlinks').innerHTML = refs.length
    ? refs.map((ref) => `<div class="ref-item"><div class="ref-title">${escapeHtml(ref.title)}</div><div class="ref-text">${escapeHtml(ref.text)}</div></div>`).join('')
    : '<div class="ref-item"><div class="ref-text">No linked references yet.</div></div>';
}

function renderSearch() {
  const query = $('searchInput').value.trim().toLowerCase();
  if (!query) {
    $('searchResults').innerHTML = '';
    return;
  }

  const results = [];
  for (const [title, page] of Object.entries(state.pages)) {
    if (title.toLowerCase().includes(query)) {
      results.push({ page: title, text: pageStats(page) });
    }
    walkBlocks(page.blocks, (block) => {
      if ((block.text || '').toLowerCase().includes(query)) {
        results.push({ page: title, text: block.text });
      }
    });
  }

  $('searchResults').innerHTML = results.slice(0, 30).map((result) => `
    <button class="search-result" type="button" data-page="${escapeHtml(result.page)}">
      ${escapeHtml(result.page)}
      <small>${escapeHtml(result.text || '')}</small>
    </button>
  `).join('') || '<div class="ref-text">No matches</div>';
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

function addBlockAfter(id) {
  const page = currentPage();
  const found = findBlock(page.blocks, id);
  if (!found) return;
  const index = found.list.findIndex((block) => block.id === id);
  found.list.splice(index + 1, 0, { id: uid(), text: '', children: [] });
  queueSave();
  render();
}

function addChild(id) {
  const page = currentPage();
  const found = findBlock(page.blocks, id);
  if (!found) return;
  found.block.children = found.block.children || [];
  found.block.children.push({ id: uid(), text: '', children: [] });
  queueSave();
  render();
}

function deleteBlock(id) {
  const page = currentPage();
  const found = findBlock(page.blocks, id);
  if (!found) return;
  if (found.list.length === 1 && found.list === page.blocks) {
    found.block.text = '';
    found.block.children = [];
  } else {
    found.list.splice(found.list.findIndex((block) => block.id === id), 1);
  }
  queueSave();
  render();
}

function indentBlock(id) {
  const page = currentPage();
  const found = findBlock(page.blocks, id);
  if (!found) return;
  const index = found.list.findIndex((block) => block.id === id);
  if (index <= 0) return;
  const [block] = found.list.splice(index, 1);
  const previous = found.list[index - 1];
  previous.children = previous.children || [];
  previous.children.push(block);
  queueSave();
  render();
}

function outdentBlock(id) {
  const page = currentPage();
  const found = findBlock(page.blocks, id);
  if (!found || !found.parent) return;
  const parentFound = findBlock(page.blocks, found.parent.id);
  if (!parentFound) return;
  const index = found.list.findIndex((block) => block.id === id);
  const [block] = found.list.splice(index, 1);
  const parentIndex = parentFound.list.findIndex((item) => item.id === found.parent.id);
  parentFound.list.splice(parentIndex + 1, 0, block);
  queueSave();
  render();
}

function showToast(message) {
  $('toast').textContent = message;
  $('toast').classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => $('toast').classList.add('hidden'), 2600);
}

function openDrawer() {
  $('drawer').classList.add('open');
  $('scrim').classList.remove('hidden');
}

function closeDrawer() {
  $('drawer').classList.remove('open');
  $('scrim').classList.add('hidden');
}

async function importFile(file) {
  const parsed = JSON.parse(await file.text());
  state = importToState(parsed);
  await saveStoredState();
  render();
  closeDrawer();
  showToast('Notes imported and saved offline.');
}

function exportJson() {
  const blob = new Blob([JSON.stringify(sanitizeState(state), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `graph-notes-mobile-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function wireEvents() {
  $('navToggle').addEventListener('click', openDrawer);
  $('bottomPagesBtn').addEventListener('click', openDrawer);
  $('drawerClose').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);
  $('searchInput').addEventListener('input', renderSearch);

  $('pagesList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-page]');
    if (!button) return;
    state.currentPage = button.dataset.page;
    queueSave();
    render();
    closeDrawer();
  });

  $('searchResults').addEventListener('click', (event) => {
    const button = event.target.closest('[data-page]');
    if (!button) return;
    state.currentPage = button.dataset.page;
    $('searchInput').value = '';
    renderSearch();
    queueSave();
    render();
    closeDrawer();
  });

  $('pageTitle').addEventListener('change', () => {
    const page = currentPage();
    const nextTitle = $('pageTitle').value.trim();
    if (!page || !nextTitle || nextTitle === page.title) {
      $('pageTitle').value = page?.title || '';
      return;
    }
    if (state.pages[nextTitle]) {
      showToast('A page with that title already exists.');
      $('pageTitle').value = page.title;
      return;
    }
    delete state.pages[page.title];
    page.title = nextTitle;
    state.pages[nextTitle] = page;
    state.currentPage = nextTitle;
    queueSave();
    render();
  });

  $('blocks').addEventListener('input', (event) => {
    const input = event.target.closest('[data-edit-block]');
    if (!input) return;
    const found = findBlock(currentPage().blocks, input.dataset.editBlock);
    if (!found) return;
    found.block.text = input.value;
    autoResize(input);
    queueSave();
  });

  $('blocks').addEventListener('click', (event) => {
    const action = event.target.closest('button');
    if (!action) return;
    if (action.dataset.addAfter) addBlockAfter(action.dataset.addAfter);
    if (action.dataset.addChild) addChild(action.dataset.addChild);
    if (action.dataset.delete) deleteBlock(action.dataset.delete);
    if (action.dataset.indent) indentBlock(action.dataset.indent);
    if (action.dataset.outdent) outdentBlock(action.dataset.outdent);
  });

  $('blocks').addEventListener('keydown', (event) => {
    const input = event.target.closest('[data-edit-block]');
    if (!input) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const currentIndex = [...document.querySelectorAll('textarea[data-edit-block]')].indexOf(input);
      addBlockAfter(input.dataset.editBlock);
      requestAnimationFrame(() => {
        const textareas = document.querySelectorAll('textarea[data-edit-block]');
        textareas[currentIndex + 1]?.focus();
      });
    }
  });

  $('addBlockBtn').addEventListener('click', () => {
    const page = currentPage();
    if (!page) return;
    page.blocks.push({ id: uid(), text: '', children: [] });
    queueSave();
    render();
  });

  $('bottomAddBtn').addEventListener('click', () => $('addBlockBtn').click());
  $('contextToggle').addEventListener('click', () => $('backlinks').classList.toggle('collapsed'));

  $('newPageBtn').addEventListener('click', () => {
    const title = prompt('Page title');
    if (!title) return;
    ensurePage(title);
    queueSave();
    render();
    closeDrawer();
  });

  const openToday = () => {
    ensurePage(todayTitle());
    queueSave();
    render();
    closeDrawer();
  };
  $('todayBtn').addEventListener('click', openToday);
  $('bottomTodayBtn').addEventListener('click', openToday);

  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('emptyImportBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await importFile(file);
    } catch (err) {
      showToast(`Import failed: ${err.message}`);
    } finally {
      event.target.value = '';
    }
  });

  $('exportBtn').addEventListener('click', exportJson);
  $('bottomExportBtn').addEventListener('click', exportJson);
  $('resetBtn').addEventListener('click', async () => {
    if (!confirm('Delete all notes stored in this mobile app?')) return;
    state = { pages: {}, currentPage: '' };
    await clearStoredState();
    render();
    showToast('Mobile notes cleared.');
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $('installBtn').classList.remove('hidden');
  });

  $('installBtn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $('installBtn').classList.add('hidden');
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./service-worker.js');
  } catch (err) {
    console.warn('Service worker registration failed', err);
  }
}

async function bootstrap() {
  wireEvents();
  await registerServiceWorker();
  state = await loadStoredState();
  render();
}

bootstrap();
