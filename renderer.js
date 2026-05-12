const STORAGE_KEY = 'local_roam_style_v1';
    const HAS_DESKTOP_STORAGE = typeof window.storageAPI !== 'undefined';
    const HAS_SERVER_STORAGE = !HAS_DESKTOP_STORAGE && /^https?:$/.test(window.location.protocol);

    function uid() { return 'b_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
    function todayTitle() { return new Date().toISOString().slice(0, 10); }

    function getTimeOfDayLabel(date = new Date()) {
      const hour = date.getHours();
      if (hour >= 5 && hour < 12) return 'morning';
      if (hour >= 12 && hour < 17) return 'afternoon';
      if (hour >= 17 && hour < 21) return 'evening';
      return 'night';
    }

    function dateShortcutText(date = new Date()) {
      return `${date.toISOString().slice(0, 10)} ${getTimeOfDayLabel(date)}`;
    }

    function expandDateShortcut(value, caretPos) {
      const text = typeof value === 'string' ? value : '';
      const caret = Number.isFinite(caretPos) ? caretPos : text.length;
      const replacement = dateShortcutText();
      const rx = /@date\b/gi;

      let changed = false;
      let out = '';
      let last = 0;
      let deltaBeforeCaret = 0;
      let match;

      while ((match = rx.exec(text))) {
        changed = true;
        const start = match.index;
        const end = start + match[0].length;
        out += text.slice(last, start) + replacement;
        if (end <= caret) deltaBeforeCaret += (replacement.length - (end - start));
        last = end;
      }

      if (!changed) return { changed: false, value: text, caret };

      out += text.slice(last);
      return {
        changed: true,
        value: out,
        caret: Math.max(0, caret + deltaBeforeCaret)
      };
    }

    function defaultData() {
      return {
        pages: {
          Home: {
            id: uid(), title: 'Home', blocks: [
              { id: uid(), text: 'Welcome! This is your local-only graph notes desktop app.', children: [] },
              { id: uid(), text: 'Try linking with [[Ideas]] or [[Projects]].', children: [] }
            ]
          },
          Ideas: { id: uid(), title: 'Ideas', blocks: [{ id: uid(), text: 'Capture rough thoughts here.', children: [] }] }
        },
        currentPage: 'Home',
        theme: 'dark'
      };
    }

    function sanitizeLoadedData(parsed) {
      if (!parsed || !parsed.pages || !Object.keys(parsed.pages).length) return defaultData();
      for (const [title, page] of Object.entries(parsed.pages)) {
        ensurePageSchema(page);
        if (!page.title) page.title = title;
      }
      if (!parsed.currentPage || !parsed.pages[parsed.currentPage]) parsed.currentPage = Object.keys(parsed.pages)[0];
      if (parsed.theme !== 'dark' && parsed.theme !== 'light') parsed.theme = 'dark';
      return parsed;
    }

    async function loadStateFromStorage() {
      try {
        if (HAS_DESKTOP_STORAGE) {
          const res = await window.storageAPI.load();
          if (!res?.ok) throw new Error(res?.error || 'desktop load failed');
          return sanitizeLoadedData(res.data);
        }
        if (HAS_SERVER_STORAGE) {
          const res = await fetch('/api/storage/load', { cache: 'no-store' }).then(r => r.json());
          if (!res?.ok) throw new Error(res?.error || 'server load failed');
          return sanitizeLoadedData(res.data);
        }
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? sanitizeLoadedData(JSON.parse(raw)) : defaultData();
      } catch (e) {
        console.error('Failed to load data', e);
        return defaultData();
      }
    }

    let state = defaultData();
    let pendingFocus = null;
    let pendingFocusOffset = null;
    let storageReady = false;
    let zoomedBlockId = null;
    let selectedBlockIds = new Set();
    let lastSelectedBlockId = null;
    let currentTagFilter = null;
    let currentView = 'editor';
    let searchResultsCollapsed = false;
    let pageBackStack = [];
    let uiState = { leftCollapsed: true, rightCollapsed: true };
    let leftSidebarCloseTimer = null;
    const GRAPH_WIDTH = 900;
    const GRAPH_HEIGHT = 560;
    const GRAPH_MIN_ZOOM = 0.5;
    const GRAPH_MAX_ZOOM = 4;
    const GRAPH_ZOOM_STEP = 1.2;
    const GRAPH_TAG_COLORS = ['#5b82c0', '#5aad8f', '#8a75c7', '#c07a50', '#5a9ec0', '#c0987a', '#7ab05a', '#c0607a'];
    let graphViewport = { scale: 1, x: 0, y: 0 };
    let graphPanState = null;
    let graphSuppressClick = false;
    let graphSettings = {
      mode: 'global',
      localDepth: 1,
      search: '',
      tag: '',
      hideOrphans: false,
      showBacklinks: true,
      showOutgoing: true,
      visualStyle: 'current',
      labelMode: 'smart',
      layout: 'force'
    };
    let graphSelectedTitle = null;
    let graphHoverTitle = null;
    let graphPinnedPositions = {};
    let graphNodeDragState = null;
    let graphLastRender = null;

    let activeAutocomplete = null;
    const blockHistory = new Map();
    const MAX_LINK_SUGGESTIONS = 12;
    const auditTrail = [];
    const AUDIT_MAX = 150;
    const AUDIT_CONSOLE = false;
    const AUDIT_AUTOCOMPLETE = false;
    let auditRenderScheduled = false;
    let lastAutocompleteNoneLog = { query: null, ts: 0 };
    let lastAutocompleteShowLog = { key: null, ts: 0 };

    function scheduleAuditRender() {
      if (auditRenderScheduled) return;
      auditRenderScheduled = true;
      requestAnimationFrame(() => {
        auditRenderScheduled = false;
        const el = document.getElementById('auditLog');
        if (!el) return;
        el.innerHTML = auditTrail.map(x => `<div class="audit-item">${escapeHtml(x)}</div>`).join('');
        el.scrollTop = el.scrollHeight;
      });
    }

    function audit(msg, data) {
      const ts = new Date().toISOString().slice(11, 23);
      let line = `[${ts}] ${msg}`;
      if (data !== undefined) {
        try { line += ' ' + (typeof data === 'string' ? data : JSON.stringify(data)); }
        catch { line += ' [unserializable data]'; }
      }
      auditTrail.push(line);
      if (auditTrail.length > AUDIT_MAX) auditTrail.splice(0, auditTrail.length - AUDIT_MAX);
      scheduleAuditRender();
      if (AUDIT_CONSOLE) console.log('[AUDIT]', msg, data ?? '');
    }

    function auditAutocompleteNone(query) {
      if (!AUDIT_AUTOCOMPLETE) return;
      const now = Date.now();
      if (lastAutocompleteNoneLog.query === query && (now - lastAutocompleteNoneLog.ts) < 800) return;
      lastAutocompleteNoneLog = { query, ts: now };
      audit('autocomplete.none', { query });
    }

    function auditAutocompleteShow(blockId, query, count) {
      if (!AUDIT_AUTOCOMPLETE) return;
      const now = Date.now();
      const key = `${blockId || ''}::${query || ''}::${count || 0}`;
      if (lastAutocompleteShowLog.key === key && (now - lastAutocompleteShowLog.ts) < 400) return;
      lastAutocompleteShowLog = { key, ts: now };
      audit('autocomplete.show', { blockId, query, count });
    }

    let dragState = { sourceId: null, overId: null, position: null };

    function viewShowsEditor() {
      return currentView === 'editor' || currentView === 'split';
    }

    function viewShowsGraph() {
      return currentView === 'graph' || currentView === 'split';
    }

    function getGraphViewBox(viewport = graphViewport) {
      return {
        x: viewport.x,
        y: viewport.y,
        width: GRAPH_WIDTH / viewport.scale,
        height: GRAPH_HEIGHT / viewport.scale
      };
    }

    function clampGraphViewport(x, y, scale) {
      const clampedScale = Math.max(GRAPH_MIN_ZOOM, Math.min(GRAPH_MAX_ZOOM, scale));
      const width = GRAPH_WIDTH / clampedScale;
      const height = GRAPH_HEIGHT / clampedScale;
      const nextX = width >= GRAPH_WIDTH
        ? (GRAPH_WIDTH - width) / 2
        : Math.max(0, Math.min(GRAPH_WIDTH - width, x));
      const nextY = height >= GRAPH_HEIGHT
        ? (GRAPH_HEIGHT - height) / 2
        : Math.max(0, Math.min(GRAPH_HEIGHT - height, y));
      return { scale: clampedScale, x: nextX, y: nextY };
    }

    function updateGraphZoomLabel() {
      const label = document.getElementById('graphZoomLevel');
      if (label) label.textContent = `${Math.round(graphViewport.scale * 100)}%`;
    }

    function applyGraphViewport() {
      const svg = document.getElementById('graphSvg');
      if (!svg) return;
      const box = getGraphViewBox();
      svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
      updateGraphZoomLabel();
    }

    function getGraphSvgPoint(svg, event) {
      const ctm = svg.getScreenCTM();
      if (!ctm) {
        const box = getGraphViewBox();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      return point.matrixTransform(ctm.inverse());
    }

    function zoomGraph(factor, anchorPoint) {
      const current = getGraphViewBox();
      const anchor = anchorPoint || {
        x: current.x + current.width / 2,
        y: current.y + current.height / 2
      };
      const ratioX = (anchor.x - current.x) / current.width;
      const ratioY = (anchor.y - current.y) / current.height;
      const nextScale = Math.max(GRAPH_MIN_ZOOM, Math.min(GRAPH_MAX_ZOOM, graphViewport.scale * factor));
      const nextWidth = GRAPH_WIDTH / nextScale;
      const nextHeight = GRAPH_HEIGHT / nextScale;
      graphViewport = clampGraphViewport(
        anchor.x - ratioX * nextWidth,
        anchor.y - ratioY * nextHeight,
        nextScale
      );
      applyGraphViewport();
    }

    function resetGraphZoom() {
      graphViewport = { scale: 1, x: 0, y: 0 };
      applyGraphViewport();
    }

    function panGraph(clientDx, clientDy, startViewport, svg) {
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const box = getGraphViewBox(startViewport);
      graphViewport = clampGraphViewport(
        startViewport.x - clientDx * (box.width / rect.width),
        startViewport.y - clientDy * (box.height / rect.height),
        startViewport.scale
      );
      applyGraphViewport();
    }

    function setupGraphZoomControls() {
      const svg = document.getElementById('graphSvg');
      const zoomInBtn = document.getElementById('graphZoomInBtn');
      const zoomOutBtn = document.getElementById('graphZoomOutBtn');
      const resetBtn = document.getElementById('graphZoomResetBtn');
      if (!svg) return;

      svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        const anchor = getGraphSvgPoint(svg, e);
        zoomGraph(e.deltaY < 0 ? GRAPH_ZOOM_STEP : 1 / GRAPH_ZOOM_STEP, anchor);
      }, { passive: false });

      svg.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        graphPanState = {
          pointerId: e.pointerId,
          startClientX: e.clientX,
          startClientY: e.clientY,
          viewport: { ...graphViewport },
          moved: false
        };
        svg.classList.add('is-panning');
        svg.setPointerCapture?.(e.pointerId);
      });

      svg.addEventListener('pointermove', (e) => {
        if (!graphPanState || graphPanState.pointerId !== e.pointerId) return;
        const dx = e.clientX - graphPanState.startClientX;
        const dy = e.clientY - graphPanState.startClientY;
        if (Math.abs(dx) + Math.abs(dy) > 3) {
          graphPanState.moved = true;
          graphSuppressClick = true;
        }
        panGraph(dx, dy, graphPanState.viewport, svg);
      });

      function endGraphPan(e) {
        if (!graphPanState || graphPanState.pointerId !== e.pointerId) return;
        svg.classList.remove('is-panning');
        svg.releasePointerCapture?.(e.pointerId);
        if (graphPanState.moved) setTimeout(() => { graphSuppressClick = false; }, 0);
        graphPanState = null;
      }

      svg.addEventListener('pointerup', endGraphPan);
      svg.addEventListener('pointercancel', endGraphPan);
      svg.addEventListener('lostpointercapture', () => {
        svg.classList.remove('is-panning');
        graphPanState = null;
      });

      if (zoomInBtn) zoomInBtn.addEventListener('click', () => zoomGraph(GRAPH_ZOOM_STEP));
      if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => zoomGraph(1 / GRAPH_ZOOM_STEP));
      if (resetBtn) resetBtn.addEventListener('click', () => resetGraphZoom());
      updateGraphZoomLabel();
    }

    function setupGraphVisualizationControls() {
      const globalBtn = document.getElementById('graphModeGlobalBtn');
      const localBtn = document.getElementById('graphModeLocalBtn');
      const depth = document.getElementById('graphLocalDepth');
      const search = document.getElementById('graphSearchInput');
      const tag = document.getElementById('graphTagFilter');
      const hideOrphans = document.getElementById('graphHideOrphans');
      const backlinks = document.getElementById('graphShowBacklinks');
      const outgoing = document.getElementById('graphShowOutgoing');
      const style = document.getElementById('graphStyleMode');
      const labels = document.getElementById('graphLabelMode');
      const layout = document.getElementById('graphLayoutMode');
      const fitBtn = document.getElementById('graphFitBtn');
      const fitCurrentBtn = document.getElementById('graphFitCurrentBtn');
      const resetPinsBtn = document.getElementById('graphResetPinsBtn');

      globalBtn?.addEventListener('click', () => {
        graphSettings.mode = 'global';
        renderGraphView();
      });
      localBtn?.addEventListener('click', () => {
        graphSettings.mode = 'local';
        renderGraphView();
      });
      depth?.addEventListener('change', () => {
        graphSettings.localDepth = Number(depth.value) === 2 ? 2 : 1;
        renderGraphView();
      });
      search?.addEventListener('input', () => {
        graphSettings.search = search.value || '';
        renderGraphView();
      });
      tag?.addEventListener('change', () => {
        graphSettings.tag = tag.value || '';
        renderGraphView();
      });
      hideOrphans?.addEventListener('change', () => {
        graphSettings.hideOrphans = hideOrphans.checked;
        renderGraphView();
      });
      backlinks?.addEventListener('change', () => {
        graphSettings.showBacklinks = backlinks.checked;
        renderGraphView();
      });
      outgoing?.addEventListener('change', () => {
        graphSettings.showOutgoing = outgoing.checked;
        renderGraphView();
      });
      style?.addEventListener('change', () => {
        graphSettings.visualStyle = style.value === 'roam-original' ? 'roam-original' : 'current';
        renderGraphView();
      });
      labels?.addEventListener('change', () => {
        graphSettings.labelMode = labels.value || 'smart';
        renderGraphView();
      });
      layout?.addEventListener('change', () => {
        graphSettings.layout = layout.value === 'radial' ? 'radial' : 'force';
        renderGraphView();
      });
      fitBtn?.addEventListener('click', () => fitGraphToVisible());
      fitCurrentBtn?.addEventListener('click', () => centerGraphOnTitle(state.currentPage));
      resetPinsBtn?.addEventListener('click', () => {
        graphPinnedPositions = {};
        renderGraphView();
      });
    }



    function applyTheme(theme) {
      const next = theme === 'light' ? 'light' : 'dark';
      state.theme = next;
      document.body.classList.toggle('theme-light', next === 'light');
    }

    function renderThemeToggle() {
      const btn = document.getElementById('themeToggleBtn');
      if (!btn) return;
      const isLight = state.theme === 'light';
      btn.textContent = isLight ? 'Theme: Day' : 'Theme: Dark';
      btn.title = isLight ? 'Switch to dark mode' : 'Switch to day mode';
    }

    function applySidebarLayout() {
      const appEl = document.querySelector('.app');
      if (!appEl) return;
      appEl.classList.toggle('left-collapsed', !!uiState.leftCollapsed);
      appEl.classList.toggle('right-collapsed', !!uiState.rightCollapsed);

      const leftBtn = document.getElementById('toggleLeftSidebarBtn');
      const rightBtn = document.getElementById('toggleRightSidebarBtn');
      if (leftBtn) leftBtn.textContent = uiState.leftCollapsed ? 'Left: Off' : 'Left: On';
      if (rightBtn) rightBtn.textContent = uiState.rightCollapsed ? 'Right: Off' : 'Right: On';
    }

    function toggleLeftSidebar() {
      uiState.leftCollapsed = !uiState.leftCollapsed;
      applySidebarLayout();
    }

    function openLeftSidebar() {
      if (!uiState.leftCollapsed) return;
      uiState.leftCollapsed = false;
      applySidebarLayout();
    }

    function toggleRightSidebar() {
      uiState.rightCollapsed = !uiState.rightCollapsed;
      applySidebarLayout();
    }

    function closeLeftSidebar() {
      if (uiState.leftCollapsed) return;
      uiState.leftCollapsed = true;
      applySidebarLayout();
    }

    function handleLeftSidebarAutoHover(e) {
      const HOT_CORNER_SIZE = 24;
      const CLOSE_DELAY_MS = 200;
      const inTopLeftCorner = e.clientX <= HOT_CORNER_SIZE && e.clientY <= HOT_CORNER_SIZE;

      if (inTopLeftCorner) {
        if (leftSidebarCloseTimer) {
          clearTimeout(leftSidebarCloseTimer);
          leftSidebarCloseTimer = null;
        }
        openLeftSidebar();
        return;
      }

      if (uiState.leftCollapsed) return;

      const leftPanel = document.querySelector('.app > aside.panel:not(.right)');
      if (!leftPanel) return;
      const rect = leftPanel.getBoundingClientRect();
      const overLeftPanel = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      if (overLeftPanel) {
        if (leftSidebarCloseTimer) {
          clearTimeout(leftSidebarCloseTimer);
          leftSidebarCloseTimer = null;
        }
        return;
      }

      if (!leftSidebarCloseTimer) {
        leftSidebarCloseTimer = setTimeout(() => {
          leftSidebarCloseTimer = null;
          closeLeftSidebar();
        }, CLOSE_DELAY_MS);
      }
    }

    async function toggleTheme() {
      applyTheme(state.theme === 'light' ? 'dark' : 'light');
      renderThemeToggle();
      await saveData();
    }

    const DAILY_TEMPLATE_LINES = [
      '## Daily Plan',
      '- Top 3 priorities:',
      '- Meetings:',
      '## Notes',
      '- ',
      '## Reflection',
      '- Wins:',
      '- Improvements:'
    ];

    const SAVE_DEBOUNCE_MS = 220;
    let saveTimer = null;
    let saveInFlight = false;
    let saveRequestedWhileInFlight = false;

    async function persistNow(options = {}) {
      if (!storageReady) {
        console.warn('Skipped save before storage finished loading');
        return;
      }
      try {
        if (HAS_DESKTOP_STORAGE) {
          const res = await window.storageAPI.save(state, options);
          if (!res?.ok) throw new Error(res?.error || 'desktop save failed');
          return;
        }
        if (HAS_SERVER_STORAGE) {
          const res = await fetch('/api/storage/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: state, options })
          }).then(r => r.json());
          if (!res?.ok) throw new Error(res?.error || 'server save failed');
          return;
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) {
        console.error('Failed to save data', e);
      }
    }

    async function flushSave(options = {}) {
      if (saveInFlight) {
        saveRequestedWhileInFlight = true;
        return;
      }
      saveInFlight = true;
      do {
        saveRequestedWhileInFlight = false;
        await persistNow(options);
      } while (saveRequestedWhileInFlight);
      saveInFlight = false;
    }

    function queueSave() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        flushSave();
      }, SAVE_DEBOUNCE_MS);
    }

    async function saveData(options = {}) {
      await flushSave(options);
    }

    function normalizeTag(tag) {
      const clean = (tag || '').trim().replace(/^#+/, '').toLowerCase();
      return clean.replace(/[^a-z0-9_-]/g, '');
    }

    function extractTags(text) {
      const matches = (text || '').match(/#[a-zA-Z0-9_-]+/g) || [];
      const tags = [...new Set(matches.map(t => normalizeTag(t)).filter(Boolean))];
      return tags;
    }

    function ensurePageSchema(page) {
      if (!page) return;
      if (!Array.isArray(page.blocks)) page.blocks = [];
      if (!Array.isArray(page.tags)) page.tags = [];
      page.tags = [...new Set(page.tags.map(normalizeTag).filter(Boolean))];
      const normalizeBlock = (b) => {
        if (!Array.isArray(b.children)) b.children = [];
        b.collapsed = Boolean(b.collapsed);
        for (const child of b.children) normalizeBlock(child);
      };
      for (const b of page.blocks) normalizeBlock(b);
    }

    function isDailyTitle(title) {
      return /^\d{4}-\d{2}-\d{2}$/.test((title || '').trim());
    }

    function applyDailyTemplateIfNeeded(page, title) {
      if (!isDailyTitle(title)) return;
      if (page.blocks && page.blocks.length && page.blocks.some(b => (b.text || '').trim().length > 0 || (b.children || []).length > 0)) return;
      page.blocks = DAILY_TEMPLATE_LINES.map(line => ({ id: uid(), text: line, children: [] }));
      page.tags = [...new Set([...(page.tags || []), 'daily'])];
    }

    function ensurePage(title) {
      const clean = (title || '').trim();
      if (!clean) return null;
      if (!state.pages[clean]) {
        state.pages[clean] = { id: uid(), title: clean, blocks: [{ id: uid(), text: '', children: [] }], tags: [] };
        applyDailyTemplateIfNeeded(state.pages[clean], clean);
      }
      ensurePageSchema(state.pages[clean]);
      return state.pages[clean];
    }

    function prunePageBackStack() {
      pageBackStack = pageBackStack.filter(title => title && title !== state.currentPage && Boolean(state.pages[title]));
    }

    function renderBackButtonState() {
      const btn = document.getElementById('backPageBtn');
      if (!btn) return;
      prunePageBackStack();
      const previousPage = pageBackStack[pageBackStack.length - 1] || '';
      btn.disabled = !previousPage;
      btn.title = previousPage ? `Go back to ${previousPage}` : 'No previous page';
      btn.setAttribute('aria-label', previousPage ? `Go back to ${previousPage}` : 'No previous page');
    }

    async function goBackPage() {
      prunePageBackStack();
      const previousPage = pageBackStack.pop();
      if (!previousPage) {
        renderBackButtonState();
        return;
      }
      await setCurrentPage(previousPage, { recordHistory: false });
    }

    async function setCurrentPage(title, options = {}) {
      const { recordHistory = true } = options;
      const previousTitle = state.currentPage;
      const page = ensurePage(title);
      if (!page) return;
      if (recordHistory && previousTitle && previousTitle !== page.title && state.pages[previousTitle]) {
        if (pageBackStack[pageBackStack.length - 1] !== previousTitle) pageBackStack.push(previousTitle);
        if (pageBackStack.length > 100) pageBackStack.shift();
      }
      state.currentPage = page.title;
      zoomedBlockId = null;
      selectedBlockIds.clear();
      lastSelectedBlockId = null;
      await saveData();
      applyTheme(state.theme);
      applySidebarLayout();
      render();
    }

    function getCurrentPage() { return state.pages[state.currentPage]; }

    async function deleteCurrentPage() {
      const title = state.currentPage;
      const titles = Object.keys(state.pages);

      if (titles.length <= 1) {
        alert('Cannot delete the last remaining page.');
        return;
      }

      const ok = confirm('Delete page "' + title + '"? This cannot be undone.');
      if (!ok) return;

      delete state.pages[title];
      pageBackStack = pageBackStack.filter(pageTitle => pageTitle !== title);

      const remaining = Object.keys(state.pages).sort((a, b) => a.localeCompare(b));
      state.currentPage = remaining[0] || '';

      if (!state.currentPage) {
        state = defaultData();
      }

      await saveData();
      render();
    }


    function findBlockContext(arr, blockId, parentBlock = null, parentArray = null) {
      for (let i = 0; i < arr.length; i++) {
        const block = arr[i];
        if (block.id === blockId) return { block, index: i, array: arr, parentBlock, parentArray };
        const inChild = findBlockContext(block.children, blockId, block, arr);
        if (inChild) return inChild;
      }
      return null;
    }

    function findBlockPath(arr, blockId, path = []) {
      for (const block of arr || []) {
        const nextPath = [...path, block];
        if (block.id === blockId) return nextPath;
        const childPath = findBlockPath(block.children || [], blockId, nextPath);
        if (childPath) return childPath;
      }
      return null;
    }

    function getZoomRootContext(page = getCurrentPage()) {
      if (!zoomedBlockId) return null;
      const ctx = findBlockContext(page.blocks, zoomedBlockId);
      if (!ctx) {
        zoomedBlockId = null;
        return null;
      }
      return ctx;
    }

    function getVisibleBlockList() {
      const page = getCurrentPage();
      const rootCtx = getZoomRootContext(page);
      const roots = rootCtx ? [rootCtx.block] : (page.blocks || []);
      const out = [];
      const visit = (block, depth = 0) => {
        out.push({ block, depth });
        if (!block.collapsed) {
          for (const child of block.children || []) visit(child, depth + 1);
        }
      };
      for (const block of roots) visit(block, rootCtx ? 0 : 0);
      return out;
    }

    function getPreviousVisibleBlockId(blockId) {
      const blocks = getVisibleBlockList();
      const idx = blocks.findIndex(item => item.block.id === blockId);
      return idx > 0 ? blocks[idx - 1].block.id : null;
    }

    function getNextVisibleBlockId(blockId) {
      const blocks = getVisibleBlockList();
      const idx = blocks.findIndex(item => item.block.id === blockId);
      return idx >= 0 && idx < blocks.length - 1 ? blocks[idx + 1].block.id : null;
    }

    function getVisibleBlockIds() {
      return getVisibleBlockList().map(item => item.block.id);
    }


    function isDescendantBlock(maybeDescendant, maybeAncestor) {
      if (!maybeDescendant || !maybeAncestor) return false;
      if (maybeDescendant.id === maybeAncestor.id) return true;
      for (const child of (maybeAncestor.children || [])) {
        if (isDescendantBlock(maybeDescendant, child)) return true;
      }
      return false;
    }

    async function reorderBlock(sourceId, targetId, position) {
      const page = getCurrentPage();
      const sourceCtx = findBlockContext(page.blocks, sourceId);
      const targetCtx = findBlockContext(page.blocks, targetId);
      if (!sourceCtx || !targetCtx) return;
      if (!position || (position !== 'before' && position !== 'after')) return;
      if (sourceCtx.block.id === targetCtx.block.id) return;
      if (isDescendantBlock(targetCtx.block, sourceCtx.block)) return;

      sourceCtx.array.splice(sourceCtx.index, 1);

      const nextTargetCtx = findBlockContext(page.blocks, targetId);
      if (!nextTargetCtx) {
        sourceCtx.array.splice(sourceCtx.index, 0, sourceCtx.block);
        return;
      }

      const insertIndex = nextTargetCtx.index + (position === 'after' ? 1 : 0);
      nextTargetCtx.array.splice(insertIndex, 0, sourceCtx.block);

      pendingFocus = sourceCtx.block.id;
      await saveData();
      render();
    }

    async function reorderSelectedBlocks(sourceId, targetId, position) {
      const page = getCurrentPage();
      const ids = selectedBlocksInVisibleOrder();
      if (!selectedBlockIds.has(sourceId) || ids.length <= 1 || selectedBlockIds.has(targetId)) {
        await reorderBlock(sourceId, targetId, position);
        return;
      }

      const moving = [];
      for (const id of [...ids].reverse()) {
        const ctx = findBlockContext(page.blocks, id);
        if (!ctx) continue;
        moving.unshift(ctx.block);
        ctx.array.splice(ctx.index, 1);
      }

      const targetCtx = findBlockContext(page.blocks, targetId);
      if (!targetCtx) return;
      const insertIndex = targetCtx.index + (position === 'after' ? 1 : 0);
      targetCtx.array.splice(insertIndex, 0, ...moving);
      pendingFocus = sourceId;
      await saveData();
      render();
    }

    function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.max(36, el.scrollHeight) + 'px'; }

    let heavyRenderTimer = null;
    function scheduleHeavyRenders() {
      if (heavyRenderTimer) clearTimeout(heavyRenderTimer);
      heavyRenderTimer = setTimeout(() => {
        heavyRenderTimer = null;
        renderBacklinks();
        renderSearchResults();
        if (viewShowsGraph()) renderGraphView();
      }, 100);
    }

    function escapeHtml(str) {
      return (str || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function normalizeWikiTitle(title) {
      let clean = (title || '').trim();
      let previous = '';
      while (clean && clean !== previous) {
        previous = clean;
        clean = clean
          .replace(/^\*\*([\s\S]+)\*\*$/, '$1')
          .replace(/^__([\s\S]+)__$/, '$1')
          .trim();
      }
      return clean;
    }

    async function copyText(text) {
      const val = text || '';
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(val);
          return true;
        }
      } catch {}
      try {
        const ta = document.createElement('textarea');
        ta.value = val;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return !!ok;
      } catch {
        return false;
      }
    }

    function findBlockById(blockId) {
      const targetId = (blockId || '').trim();
      if (!targetId) return null;
      for (const [pageTitle, page] of Object.entries(state.pages)) {
        const ctx = findBlockContext(page.blocks, targetId);
        if (ctx?.block) return { pageTitle, block: ctx.block };
      }
      return null;
    }

    function renderInlineMarkdown(escapedLine) {
      let t = escapedLine || '';
      t = t.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+|file:[^\s)]+|data:image\/[^\s)]+)\)/g, '<img class="inline-image" src="$2" alt="$1" />');
      t = t.replace(/\[([^\]]+)\]\(\[\[([^\]]+)\]\]\)/g, (_m, aliasText, pageTitle) => {
        const page = normalizeWikiTitle(pageTitle);
        return '<a data-wiki="' + page + '">' + renderInlineMarkdown(aliasText) + '</a>';
      });
      t = t.replace(/\[\[([^\]]+)\]\]/g, (_m, pageTitle) => {
        const page = normalizeWikiTitle(pageTitle);
        return '<a data-wiki="' + page + '">[[' + renderInlineMarkdown(pageTitle) + ']]</a>';
      });
      t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
      t = t.replace(/~~([^~]+)~~/g, '<s>$1</s>');
      t = t.replace(/\^\^([^^]+)\^\^/g, '<mark>$1</mark>');
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
      t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      return t;
    }

    function renderEditorHiddenInlineMarkdown(escapedLine) {
      let t = escapedLine || '';
      const hiddenToken = (token) => '<span class="md-token md-token-hidden">' + token + '</span>';
      t = t.replace(/`([^`]+)`/g, hiddenToken('`') + '<code>$1</code>' + hiddenToken('`'));
      t = t.replace(/~~([^~]+)~~/g, hiddenToken('~~') + '<s>$1</s>' + hiddenToken('~~'));
      t = t.replace(/\^\^([^^]+)\^\^/g, hiddenToken('^^') + '<mark>$1</mark>' + hiddenToken('^^'));
      t = t.replace(/\*\*([^*]+)\*\*/g, hiddenToken('**') + '<strong>$1</strong>' + hiddenToken('**'));
      t = t.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1' + hiddenToken('*') + '<em>$2</em>' + hiddenToken('*'));
      return t;
    }

    function renderEditorInlineMarkdown(escapedLine) {
      let t = escapedLine || '';
      const tokens = [];
      const keep = (html) => {
        tokens.push(html);
        return '@@EDTK' + (tokens.length - 1) + '@@';
      };
      t = t.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+|file:[^\s)]+|data:image\/[^\s)]+)\)/g, (_m, altText, url) => keep('<span class="md-token">!</span><span class="md-token">[</span><span class="md-alt">' + altText + '</span><span class="md-token">]</span><span class="md-token">(</span><span class="md-url">' + url + '</span><span class="md-token">)</span>'));
      t = t.replace(/\[([^\]]+)\]\(\[\[([^\]]+)\]\]\)/g, (_m, aliasText, pageTitle) => keep('<span class="md-token">[</span><span class="md-alias">' + renderEditorHiddenInlineMarkdown(aliasText) + '</span><span class="md-token">]([[</span><span class="wiki-chip">' + renderEditorHiddenInlineMarkdown(pageTitle) + '</span><span class="md-token">]])</span>'));
      t = t.replace(/\[\[([^\]]+)\]\]/g, (_m, pageTitle) => keep('<span class="wiki-chip">[[' + renderEditorHiddenInlineMarkdown(pageTitle) + ']]</span>'));
      t = t.replace(/\(\(([^)]+)\)\)/g, (_m, blockId) => keep('<span class="block-ref-chip">((' + blockId + '))</span>'));
      t = t.replace(/`([^`]+)`/g, '<span class="md-token">`</span><code>$1</code><span class="md-token">`</span>');
      t = t.replace(/~~([^~]+)~~/g, '<span class="md-token">~~</span><s>$1</s><span class="md-token">~~</span>');
      t = t.replace(/\^\^([^^]+)\^\^/g, '<span class="md-token">^^</span><mark>$1</mark><span class="md-token">^^</span>');
      t = t.replace(/\*\*([^*]+)\*\*/g, '<span class="md-token">**</span><strong>$1</strong><span class="md-token">**</span>');
      t = t.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<span class="md-token">*</span><em>$2</em><span class="md-token">*</span>');
      t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<span class="md-token">[</span><a href="$2" target="_blank" rel="noopener noreferrer">$1</a><span class="md-token">]($2)</span>');
      t = t.replace(/@@EDTK(\d+)@@/g, (_m, i) => tokens[Number(i)] || '');
      return t;
    }

    function renderEditorMarkdown(text) {
      return (text || '').split(/\r?\n/).map(line => renderEditorInlineMarkdown(escapeHtml(line))).join('\n');
    }

    function renderMarkdown(text, options = {}) {
      const raw = text || '';
      const depth = options.depth || 0;
      const visited = options.visited || new Set();
      const tokenRe = /\[([^\]]+)\]\(\[\[([^\]]+)\]\]\)|\[\[([^\]]+)\]\]|\(\(([^)]+)\)\)/g;
      const tokens = [];

      const withPlaceholders = raw.replace(tokenRe, (_m, aliasText, aliasPage, wikiPage, embedId) => {
        if (aliasPage !== undefined) {
          const page = normalizeWikiTitle(aliasPage);
          const label = (aliasText || page).trim();
          tokens.push('<a data-wiki="' + escapeHtml(page) + '">' + renderInlineMarkdown(escapeHtml(label)) + '</a>');
          return '@@TK' + (tokens.length - 1) + '@@';
        }

        if (wikiPage !== undefined) {
          const rawPage = (wikiPage || '').trim();
          const page = normalizeWikiTitle(rawPage);
          const safePage = escapeHtml(page);
          tokens.push('<a data-wiki="' + safePage + '">[[' + renderInlineMarkdown(escapeHtml(rawPage)) + ']]</a>');
          return '@@TK' + (tokens.length - 1) + '@@';
        }

        const blockId = (embedId || '').trim();
        const safeId = escapeHtml(blockId);
        const found = findBlockById(blockId);

        if (!blockId) {
          tokens.push('<span class="muted">(())</span>');
        } else if (!found) {
          tokens.push('<span class="muted">((' + safeId + '))</span>');
        } else if (visited.has(blockId)) {
          tokens.push('<span class="muted">((' + safeId + ')) circular</span>');
        } else if (depth >= 4) {
          tokens.push('<span class="muted">((' + safeId + ')) depth limit</span>');
        } else {
          const nextVisited = new Set(visited);
          nextVisited.add(blockId);
          tokens.push(
            '<div class="ref-item" style="margin:6px 0;">' +
            '<div class="from">embed from <a data-open-page="' + escapeHtml(found.pageTitle) + '">' + escapeHtml(found.pageTitle) + '</a> Â· id: ' + safeId + '</div>' +
            '<div>' + renderMarkdown(found.block.text || '', { depth: depth + 1, visited: nextVisited }) + '</div>' +
            '</div>'
          );
        }

        return '@@TK' + (tokens.length - 1) + '@@';
      });

      const lines = withPlaceholders.split(/\r?\n/);
      let html = '';
      let inUl = false;
      let inOl = false;
      let inCode = false;
      let codeFenceLength = 0;

      const closeLists = () => {
        if (inUl) { html += '</ul>'; inUl = false; }
        if (inOl) { html += '</ol>'; inOl = false; }
      };

      for (let line of lines) {
        const escaped = escapeHtml(line);

        const fenceMatch = escaped.match(/^[ \t]*(`{3,})/);
        if (fenceMatch && (!inCode || fenceMatch[1].length >= codeFenceLength)) {
          closeLists();
          if (!inCode) {
            html += '<pre><code>';
            inCode = true;
            codeFenceLength = fenceMatch[1].length;
          } else {
            html += '</code></pre>';
            inCode = false;
            codeFenceLength = 0;
          }
          continue;
        }

        if (inCode) { html += escaped + '\n'; continue; }
        if (!escaped.trim()) { closeLists(); continue; }

        let m;
        if (escaped.trim() === '---') { closeLists(); html += '<hr>'; continue; }
        if ((m = escaped.match(/^###\s+(.+)$/))) { closeLists(); html += '<h3>' + renderInlineMarkdown(m[1]) + '</h3>'; continue; }
        if ((m = escaped.match(/^##\s+(.+)$/))) { closeLists(); html += '<h2>' + renderInlineMarkdown(m[1]) + '</h2>'; continue; }
        if ((m = escaped.match(/^#\s+(.+)$/))) { closeLists(); html += '<h1>' + renderInlineMarkdown(m[1]) + '</h1>'; continue; }
        if ((m = escaped.match(/^>\s?(.+)$/))) { closeLists(); html += '<blockquote>' + renderInlineMarkdown(m[1]) + '</blockquote>'; continue; }
        if ((m = escaped.match(/^\{\{\[\[(TODO|DONE)\]\]\}\}\s*(.*)$/i))) { closeLists(); const checked = m[1].toUpperCase() === 'DONE'; html += '<label class="task-label"><input type="checkbox" data-task-toggle="roam" ' + (checked ? 'checked' : '') + ' /> <span>' + renderInlineMarkdown(m[2] || '') + '</span></label>'; continue; }
        if ((m = escaped.match(/^[-*]\s+\[([ xX])\]\s*(.*)$/))) { if (!inUl) { closeLists(); html += '<ul class="task-list">'; inUl = true; } const checked = m[1].toLowerCase() === 'x'; html += '<li class="task-list-item"><label class="task-label"><input type="checkbox" data-task-toggle="gfm" ' + (checked ? 'checked' : '') + ' /> <span>' + renderInlineMarkdown(m[2] || '') + '</span></label></li>'; continue; }
        if ((m = escaped.match(/^[-*]\s+(.+)$/))) { if (!inUl) { closeLists(); html += '<ul>'; inUl = true; } html += '<li>' + renderInlineMarkdown(m[1]) + '</li>'; continue; }
        if ((m = escaped.match(/^\d+[.)]\s+(.+)$/))) { if (!inOl) { closeLists(); html += '<ol>'; inOl = true; } html += '<li>' + renderInlineMarkdown(m[1]) + '</li>'; continue; }

        closeLists();
        html += '<p>' + renderInlineMarkdown(escaped) + '</p>';
      }

      if (inCode) html += '</code></pre>';
      closeLists();
      html = html.replace(/@@TK(\d+)@@/g, (_m, i) => tokens[Number(i)] || '');
      return html;
    }

    function renderRichText(text, options = {}) { return renderMarkdown(text, options); }

    window.addEventListener('error', (e) => {
      audit('window.error', { message: e.message, file: e.filename, line: e.lineno, col: e.colno });
    });

    window.addEventListener('unhandledrejection', (e) => {
      audit('unhandledrejection', { reason: String(e.reason || 'unknown') });
    });

    window.addEventListener('beforeunload', () => {
      if (storageReady) saveData();
    });

    function getPageOutgoingLinks(page) {
      const links = [];
      if (!page) return links;
      walkBlocks(page.blocks || [], (block) => {
        const matches = [...(block.text || '').matchAll(/\[\[([^\]]+)\]\]/g)]
          .map(m => normalizeWikiTitle(m[1]))
          .filter(Boolean);
        links.push(...matches);
      });
      return [...new Set(links)];
    }

    function buildGraphModel() {
      const nodeSet = new Set(Object.keys(state.pages));
      const edgeKeys = new Set();
      const edges = [];
      const outgoing = new Map();
      const incoming = new Map();

      for (const [fromTitle, page] of Object.entries(state.pages)) {
        ensurePageSchema(page);
        const links = getPageOutgoingLinks(page);
        outgoing.set(fromTitle, new Set(links));
        for (const toTitle of links) {
          nodeSet.add(toTitle);
          const key = `${fromTitle}\u0000${toTitle}`;
          if (!edgeKeys.has(key)) {
            edgeKeys.add(key);
            edges.push({ from: fromTitle, to: toTitle });
          }
          if (!incoming.has(toTitle)) incoming.set(toTitle, new Set());
          incoming.get(toTitle).add(fromTitle);
        }
      }

      for (const title of nodeSet) {
        if (!outgoing.has(title)) outgoing.set(title, new Set());
        if (!incoming.has(title)) incoming.set(title, new Set());
      }

      const meta = new Map();
      for (const title of nodeSet) {
        const page = state.pages[title] || null;
        if (page) ensurePageSchema(page);
        const outCount = outgoing.get(title)?.size || 0;
        const inCount = incoming.get(title)?.size || 0;
        meta.set(title, {
          title,
          exists: Boolean(page),
          tags: page?.tags || [],
          outgoing: outCount,
          incoming: inCount,
          degree: outCount + inCount
        });
      }

      return { nodes: [...nodeSet], edges, outgoing, incoming, meta };
    }

    function getLocalGraphNodeSet(model) {
      const start = state.currentPage;
      const visible = new Set([start]);
      let frontier = new Set([start]);
      const depth = Math.max(1, Math.min(2, Number(graphSettings.localDepth) || 1));

      for (let level = 0; level < depth; level++) {
        const next = new Set();
        for (const title of frontier) {
          if (graphSettings.showOutgoing) {
            for (const target of model.outgoing.get(title) || []) {
              if (!visible.has(target)) next.add(target);
              visible.add(target);
            }
          }
          if (graphSettings.showBacklinks) {
            for (const source of model.incoming.get(title) || []) {
              if (!visible.has(source)) next.add(source);
              visible.add(source);
            }
          }
        }
        frontier = next;
      }

      return visible;
    }

    function getFilteredGraphData() {
      const model = buildGraphModel();
      let visible = graphSettings.mode === 'local'
        ? getLocalGraphNodeSet(model)
        : new Set(model.nodes);

      const query = (graphSettings.search || '').trim().toLowerCase();
      if (query) {
        visible = new Set([...visible].filter(title => title.toLowerCase().includes(query)));
      }

      if (graphSettings.tag) {
        visible = new Set([...visible].filter(title => {
          const page = state.pages[title];
          if (!page) return false;
          ensurePageSchema(page);
          return page.tags.includes(graphSettings.tag);
        }));
      }

      let edges = model.edges.filter(edge => visible.has(edge.from) && visible.has(edge.to));

      if (graphSettings.mode === 'local') {
        edges = edges.filter(edge => {
          const isOutgoingFromCurrent = edge.from === state.currentPage;
          const isBacklinkToCurrent = edge.to === state.currentPage;
          if (!graphSettings.showOutgoing && isOutgoingFromCurrent) return false;
          if (!graphSettings.showBacklinks && isBacklinkToCurrent) return false;
          return true;
        });
      }

      if (graphSettings.hideOrphans) {
        const connected = new Set();
        for (const edge of edges) {
          connected.add(edge.from);
          connected.add(edge.to);
        }
        visible = new Set([...visible].filter(title => connected.has(title) || title === state.currentPage));
        edges = edges.filter(edge => visible.has(edge.from) && visible.has(edge.to));
      }

      const nodes = [...visible].sort((a, b) => {
        if (a === state.currentPage) return -1;
        if (b === state.currentPage) return 1;
        return a.localeCompare(b);
      });

      return { ...model, nodes, edges };
    }

    function hashTitle(title) {
      let hash = 2166136261;
      for (let i = 0; i < title.length; i++) {
        hash ^= title.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return hash >>> 0;
    }

    function computeGraphLayout(nodes, edges, width, height) {
      const margin = 58;
      const cx = width / 2;
      const cy = height / 2;
      const layout = new Map();
      const indexByTitle = new Map(nodes.map((title, i) => [title, i]));
      const count = Math.max(1, nodes.length);
      const baseRadius = Math.min(width, height) * (count > 35 ? 0.36 : 0.3);

      nodes.forEach((title, i) => {
        const hash = hashTitle(title);
        const angle = (Math.PI * 2 * i) / count + (hash % 360) * Math.PI / 1800;
        const radius = Math.max(40, baseRadius * (0.62 + ((hash % 100) / 260)));
        layout.set(title, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius, vx: 0, vy: 0 });
      });

      const linkedPairs = edges
        .map(e => [indexByTitle.get(e.from), indexByTitle.get(e.to)])
        .filter(pair => pair[0] !== undefined && pair[1] !== undefined);

      const iterations = nodes.length > 70 ? 180 : 260;
      const idealEdge = nodes.length > 50 ? 86 : 116;
      const repulsion = nodes.length > 50 ? 3600 : 5200;
      const centerPull = 0.012;

      for (let step = 0; step < iterations; step++) {
        for (let i = 0; i < nodes.length; i++) {
          const a = layout.get(nodes[i]);
          for (let j = i + 1; j < nodes.length; j++) {
            const b = layout.get(nodes[j]);
            let dx = a.x - b.x;
            let dy = a.y - b.y;
            let distSq = dx * dx + dy * dy;
            if (distSq < 0.01) {
              dx = 0.1 + (i % 3) * 0.01;
              dy = 0.1 + (j % 3) * 0.01;
              distSq = dx * dx + dy * dy;
            }
            const dist = Math.sqrt(distSq);
            const force = repulsion / distSq;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx += fx; a.vy += fy;
            b.vx -= fx; b.vy -= fy;
          }
        }

        for (const [fromIndex, toIndex] of linkedPairs) {
          const a = layout.get(nodes[fromIndex]);
          const b = layout.get(nodes[toIndex]);
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          const force = (dist - idealEdge) * 0.018;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }

        for (const title of nodes) {
          const p = layout.get(title);
          p.vx += (cx - p.x) * centerPull;
          p.vy += (cy - p.y) * centerPull;
          p.vx *= 0.72;
          p.vy *= 0.72;
          p.x = Math.max(margin, Math.min(width - margin, p.x + p.vx));
          p.y = Math.max(margin, Math.min(height - margin, p.y + p.vy));
        }
      }

      return layout;
    }

    function computeRadialGraphLayout(nodes, edges, width, height, model) {
      const layout = new Map();
      const cx = width / 2;
      const cy = height / 2;
      const current = state.currentPage;
      const nodeSet = new Set(nodes);
      const direct = new Set();

      for (const title of model.outgoing.get(current) || []) if (nodeSet.has(title)) direct.add(title);
      for (const title of model.incoming.get(current) || []) if (nodeSet.has(title)) direct.add(title);

      const rings = [
        nodes.filter(title => title === current),
        [...direct].filter(title => title !== current).sort((a, b) => a.localeCompare(b)),
        nodes.filter(title => title !== current && !direct.has(title)).sort((a, b) => a.localeCompare(b))
      ];
      const radii = [0, Math.min(width, height) * 0.23, Math.min(width, height) * 0.38];

      rings.forEach((ring, ringIndex) => {
        const count = Math.max(1, ring.length);
        ring.forEach((title, i) => {
          if (ringIndex === 0) {
            layout.set(title, { x: cx, y: cy, vx: 0, vy: 0 });
            return;
          }
          const hash = hashTitle(title);
          const angle = (Math.PI * 2 * i) / count - Math.PI / 2 + (hash % 90) * Math.PI / 1440;
          const radius = radii[ringIndex] || radii[2];
          layout.set(title, {
            x: cx + Math.cos(angle) * radius,
            y: cy + Math.sin(angle) * radius,
            vx: 0,
            vy: 0
          });
        });
      });

      return layout;
    }

    function computeRoamOriginalGraphLayout(nodes, edges, width, height, model) {
      const layout = new Map();
      const nodeSet = new Set(nodes);
      const cx = width / 2;
      const cy = height / 2;
      const current = state.currentPage;
      const degree = new Map(nodes.map(title => [title, 0]));
      const neighbors = new Map(nodes.map(title => [title, new Set()]));

      for (const edge of edges) {
        if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to)) continue;
        neighbors.get(edge.from)?.add(edge.to);
        neighbors.get(edge.to)?.add(edge.from);
      }
      for (const title of nodes) degree.set(title, neighbors.get(title)?.size || 0);

      const byDegreeThenName = (a, b) => (degree.get(a) || 0) - (degree.get(b) || 0) || a.localeCompare(b);
      const ringLimit = Math.ceil(nodes.length * 0.46);
      const ringMin = nodes.length > 60 ? Math.floor(nodes.length * 0.22) : nodes.length > 24 ? Math.min(12, Math.floor(nodes.length * 0.3)) : 0;
      const ringCandidates = nodes
        .filter(title => title !== current && (degree.get(title) || 0) === 0)
        .sort((a, b) => a.localeCompare(b));

      if (ringCandidates.length < ringMin) {
        const lowSignal = nodes
          .filter(title => title !== current && !ringCandidates.includes(title) && (degree.get(title) || 0) <= 1)
          .sort(byDegreeThenName);
        for (const title of lowSignal) {
          if (ringCandidates.length >= ringMin || ringCandidates.length >= ringLimit) break;
          ringCandidates.push(title);
        }
      }

      const ringSet = new Set(ringCandidates.slice(0, ringLimit));
      let leafNodes = nodes
        .filter(title => title !== current && !ringSet.has(title) && (degree.get(title) || 0) <= 1)
        .sort((a, b) => a.localeCompare(b));
      let coreNodes = nodes
        .filter(title => !ringSet.has(title) && !leafNodes.includes(title))
        .sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0) || a.localeCompare(b));

      if (!coreNodes.length && leafNodes.length) {
        const promoted = leafNodes.includes(current) ? current : leafNodes[0];
        leafNodes = leafNodes.filter(title => title !== promoted);
        coreNodes = [promoted];
      }

      const coreCx = cx + width * 0.08;
      const coreCy = cy + height * 0.03;
      const coreRx = Math.min(width * 0.22, 220);
      const coreRy = Math.min(height * 0.23, 135);
      const maxDegree = Math.max(1, ...coreNodes.map(title => degree.get(title) || 0));

      coreNodes.forEach((title, i) => {
        const hash = hashTitle(title);
        const angle = (hash % 6283) / 1000;
        const degreePull = 1 - ((degree.get(title) || 0) / maxDegree);
        const radius = 12 + degreePull * 0.78 * Math.min(coreRx, coreRy) + (i % 7) * 2;
        layout.set(title, {
          x: coreCx + Math.cos(angle) * radius * (coreRx / Math.min(coreRx, coreRy)),
          y: coreCy + Math.sin(angle) * radius * (coreRy / Math.min(coreRx, coreRy)),
          vx: 0,
          vy: 0,
          role: 'core'
        });
      });

      const coreIndex = new Map(coreNodes.map((title, i) => [title, i]));
      const corePairs = edges
        .map(edge => [coreIndex.get(edge.from), coreIndex.get(edge.to)])
        .filter(pair => pair[0] !== undefined && pair[1] !== undefined);
      const iterations = coreNodes.length > 80 ? 150 : 230;
      const idealEdge = coreNodes.length > 55 ? 48 : 62;
      const repulsion = coreNodes.length > 55 ? 1250 : 1750;

      for (let step = 0; step < iterations; step++) {
        for (let i = 0; i < coreNodes.length; i++) {
          const a = layout.get(coreNodes[i]);
          for (let j = i + 1; j < coreNodes.length; j++) {
            const b = layout.get(coreNodes[j]);
            let dx = a.x - b.x;
            let dy = a.y - b.y;
            let distSq = dx * dx + dy * dy;
            if (distSq < 0.01) {
              dx = 0.12 + (i % 5) * 0.01;
              dy = 0.12 + (j % 5) * 0.01;
              distSq = dx * dx + dy * dy;
            }
            const dist = Math.sqrt(distSq);
            const force = repulsion / distSq;
            a.vx += (dx / dist) * force;
            a.vy += (dy / dist) * force;
            b.vx -= (dx / dist) * force;
            b.vy -= (dy / dist) * force;
          }
        }

        for (const [fromIndex, toIndex] of corePairs) {
          const a = layout.get(coreNodes[fromIndex]);
          const b = layout.get(coreNodes[toIndex]);
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          const force = (dist - idealEdge) * 0.022;
          a.vx += (dx / dist) * force;
          a.vy += (dy / dist) * force;
          b.vx -= (dx / dist) * force;
          b.vy -= (dy / dist) * force;
        }

        for (const title of coreNodes) {
          const p = layout.get(title);
          p.vx += (coreCx - p.x) * 0.015;
          p.vy += (coreCy - p.y) * 0.015;
          p.vx *= 0.74;
          p.vy *= 0.74;
          p.x = Math.max(width * 0.18, Math.min(width * 0.88, p.x + p.vx));
          p.y = Math.max(height * 0.14, Math.min(height * 0.86, p.y + p.vy));
        }
      }

      const ringNodes = [...ringSet].sort((a, b) => a.localeCompare(b));
      const ringRx = width * 0.47;
      const ringRy = height * 0.49;
      const ringStart = 160 * Math.PI / 180;
      const ringSpan = 320 * Math.PI / 180;
      ringNodes.forEach((title, i) => {
        const denom = Math.max(1, ringNodes.length - 1);
        const hash = hashTitle(title);
        const angle = ringStart + ringSpan * (i / denom) + ((hash % 100) - 50) * Math.PI / 9000;
        const jitter = ((hash % 31) - 15) / 15;
        layout.set(title, {
          x: cx + Math.cos(angle) * (ringRx + jitter * 4),
          y: cy + Math.sin(angle) * (ringRy + jitter * 3),
          vx: 0,
          vy: 0,
          role: 'outer-ring'
        });
      });

      const leafGroups = new Map();
      for (const title of leafNodes) {
        const parent = [...(neighbors.get(title) || [])].find(candidate => layout.has(candidate)) || current || coreNodes[0];
        if (!parent) continue;
        if (!leafGroups.has(parent)) leafGroups.set(parent, []);
        leafGroups.get(parent).push(title);
      }

      for (const [parent, children] of leafGroups) {
        const parentPoint = layout.get(parent) || { x: coreCx, y: coreCy };
        let dx = parentPoint.x - coreCx;
        let dy = parentPoint.y - coreCy;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) {
          const hash = hashTitle(parent);
          dx = Math.cos((hash % 6283) / 1000);
          dy = Math.sin((hash % 6283) / 1000);
          dist = 1;
        }
        const nx = dx / dist;
        const ny = dy / dist;
        const clusterDistance = 34 + Math.min(62, children.length * 1.8);
        const clusterCx = parentPoint.x + nx * clusterDistance;
        const clusterCy = parentPoint.y + ny * clusterDistance;
        children.sort((a, b) => a.localeCompare(b)).forEach((title, i) => {
          const hash = hashTitle(title);
          const angle = i * 2.399963 + (hash % 45) * Math.PI / 900;
          const radius = 3.2 * Math.sqrt(i + 1);
          layout.set(title, {
            x: Math.max(24, Math.min(width - 24, clusterCx + Math.cos(angle) * radius)),
            y: Math.max(24, Math.min(height - 24, clusterCy + Math.sin(angle) * radius)),
            vx: 0,
            vy: 0,
            role: 'leaf-cluster'
          });
        });
      }

      for (const title of nodes) {
        if (layout.has(title)) continue;
        const hash = hashTitle(title);
        const angle = (hash % 6283) / 1000;
        const radius = 42 + (hash % 90);
        layout.set(title, {
          x: coreCx + Math.cos(angle) * radius,
          y: coreCy + Math.sin(angle) * radius * 0.65,
          vx: 0,
          vy: 0,
          role: 'core'
        });
      }

      return layout;
    }

    function applyGraphPins(layout) {
      for (const [title, pos] of Object.entries(graphPinnedPositions)) {
        if (!layout.has(title)) continue;
        layout.set(title, { x: pos.x, y: pos.y, vx: 0, vy: 0 });
      }
      return layout;
    }

    function getPrimaryGraphTag(meta) {
      return meta?.tags?.[0] || '';
    }

    function getGraphTagColor(tag) {
      if (!tag) return '#6ca5ff';
      return GRAPH_TAG_COLORS[hashTitle(tag) % GRAPH_TAG_COLORS.length];
    }

    function getGraphNodeColor(meta) {
      if (!meta?.exists) return '#6b7280';
      return getGraphTagColor(getPrimaryGraphTag(meta));
    }

    function getGraphNodeRadius(meta, dense, originalStyle = false) {
      if (originalStyle) {
        const degree = meta?.degree || 0;
        return Math.max(2.2, Math.min(5.4, 2.2 + Math.sqrt(degree) * 0.45));
      }
      const base = dense ? 4.5 : 6.5;
      const degree = meta?.degree || 0;
      return Math.max(base, Math.min(dense ? 12 : 16, base + Math.sqrt(degree) * 2.2));
    }

    function isCurrentNeighbor(title, model) {
      if (title === state.currentPage) return true;
      return (model.outgoing.get(state.currentPage)?.has(title) || model.incoming.get(state.currentPage)?.has(title));
    }

    function getGraphLabelClass(title, dense, model, originalStyle = false) {
      if (originalStyle && title !== graphSelectedTitle && title !== state.currentPage) return 'graph-label compact';
      if (graphSettings.labelMode === 'always') return 'graph-label';
      if (graphSettings.labelMode === 'hover') return 'graph-label compact';
      if (dense && !isCurrentNeighbor(title, model)) return 'graph-label compact';
      return 'graph-label';
    }

    function getGraphBounds(layout, nodes) {
      if (!nodes.length) return { minX: 0, minY: 0, maxX: GRAPH_WIDTH, maxY: GRAPH_HEIGHT };
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const title of nodes) {
        const p = layout.get(title);
        if (!p) continue;
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      return { minX, minY, maxX, maxY };
    }

    function fitGraphToBounds(bounds, padding = 70) {
      const width = Math.max(80, bounds.maxX - bounds.minX + padding * 2);
      const height = Math.max(80, bounds.maxY - bounds.minY + padding * 2);
      const scale = Math.max(GRAPH_MIN_ZOOM, Math.min(GRAPH_MAX_ZOOM, Math.min(GRAPH_WIDTH / width, GRAPH_HEIGHT / height)));
      graphViewport = clampGraphViewport(bounds.minX - padding, bounds.minY - padding, scale);
      applyGraphViewport();
    }

    function fitGraphToVisible() {
      if (!graphLastRender) return resetGraphZoom();
      fitGraphToBounds(getGraphBounds(graphLastRender.layout, graphLastRender.nodes));
    }

    function centerGraphOnTitle(title) {
      const p = graphLastRender?.layout?.get(title);
      if (!p) return;
      const box = getGraphViewBox();
      graphViewport = clampGraphViewport(p.x - box.width / 2, p.y - box.height / 2, graphViewport.scale);
      applyGraphViewport();
    }

    function updateGraphNodeDom(title) {
      const cache = graphLastRender;
      if (!cache) return;
      const item = cache.nodeEls.get(title);
      const p = cache.layout.get(title);
      if (!item || !p) return;
      const labelLeft = p.x > GRAPH_WIDTH / 2;
      item.circle.setAttribute('cx', String(p.x));
      item.circle.setAttribute('cy', String(p.y));
      item.label.setAttribute('x', String(p.x + (labelLeft ? item.radius + 5 : -item.radius - 5)));
      item.label.setAttribute('y', String(p.y + 3.5));
      item.label.setAttribute('text-anchor', labelLeft ? 'start' : 'end');

      // Update edges center-to-center (no offset)
      for (const edge of cache.edgeEls) {
        if (edge.from !== title && edge.to !== title) continue;
        const pa = cache.layout.get(edge.from);
        const pb = cache.layout.get(edge.to);
        if (!pa || !pb) continue;
        edge.line.setAttribute('x1', String(pa.x));
        edge.line.setAttribute('y1', String(pa.y));
        edge.line.setAttribute('x2', String(pb.x));
        edge.line.setAttribute('y2', String(pb.y));
      }
    }

    function getGraphEdgePoints(layout, fromTitle, toTitle, radiusByTitle = new Map()) {
      const a = layout.get(fromTitle);
      const b = layout.get(toTitle);
      if (!a || !b) return null;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const fromRadius = (radiusByTitle.get(fromTitle) || 8) + 2;
      const toRadius = (radiusByTitle.get(toTitle) || 8) + 7;
      return {
        x1: a.x + (dx / dist) * fromRadius,
        y1: a.y + (dy / dist) * fromRadius,
        x2: b.x - (dx / dist) * toRadius,
        y2: b.y - (dy / dist) * toRadius
      };
    }

    function renderGraphTagFilter() {
      const select = document.getElementById('graphTagFilter');
      if (!select) return;
      const current = graphSettings.tag || '';
      const tags = getAllTagsWithCounts();
      select.innerHTML = '<option value="">All tags</option>' + tags
        .map(([tag, count]) => `<option value="${escapeHtml(tag)}">#${escapeHtml(tag)} (${count})</option>`)
        .join('');
      select.value = tags.some(([tag]) => tag === current) ? current : '';
      graphSettings.tag = select.value;
    }

    function syncGraphControls() {
      renderGraphTagFilter();
      const globalBtn = document.getElementById('graphModeGlobalBtn');
      const localBtn = document.getElementById('graphModeLocalBtn');
      const depth = document.getElementById('graphLocalDepth');
      const search = document.getElementById('graphSearchInput');
      const tag = document.getElementById('graphTagFilter');
      const hideOrphans = document.getElementById('graphHideOrphans');
      const backlinks = document.getElementById('graphShowBacklinks');
      const outgoing = document.getElementById('graphShowOutgoing');
      const style = document.getElementById('graphStyleMode');
      const labels = document.getElementById('graphLabelMode');
      const layout = document.getElementById('graphLayoutMode');
      const localOptions = document.querySelector('.graph-local-options');
      const depthField = document.querySelector('.graph-depth-field');

      globalBtn?.classList.toggle('active-view', graphSettings.mode === 'global');
      localBtn?.classList.toggle('active-view', graphSettings.mode === 'local');
      if (depth) depth.value = String(graphSettings.localDepth);
      if (search && search.value !== graphSettings.search) search.value = graphSettings.search;
      if (tag) tag.value = graphSettings.tag || '';
      if (hideOrphans) hideOrphans.checked = graphSettings.hideOrphans;
      if (backlinks) backlinks.checked = graphSettings.showBacklinks;
      if (outgoing) outgoing.checked = graphSettings.showOutgoing;
      if (style) style.value = graphSettings.visualStyle;
      if (labels) labels.value = graphSettings.labelMode;
      if (layout) layout.value = graphSettings.layout;
      localOptions?.classList.toggle('is-muted', graphSettings.mode !== 'local');
      depthField?.classList.toggle('is-muted', graphSettings.mode !== 'local');
    }

    function renderGraphLegend(data) {
      const el = document.getElementById('graphLegend');
      if (!el) return;
      if (graphSettings.visualStyle === 'roam-original') {
        el.innerHTML = `
          <span class="graph-legend-item"><span class="graph-legend-line"></span>linked pages</span>
          <span class="graph-legend-item"><span class="graph-legend-dot" style="--legend-color:#8fa3b2"></span>Roam original</span>
          <span class="graph-legend-item"><span class="graph-legend-dot" style="--legend-color:#d4a400"></span>current</span>
        `;
        return;
      }
      const tags = [...new Set(data.nodes.map(title => getPrimaryGraphTag(data.meta.get(title))).filter(Boolean))].slice(0, 4);
      const tagItems = tags.map(tag => `
        <span class="graph-legend-item"><span class="graph-legend-dot" style="--legend-color:${getGraphTagColor(tag)}"></span>#${escapeHtml(tag)}</span>
      `).join('');
      el.innerHTML = `
        <span class="graph-legend-item"><span class="graph-legend-line"></span>linked pages</span>
        <span class="graph-legend-item"><span class="graph-legend-dot" style="--legend-color:#305798"></span>current</span>
        <span class="graph-legend-item"><span class="graph-legend-dot" style="--legend-color:#6b7280"></span>missing page</span>
        ${tagItems}
      `;
    }

    function renderGraphInspector(title, persistent = false) {
      const el = document.getElementById('graphInspector');
      if (!el) return;
      const activeTitle = title || graphSelectedTitle || graphHoverTitle;
      if (!activeTitle || !graphLastRender?.meta?.has(activeTitle)) {
        el.classList.add('hidden');
        el.innerHTML = '';
        return;
      }
      const meta = graphLastRender.meta.get(activeTitle);
      const tagsHtml = meta.tags?.length
        ? meta.tags.map(tag => `<span class="tag-chip" data-graph-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</span>`).join('')
        : '<span class="muted">No tags</span>';
      el.classList.remove('hidden');
      el.innerHTML = `
        <div class="graph-inspector-title">${escapeHtml(activeTitle)}</div>
        <div class="graph-inspector-meta">
          <div class="graph-stat"><strong>${meta.incoming}</strong><span>backlinks</span></div>
          <div class="graph-stat"><strong>${meta.outgoing}</strong><span>outgoing</span></div>
          <div class="graph-stat"><strong>${meta.degree}</strong><span>total</span></div>
        </div>
        <div class="graph-inspector-tags">${tagsHtml}</div>
        <div class="graph-inspector-actions">
          <button type="button" data-graph-open="${escapeHtml(activeTitle)}">${meta.exists ? 'Open Page' : 'Create Page'}</button>
          <button type="button" data-graph-center="${escapeHtml(activeTitle)}">Center</button>
          ${persistent ? '<button type="button" data-graph-clear-selection="1">Clear</button>' : ''}
        </div>
      `;
      el.querySelectorAll('[data-graph-open]').forEach(btn => {
        btn.addEventListener('click', () => setCurrentPage(btn.dataset.graphOpen));
      });
      el.querySelectorAll('[data-graph-center]').forEach(btn => {
        btn.addEventListener('click', () => centerGraphOnTitle(btn.dataset.graphCenter));
      });
      el.querySelectorAll('[data-graph-clear-selection]').forEach(btn => {
        btn.addEventListener('click', () => {
          graphSelectedTitle = null;
          renderGraphView();
        });
      });
      el.querySelectorAll('[data-graph-tag]').forEach(chip => {
        chip.addEventListener('click', () => {
          graphSettings.tag = chip.dataset.graphTag || '';
          renderGraphView();
        });
      });
    }

    function renderGraphView() {
      const svg = document.getElementById('graphSvg');
      if (!svg) return;
      syncGraphControls();
      const data = getFilteredGraphData();
      const { nodes, edges } = data;
      if (graphSelectedTitle && !nodes.includes(graphSelectedTitle)) graphSelectedTitle = null;
      const width = GRAPH_WIDTH, height = GRAPH_HEIGHT, cx = width / 2, cy = height / 2;
      const originalStyle = graphSettings.visualStyle === 'roam-original';
      svg.classList.toggle('is-roam-original', originalStyle);
      document.getElementById('graphView')?.classList.toggle('is-roam-original', originalStyle);
      const byTitle = applyGraphPins(
        originalStyle
          ? computeRoamOriginalGraphLayout(nodes, edges, width, height, data)
          : graphSettings.layout === 'radial'
          ? computeRadialGraphLayout(nodes, edges, width, height, data)
          : computeGraphLayout(nodes, edges, width, height)
      );
      const dense = nodes.length > 35;
      const directNeighbors = new Set(nodes.filter(title => isCurrentNeighbor(title, data)));
      const radiusByTitle = new Map(nodes.map(title => [title, getGraphNodeRadius(data.meta.get(title), dense, originalStyle)]));

      svg.innerHTML = '';
      applyGraphViewport();
      graphLastRender = {
        nodes,
        edges,
        layout: byTitle,
        meta: data.meta,
        radiusByTitle,
        nodeEls: new Map(),
        edgeEls: []
      };

      if (!nodes.length) {
        const empty = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        empty.setAttribute('x', String(cx));
        empty.setAttribute('y', String(cy));
        empty.setAttribute('class', 'graph-empty');
        empty.setAttribute('text-anchor', 'middle');
        empty.textContent = 'No pages match the graph filters';
        svg.appendChild(empty);
        renderGraphLegend(data);
        renderGraphInspector(null);
        return;
      }

      // No arrow defs — Roam Research uses plain undirected edges

      for (const e of edges) {
        const pa = byTitle.get(e.from);
        const pb = byTitle.get(e.to);
        if (!pa || !pb) continue;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        // Draw center-to-center (no offset), undirected, no arrowhead
        line.setAttribute('x1', String(pa.x)); line.setAttribute('y1', String(pa.y));
        line.setAttribute('x2', String(pb.x)); line.setAttribute('y2', String(pb.y));
        const neighbor = e.from === state.currentPage || e.to === state.currentPage;
        const selectedRelated = graphSelectedTitle && (e.from === graphSelectedTitle || e.to === graphSelectedTitle);
        line.setAttribute('class', 'graph-edge' + (neighbor || selectedRelated ? ' neighbor' : '') + (graphSelectedTitle && !selectedRelated ? ' dimmed' : ''));
        svg.appendChild(line);
        graphLastRender.edgeEls.push({ line, from: e.from, to: e.to });
      }

      for (const title of nodes) {
        const p = byTitle.get(title); if (!p) continue;
        const meta = data.meta.get(title);
        const radius = radiusByTitle.get(title) || getGraphNodeRadius(meta, dense);
        const isCurrent = title === state.currentPage;
        const isNeighbor = directNeighbors.has(title) && !isCurrent;
        const isSelected = title === graphSelectedTitle;
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        const roleClass = originalStyle && p.role ? ` ${p.role}` : '';
        group.setAttribute('class', 'graph-item' + roleClass + (isCurrent ? ' current' : '') + (isNeighbor ? ' neighbor' : '') + (isSelected ? ' selected' : '') + (graphSelectedTitle && !isSelected && !isNeighbor && !isCurrent ? ' dimmed' : ''));
        group.dataset.title = title;

        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', String(p.x)); circle.setAttribute('cy', String(p.y));
        circle.setAttribute('r', String(radius));
        circle.setAttribute('class', 'graph-node');
        circle.style.setProperty('--node-color', getGraphNodeColor(meta));
        group.appendChild(circle);

        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        const labelLeft = p.x > cx;
        label.setAttribute('x', String(p.x + (labelLeft ? radius + 5 : -radius - 5)));
        label.setAttribute('y', String(p.y + 3.5));
        label.setAttribute('text-anchor', labelLeft ? 'start' : 'end');
        label.setAttribute('class', getGraphLabelClass(title, dense, data, originalStyle));
        label.textContent = title;
        group.appendChild(label);

        const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        titleEl.textContent = title;
        group.appendChild(titleEl);

        group.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          const point = getGraphSvgPoint(svg, e);
          graphNodeDragState = {
            title,
            pointerId: e.pointerId,
            startX: point.x,
            startY: point.y,
            origin: { x: p.x, y: p.y },
            moved: false
          };
          group.setPointerCapture?.(e.pointerId);
        });

        group.addEventListener('pointermove', (e) => {
          if (!graphNodeDragState || graphNodeDragState.pointerId !== e.pointerId || graphNodeDragState.title !== title) return;
          const point = getGraphSvgPoint(svg, e);
          const dx = point.x - graphNodeDragState.startX;
          const dy = point.y - graphNodeDragState.startY;
          if (Math.abs(dx) + Math.abs(dy) > 3) {
            graphNodeDragState.moved = true;
            graphSuppressClick = true;
          }
          const next = {
            x: Math.max(30, Math.min(GRAPH_WIDTH - 30, graphNodeDragState.origin.x + dx)),
            y: Math.max(30, Math.min(GRAPH_HEIGHT - 30, graphNodeDragState.origin.y + dy))
          };
          graphPinnedPositions[title] = next;
          byTitle.set(title, { ...next, vx: 0, vy: 0 });
          updateGraphNodeDom(title);
        });

        function endNodeDrag(e) {
          if (!graphNodeDragState || graphNodeDragState.pointerId !== e.pointerId || graphNodeDragState.title !== title) return;
          group.releasePointerCapture?.(e.pointerId);
          if (graphNodeDragState.moved) setTimeout(() => { graphSuppressClick = false; }, 0);
          graphNodeDragState = null;
        }

        group.addEventListener('pointerup', endNodeDrag);
        group.addEventListener('pointercancel', endNodeDrag);
        group.addEventListener('mouseenter', () => {
          graphHoverTitle = title;
          if (!graphSelectedTitle) renderGraphInspector(title);
        });
        group.addEventListener('mouseleave', () => {
          graphHoverTitle = null;
          if (!graphSelectedTitle) renderGraphInspector(null);
        });
        group.addEventListener('click', (e) => {
          if (graphSuppressClick) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          graphSelectedTitle = title;
          renderGraphView();
          renderGraphInspector(title, true);
        });
        group.addEventListener('dblclick', (e) => {
          e.preventDefault();
          e.stopPropagation();
          setCurrentPage(title);
        });
        svg.appendChild(group);
        graphLastRender.nodeEls.set(title, { group, circle, label, radius });
      }

      renderGraphLegend(data);
      renderGraphInspector(graphSelectedTitle, Boolean(graphSelectedTitle));
    }

    function renderViewMode() {
      const blocks = document.getElementById('blocks');
      const graphView = document.getElementById('graphView');
      const workspace = document.getElementById('workspace');
      if (!blocks || !graphView || !workspace) return;
      blocks.classList.toggle('hidden', !viewShowsEditor());
      graphView.classList.toggle('hidden', !viewShowsGraph());
      const linkedRefsSection = document.getElementById('linkedRefsSection');
      if (linkedRefsSection) linkedRefsSection.classList.toggle('hidden', !viewShowsEditor());
      workspace.classList.toggle('view-editor', currentView === 'editor');
      workspace.classList.toggle('view-graph', currentView === 'graph');
      workspace.classList.toggle('view-split', currentView === 'split');
      if (viewShowsGraph()) renderGraphView();

      const btnEditor = document.getElementById('viewEditorBtn');
      const btnGraph = document.getElementById('viewGraphBtn');
      const btnSplit = document.getElementById('viewSplitBtn');
      if (btnEditor) btnEditor.classList.toggle('active-view', currentView === 'editor');
      if (btnGraph) btnGraph.classList.toggle('active-view', currentView === 'graph');
      if (btnSplit) btnSplit.classList.toggle('active-view', currentView === 'split');
    }

    function walkBlocks(blocks, visitor, depth = 0) {
      for (const b of blocks) { visitor(b, depth); walkBlocks(b.children, visitor, depth + 1); }
    }

    function escapeRegExp(str) {
      return (str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function isBlockEditor(el) {
      return Boolean(el?.classList?.contains('block-input') && el.isContentEditable);
    }

    function getEditorText(editor) {
      return (editor?.textContent || '').replace(/\u00a0/g, ' ').replace(/\r/g, '');
    }

    function getSelectionOffsets(root) {
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount || !root.contains(selection.anchorNode)) {
        const len = getEditorText(root).length;
        return { start: len, end: len };
      }
      const range = selection.getRangeAt(0);
      const before = range.cloneRange();
      before.selectNodeContents(root);
      before.setEnd(range.startContainer, range.startOffset);
      const selected = range.cloneRange();
      return {
        start: before.toString().length,
        end: before.toString().length + selected.toString().length
      };
    }

    function setSelectionOffsets(root, start, end = start) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      const textLength = getEditorText(root).length;
      const targetStart = Math.max(0, Math.min(start, textLength));
      const targetEnd = Math.max(0, Math.min(end, textLength));
      let pos = 0;
      let startSet = false;
      let endSet = false;
      let node;

      while ((node = walker.nextNode())) {
        const next = pos + node.nodeValue.length;
        if (!startSet && targetStart <= next) {
          range.setStart(node, targetStart - pos);
          startSet = true;
        }
        if (!endSet && targetEnd <= next) {
          range.setEnd(node, targetEnd - pos);
          endSet = true;
          break;
        }
        pos = next;
      }

      if (!startSet || !endSet) {
        range.selectNodeContents(root);
        range.collapse(false);
      }

      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }

    function syncEditorHtml(editor, text, caretStart = null, caretEnd = caretStart) {
      editor.innerHTML = renderEditorMarkdown(text || '');
      if (caretStart !== null) {
        editor.focus();
        setSelectionOffsets(editor, caretStart, caretEnd ?? caretStart);
      }
    }

    function recordBlockHistory(block, previousText) {
      if (!block) return;
      const prev = previousText ?? '';
      const entry = blockHistory.get(block.id) || { undo: [], redo: [] };
      if (entry.undo[entry.undo.length - 1] !== prev) entry.undo.push(prev);
      if (entry.undo.length > 100) entry.undo.shift();
      entry.redo = [];
      blockHistory.set(block.id, entry);
    }

    function setBlockTextFromEditor(editor, block, nextText, caretStart = null, caretEnd = caretStart) {
      const previous = block.text || '';
      if (previous !== nextText) recordBlockHistory(block, previous);
      block.text = nextText;
      syncEditorHtml(editor, nextText, caretStart, caretEnd);
      queueSave();
      scheduleHeavyRenders();
      updateAutocompleteForInput(editor, block);
    }

    function undoBlockEdit(editor, block, direction) {
      const entry = blockHistory.get(block.id);
      if (!entry) return false;
      const from = direction === 'redo' ? entry.redo : entry.undo;
      const to = direction === 'redo' ? entry.undo : entry.redo;
      if (!from.length) return false;
      to.push(block.text || '');
      const next = from.pop();
      block.text = next;
      syncEditorHtml(editor, next, next.length);
      queueSave();
      scheduleHeavyRenders();
      return true;
    }

    function replaceEditorRange(editor, block, start, end, replacement, caretStart, caretEnd = caretStart) {
      const text = getEditorText(editor);
      const next = text.slice(0, start) + replacement + text.slice(end);
      setBlockTextFromEditor(editor, block, next, caretStart, caretEnd);
    }

    function getFenceContextAtOffset(text, offset) {
      const source = text || '';
      const targetOffset = Math.max(0, offset);
      const fenceRe = /^[ \t]*(`{3,})/gm;
      let open = null;
      let match;

      while ((match = fenceRe.exec(source))) {
        const lineStart = match.index;
        const lineEnd = source.indexOf('\n', lineStart);
        const endOffset = lineEnd === -1 ? source.length : lineEnd;
        const length = match[1].length;

        if (!open) {
          if (lineStart >= targetOffset) return null;
          open = { start: lineStart, end: endOffset, length };
          continue;
        }

        if (length >= open.length) {
          if (lineStart >= targetOffset) {
            return { ...open, closeStart: lineStart, closeEnd: endOffset };
          }
          open = null;
        }
      }

      return open;
    }

    function maxPastedFenceLength(text) {
      let max = 0;
      const fenceRe = /^[ \t]*(`{3,})/gm;
      let match;
      while ((match = fenceRe.exec(text || ''))) {
        max = Math.max(max, match[1].length);
      }
      return max;
    }

    function replaceFenceTicksInLine(text, lineStart, lineEnd, ticks) {
      const before = text.slice(0, lineStart);
      const line = text.slice(lineStart, lineEnd);
      const after = text.slice(lineEnd);
      return before + line.replace(/`{3,}/, ticks) + after;
    }

    function isSelectionInsideFencedCode(editor) {
      const { start, end } = getSelectionOffsets(editor);
      const text = getEditorText(editor);
      const startContext = getFenceContextAtOffset(text, start);
      const endContext = getFenceContextAtOffset(text, end);
      return Boolean(
        startContext &&
        endContext &&
        startContext.start === endContext.start
      );
    }

    function insertPlainTextPaste(editor, block, text, options = {}) {
      const pasted = (text || '').replace(/\r\n?/g, '\n');
      if (!pasted) return false;
      const { start, end } = getSelectionOffsets(editor);
      const current = getEditorText(editor);
      let next = current.slice(0, start) + pasted + current.slice(end);
      let caret = start + pasted.length;

      if (options.upgradeCodeFence) {
        const context = getFenceContextAtOffset(current, start);
        const pastedFenceLength = maxPastedFenceLength(pasted);
        if (context && pastedFenceLength >= context.length) {
          const ticks = '`'.repeat(pastedFenceLength + 1);
          const delta = pasted.length - (end - start);
          if (typeof context.closeStart === 'number') {
            next = replaceFenceTicksInLine(next, context.closeStart + delta, context.closeEnd + delta, ticks);
          }
          next = replaceFenceTicksInLine(next, context.start, context.end, ticks);
          caret += ticks.length - context.length;
        }
      }

      setBlockTextFromEditor(editor, block, next, caret);
      return true;
    }

    function normalizePastedBlockText(text) {
      return (text || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function createPastedBlock(text, children = [], meta = {}) {
      const block = { id: uid(), text: normalizePastedBlockText(text), children };
      if (meta.fromList) block._pasteFromList = true;
      return block;
    }

    function pastedOutlineHasStructure(blocks) {
      if (!blocks || !blocks.length) return false;
      if (blocks.length > 1) return true;
      return Boolean(blocks[0].children && blocks[0].children.length);
    }

    function getLastPastedBlock(blocks) {
      let last = null;
      const visit = (block) => {
        if (!block) return;
        last = block;
        for (const child of block.children || []) visit(child);
      };
      for (const block of blocks || []) visit(block);
      return last;
    }

    // Convert an HTML element's inline content to markdown-flavoured plain text,
    // preserving bold (**), italic (*), inline-code (`), strikethrough (~~) and links.
    function htmlNodeToMarkdown(node) {
      if (!node) return '';
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';

      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const tag = (node.tagName || '').toLowerCase();
      const inner = () => Array.from(node.childNodes).map(htmlNodeToMarkdown).join('');

      // Skip block-level list elements — those are handled by the outline parser
      if (tag === 'ul' || tag === 'ol' || tag === 'li') return inner();

      if (tag === 'strong' || tag === 'b') return `**${inner()}**`;
      if (tag === 'em' || tag === 'i') return `*${inner()}*`;
      if (tag === 'code') return `\`${node.textContent || ''}\``;
      if (tag === 's' || tag === 'strike' || tag === 'del') return `~~${inner()}~~`;
      if (tag === 'mark') return `^^${inner()}^^`;
      if (tag === 'a') {
        const href = node.getAttribute('href') || '';
        const text = inner();
        return href && href !== text ? `[${text}](${href})` : text;
      }
      // Preserve heading levels as markdown
      const headingLevels = { h1: '#', h2: '##', h3: '###', h4: '####', h5: '#####', h6: '######' };
      if (headingLevels[tag]) return `${headingLevels[tag]} ${inner()}`;

      // Detect bold/italic/strikethrough from CSS classes (Roam Research uses rm-bold, rm-italic)
      // or from inline styles (font-weight:bold, font-style:italic, text-decoration:line-through)
      if (tag === 'span' || tag === 'div') {
        const cls = (node.getAttribute('class') || '').toLowerCase();
        const style = (node.getAttribute('style') || '').toLowerCase();
        const isBold = cls.includes('bold') || cls.includes('strong') ||
                       /font-weight\s*:\s*(bold|[6-9]\d\d|1\d{3})/.test(style);
        const isItalic = cls.includes('italic') || cls.includes('oblique') ||
                         /font-style\s*:\s*(italic|oblique)/.test(style);
        const isStrike = cls.includes('strike') || cls.includes('line-through') ||
                         /text-decoration[^:]*:\s*[^;]*line-through/.test(style);
        const innerMd = inner();
        let result = innerMd;
        if (isStrike) result = `~~${result}~~`;
        if (isItalic) result = `*${result}*`;
        if (isBold) result = `**${result}**`;
        return result;
      }

      // Treat block-level elements as inline continuations (content already split by caller)
      return inner();
    }


    function getElementInnerText(el) {
      if (!el) return '';
      const md = Array.from(el.childNodes).map(htmlNodeToMarkdown).join('');
      return normalizePastedBlockText(md);
    }

    function getElementTextWithoutDirectLists(el) {
      const clone = el?.cloneNode?.(true);
      if (!clone) return '';
      clone.querySelectorAll?.(':scope > ul, :scope > ol').forEach(list => list.remove());
      return getElementInnerText(clone);
    }

    function directTextBlocksFromListItem(li) {
      const blocks = [];
      let inlineBuffer = '';

      const flushInline = () => {
        const text = normalizePastedBlockText(inlineBuffer);
        if (text) blocks.push(text);
        inlineBuffer = '';
      };

      for (const node of Array.from(li.childNodes || [])) {
        if (node.nodeType === Node.TEXT_NODE) {
          // Use htmlNodeToMarkdown so text nodes are handled consistently in sequence
          inlineBuffer += node.textContent || '';
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        const tag = node.tagName?.toLowerCase();
        if (tag === 'ul' || tag === 'ol') {
          flushInline();
          continue;
        }

        if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre'].includes(tag)) {
          flushInline();
          const text = getElementInnerText(node);
          if (text) blocks.push(text);
        } else {
          // Inline element: convert to markdown in-place preserving order and formatting
          inlineBuffer += htmlNodeToMarkdown(node);
        }
      }

      flushInline();
      return blocks;
    }

    function parseHtmlList(listEl) {
      const out = [];
      for (const li of Array.from(listEl.children || []).filter(child => child.tagName?.toLowerCase() === 'li')) {
        const directBlocks = directTextBlocksFromListItem(li);
        const nested = [];
        for (const childList of Array.from(li.children || []).filter(child => {
          const tag = child.tagName?.toLowerCase();
          return tag === 'ul' || tag === 'ol';
        })) {
          nested.push(...parseHtmlList(childList));
        }

        const firstText = directBlocks.shift() || getElementTextWithoutDirectLists(li);
        if (!firstText && !nested.length) continue;
        out.push(createPastedBlock(firstText, [
          ...directBlocks.map(text => createPastedBlock(text)),
          ...nested
        ], { fromList: true }));
      }
      return out;
    }

    function pastedOutlineHasNestedStructure(blocks) {
      return Boolean((blocks || []).some(block => block.children && block.children.length));
    }

    function attachHtmlContinuationsToSingleListItem(blocks) {
      if (!blocks || blocks.length < 2) return blocks || [];
      const [first, ...rest] = blocks;
      if (!first?._pasteFromList || rest.some(block => block._pasteFromList)) return blocks;
      first.children = [...(first.children || []), ...rest];
      return [first];
    }

    function stripPasteMetadata(blocks) {
      for (const block of blocks || []) {
        delete block._pasteFromList;
        stripPasteMetadata(block.children);
      }
      return blocks || [];
    }

    function shouldNestPastedContinuationBlocks(blocks) {
      if (!blocks || blocks.length < 2) return false;
      const [first, ...rest] = blocks;
      if (!first?.text || first.children?.length) return false;
      if (rest.some(block => block.children?.length)) return false;
      if (first._pasteFromList) return true;

      const title = first.text.trim();
      const body = rest.map(block => block.text || '').join(' ').trim();
      if (!title || !body) return false;
      if (title.length > 80) return false;
      if (/[.!?]$/.test(title)) return false;
      return body.length > title.length;
    }

    function normalizePastedContinuationBlocks(blocks) {
      if (!shouldNestPastedContinuationBlocks(blocks)) return blocks || [];
      const [first, ...rest] = blocks;
      first.children = [...(first.children || []), ...rest];
      return [first];
    }

    function parseClipboardHtmlBlocks(html) {
      if (!html || !html.trim()) return [];
      try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const body = doc.body;
        const blocks = [];

        const appendElement = (el) => {
          const tag = el.tagName?.toLowerCase();
          if (tag === 'ul' || tag === 'ol') {
            blocks.push(...parseHtmlList(el));
            return;
          }
          if (el.querySelector?.(':scope > ul, :scope > ol')) {
            const text = getElementTextWithoutDirectLists(el);
            const nested = [];
            el.querySelectorAll(':scope > ul, :scope > ol').forEach(list => nested.push(...parseHtmlList(list)));
            if (text) blocks.push(createPastedBlock(text, nested));
            else blocks.push(...nested);
            return;
          }
          const text = getElementInnerText(el);
          if (text) blocks.push(createPastedBlock(text));
        };

        for (const node of Array.from(body.childNodes || [])) {
          if (node.nodeType === Node.TEXT_NODE) {
            const text = normalizePastedBlockText(node.textContent || '');
            if (text) blocks.push(createPastedBlock(text));
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            appendElement(node);
          }
        }

        return attachHtmlContinuationsToSingleListItem(blocks.filter(block => block.text || (block.children && block.children.length)));
      } catch (err) {
        console.warn('Could not parse clipboard HTML', err);
        return [];
      }
    }

    function plainLineIndent(line) {
      return (line.match(/^[\t ]*/) || [''])[0].replace(/\t/g, '  ').length;
    }

    function parsePlainTextOutlineBlocks(text) {
      const lines = (text || '').replace(/\r/g, '').split('\n');
      const hasMultipleMeaningfulLines = lines.filter(line => line.trim()).length > 1;
      if (!hasMultipleMeaningfulLines) return [];

      const roots = [];
      const stack = [];
      let lastListItem = null;

      const addBlock = (indent, textValue, forceChildOfLastList = false) => {
        const node = createPastedBlock(textValue);
        if (!node.text) return null;

        if (forceChildOfLastList && lastListItem?.node) {
          lastListItem.node.children.push(node);
          stack.push({ indent: lastListItem.indent + 1, node });
          return node;
        }

        while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
        const parent = stack[stack.length - 1]?.node;
        if (parent) parent.children.push(node);
        else roots.push(node);
        stack.push({ indent, node });
        return node;
      };

      for (const rawLine of lines) {
        if (!rawLine.trim()) continue;

        const indent = plainLineIndent(rawLine);
        const line = rawLine.trim();
        const listMatch = line.match(/^([-*+]|(?:\d+)[.)]|[•‣◦])\s+(.*)$/);

        if (listMatch) {
          const node = addBlock(indent, listMatch[2]);
          if (node) node._pasteFromList = true;
          if (node) lastListItem = { indent, node };
          continue;
        }

        const shouldAttachToListItem = Boolean(lastListItem && roots.length === 1 && indent <= lastListItem.indent);
        const node = addBlock(indent, line, shouldAttachToListItem);
        if (!shouldAttachToListItem && node) lastListItem = null;
      }

      return roots;
    }

    function parseClipboardBlocks(clipboardData) {
      const html = clipboardData?.getData('text/html') || '';
      const plain = clipboardData?.getData('text/plain') || '';

      // If the plain text is a single line, never split into multiple blocks —
      // the HTML parser can wrongly split inline elements (e.g. <code> spans) into
      // separate blocks. Let the browser handle single-line pastes natively.
      const plainLines = plain.replace(/\r/g, '').split('\n').filter(l => l.trim());
      if (plainLines.length <= 1) return [];

      const htmlBlocks = normalizePastedContinuationBlocks(parseClipboardHtmlBlocks(html));
      const plainBlocks = normalizePastedContinuationBlocks(parsePlainTextOutlineBlocks(plain));
      if (pastedOutlineHasNestedStructure(plainBlocks) && !pastedOutlineHasNestedStructure(htmlBlocks)) {
        return stripPasteMetadata(plainBlocks);
      }
      if (pastedOutlineHasStructure(htmlBlocks)) return stripPasteMetadata(htmlBlocks);
      if (pastedOutlineHasStructure(plainBlocks)) return stripPasteMetadata(plainBlocks);
      return [];
    }

    async function pasteOutlineBlocksIntoEditor(editor, block, pastedBlocks) {
      if (!pastedOutlineHasStructure(pastedBlocks)) return false;
      const page = getCurrentPage();
      const ctx = findBlockContext(page.blocks, block.id);
      if (!ctx) return false;

      const { start, end } = getSelectionOffsets(editor);
      const currentText = getEditorText(editor);
      const before = currentText.slice(0, start);
      const after = currentText.slice(end);
      const [firstBlock, ...siblingBlocks] = pastedBlocks;

      recordBlockHistory(block, block.text || '');
      block.text = normalizePastedBlockText(before + firstBlock.text);
      block.children = [...(firstBlock.children || []), ...(block.children || [])];

      if (after) {
        const tail = getLastPastedBlock(siblingBlocks.length ? siblingBlocks : firstBlock.children);
        if (tail) tail.text = normalizePastedBlockText(tail.text + ' ' + after);
        else block.text = normalizePastedBlockText(block.text + ' ' + after);
      }

      ctx.array.splice(ctx.index + 1, 0, ...siblingBlocks);
      const focusTarget = getLastPastedBlock(siblingBlocks.length ? siblingBlocks : firstBlock.children) || block;
      pendingFocus = focusTarget.id;
      pendingFocusOffset = Number.POSITIVE_INFINITY;
      await saveData();
      render();
      return true;
    }

    function wrapEditorSelection(editor, block, prefix, suffix = prefix) {
      const { start, end } = getSelectionOffsets(editor);
      const text = getEditorText(editor);
      const selected = text.slice(start, end);
      const replacement = prefix + selected + suffix;
      const caretStart = selected ? start : start + prefix.length;
      const caretEnd = selected ? start + replacement.length : caretStart;
      replaceEditorRange(editor, block, start, end, replacement, caretStart, caretEnd);
    }

    function applyDateShortcutToEditor(editor, block) {
      const { start } = getSelectionOffsets(editor);
      const expanded = expandDateShortcut(getEditorText(editor), start);
      if (!expanded.changed) return false;
      setBlockTextFromEditor(editor, block, expanded.value, expanded.caret);
      return true;
    }

    function getAutocompleteContext(text, caretPos) {
      const val = text || '';
      const pos = Math.max(0, Math.min(caretPos ?? val.length, val.length));
      const before = val.slice(0, pos);

      // Find the nearest unmatched [[ before the caret
      let openIdx = before.lastIndexOf('[[');
      while (openIdx >= 0) {
        const segment = before.slice(openIdx + 2);
        if (!segment.includes(']]') && !/[\r\n]/.test(segment)) {
          return {
            start: openIdx,
            queryStart: openIdx + 2,
            query: segment
          };
        }
        if (openIdx === 0) break;
        openIdx = before.lastIndexOf('[[', openIdx - 1);
      }

      return null;
    }

    function getBlockRefAutocompleteContext(text, caretPos) {
      const val = text || '';
      const pos = Math.max(0, Math.min(caretPos ?? val.length, val.length));
      const before = val.slice(0, pos);
      let openIdx = before.lastIndexOf('((');
      while (openIdx >= 0) {
        const segment = before.slice(openIdx + 2);
        if (!segment.includes('))') && !/[\r\n]/.test(segment)) {
          return { start: openIdx, queryStart: openIdx + 2, query: segment };
        }
        if (openIdx === 0) break;
        openIdx = before.lastIndexOf('((', openIdx - 1);
      }
      return null;
    }

    function getSlashContext(text, caretPos) {
      const val = text || '';
      const pos = Math.max(0, Math.min(caretPos ?? val.length, val.length));
      const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
      const before = val.slice(lineStart, pos);
      const m = before.match(/^(\s*)\/([a-zA-Z -]*)$/);
      if (!m) return null;
      return { start: lineStart + m[1].length, queryStart: lineStart + before.length - m[2].length, query: m[2] || '' };
    }

    function getPageSuggestions(query, limit = MAX_LINK_SUGGESTIONS) {
      const q = (query || '').trim().toLowerCase();
      let titles = Object.keys(state.pages);
      if (q) titles = titles.filter(t => t.toLowerCase().includes(q));
      titles.sort((a, b) => {
        const ai = q ? a.toLowerCase().indexOf(q) : 0;
        const bi = q ? b.toLowerCase().indexOf(q) : 0;
        if (ai !== bi) return ai - bi;
        return a.localeCompare(b);
      });
      return titles.slice(0, limit);
    }

    function getBlockRefSuggestions(query, limit = MAX_LINK_SUGGESTIONS) {
      const q = (query || '').trim().toLowerCase();
      const out = [];
      for (const [pageTitle, page] of Object.entries(state.pages)) {
        walkBlocks(page.blocks || [], (block) => {
          const text = (block.text || '').replace(/\s+/g, ' ').trim();
          if (!text && q) return;
          const haystack = `${text} ${pageTitle} ${block.id}`.toLowerCase();
          if (!q || haystack.includes(q)) out.push({ id: block.id, pageTitle, text: text || '(empty block)' });
        });
      }
      out.sort((a, b) => a.text.localeCompare(b.text));
      return out.slice(0, limit);
    }

    const SLASH_COMMANDS = [
      { label: 'todo', detail: 'Checkbox task', insert: '- [ ] ' },
      { label: 'date', detail: 'Today page link', insert: () => `[[${todayTitle()}]]` },
      { label: 'bold', detail: 'Bold text', insert: '**text**', select: [2, 6] },
      { label: 'italic', detail: 'Italic text', insert: '*text*', select: [1, 5] },
      { label: 'highlight', detail: 'Highlighted text', insert: '^^text^^', select: [2, 6] },
      { label: 'strike', detail: 'Strikethrough text', insert: '~~text~~', select: [2, 6] },
      { label: 'code', detail: 'Inline code', insert: '`code`', select: [1, 5] },
      { label: 'code block', detail: 'Fenced code block', insert: '```\ncode\n```', select: [4, 8] },
      { label: 'image', detail: 'Image embed', insert: '![alt](https://example.com/image.png)', select: [2, 5] },
      { label: 'video', detail: 'Video link', insert: '[video](https://example.com/video.mp4)', select: [1, 6] },
      { label: 'hr', detail: 'Horizontal rule', insert: '---' }
    ];

    function getSlashSuggestions(query, limit = MAX_LINK_SUGGESTIONS) {
      const q = (query || '').trim().toLowerCase();
      return SLASH_COMMANDS.filter(cmd => !q || cmd.label.includes(q)).slice(0, limit);
    }

    function closeAutocomplete() {
      if (!activeAutocomplete) return;
      audit('autocomplete.close', { blockId: activeAutocomplete.block?.id });
      activeAutocomplete.menu?.remove();
      activeAutocomplete = null;
    }

    function applyAutocompleteSelection(selection) {
      if (!activeAutocomplete) return;
      const { input, block, context, kind } = activeAutocomplete;
      audit('autocomplete.apply', { selection, kind, blockId: block?.id, query: context?.query || '' });
      const val = getEditorText(input);
      const before = val.slice(0, context.start);
      const { end } = getSelectionOffsets(input);
      const after = val.slice(end);
      let inserted = '';
      let selectStart = null;
      let selectEnd = null;

      if (kind === 'block-ref') {
        inserted = `((${selection.id}))`;
      } else if (kind === 'slash') {
        inserted = typeof selection.insert === 'function' ? selection.insert() : selection.insert;
        if (selection.select) {
          selectStart = before.length + selection.select[0];
          selectEnd = before.length + selection.select[1];
        }
      } else {
        inserted = `[[${selection}]]`;
      }

      const next = before + inserted + after;
      if ((block.text || '') !== next) recordBlockHistory(block, block.text || '');
      block.text = next;

      const caret = before.length + inserted.length;
      input.focus();
      syncEditorHtml(input, next, selectStart ?? caret, selectEnd ?? selectStart ?? caret);

      queueSave();
      renderBacklinks();
      renderSearchResults();
      if (viewShowsGraph()) renderGraphView();

      closeAutocomplete();
    }

    function renderAutocompleteMenu() {
      if (!activeAutocomplete) return;
      const { input, host, suggestions, activeIndex, kind } = activeAutocomplete;
      activeAutocomplete.menu?.remove();

      if (!suggestions.length) return;

      const menu = document.createElement('div');
      menu.className = 'link-autocomplete' + (kind === 'slash' ? ' slash-command-menu' : '');

      suggestions.forEach((suggestion, idx) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'link-autocomplete-item' + (idx === activeIndex ? ' active' : '');
        if (kind === 'block-ref') {
          item.innerHTML = `<span>${escapeHtml(suggestion.text)}</span><small>${escapeHtml(suggestion.pageTitle)} · ${escapeHtml(suggestion.id)}</small>`;
        } else if (kind === 'slash') {
          item.innerHTML = `<span>/${escapeHtml(suggestion.label)}</span><small>${escapeHtml(suggestion.detail || '')}</small>`;
        } else {
          item.textContent = suggestion;
        }
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          audit('autocomplete.select.mouse', { suggestion, kind });
          applyAutocompleteSelection(suggestion);
        });
        menu.appendChild(item);
      });

      host.appendChild(menu);
      activeAutocomplete.menu = menu;
    }

    function updateAutocompleteForInput(input, block) {
      const host = input.parentElement;
      if (!host) return;

      const text = getEditorText(input);
      const { start } = getSelectionOffsets(input);
      let kind = 'wiki';
      let context = getSlashContext(text, start);
      let suggestions = [];
      if (context) {
        kind = 'slash';
        suggestions = getSlashSuggestions(context.query);
      } else {
        context = getBlockRefAutocompleteContext(text, start);
        if (context) {
          kind = 'block-ref';
          suggestions = getBlockRefSuggestions(context.query);
        } else {
          context = getAutocompleteContext(text, start);
          if (context) suggestions = getPageSuggestions(context.query);
        }
      }

      if (!context) {
        closeAutocomplete();
        return;
      }

      if (!suggestions.length) {
        auditAutocompleteNone(context.query);
        closeAutocomplete();
        return;
      }

      activeAutocomplete = {
        input,
        block,
        host,
        kind,
        context,
        suggestions,
        activeIndex: 0,
        menu: activeAutocomplete?.input === input ? activeAutocomplete.menu : null
      };

      auditAutocompleteShow(block?.id, context.query, suggestions.length);
      renderAutocompleteMenu();
    }

    function findBlockAncestors(blocks, targetId, path = []) {
      for (const block of blocks) {
        const next = [...path, block];
        if (block.id === targetId) return next;
        const found = findBlockAncestors(block.children || [], targetId, next);
        if (found) return found;
      }
      return null;
    }

    function getBacklinks(targetTitle) {
      const linkedByPage = new Map();
      const unlinkedByPage = new Map();
      const plainRx = new RegExp(`(^|[^\\[])(\\b${escapeRegExp(targetTitle)}\\b)(?!\\]\\])`, 'i');

      for (const [pageTitle, page] of Object.entries(state.pages)) {
        const isCurrentPage = pageTitle === targetTitle;
        if (isCurrentPage) continue;

        ensurePageSchema(page);
        walkBlocks(page.blocks, (block) => {
          const txt = block.text || '';
          const matches = [...txt.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => normalizeWikiTitle(m[1]));
          const ancestors = findBlockAncestors(page.blocks, block.id) || [];
          const breadcrumb = ancestors.slice(0, -1); // all ancestors except the block itself

          const ref = { pageTitle, blockId: block.id, text: txt, breadcrumb, children: block.children || [] };

          if (matches.includes(targetTitle)) {
            if (!linkedByPage.has(pageTitle)) linkedByPage.set(pageTitle, []);
            linkedByPage.get(pageTitle).push(ref);
          } else if (plainRx.test(txt)) {
            if (!unlinkedByPage.has(pageTitle)) unlinkedByPage.set(pageTitle, []);
            unlinkedByPage.get(pageTitle).push(ref);
          }
        });
      }

      return { linkedByPage, unlinkedByPage };
    }

    function getAllTagsWithCounts() {
      const counts = new Map();
      for (const page of Object.values(state.pages)) {
        ensurePageSchema(page);
        for (const tag of page.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    }

    function renderTagFilters() {
      const el = document.getElementById('tagFilters');
      const tags = getAllTagsWithCounts();
      if (!tags.length) {
        el.innerHTML = '<span class="muted">No tags yet</span>';
        return;
      }
      const allChip = `<span class="tag-chip" data-tag="">All</span>`;
      el.innerHTML = allChip + tags.map(([tag, count]) => `<span class="tag-chip" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)} (${count})</span>`).join('');
      el.querySelectorAll('.tag-chip').forEach(chip => {
        const tag = chip.dataset.tag || null;
        if ((tag || null) === (currentTagFilter || null)) chip.style.outline = '1px solid #8dd0ff';
        chip.addEventListener('click', () => {
          currentTagFilter = tag || null;
          renderPagesList();
          renderTagFilters();
        });
      });
    }

    function gatherSearchResults(query) {
      const q = (query || '').trim().toLowerCase();
      if (!q) return [];
      const out = [];

      // Priority tiers (lower number = higher priority):
      //   0 — page title exact match
      //   1 — page title starts with query
      //   2 — page title contains query
      //   3 — block text starts with query (after trimming)
      //   4 — block text contains query
      function pagePriority(title) {
        const t = title.toLowerCase();
        if (t === q) return 0;
        if (t.startsWith(q)) return 1;
        return 2;
      }

      function blockPriority(text) {
        const t = (text || '').trim().toLowerCase();
        if (t.startsWith(q)) return 3;
        return 4;
      }

      for (const [pageTitle, page] of Object.entries(state.pages)) {
        const tl = pageTitle.toLowerCase();
        if (tl.includes(q)) {
          out.push({ type: 'page', pageTitle, text: pageTitle, _rank: pagePriority(pageTitle) });
        }
        walkBlocks(page.blocks, (block) => {
          const txt = (block.text || '');
          if (txt.toLowerCase().includes(q)) {
            out.push({ type: 'block', pageTitle, text: txt, _rank: blockPriority(txt) });
          }
        });
      }

      // Sort by rank first, then alphabetically by pageTitle for stable ordering
      out.sort((a, b) => {
        if (a._rank !== b._rank) return a._rank - b._rank;
        return a.pageTitle.localeCompare(b.pageTitle);
      });

      return out.slice(0, 100);
    }

    function renderSearchResults() {
      const q = document.getElementById('searchInput').value || '';
      const el = document.getElementById('searchResults');
      if (!q.trim()) {
        el.innerHTML = '';
        return;
      }
      if (searchResultsCollapsed) {
        el.innerHTML = '';
        return;
      }
      const results = gatherSearchResults(q);
      if (!results.length) {
        el.innerHTML = '<div class="muted">No matches</div>';
        return;
      }
      el.innerHTML = results.map(r => `
        <div class="search-item" data-open-page="${escapeHtml(r.pageTitle)}" tabindex="0" role="button" aria-label="Open page ${escapeHtml(r.pageTitle)}">
          <div class="from"><a data-open-page="${escapeHtml(r.pageTitle)}">${escapeHtml(r.pageTitle)}</a> Ã‚Â· ${r.type}</div>
          <div class="snippet">${renderRichText(r.text)}</div>
        </div>
      `).join('');
      el.querySelectorAll('.search-item[data-open-page]').forEach(item => {
        item.addEventListener('click', async (e) => {
          if (e.target.closest('a[data-open-page], a[data-wiki]')) return;
          await openSearchResultPage(item.dataset.openPage);
        });
        item.addEventListener('keydown', async (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            await openSearchResultPage(item.dataset.openPage);
          }
        });
      });
      el.querySelectorAll('a[data-open-page]').forEach(a => {
        a.addEventListener('click', async (e) => { e.preventDefault(); e.stopPropagation(); await openSearchResultPage(a.dataset.openPage); });
      });
      el.querySelectorAll('a[data-wiki]').forEach(a => {
        a.addEventListener('click', async (e) => { e.preventDefault(); e.stopPropagation(); await openSearchResultPage(a.dataset.wiki); });
      });
    }

    async function openSearchResultPage(title) {
      searchResultsCollapsed = true;
      const el = document.getElementById('searchResults');
      if (el) el.innerHTML = '';
      await setCurrentPage(title);
    }

    function renderPagesList() {
      const list = document.getElementById('pagesList');
      list.innerHTML = '';
      let titles = Object.keys(state.pages).sort((a, b) => a.localeCompare(b));
      if (currentTagFilter) {
        titles = titles.filter(t => {
          const page = state.pages[t];
          ensurePageSchema(page);
          return page.tags.includes(currentTagFilter);
        });
      }
      for (const title of titles) {
        const li = document.createElement('li');
        const row = document.createElement('div');
        row.className = 'page-row';

        const btn = document.createElement('button');
        btn.className = 'page-btn' + (title === state.currentPage ? ' active' : '');
        const page = state.pages[title];
        const suffix = page.tags?.length ? `  Â·  ${page.tags.map(t => '#' + t).join(' ')}` : '';
        btn.textContent = title + suffix;
        btn.title = 'Open page';
        btn.addEventListener('click', () => { setCurrentPage(title); });

        const delBtn = document.createElement('button');
        delBtn.className = 'page-delete-btn';
        delBtn.type = 'button';
        delBtn.title = `Delete page "${title}"`;
        delBtn.setAttribute('aria-label', `Delete page ${title}`);
        delBtn.textContent = 'Del';
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();

          const allTitles = Object.keys(state.pages);
          if (allTitles.length <= 1) {
            alert('Cannot delete the last remaining page.');
            return;
          }

          const ok = confirm('Delete page "' + title + '"? This cannot be undone.');
          if (!ok) return;

          const wasCurrent = state.currentPage === title;
          delete state.pages[title];
          pageBackStack = pageBackStack.filter(pageTitle => pageTitle !== title);

          if (wasCurrent) {
            const remaining = Object.keys(state.pages).sort((a, b) => a.localeCompare(b));
            state.currentPage = remaining[0] || '';
            if (!state.currentPage) state = defaultData();
          }

          await saveData();
          render();
        });

        row.appendChild(btn);
        row.appendChild(delBtn);
        li.appendChild(row);
        list.appendChild(li);
      }
      if (!titles.length) {
        const li = document.createElement('li');
        li.innerHTML = '<div class="muted">No pages for this tag</div>';
        list.appendChild(li);
      }
    }

    function toggleTaskInBlock(block, checked) {
      const text = block.text || '';
      if (/^\s*[-*]\s+\[[ xX]\]/.test(text)) {
        block.text = text.replace(/^(\s*[-*]\s+\[)[ xX](\])/, `$1${checked ? 'x' : ' '}$2`);
        return;
      }
      if (/^\s*\{\{\[\[(TODO|DONE)\]\]\}\}/i.test(text)) {
        block.text = text.replace(/\{\{\[\[(TODO|DONE)\]\]\}\}/i, `{{[[${checked ? 'DONE' : 'TODO'}]]}}`);
      }
    }

    function updateBlockSelection(blockId, { range = false, toggle = false } = {}) {
      const ids = getVisibleBlockIds();
      if (range && lastSelectedBlockId && ids.includes(lastSelectedBlockId) && ids.includes(blockId)) {
        const a = ids.indexOf(lastSelectedBlockId);
        const b = ids.indexOf(blockId);
        selectedBlockIds = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
      } else if (toggle) {
        if (selectedBlockIds.has(blockId)) selectedBlockIds.delete(blockId);
        else selectedBlockIds.add(blockId);
        lastSelectedBlockId = blockId;
      } else {
        selectedBlockIds = new Set([blockId]);
        lastSelectedBlockId = blockId;
      }
    }

    function selectedBlocksInVisibleOrder() {
      return getVisibleBlockIds().filter(id => selectedBlockIds.has(id));
    }

    async function deleteSelectedBlocks() {
      const page = getCurrentPage();
      const ids = selectedBlocksInVisibleOrder();
      if (!ids.length) return;
      const firstPrev = getPreviousVisibleBlockId(ids[0]) || getNextVisibleBlockId(ids[ids.length - 1]);
      for (const id of [...ids].reverse()) {
        const ctx = findBlockContext(page.blocks, id);
        if (ctx) ctx.array.splice(ctx.index, 1);
      }
      if (page.blocks.length === 0) page.blocks.push({ id: uid(), text: '', children: [] });
      pendingFocus = firstPrev || page.blocks[0].id;
      selectedBlockIds.clear();
      await saveData();
    }

    async function indentSelectedBlocks(indent = true) {
      const page = getCurrentPage();
      const ids = selectedBlocksInVisibleOrder();
      if (!ids.length) return;
      if (indent) {
        for (const id of ids) {
          const ctx = findBlockContext(page.blocks, id);
          if (!ctx || ctx.index === 0) continue;
          const prev = ctx.array[ctx.index - 1];
          if (selectedBlockIds.has(prev.id)) continue;
          ctx.array.splice(ctx.index, 1);
          prev.children.push(ctx.block);
        }
      } else {
        for (const id of ids) {
          const ctx = findBlockContext(page.blocks, id);
          if (!ctx || !ctx.parentBlock) continue;
          const parentCtx = findBlockContext(page.blocks, ctx.parentBlock.id);
          if (!parentCtx) continue;
          ctx.array.splice(ctx.index, 1);
          parentCtx.array.splice(parentCtx.index + 1, 0, ctx.block);
        }
      }
      await saveData();
    }

    function getBlockMergeSeparator(leftText, rightText) {
      const left = leftText || '';
      const right = rightText || '';
      if (!left || !right) return '';
      if (/\s$/.test(left) || /^\s/.test(right)) return '';
      if (/^[,.;:!?)]/.test(right)) return '';
      if (/[(\[{]$/.test(left)) return '';
      return ' ';
    }

    function mergeBlockIntoPreviousVisibleBlock(block) {
      const page = getCurrentPage();
      const ctx = findBlockContext(page.blocks, block.id);
      const prevId = getPreviousVisibleBlockId(block.id);
      if (!ctx || !prevId) return false;

      const prevCtx = findBlockContext(page.blocks, prevId);
      if (!prevCtx || prevCtx.block.id === block.id || isDescendantBlock(prevCtx.block, block)) return false;

      const prevText = prevCtx.block.text || '';
      const currentText = block.text || '';
      const separator = getBlockMergeSeparator(prevText, currentText);
      const caret = prevText.length + separator.length;

      recordBlockHistory(prevCtx.block, prevText);
      prevCtx.block.text = prevText + separator + currentText;
      if (block.children && block.children.length) {
        prevCtx.block.children = prevCtx.block.children || [];
        prevCtx.block.children.push(...block.children);
      }

      ctx.array.splice(ctx.index, 1);
      selectedBlockIds.delete(block.id);
      pendingFocus = prevCtx.block.id;
      pendingFocusOffset = caret;
      return true;
    }

    function renderBlockNode(block, container) {
      const wrap = document.createElement('div');
      wrap.className = 'block';
      if (selectedBlockIds.has(block.id)) wrap.classList.add('selected');
      wrap.dataset.blockId = block.id;
      wrap.setAttribute('draggable', 'true');

      const row = document.createElement('div');
      row.className = 'block-row';

      wrap.addEventListener('dragstart', (e) => {
        if (e.target && e.target.closest('.block-input')) {
          e.preventDefault();
          return;
        }
        dragState.sourceId = block.id;
        dragState.overId = null;
        dragState.position = null;
        wrap.classList.add('drag-source');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', block.id);
        }
      });

      wrap.addEventListener('dragover', (e) => {
        const sourceId = dragState.sourceId;
        if (!sourceId || sourceId === block.id) return;

        const page = getCurrentPage();
        const sourceCtx = findBlockContext(page.blocks, sourceId);
        const targetCtx = findBlockContext(page.blocks, block.id);
        if (!sourceCtx || !targetCtx) return;
        if (isDescendantBlock(targetCtx.block, sourceCtx.block)) return;

        e.preventDefault();
        const rect = wrap.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const nextPos = y < rect.height / 2 ? 'before' : 'after';

        if (dragState.overId !== block.id || dragState.position !== nextPos) {
          dragState.overId = block.id;
          dragState.position = nextPos;
          document.querySelectorAll('.block.drop-before, .block.drop-after').forEach(el => {
            el.classList.remove('drop-before', 'drop-after');
          });
          wrap.classList.add(nextPos === 'before' ? 'drop-before' : 'drop-after');
        }
      });

      wrap.addEventListener('drop', async (e) => {
        e.preventDefault();
        const sourceId = dragState.sourceId;
        const targetId = block.id;
        const position = dragState.position;

        dragState = { sourceId: null, overId: null, position: null };
        document.querySelectorAll('.block.drag-source, .block.drop-before, .block.drop-after').forEach(el => {
          el.classList.remove('drag-source', 'drop-before', 'drop-after');
        });

        if (!sourceId || !position || sourceId === targetId) return;
        await reorderSelectedBlocks(sourceId, targetId, position);
      });

      wrap.addEventListener('dragend', () => {
        dragState = { sourceId: null, overId: null, position: null };
        document.querySelectorAll('.block.drag-source, .block.drop-before, .block.drop-after').forEach(el => {
          el.classList.remove('drag-source', 'drop-before', 'drop-after');
        });
      });

      const bullet = document.createElement('div');
      bullet.className = 'bullet';
      const hasChildren = Boolean(block.children && block.children.length);

      const collapseBtn = document.createElement('button');
      collapseBtn.type = 'button';
      collapseBtn.className = 'collapse-toggle';
      collapseBtn.textContent = hasChildren ? (block.collapsed ? '▸' : '▾') : '';
      collapseBtn.title = hasChildren ? (block.collapsed ? 'Expand children' : 'Collapse children') : '';
      collapseBtn.disabled = !hasChildren;
      collapseBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!hasChildren) return;
        block.collapsed = !block.collapsed;
        await saveData();
        renderBlocks();
      });

      const zoomBtn = document.createElement('button');
      zoomBtn.type = 'button';
      zoomBtn.className = 'bullet-dot';
      zoomBtn.textContent = '•';
      zoomBtn.title = 'Click to zoom into this block. Shift-click selects blocks. Alt-click copies block reference.';
      zoomBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.altKey) {
          const ref = `((${block.id}))`;
          const ok = await copyText(ref);
          zoomBtn.textContent = ok ? 'OK' : '!';
          setTimeout(() => { zoomBtn.textContent = '•'; }, 800);
          return;
        }
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          updateBlockSelection(block.id, { range: e.shiftKey, toggle: e.ctrlKey || e.metaKey });
          renderBlocks();
          return;
        }
        zoomedBlockId = block.id;
        selectedBlockIds.clear();
        lastSelectedBlockId = null;
        render();
      });
      bullet.appendChild(collapseBtn);
      bullet.appendChild(zoomBtn);

      // Preview shown by default; contenteditable editor opens on click and keeps live markdown highlighting.
      const preview = document.createElement('div');
      preview.className = 'preview preview-editable';
      preview.innerHTML = renderMarkdown(block.text || '');

      const input = document.createElement('div');
      input.className = 'block-input';
      input.contentEditable = 'true';
      input.spellcheck = true;
      input.innerHTML = renderEditorMarkdown(block.text || '');
      input.dataset.blockId = block.id;
      input.style.display = 'none';

      function attachPreviewHandlers() {
        preview.querySelectorAll('a[data-wiki]').forEach(a => {
          a.addEventListener('click', (e) => { e.preventDefault(); setCurrentPage(a.dataset.wiki); });
        });
        preview.querySelectorAll('a[data-open-page]').forEach(a => {
          a.addEventListener('click', (e) => { e.preventDefault(); setCurrentPage(a.dataset.openPage); });
        });
        preview.querySelectorAll('input[data-task-toggle]').forEach(box => {
          box.addEventListener('click', async (e) => {
            e.stopPropagation();
            toggleTaskInBlock(block, box.checked);
            await saveData();
            preview.innerHTML = renderMarkdown(block.text || '');
            attachPreviewHandlers();
            scheduleHeavyRenders();
          });
        });
      }
      attachPreviewHandlers();

      // Click preview -> enter edit mode
      preview.addEventListener('click', (e) => {
        if (e.target.closest('a, input, button')) return;
        closeAutocomplete();
        preview.style.display = 'none';
        input.style.display = '';
        input.focus();
        const len = getEditorText(input).length;
        setSelectionOffsets(input, len, len);
      });

      // Blur editor -> exit edit mode, re-render preview
      input.addEventListener('blur', () => {
        audit('block.blur', { blockId: block.id });
        setTimeout(() => {
          if (activeAutocomplete?.input === input) closeAutocomplete();
        }, 0);
        input.style.display = 'none';
        preview.style.display = '';
        preview.innerHTML = renderMarkdown(block.text || '');
        attachPreviewHandlers();
        renderBacklinks();
        if (viewShowsGraph()) renderGraphView();
      });

      input.addEventListener('input', (e) => {
        const { start } = getSelectionOffsets(input);
        const raw = getEditorText(input);
        const expanded = expandDateShortcut(raw, start);
        const next = expanded.changed ? expanded.value : raw;
        const caret = expanded.changed ? expanded.caret : start;
        if (block.text !== next) recordBlockHistory(block, block.text || '');
        block.text = next;
        syncEditorHtml(input, next, caret);
        queueSave();
        scheduleHeavyRenders();
        updateAutocompleteForInput(input, block);
      });

      input.addEventListener('paste', async (e) => {
        if (isSelectionInsideFencedCode(input)) {
          const plain = e.clipboardData?.getData('text/plain') || '';
          if (plain) {
            e.preventDefault();
            closeAutocomplete();
            insertPlainTextPaste(input, block, plain, { upgradeCodeFence: true });
            return;
          }
        }

        const pastedBlocks = parseClipboardBlocks(e.clipboardData);
        if (pastedOutlineHasStructure(pastedBlocks)) {
          e.preventDefault();
          closeAutocomplete();
          await pasteOutlineBlocksIntoEditor(input, block, pastedBlocks);
          return;
        }

        // Single-line paste: convert HTML inline formatting (bold, italic, code…) to markdown,
        // then insert at the cursor position ourselves so formatting is preserved.
        const html = e.clipboardData?.getData('text/html') || '';
        const plain = e.clipboardData?.getData('text/plain') || '';
        if (html && plain) {
          try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const mdText = Array.from(doc.body.childNodes).map(htmlNodeToMarkdown).join('').replace(/\s+/g, ' ').trim();
            // Only use the markdown conversion if it differs from plain text (i.e. it has formatting)
            if (mdText && mdText !== plain.trim()) {
              e.preventDefault();
              closeAutocomplete();
              const { start, end } = getSelectionOffsets(input);
              const current = getEditorText(input);
              const next = current.slice(0, start) + mdText + current.slice(end);
              recordBlockHistory(block, block.text || '');
              block.text = next;
              const newCaret = start + mdText.length;
              syncEditorHtml(input, next, newCaret);
              queueSave();
              scheduleHeavyRenders();
              return;
            }
          } catch (err) {
            // fall through to native paste
          }
        }
      });

      input.addEventListener('keydown', async (e) => {
        const page = getCurrentPage();
        const ctx = findBlockContext(page.blocks, block.id);
        if (!ctx) return;

        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
          const key = e.key.toLowerCase();
          if (key === 'z') {
            e.preventDefault();
            undoBlockEdit(input, block, e.shiftKey ? 'redo' : 'undo');
            return;
          }
          if (key === 'y') {
            e.preventDefault();
            undoBlockEdit(input, block, 'redo');
            return;
          }
          if (key === 'b') {
            e.preventDefault();
            wrapEditorSelection(input, block, '**');
            return;
          }
          if (key === 'i') {
            e.preventDefault();
            wrapEditorSelection(input, block, '*');
            return;
          }
          if (key === 'h') {
            e.preventDefault();
            wrapEditorSelection(input, block, e.shiftKey ? '~~' : '^^');
            return;
          }
          if (e.key === '`') {
            e.preventDefault();
            wrapEditorSelection(input, block, '`');
            return;
          }
          if (key === 'n') {
            const { start, end } = getSelectionOffsets(input);
            const text = getEditorText(input);
            const sel = start !== end
              ? text.substring(start, end).trim()
              : '';
            if (sel) {
              // Selected text -> link it in the source block and ensure the page exists.
              e.preventDefault();
              const replacement = `[[${sel}]]`;
              replaceEditorRange(input, block, start, end, replacement, start + replacement.length);
              ensurePage(sel);
              await saveData();
              renderPagesList();
              return;
            }
            // Nothing selected → focus the New Page input in the sidebar
            e.preventDefault();
            openLeftSidebar();
            const npi = document.getElementById('newPageInput');
            if (npi) { npi.focus(); npi.select(); }
            return;
          }
        }

        const ac = activeAutocomplete?.input === input ? activeAutocomplete : null;
        if (ac) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            ac.activeIndex = (ac.activeIndex + 1) % ac.suggestions.length;
            renderAutocompleteMenu();
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            ac.activeIndex = (ac.activeIndex - 1 + ac.suggestions.length) % ac.suggestions.length;
            renderAutocompleteMenu();
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            closeAutocomplete();
            return;
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const selected = ac.suggestions[ac.activeIndex] || ac.suggestions[0];
            if (selected) {
              audit('autocomplete.select.enter', { selected, index: ac.activeIndex });
              applyAutocompleteSelection(selected);
              return;
            }
          }
        }

        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          const { start } = getSelectionOffsets(input);
          const text = getEditorText(input);
          const onFirstLine = !text.slice(0, start).includes('\n');
          const onLastLine = !text.slice(start).includes('\n');
          if (e.key === 'ArrowUp' && onFirstLine) {
            const prevId = getPreviousVisibleBlockId(block.id);
            if (prevId) {
              e.preventDefault();
              pendingFocus = prevId;
              pendingFocusOffset = Number.POSITIVE_INFINITY;
              renderBlocks();
              return;
            }
          }
          if (e.key === 'ArrowDown' && onLastLine) {
            const nextId = getNextVisibleBlockId(block.id);
            if (nextId) {
              e.preventDefault();
              pendingFocus = nextId;
              pendingFocusOffset = Number.POSITIVE_INFINITY;
              renderBlocks();
              return;
            }
          }
        }

        if (e.key === 'Enter' && e.shiftKey) {
          e.preventDefault();
          const { start, end } = getSelectionOffsets(input);
          replaceEditorRange(input, block, start, end, '\n', start + 1);
          return;
        }

        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const newBlock = { id: uid(), text: '', children: [] };
          ctx.array.splice(ctx.index + 1, 0, newBlock);
          pendingFocus = newBlock.id;
          await saveData();
          render();
          return;
        }

        if (e.key === 'Tab') {
          e.preventDefault();
          if (selectedBlockIds.size > 1) {
            await indentSelectedBlocks(!e.shiftKey);
            pendingFocus = block.id;
            render();
            return;
          }
          if (!e.shiftKey) {
            if (ctx.index === 0) return;
            const prev = ctx.array[ctx.index - 1];
            ctx.array.splice(ctx.index, 1);
            prev.children.push(ctx.block);
            pendingFocus = ctx.block.id;
            await saveData();
            render();
            return;
          }
          if (!ctx.parentBlock) return;
          const parentCtx = findBlockContext(page.blocks, ctx.parentBlock.id);
          if (!parentCtx) return;
          ctx.array.splice(ctx.index, 1);
          parentCtx.array.splice(parentCtx.index + 1, 0, ctx.block);
          pendingFocus = ctx.block.id;
          await saveData();
          render();
          return;
        }

        if (e.key === 'Backspace' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
          const { start, end } = getSelectionOffsets(input);
          if (start === 0 && end === 0 && getEditorText(input).length > 0 && mergeBlockIntoPreviousVisibleBlock(block)) {
            e.preventDefault();
            closeAutocomplete();
            await saveData();
            render();
            return;
          }
        }

        if (e.key === 'Backspace' && !e.shiftKey && !e.ctrlKey && !e.metaKey && getEditorText(input).length === 0) {
          e.preventDefault();
          if (selectedBlockIds.size > 1) {
            await deleteSelectedBlocks();
            render();
            return;
          }
          const c = findBlockContext(page.blocks, block.id);
          if (!c) return;
          const prevId = c.index > 0 ? c.array[c.index - 1].id : (c.parentBlock ? c.parentBlock.id : null);
          c.array.splice(c.index, 1);
          if (page.blocks.length === 0) {
            page.blocks.push({ id: uid(), text: '', children: [] });
            pendingFocus = page.blocks[0].id;
          } else {
            pendingFocus = prevId;
          }
          await saveData();
          render();
        }
      });

      const contentDiv = document.createElement('div');
      contentDiv.style.cssText = 'flex:1;min-width:0;position:relative;';
      contentDiv.appendChild(preview);
      contentDiv.appendChild(input);

      row.appendChild(bullet);
      row.appendChild(contentDiv);
      wrap.appendChild(row);

      if (!block.collapsed && block.children && block.children.length) {
        const childrenWrap = document.createElement('div');
        childrenWrap.className = 'children';
        for (const child of block.children) renderBlockNode(child, childrenWrap);
        wrap.appendChild(childrenWrap);
      }

      container.appendChild(wrap);
    }

    function renderBlocks() {
      const page = getCurrentPage();
      const blocksEl = document.getElementById('blocks');
      blocksEl.innerHTML = '';

      if (!page.blocks.length) page.blocks.push({ id: uid(), text: '', children: [] });

      const zoomCtx = getZoomRootContext(page);
      if (zoomCtx) {
        renderZoomBreadcrumbs(blocksEl, zoomCtx.block);
        renderBlockNode(zoomCtx.block, blocksEl);
      } else {
        for (const block of page.blocks) renderBlockNode(block, blocksEl);
      }

      if (pendingFocus) {
        const target = document.querySelector(`.block-input[data-block-id="${pendingFocus}"]`);
        if (target) {
          const blockWrap = target.closest('.block');
          const previewEl = blockWrap?.querySelector('.preview');
          if (previewEl) previewEl.style.display = 'none';
          target.style.display = '';
          target.focus();
          const len = getEditorText(target).length;
          const offset = pendingFocusOffset === Number.POSITIVE_INFINITY ? len : (pendingFocusOffset ?? len);
          setSelectionOffsets(target, offset, offset);
        }
        pendingFocus = null;
        pendingFocusOffset = null;
      }
    }

    function renderZoomBreadcrumbs(container, block) {
      const path = findBlockPath(getCurrentPage().blocks, block.id) || [block];
      const bar = document.createElement('div');
      bar.className = 'zoom-breadcrumbs';

      const pageBtn = document.createElement('button');
      pageBtn.type = 'button';
      pageBtn.textContent = state.currentPage;
      pageBtn.addEventListener('click', () => {
        zoomedBlockId = null;
        render();
      });
      bar.appendChild(pageBtn);

      path.forEach((item, idx) => {
        const sep = document.createElement('span');
        sep.textContent = '/';
        bar.appendChild(sep);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = (item.text || 'Untitled block').replace(/\s+/g, ' ').slice(0, 36);
        btn.disabled = idx === path.length - 1;
        btn.addEventListener('click', () => {
          zoomedBlockId = item.id;
          render();
        });
        bar.appendChild(btn);
      });

      const exitBtn = document.createElement('button');
      exitBtn.type = 'button';
      exitBtn.className = 'zoom-exit';
      exitBtn.textContent = 'Exit zoom';
      exitBtn.addEventListener('click', () => {
        zoomedBlockId = null;
        render();
      });
      bar.appendChild(exitBtn);
      container.appendChild(bar);
    }

    // Track which page groups are collapsed in the linked refs panel
    let linkedRefsCollapsed = new Set();
    let unlinkedRefsSectionCollapsed = false;

    function renderRefBlockWithChildren(block, targetTitle, depth = 0) {
      const highlightedText = renderRichTextHighlighted(block.text || '', targetTitle);
      let html = `<div class="ref-block" style="${depth > 0 ? `margin-left:${depth * 18}px;border-left:2px solid var(--ref-indent-border, #2b3550);padding-left:8px;` : ''}">`;
      html += `<div class="ref-block-text">${highlightedText}</div>`;
      const visibleChildren = (block.children || []).filter(c => c.text || (c.children && c.children.length));
      if (visibleChildren.length) {
        html += visibleChildren.map(child => renderRefBlockWithChildren(child, targetTitle, depth + 1)).join('');
      }
      html += '</div>';
      return html;
    }

    function renderRichTextHighlighted(text, highlightTitle) {
      // Renders rich text but highlights the [[highlightTitle]] links
      const rendered = renderRichText(text);
      // Wrap all data-wiki links matching the target with a highlight class
      const safeTitle = escapeHtml(highlightTitle);
      return rendered.replace(
        new RegExp(`<a data-wiki="${safeTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"([^>]*)>`, 'gi'),
        `<a data-wiki="${safeTitle}"$1 class="linked-ref-highlight">`
      );
    }

    function renderBreadcrumb(breadcrumb, pageTitle) {
      if (!breadcrumb || !breadcrumb.length) return '';
      const crumbs = breadcrumb.map(b => {
        const truncated = (b.text || 'Untitled block').replace(/\s+/g, ' ').slice(0, 40);
        return `<span class="ref-breadcrumb-item" title="${escapeHtml(b.text || '')}">${escapeHtml(truncated)}${(b.text || '').length > 40 ? '…' : ''}</span>`;
      });
      return `<div class="ref-breadcrumb"><span class="ref-breadcrumb-page">${escapeHtml(pageTitle)}</span>${crumbs.length ? ' <span class="ref-breadcrumb-sep">›</span> ' + crumbs.join(' <span class="ref-breadcrumb-sep">›</span> ') : ''}</div>`;
    }

    function renderBacklinks() {
      const { linkedByPage, unlinkedByPage } = getBacklinks(state.currentPage);
      const el = document.getElementById('backlinks');

      const totalLinked = [...linkedByPage.values()].reduce((s, arr) => s + arr.length, 0);
      const totalUnlinked = [...unlinkedByPage.values()].reduce((s, arr) => s + arr.length, 0);

      if (totalLinked === 0 && totalUnlinked === 0) {
        el.innerHTML = '<div class="backlinks-empty"><span class="backlinks-empty-icon">🔗</span><div>No references to this page yet.</div><div class="muted" style="margin-top:4px;font-size:11px;">Create links using [[PageName]] syntax</div></div>';
        return;
      }

      let html = '';

      // ── Linked References section ──
      html += `<div class="backlinks-section-header">`;
      html += `<span class="backlinks-section-title">Linked References</span>`;
      html += `<span class="backlinks-count-badge">${totalLinked}</span>`;
      html += `</div>`;

      if (totalLinked === 0) {
        html += '<div class="muted" style="padding:8px 2px;font-size:12px;">No linked references.</div>';
      } else {
        for (const [pageTitle, refs] of linkedByPage) {
          const collapsed = linkedRefsCollapsed.has(pageTitle);
          const pageRefCount = refs.length;
          html += `<div class="ref-page-group" data-ref-page="${escapeHtml(pageTitle)}">` +
            `<div class="ref-page-header">` +
            `<button class="ref-page-collapse-btn" data-collapse-page="${escapeHtml(pageTitle)}" aria-expanded="${collapsed ? 'false' : 'true'}" title="${collapsed ? 'Expand' : 'Collapse'}">${collapsed ? '▸' : '▾'}</button>` +
            `<a class="ref-page-title" data-open-page="${escapeHtml(pageTitle)}">${escapeHtml(pageTitle)}</a>` +
            `<span class="ref-page-count">${pageRefCount}</span>` +
            `</div>`;
          if (!collapsed) {
            html += `<div class="ref-page-blocks">`;
            for (const ref of refs) {
              html += `<div class="ref-item" data-block-id="${escapeHtml(ref.blockId)}">` +
                (ref.breadcrumb.length ? renderBreadcrumb(ref.breadcrumb, pageTitle) : '') +
                renderRefBlockWithChildren({ text: ref.text, children: ref.children }, state.currentPage) +
                `</div>`;
            }
            html += `</div>`;
          }
          html += `</div>`;
        }
      }

      // ── Unlinked References section ──
      if (totalUnlinked > 0) {
        const ulCollapsed = unlinkedRefsSectionCollapsed;
        html += `<div class="backlinks-section-header" style="margin-top:16px;">` +
          `<button class="ref-section-collapse-btn" id="unlinkedSectionToggle" aria-expanded="${ulCollapsed ? 'false' : 'true'}">${ulCollapsed ? '▸' : '▾'}</button>` +
          `<span class="backlinks-section-title">Unlinked References</span>` +
          `<span class="backlinks-count-badge backlinks-count-unlinked">${totalUnlinked}</span>` +
          `</div>`;

        if (!ulCollapsed) {
          for (const [pageTitle, refs] of unlinkedByPage) {
            const collapsed = linkedRefsCollapsed.has('__unlinked__' + pageTitle);
            const pageRefCount = refs.length;
            html += `<div class="ref-page-group" data-ref-page="${escapeHtml(pageTitle)}" data-unlinked="1">` +
              `<div class="ref-page-header">` +
              `<button class="ref-page-collapse-btn" data-collapse-page="${escapeHtml(pageTitle)}" data-unlinked="1" aria-expanded="${collapsed ? 'false' : 'true'}">${collapsed ? '▸' : '▾'}</button>` +
              `<a class="ref-page-title" data-open-page="${escapeHtml(pageTitle)}">${escapeHtml(pageTitle)}</a>` +
              `<span class="ref-page-count">${pageRefCount}</span>` +
              `</div>`;
            if (!collapsed) {
              html += `<div class="ref-page-blocks">`;
              for (const ref of refs) {
                html += `<div class="ref-item ref-item-unlinked" data-block-id="${escapeHtml(ref.blockId)}">` +
                  (ref.breadcrumb.length ? renderBreadcrumb(ref.breadcrumb, pageTitle) : '') +
                  renderRefBlockWithChildren({ text: ref.text, children: ref.children }, state.currentPage) +
                  `<button class="convert-unlinked-btn" data-block-id="${escapeHtml(ref.blockId)}" type="button"><span>🔗</span> Link mention</button>` +
                  `</div>`;
              }
              html += `</div>`;
            }
            html += `</div>`;
          }
        }
      }

      el.innerHTML = html;

      // Wire up page link clicks
      el.querySelectorAll('a[data-open-page]').forEach(a => {
        a.addEventListener('click', (e) => { e.preventDefault(); setCurrentPage(a.dataset.openPage); });
      });
      el.querySelectorAll('a[data-wiki]').forEach(a => {
        a.addEventListener('click', (e) => { e.preventDefault(); setCurrentPage(a.dataset.wiki); });
      });

      // Wire up page group collapse toggles (linked)
      el.querySelectorAll('.ref-page-collapse-btn[data-collapse-page]:not([data-unlinked])').forEach(btn => {
        btn.addEventListener('click', () => {
          const pg = btn.dataset.collapsePage;
          if (linkedRefsCollapsed.has(pg)) linkedRefsCollapsed.delete(pg);
          else linkedRefsCollapsed.add(pg);
          renderBacklinks();
        });
      });

      // Wire up page group collapse toggles (unlinked)
      el.querySelectorAll('.ref-page-collapse-btn[data-collapse-page][data-unlinked]').forEach(btn => {
        btn.addEventListener('click', () => {
          const key = '__unlinked__' + btn.dataset.collapsePage;
          if (linkedRefsCollapsed.has(key)) linkedRefsCollapsed.delete(key);
          else linkedRefsCollapsed.add(key);
          renderBacklinks();
        });
      });

      // Wire up unlinked section collapse toggle
      const ulToggle = el.querySelector('#unlinkedSectionToggle');
      if (ulToggle) {
        ulToggle.addEventListener('click', () => {
          unlinkedRefsSectionCollapsed = !unlinkedRefsSectionCollapsed;
          renderBacklinks();
        });
      }

      // Wire up convert-to-link buttons
      el.querySelectorAll('.convert-unlinked-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const found = findBlockById(btn.dataset.blockId);
          if (!found) return;
          const rx = new RegExp(`(^|[^\\[])(${escapeRegExp(state.currentPage)})(?!\\]\\])`, 'i');
          found.block.text = (found.block.text || '').replace(rx, (_m, prefix, title) => `${prefix}[[${title}]]`);
          await saveData();
          render();
        });
      });

      // Wire up ref-item click to navigate to source block
      el.querySelectorAll('.ref-item[data-block-id]').forEach(item => {
        item.addEventListener('click', (e) => {
          if (e.target.closest('a, button, input')) return;
          const blockId = item.dataset.blockId;
          const found = findBlockById(blockId);
          if (found) setCurrentPage(found.pageTitle);
        });
      });
    }

    function syncPageTitleWidth() {
      const input = document.getElementById('pageTitle');
      if (!input) return;
      const len = Math.max((input.value || '').length, 2);
      input.style.width = `${len + 1}ch`;
    }

    function renderCurrentPageMeta() {
      const titleInput = document.getElementById('pageTitle');
      titleInput.value = state.currentPage;
      syncPageTitleWidth();
    }

    function renderPageTags() {
      const page = getCurrentPage();
      ensurePageSchema(page);
      const listEl = document.getElementById('pageTagsList');
      const tagsHtml = page.tags.map(tag => `<span class="tag-chip" data-open-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</span>`).join('');
      if (!page.tags.length) {
        listEl.innerHTML = '<span class="muted">No tags on this page</span> <button class="tag-add-inline" data-add-tag="1">+tag</button>';
        return;
      }
      listEl.innerHTML = `${tagsHtml} <button class="tag-add-inline" data-add-tag="1">+tag</button>`;
      listEl.querySelectorAll('.tag-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          currentTagFilter = chip.dataset.openTag;
          renderPagesList();
          renderTagFilters();
        });
      });
    }

    function showTagAddForm() {
      document.getElementById('tagAddForm').classList.remove('hidden');
      const input = document.getElementById('newTagInput');
      input.value = '';
      input.focus();
    }

    function hideTagAddForm() {
      document.getElementById('tagAddForm').classList.add('hidden');
      document.getElementById('newTagInput').value = '';
    }

    async function saveNewTagFromInput() {
      const page = getCurrentPage();
      ensurePageSchema(page);
      const raw = (document.getElementById('newTagInput').value || '').trim();
      const normalized = normalizeTag(raw);
      if (!normalized) return;
      page.tags = [...new Set([...(page.tags || []), normalized])];
      hideTagAddForm();
      await saveData();
      renderPagesList();
      renderTagFilters();
      renderPageTags();
      renderSearchResults();
      renderViewMode();
      renderThemeToggle();
    }

    function render() {
      renderBackButtonState();
      renderPagesList();
      renderTagFilters();
      renderCurrentPageMeta();
      renderPageTags();
      renderBlocks();
      renderBacklinks();
      renderSearchResults();
      renderViewMode();
      renderThemeToggle();
    }

    async function openOrCreateFromInput() {
      const input = document.getElementById('newPageInput');
      const title = input.value.trim();
      if (!title) return;
      await setCurrentPage(title);
      input.value = '';
    }

    document.getElementById('backPageBtn').addEventListener('click', () => { goBackPage(); });
    document.getElementById('newPageBtn').addEventListener('click', () => { openOrCreateFromInput(); });
    document.getElementById('newPageInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') openOrCreateFromInput(); });
    document.getElementById('searchInput').addEventListener('input', () => {
      searchResultsCollapsed = false;
      renderSearchResults();
    });
    document.getElementById('searchInput').addEventListener('focus', () => {
      searchResultsCollapsed = false;
      renderSearchResults();
    });
    document.getElementById('searchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        const si = document.getElementById('searchInput');
        searchResultsCollapsed = false;
        si.value = '';
        renderSearchResults();
        si.blur();
      }
    });
    document.addEventListener('keydown', (e) => {
      // Ctrl+F or Cmd+F → open global search
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        const si = document.getElementById('searchInput');
        if (si) {
          searchResultsCollapsed = false;
          renderSearchResults();
          si.focus();
          si.select();
        }
      }
    });
    document.getElementById('pageTagsList').addEventListener('click', (e) => {
      const addBtn = e.target.closest('[data-add-tag]');
      if (addBtn) {
        showTagAddForm();
        return;
      }
    });
    document.getElementById('saveNewTagBtn').addEventListener('click', () => { saveNewTagFromInput(); });
    document.getElementById('cancelNewTagBtn').addEventListener('click', () => { hideTagAddForm(); });
    document.getElementById('viewEditorBtn').addEventListener('click', () => { currentView = 'editor'; renderViewMode(); });
    document.getElementById('viewGraphBtn').addEventListener('click', () => { currentView = 'graph'; renderViewMode(); });
    document.getElementById('viewSplitBtn').addEventListener('click', () => { currentView = 'split'; renderViewMode(); });
    setupGraphZoomControls();
    setupGraphVisualizationControls();
    document.getElementById('toggleLeftSidebarBtn').addEventListener('click', () => { toggleLeftSidebar(); });
    document.getElementById('toggleRightSidebarBtn').addEventListener('click', () => { toggleRightSidebar(); });
    document.addEventListener('mousemove', handleLeftSidebarAutoHover);
    const hamburgerBtn = document.getElementById('hamburgerBtn');
    const hamburgerMenu = document.getElementById('hamburgerMenu');

    function closeHamburgerMenu() {
      hamburgerMenu.classList.add('hidden');
      hamburgerBtn.setAttribute('aria-expanded', 'false');
    }

    hamburgerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = hamburgerMenu.classList.contains('hidden');
      hamburgerMenu.classList.toggle('hidden', !isHidden);
      hamburgerBtn.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
    });

    hamburgerMenu.addEventListener('click', (e) => {
      const target = e.target;
      if (target && target.tagName === 'BUTTON') {
        closeHamburgerMenu();
      }
    });

    document.addEventListener('click', (e) => {
      if (!hamburgerMenu.classList.contains('hidden') && !hamburgerMenu.contains(e.target) && e.target !== hamburgerBtn) {
        closeHamburgerMenu();
      }
    });

    document.getElementById('themeToggleBtn').addEventListener('click', async () => { await toggleTheme(); });
    document.getElementById('deletePageBtn').addEventListener('click', async () => { await deleteCurrentPage(); });
    document.getElementById('newTagInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveNewTagFromInput();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideTagAddForm();
      }
    });

    document.getElementById('addBlockBtn').addEventListener('click', async () => {
      const page = getCurrentPage();
      const newBlock = { id: uid(), text: '', children: [] };
      page.blocks.push(newBlock);
      pendingFocus = newBlock.id;
      await saveData();
      render();
    });

    document.getElementById('newDailyBtn').addEventListener('click', async () => {
      const title = todayTitle();
      const existed = !!state.pages[title];
      await setCurrentPage(title);
      if (!existed) {
        const page = state.pages[title];
        applyDailyTemplateIfNeeded(page, title);
        await saveData();
        render();
      }
    });

    document.getElementById('pageTitle').addEventListener('input', () => {
      syncPageTitleWidth();
    });

    document.getElementById('pageTitle').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.target.blur();
    });

    document.getElementById('pageTitle').addEventListener('blur', async (e) => {
      syncPageTitleWidth();
      const oldTitle = state.currentPage;
      const newTitle = (e.target.value || '').trim();
      if (!newTitle || newTitle === oldTitle) { e.target.value = oldTitle; return; }
      if (state.pages[newTitle]) { alert('A page with that title already exists.'); e.target.value = oldTitle; return; }

      const page = state.pages[oldTitle];
      delete state.pages[oldTitle];
      page.title = newTitle;
      ensurePageSchema(page);
      state.pages[newTitle] = page;
      state.currentPage = newTitle;
      pageBackStack = pageBackStack.map(title => title === oldTitle ? newTitle : title);
      await saveData();
      render();
    });

    document.getElementById('resetBtn').addEventListener('click', async () => {
      const ok = confirm('Delete all local notes? This cannot be undone.');
      if (!ok) return;
      if (!HAS_DESKTOP_STORAGE && !HAS_SERVER_STORAGE) localStorage.removeItem(STORAGE_KEY);
      state = defaultData();
      pageBackStack = [];
      await saveData({ allowDestructive: true });
      render();
    });

    document.getElementById('exportBtn').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `local-graph-notes-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    async function createNotesBackup() {
      try {
        let res;
        if (HAS_DESKTOP_STORAGE) {
          res = await window.storageAPI.backup(state);
        } else if (HAS_SERVER_STORAGE) {
          res = await fetch('/api/storage/backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: state })
          }).then(r => r.json());
        } else {
          const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `roam-notes-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
          a.click();
          URL.revokeObjectURL(url);
          alert('Backup downloaded. Desktop storage is required to save directly to Documents.');
          return;
        }

        if (!res?.ok) throw new Error(res?.error || 'Backup failed');
        alert(`Backup created:\n${res.path}`);
      } catch (err) {
        alert('Backup failed: ' + err.message);
      }
    }

    document.getElementById('backupBtn').addEventListener('click', createNotesBackup);
    document.getElementById('backupMenuBtn').addEventListener('click', createNotesBackup);

    document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());

    document.getElementById('importFile').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!parsed.pages || typeof parsed.pages !== 'object') throw new Error('Invalid JSON format');
        state = sanitizeLoadedData(parsed);
        pageBackStack = [];
        await saveData({ allowDestructive: true });
        render();
      } catch (err) {
        alert('Import failed: ' + err.message);
      } finally {
        e.target.value = '';
      }
    });

    async function bootstrap() {
      audit('bootstrap.start');
      state = await loadStateFromStorage();
      storageReady = true;
      const meta = document.getElementById('storageMeta');
      if (HAS_DESKTOP_STORAGE) {
        const p = await window.storageAPI.path();
        meta.textContent = '';
      } else if (HAS_SERVER_STORAGE) {
        const p = await fetch('/api/storage/path', { cache: 'no-store' }).then(r => r.json());
        meta.textContent = '';
      } else {
        meta.textContent = '';
      }
      applyTheme(state.theme);
      applySidebarLayout();
      render();
    }

    bootstrap();


