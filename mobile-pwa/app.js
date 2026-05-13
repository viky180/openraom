const STORAGE_KEY = 'graph-notes-mobile-state-v1';
const DB_NAME = 'graph-notes-mobile';
const DB_VERSION = 1;
const STORE_NAME = 'state';

let state = { pages: {}, currentPage: '' };
let saveTimer = null;
let deferredInstallPrompt = null;
let activeActionBlockId = null;

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

function renderInlineMarkdown(escapedLine) {
  let t = escapedLine || '';
  const placeholders = [];
  const keep = (html) => {
    placeholders.push(html);
    return `\u0000${placeholders.length - 1}\u0000`;
  };

  t = t.replace(/\[([^\]]+)\]\(\[\[([^\]]+)\]\]\)/g, (_m, label, pageTitle) => keep(
    `<span class="inline-wiki-link" data-open-page="${pageTitle}">${renderInlineMarkdown(label)}</span>`
  ));
  t = t.replace(/\[\[([^\]]+)\]\]/g, (_m, pageTitle) => keep(
    `<span class="inline-wiki-link" data-open-page="${pageTitle}">[[${renderInlineMarkdown(pageTitle)}]]</span>`
  ));
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i) => placeholders[Number(i)] || '');

  return t;
}

function render() {
  const hasPages = Object.keys(state.pages).length > 0;
  if (!hasPages) closeBlockActionSheet();
  if (activeActionBlockId && hasPages) {
    const page = currentPage();
    if (!page || !findBlock(page.blocks, activeActionBlockId)) closeBlockActionSheet();
  }
  $('emptyState').classList.toggle('hidden', hasPages);
  $('editor').classList.toggle('hidden', !hasPages);
  document.querySelector('.context-panel').classList.toggle('hidden', !hasPages);

  renderPages();
  renderEditor();
  renderBacklinks();
  updateTopbarTitle();
}

function updateTopbarTitle() {
  const titleEl = $('topbarTitle');
  if (!titleEl) return;
  titleEl.textContent = 'Graph Notes';
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
  updateTopbarTitle();
}

function renderBlock(block, depth) {
  const wikiLinkChips = renderWikiLinkChips(block.text, block.id);
  const children = (block.children || []).map((child) => renderBlock(child, depth + 1)).join('');
  return `<article class="block" style="--depth:${depth}" data-block="${escapeHtml(block.id)}">
    <span class="bullet"></span>
    <div class="block-body">
      <button class="block-action-trigger" type="button" data-open-actions="${escapeHtml(block.id)}" aria-label="Block actions">⋯</button>
      <textarea rows="1" data-edit-block="${escapeHtml(block.id)}" aria-label="Block text">${escapeHtml(block.text)}</textarea>
      <div class="block-preview" data-preview-block="${escapeHtml(block.id)}">${renderInlineMarkdown(escapeHtml(block.text))}</div>
      ${wikiLinkChips}
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
    ? refs.map((ref) => `<div class="ref-item"><div class="ref-title">${escapeHtml(ref.title)}</div><div class="ref-text">${renderInlineMarkdown(escapeHtml(ref.text))}</div></div>`).join('')
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

function renderWikiLinkChips(text, blockId) {
  const wikiLinks = extractWikiLinks(text);
  if (!wikiLinks.length) return '';
  const chips = wikiLinks.map((title) => `<button type="button" class="wiki-link-chip" data-open-page="${escapeHtml(title)}">[[${escapeHtml(title)}]]</button>`).join('');
  return `<div class="block-wiki-links" data-wiki-links-for="${escapeHtml(blockId)}">${chips}</div>`;
}

function extractWikiLinks(text) {
  const links = [];
  const seen = new Set();
  const source = String(text || '');

  const pushLink = (rawTitle) => {
    const title = String(rawTitle || '').trim();
    if (!title) return;
    const key = title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    links.push(title);
  };

  source.replace(/\[[^\]]+\]\(\[\[([^\]]+)\]\]\)/g, (_m, pageTitle) => {
    pushLink(pageTitle);
    return _m;
  });
  source.replace(/\[\[([^\]]+)\]\]/g, (_m, pageTitle) => {
    pushLink(pageTitle);
    return _m;
  });

  return links;
}

function refreshBlockWikiLinks(input) {
  const blockBody = input.closest('.block-body');
  if (!blockBody) return;
  const chipsMarkup = renderWikiLinkChips(input.value, input.dataset.editBlock || '');
  let chipsEl = blockBody.querySelector('.block-wiki-links');
  if (!chipsMarkup) {
    chipsEl?.remove();
    return;
  }
  if (!chipsEl) {
    input.insertAdjacentHTML('afterend', chipsMarkup);
    return;
  }
  chipsEl.outerHTML = chipsMarkup;
}

function refreshBlockPreview(input) {
  const blockBody = input.closest('.block-body');
  if (!blockBody) return;
  const previewEl = blockBody.querySelector('.block-preview');
  if (!previewEl) return;
  previewEl.innerHTML = renderInlineMarkdown(escapeHtml(input.value || ''));
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

function isDesktopLayout() {
  return window.matchMedia('(min-width: 860px)').matches;
}

function syncScrimVisibility() {
  const showScrim = $('drawer').classList.contains('open') || $('blockActionSheet').classList.contains('open');
  $('scrim').classList.toggle('hidden', !showScrim);
}

function openDrawer() {
  closeBlockActionSheet();
  $('drawer').classList.add('open');
  syncScrimVisibility();
}

function closeDrawer() {
  $('drawer').classList.remove('open');
  syncScrimVisibility();
}

function openBlockActionSheet(blockId) {
  if (!blockId || isDesktopLayout()) return;
  activeActionBlockId = blockId;
  const sheet = $('blockActionSheet');
  sheet.classList.remove('hidden');
  sheet.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => sheet.classList.add('open'));
  syncScrimVisibility();
}

function closeBlockActionSheet() {
  activeActionBlockId = null;
  const sheet = $('blockActionSheet');
  sheet.classList.remove('open');
  sheet.classList.add('hidden');
  sheet.setAttribute('aria-hidden', 'true');
  syncScrimVisibility();
}

function runBlockAction(action, blockId) {
  if (!blockId) return;
  if (action === 'after') addBlockAfter(blockId);
  if (action === 'child') addChild(blockId);
  if (action === 'delete') deleteBlock(blockId);
  if (action === 'indent') indentBlock(blockId);
  if (action === 'outdent') outdentBlock(blockId);
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
  $('blockActionSheetClose').addEventListener('click', closeBlockActionSheet);
  $('scrim').addEventListener('click', () => {
    closeDrawer();
    closeBlockActionSheet();
  });
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
    refreshBlockPreview(input);
    refreshBlockWikiLinks(input);
    autoResize(input);
    queueSave();
  });

  $('blocks').addEventListener('click', (event) => {
    const pageLink = event.target.closest('[data-open-page]');
    if (pageLink) {
      ensurePage(pageLink.dataset.openPage);
      queueSave();
      render();
      return;
    }
    const openActions = event.target.closest('[data-open-actions]');
    if (openActions) {
      openBlockActionSheet(openActions.dataset.openActions);
      return;
    }
    const action = event.target.closest('button');
    if (!action) return;
    runBlockAction(
      action.dataset.addAfter ? 'after' :
        action.dataset.addChild ? 'child' :
          action.dataset.delete ? 'delete' :
            action.dataset.indent ? 'indent' :
              action.dataset.outdent ? 'outdent' : '',
      action.dataset.addAfter || action.dataset.addChild || action.dataset.delete || action.dataset.indent || action.dataset.outdent || ''
    );
  });

  $('blockActionSheet').addEventListener('click', (event) => {
    const button = event.target.closest('[data-sheet-action]');
    if (!button || !activeActionBlockId) return;
    const action = button.dataset.sheetAction;
    const blockId = activeActionBlockId;
    closeBlockActionSheet();
    runBlockAction(action, blockId);
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

  $('blocks').addEventListener('focusin', (event) => {
    if (!event.target.closest('textarea[data-edit-block]')) return;
    $('blocks').classList.add('is-typing');
    closeBlockActionSheet();
  });

  $('blocks').addEventListener('focusout', () => {
    requestAnimationFrame(() => {
      const active = document.activeElement;
      const stillTyping = Boolean(active && active.matches?.('textarea[data-edit-block]'));
      $('blocks').classList.toggle('is-typing', stillTyping);
    });
  });

  $('addBlockBtn').addEventListener('click', () => {
    const page = currentPage();
    if (!page) return;
    page.blocks.push({ id: uid(), text: '', children: [] });
    queueSave();
    render();
  });

  $('bottomAddBtn').addEventListener('click', () => $('addBlockBtn').click());
  $('contextToggle').addEventListener('click', () => {
    const isCollapsed = $('backlinks').classList.toggle('collapsed');
    $('contextToggle').classList.toggle('open', !isCollapsed);
  });
  $('backlinks').addEventListener('click', (event) => {
    const pageLink = event.target.closest('[data-open-page]');
    if (!pageLink) return;
    ensurePage(pageLink.dataset.openPage);
    queueSave();
    render();
  });

  // Inline new-page bar
  function showNewPageBar() {
    $('newPageBar').classList.remove('hidden');
    $('newPageInput').value = '';
    $('newPageInput').focus();
  }
  function hideNewPageBar() {
    $('newPageBar').classList.add('hidden');
    $('newPageInput').value = '';
  }
  function createNewPage() {
    const title = $('newPageInput').value.trim();
    if (!title) { hideNewPageBar(); return; }
    ensurePage(title);
    queueSave();
    render();
    hideNewPageBar();
    closeDrawer();
  }
  $('newPageBtn').addEventListener('click', showNewPageBar);
  $('newPageConfirm').addEventListener('click', createNewPage);
  $('newPageCancel').addEventListener('click', hideNewPageBar);
  $('newPageInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createNewPage();
    if (e.key === 'Escape') hideNewPageBar();
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
  $('emptyImportBtn')?.addEventListener('click', () => $('importFile').click());
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

// ═══════════════════════════════════════════════════════════
//  GRAPH VIEW  –  force-directed canvas graph with touch/mouse
// ═══════════════════════════════════════════════════════════

const GRAPH = (() => {
  // ---------- physics constants ----------
  const REPULSION   = 4500;
  const SPRING_LEN  = 110;
  const SPRING_K    = 0.04;
  const DAMPING     = 0.88;   // higher = settles faster
  const CENTER_PULL = 0.022;
  const TICK_LIMIT  = 300;   // stop sim after this many ticks with no drag (~5 s @ 60 fps)
  const MIN_SPEED   = 0.25;  // px/frame threshold — raised so sim stops sooner
  const STABLE_TICKS_TO_STOP = 15;

  // ---------- visual constants ----------
  const NODE_R_BASE   = 7;
  const NODE_R_SCALE  = 2.2;   // extra radius per extra link
  const NODE_R_MAX    = 22;
  const LABEL_FONT    = '500 11px "Aptos","Segoe UI",sans-serif';
  const LABEL_FONT_BIG= '700 13px "Aptos","Segoe UI",sans-serif';

  // Theme-aware graph colors — resolved at draw time so they update live
  function graphColors() {
    const isDark = document.documentElement.classList.contains('dark') ||
      (!document.documentElement.classList.contains('light') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    return isDark ? {
      node:    '#b7e6cc',
      current: '#f0c36a',
      orphan:  '#9eb0a8',
      edge:    'rgba(183,230,204,0.18)',
      edgeHi:  'rgba(183,230,204,0.55)',
      glow:    'rgba(183,230,204,0.22)',
      glowCur: 'rgba(240,195,106,0.25)',
      bgLabel: 'rgba(10,13,17,0.82)',
      label:   '#9eb0a8',
      labelBig:'#f1f0e8',
    } : {
      node:    '#2d7a56',
      current: '#b45e10',
      orphan:  '#9ca3af',
      edge:    'rgba(45,122,86,0.20)',
      edgeHi:  'rgba(45,122,86,0.55)',
      glow:    'rgba(45,122,86,0.18)',
      glowCur: 'rgba(180,94,16,0.18)',
      bgLabel: 'rgba(245,245,240,0.88)',
      label:   '#6b7280',
      labelBig:'#1a1a18',
    };
  }

  let canvas, ctx, overlay, tooltip, nodeCountEl;
  let nodes = [], edges = [];
  let width = 0, height = 0;
  let raf = null;
  let tickCount = 0;
  let stableTicks = 0;
  let needsTick = true;

  // camera (pan + zoom)
  let camX = 0, camY = 0, camZ = 1;

  // interaction
  let dragging = null;        // { node, ox, oy }
  let panning  = null;        // { startX, startY, startCamX, startCamY }
  let pinchDist0 = 0, pinchZ0 = 1;
  let hoveredNode = null;
  let tooltipTimer = null;

  // ---------- helpers ----------
  function screenToWorld(sx, sy) {
    return { x: (sx - width / 2 - camX) / camZ, y: (sy - height / 2 - camY) / camZ };
  }

  function worldToScreen(wx, wy) {
    return { x: wx * camZ + width / 2 + camX, y: wy * camZ + height / 2 + camY };
  }

  function nodeRadius(node) {
    const r = NODE_R_BASE + Math.min(node.linkCount * NODE_R_SCALE, NODE_R_MAX - NODE_R_BASE);
    return r;
  }

  function dist(p1, p2) {
    const dx = p1.x - p2.x, dy = p1.y - p2.y;
    return Math.sqrt(dx * dx + dy * dy) || 0.001;
  }

  function fillRoundedRect(x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, radius);
    } else {
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + w - radius, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
      ctx.lineTo(x + w, y + h - radius);
      ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
      ctx.lineTo(x + radius, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
    }
    ctx.fill();
  }

  function hitTest(wx, wy) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (dist({ x: wx, y: wy }, n) <= nodeRadius(n) * 1.4) return n;
    }
    return null;
  }

  // ---------- build graph from state ----------
  function buildGraph() {
    nodes = [];
    edges = [];

    const pageKeys = Object.keys(state.pages);
    if (!pageKeys.length) return;

    // create nodes with random start positions in a circle
    const angle = (2 * Math.PI) / pageKeys.length;
    const initR  = Math.min(width, height) * 0.32;

    const nodeMap = {};
    pageKeys.forEach((title, i) => {
      const node = {
        id: title,
        label: title,
        x: Math.cos(angle * i) * initR,
        y: Math.sin(angle * i) * initR,
        vx: 0, vy: 0,
        linkCount: 0,
        isCurrent: title === state.currentPage
      };
      nodes.push(node);
      nodeMap[title] = node;
    });

    // create edges from [[links]]
    const linkRe = /\[\[([^\]]+)\]\]/g;
    const edgeSet = new Set();

    for (const [title, page] of Object.entries(state.pages)) {
      const collectText = (blocks) => blocks?.forEach(b => {
        const text = b.text || '';
        let m;
        while ((m = linkRe.exec(text)) !== null) {
          const target = m[1];
          if (nodeMap[target] && target !== title) {
            const key = [title, target].sort().join('|||');
            if (!edgeSet.has(key)) {
              edgeSet.add(key);
              edges.push({ source: nodeMap[title], target: nodeMap[target] });
              nodeMap[title].linkCount++;
              nodeMap[target].linkCount++;
            }
          }
        }
        if (b.children?.length) collectText(b.children);
      });
      collectText(page.blocks);
    }

    nodeCountEl.textContent = `${nodes.length} pages · ${edges.length} links`;
    tickCount = 0;
    stableTicks = 0;
    needsTick = true;
  }

  // ---------- physics tick ----------
  function tick() {
    const len = nodes.length;
    if (!len) return;

    // repulsion
    for (let i = 0; i < len; i++) {
      for (let j = i + 1; j < len; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d  = Math.sqrt(dx * dx + dy * dy) || 1;
        const f  = REPULSION / (d * d);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }

    // spring (edges)
    for (const e of edges) {
      const dx = e.target.x - e.source.x;
      const dy = e.target.y - e.source.y;
      const d  = Math.sqrt(dx * dx + dy * dy) || 1;
      const f  = (d - SPRING_LEN) * SPRING_K;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      e.source.vx += fx; e.source.vy += fy;
      e.target.vx -= fx; e.target.vy -= fy;
    }

    // centre pull + dampen + integrate
    let maxSpeed = 0;
    for (const n of nodes) {
      if (n === dragging?.node) continue;
      n.vx = (n.vx - n.x * CENTER_PULL) * DAMPING;
      n.vy = (n.vy - n.y * CENTER_PULL) * DAMPING;
      const speed = Math.hypot(n.vx, n.vy);
      if (speed < MIN_SPEED) {
        n.vx = 0;
        n.vy = 0;
      } else {
        maxSpeed = Math.max(maxSpeed, speed);
      }
      n.x += n.vx;
      n.y += n.vy;
    }

    tickCount++;
    stableTicks = maxSpeed < MIN_SPEED ? stableTicks + 1 : 0;
    if (tickCount > TICK_LIMIT || stableTicks >= STABLE_TICKS_TO_STOP) needsTick = false;
  }

  // ---------- draw ----------
  function draw() {
    const C = graphColors();
    ctx.clearRect(0, 0, width, height);

    ctx.save();
    ctx.translate(width / 2 + camX, height / 2 + camY);
    ctx.scale(camZ, camZ);

    // edges
    const highlightEdges = hoveredNode
      ? new Set(edges.filter(e => e.source === hoveredNode || e.target === hoveredNode))
      : null;

    for (const e of edges) {
      const hi = highlightEdges?.has(e);
      ctx.beginPath();
      ctx.moveTo(e.source.x, e.source.y);
      ctx.lineTo(e.target.x, e.target.y);
      ctx.strokeStyle = hi ? C.edgeHi : C.edge;
      ctx.lineWidth   = hi ? 1.5 : 0.9;
      ctx.stroke();
    }

    // nodes
    for (const n of nodes) {
      const r     = nodeRadius(n);
      const glow  = n.isCurrent ? C.glowCur : (n === hoveredNode ? C.glow : null);
      const color = n.isCurrent ? C.current : (n.linkCount ? C.node : C.orphan);

      // glow ring
      if (glow) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 7, 0, Math.PI * 2);
        ctx.fillStyle = glow;
        ctx.fill();
      }

      // circle
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // label (always shown, bigger when hovered or current)
      const big    = n === hoveredNode || n.isCurrent;
      const font   = big ? LABEL_FONT_BIG : LABEL_FONT;
      ctx.font     = font;
      const tw     = ctx.measureText(n.label).width;
      const lx     = n.x - tw / 2;
      const ly     = n.y + r + 14;

      // label backdrop
      ctx.fillStyle = C.bgLabel;
      fillRoundedRect(lx - 4, ly - 11, tw + 8, 15, 4);

      ctx.fillStyle = big ? C.labelBig : C.label;
      ctx.fillText(n.label, lx, ly);
    }

    ctx.restore();
  }

  // ---------- loop ----------
  function loop() {
    if (needsTick || dragging) tick();
    draw();
    raf = requestAnimationFrame(loop);
  }

  function startLoop() {
    if (!raf) raf = requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
  }

  // ---------- resize ----------
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width || canvas.clientWidth || 1));
    height = Math.max(1, Math.round(rect.height || canvas.clientHeight || 1));
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    needsTick = true;
  }

  // ---------- pointer helpers ----------
  function getPointerCanvas(e) {
    const rect = canvas.getBoundingClientRect();
    const touch = e.touches?.[0] ?? e;
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
  }

  function pointerDown(sx, sy) {
    const wp = screenToWorld(sx, sy);
    const hit = hitTest(wp.x, wp.y);
    if (hit) {
      dragging = { node: hit, ox: hit.x - wp.x, oy: hit.y - wp.y };
      hit.vx = 0; hit.vy = 0;
    } else {
      panning = { startX: sx, startY: sy, startCamX: camX, startCamY: camY };
    }
  }

  function pointerMove(sx, sy, isActualMove) {
    if (dragging) {
      const wp = screenToWorld(sx, sy);
      dragging.node.x = wp.x + dragging.ox;
      dragging.node.y = wp.y + dragging.oy;
      // Only restart physics when the user is actively dragging a node (not on a tap)
      if (isActualMove) {
        tickCount = 0;
        stableTicks = 0;
        needsTick = true;
      }
    } else if (panning) {
      camX = panning.startCamX + (sx - panning.startX);
      camY = panning.startCamY + (sy - panning.startY);
    } else {
      const wp = screenToWorld(sx, sy);
      const hit = hitTest(wp.x, wp.y);
      if (hit !== hoveredNode) {
        hoveredNode = hit;
        clearTimeout(tooltipTimer);
        if (hit) {
          tooltip.textContent = hit.label;
          tooltip.classList.remove('hidden');
        } else {
          tooltip.classList.add('hidden');
        }
      }
    }
  }

  function pointerUp(sx, sy, tapped) {
    if (tapped && dragging) {
      // it was a tap on a node → navigate
      const wp = screenToWorld(sx, sy);
      const hit = hitTest(wp.x, wp.y);
      if (hit) navigateToNode(hit);
    }
    dragging = null;
    panning  = null;
  }

  function navigateToNode(node) {
    closeGraph();
    state.currentPage = node.id;
    queueSave();
    render();
    showToast(`Opened "${node.id}"`);
  }

  // ---------- touch handling ----------
  let tapStart = null;

  function onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 2) {
      // pinch start
      dragging = null;
      panning = null;
      pinchDist0 = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      pinchZ0 = camZ;
      return;
    }
    const { x, y } = getPointerCanvas(e);
    tapStart = { x, y, t: Date.now() };
    pointerDown(x, y);
  }

  function onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 2) {
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      camZ = Math.max(0.25, Math.min(3, pinchZ0 * (d / pinchDist0)));
      return;
    }
    const { x, y } = getPointerCanvas(e);
    pointerMove(x, y, true);
  }

  function onTouchEnd(e) {
    e.preventDefault();
    if (tapStart) {
      const dt = Date.now() - tapStart.t;
      const { x, y } = getPointerCanvas({ touches: e.changedTouches });
      const dx = Math.abs(x - tapStart.x), dy = Math.abs(y - tapStart.y);
      const tapped = dt < 300 && dx < 8 && dy < 8;
      pointerUp(tapStart.x, tapStart.y, tapped);
      tapStart = null;
    } else {
      pointerUp(0, 0, false);
    }
  }

  // ---------- mouse handling ----------
  let mouseDownPos = null;

  function onMouseDown(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    mouseDownPos = { x, y };
    pointerDown(x, y);
  }

  function onMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    // isActualMove=true only when a button is held (real drag), not just hovering
    pointerMove(e.clientX - rect.left, e.clientY - rect.top, e.buttons > 0);
  }

  function onMouseUp(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const tapped = mouseDownPos
      ? Math.hypot(x - mouseDownPos.x, y - mouseDownPos.y) < 5
      : false;
    mouseDownPos = null;
    pointerUp(x, y, tapped);
  }

  function onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    camZ = Math.max(0.25, Math.min(3, camZ * factor));
  }

  // ---------- open / close ----------
  function openGraph() {
    overlay.classList.remove('hidden');
    camX = 0; camY = 0; camZ = 1;
    hoveredNode = null;
    tooltip.classList.add('hidden');
    requestAnimationFrame(() => {
      if (overlay.classList.contains('hidden')) return;
      resize();
      buildGraph();
      tickCount = 0;
      stableTicks = 0;
      needsTick = true;
      startLoop();
    });
    $('bottomGraphBtn').classList.add('active');
  }

  function closeGraph() {
    overlay.classList.add('hidden');
    stopLoop();
    $('bottomGraphBtn').classList.remove('active');
  }

  // ---------- init ----------
  function init() {
    canvas      = $('graphCanvas');
    ctx         = canvas.getContext('2d');
    overlay     = $('graphOverlay');
    tooltip     = $('graphTooltip');
    nodeCountEl = $('graphNodeCount');

    // touch
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove',  onTouchMove,  { passive: false });
    canvas.addEventListener('touchend',   onTouchEnd,   { passive: false });
    canvas.addEventListener('touchcancel',() => { dragging=null; panning=null; tapStart=null; }, { passive: true });

    // mouse
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup',   onMouseUp);
    canvas.addEventListener('mouseleave',() => { hoveredNode=null; tooltip.classList.add('hidden'); });
    canvas.addEventListener('wheel',     onWheel, { passive: false });

    // resize
    window.addEventListener('resize', () => { if (!overlay.classList.contains('hidden')) resize(); });

    // close
    $('graphClose').addEventListener('click', closeGraph);
    $('bottomGraphBtn').addEventListener('click', openGraph);
  }

  return { init, openGraph, closeGraph };
})();

// ═══════════════════════════════════════════════════════════

async function bootstrap() {
  wireEvents();
  GRAPH.init();
  await registerServiceWorker();
  state = await loadStoredState();
  render();
}

bootstrap();
