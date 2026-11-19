// DocFlow Studio Windows Flagship App Shell:
// Multi-tab workspace, library with nested folders & 30-day trash, split-screen dual editor,
// S Pen tools, Geodreieck, Lecture Audio sync, Offline Windows OCR, Command Palette, and Export Studio.

import { t, setLanguage, getLanguage, getEffectiveLanguage, relativeTime } from './i18n.js';
import {
  readBundle,
  writeBundle,
  createNotebook,
  mergeRemote,
  inspectBundleSummary,
  sanitizeFileStem,
  BUNDLE_EXTENSION,
  TEMPLATES,
} from './model.js';
import {
  FOLDER_COLORS,
  COVER_COLORS,
  normalizeWorkspace,
  createFolder,
  renameFolder,
  deleteFolder,
  moveNotebookToFolder,
  setNotebookFavorite,
  isNotebookFavorite,
  getFolderPath,
  buildFolderTree,
  filterAndSortNotebooks,
} from './folders.js';
import { Editor, INK_TOOLS, DEFAULT_TOOL_SETTINGS } from './editor.js';
import { drawPaper, drawPageContent, drawTextBox, cssHexToArgb, argbToHex } from './render.js';
import { PdfBackgrounds } from './pdfbg.js';
import { EXPORT_LAYER_MODES, exportNotebookPdf, exportPagePng } from './export.js';
import { StudioAudioController, formatAudioTime } from './audio.js';
import { recognizeStrokesOcr, indexNotebookText } from './ocr.js';

const bridge = window.docflow ?? await (await import('./demo-bridge.js')).createDemoBridge();
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const PEN_TOOLS = ['FOUNTAIN_PEN', 'FINELINER', 'BALLPOINT_PEN', 'PENCIL', 'BRUSH_PEN', 'CALLIGRAPHY_PEN'];
const COLORS = ['#0f172a', '#475569', '#1d4ed8', '#0ea5e9', '#16a34a', '#dc2626', '#ea580c', '#9333ea'];
const HIGHLIGHT_COLORS = ['#facc15', '#4ade80', '#38bdf8', '#f472b6', '#fb923c', '#a78bfa'];
const STICKY_BG_COLORS = [
  { label: 'Amber', argb: 0xfffef3c7, hex: '#fef3c7' },
  { label: 'Sky', argb: 0xffe0f2fe, hex: '#e0f2fe' },
  { label: 'Emerald', argb: 0xffdcfce7, hex: '#dcfce7' },
  { label: 'Rose', argb: 0xffffe4e6, hex: '#ffe4e6' },
  { label: 'Transparent', argb: 0, hex: 'transparent' },
];
const THEMES = ['anthracite', 'light', 'oled'];
const SAVE_DELAY_MS = 1800;
const PREF_THEME_KEY = 'docflow.pref.theme';
const PREF_LANG_KEY = 'docflow.pref.lang';

const ICONS = {
  FOUNTAIN_PEN: '<path d="M12 2l4 8-4 12-4-12z M12 10v4" />',
  FINELINER: '<path d="M4 20l3-1 11-11-2-2L5 17z M14 6l2 2" />',
  BALLPOINT_PEN: '<path d="M5 19l2-6 9-9 3 3-9 9z M5 19l3-1" />',
  PENCIL: '<path d="M4 20l1-4 11-11 3 3-11 11z M14 7l3 3" />',
  BRUSH_PEN: '<path d="M18 3l3 3-8 8-3-3z M10 11c-3 0-5 2-5 5 0 2-1 3-2 4 4 0 9-1 9-6" />',
  CALLIGRAPHY_PEN: '<path d="M5 19L19 5 M8 4l12 12-4 4L4 8z" />',
  HIGHLIGHTER: '<path d="M9 14l6-6 3 3-6 6H9z M9 17l-4 4h6" />',
  ERASER: '<path d="M4 16l9-9 6 6-7 7H8z M9 20h11" />',
  LASSO: '<path d="M12 4c5 0 9 2.5 9 5.5S17 15 12 15 3 12.5 3 9.5 7 4 12 4z M6 14c-1 2 0 4 2 5" stroke-dasharray="3 2" />',
  HAND: '<path d="M8 12V5a1.5 1.5 0 013 0v6 M11 11V4a1.5 1.5 0 013 0v7 M14 11V6a1.5 1.5 0 013 0v8c0 4-3 7-7 7-3 0-5-2-6-4l-2-4a1.5 1.5 0 012.6-1.5L8 14" />',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />',
  eyeOff: '<path d="M3 3l18 18 M10.6 5.1A10 10 0 0122 12s-1.2 2.1-3.4 4 M6.6 6.6C3.7 8.4 2 12 2 12s4 7 10 7c1.7 0 3.2-.5 4.5-1.2" />',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" />',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 017.5-2" />',
  trash: '<path d="M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13" />',
  star: '<path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" />',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z" />',
  more: '<circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" />',
};
const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

const state = {
  info: null,
  settings: {},
  workspace: normalizeWorkspace(null),
  notebooks: [],
  trashItems: [],
  covers: new Map(),
  libraryFilter: 'all', // 'all' | 'favorites' | 'recent' | 'folder'
  activeFolderId: null,
  sortOrder: 'UPDATED_DESC',
  openTabs: [], // [{ name, title, notebook, mtime }]
  activeTabName: null, // null = Home Library
  current: null, // { notebook, name, mtime }
  editor: null,
  secondaryEditor: null,
  secondary: null, // { name, notebook, mtime, sameAsPrimary }
  secondarySaveTimer: null,
  secondarySaving: false,
  splitActive: false,
  favoritePens: [
    { id: 'fav_1', tool: 'FOUNTAIN_PEN', color: '#0f172a', width: 5.5 },
    { id: 'fav_2', tool: 'FINELINER', color: '#1d4ed8', width: 4 },
    { id: 'fav_3', tool: 'HIGHLIGHTER', color: '#facc15', width: 28 },
  ],
  audio: null,
  editingTextBoxContext: null,
  pendingImageInsert: null,
  newNbCoverArgb: COVER_COLORS[2].argb,
  saving: false,
  saveTimer: null,
  saveQueued: false,
};

// ---- Helpers & Localization ----

function applyTexts(root = document) {
  root.querySelectorAll('[data-t]').forEach((el) => {
    el.textContent = t(el.dataset.t);
  });
  root.querySelectorAll('[data-t-title]').forEach((el) => {
    const label = t(el.dataset.tTitle);
    el.title = label;
    el.setAttribute('aria-label', label);
  });
  root.querySelectorAll('[data-t-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.tPlaceholder);
  });
}

function applyTheme(themeName, persist = true) {
  const clean = THEMES.includes(themeName) ? themeName : 'anthracite';
  document.documentElement.setAttribute('data-theme', clean);
  if ($('#set-theme')) $('#set-theme').value = clean;
  try { localStorage.setItem(PREF_THEME_KEY, clean); } catch { /* ignore */ }
  if (persist) saveSettings({ theme: clean });
  state.editor?.requestDraw();
  state.secondaryEditor?.requestDraw();
}

function applyLanguage(langPref, persist = true) {
  const clean = ['de', 'en', 'auto'].includes(langPref) ? langPref : 'de';
  setLanguage(clean);
  if ($('#set-lang')) $('#set-lang').value = clean;
  try { localStorage.setItem(PREF_LANG_KEY, clean); } catch { /* ignore */ }
  if (persist) saveSettings({ language: clean });
  applyTexts();
  populateTemplateOptions();
  renderTabs();
  renderFolderTree();
  renderGrid();
  renderFavoritePensBar();
  renderLayers();
  renderPageSorter();
  updateNav();
}

function show(screen) {
  const main = $('#main-workspace');
  for (const id of ['setup', 'library', 'editor']) {
    const el = $(`#${id}`);
    if (el) {
      const active = id === screen;
      el.hidden = !active;
      if (active && main && el.parentElement === main) {
        main.prepend(el);
      }
    }
  }
  renderTabs();
}

let toastTimer;
const toastEl = $('#toast');
function toast(message, isError = false) {
  if (!toastEl) return;
  toastEl.id = 'toast';
  toastEl.textContent = message;
  toastEl.classList.toggle('error', isError);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, Math.max(3200, String(message).length * 55));
}

function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  state.editor?.updateSettings(state.settings);
  state.secondaryEditor?.updateSettings(state.settings);
  bridge.saveSettings?.(state.settings);
}

async function persistWorkspace() {
  await bridge.writeWorkspace?.(state.workspace);
}

/** Generic promise-based modal dialog using #dialog. */
function dialog(title, build, okText = t('ok')) {
  const dlg = $('#dialog');
  $('#dialog-title').textContent = title;
  const body = $('#dialog-body');
  body.innerHTML = '';
  const getValue = build ? build(body) : null;
  $('#dialog-ok').textContent = okText;
  if (!dlg.open) dlg.showModal();
  const firstInput = body.querySelector('input, select, textarea');
  firstInput?.focus();
  firstInput?.select?.();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      resolve(val);
    };
    const onCancel = () => finish(null);
    const onSubmit = (e) => {
      e.preventDefault();
      finish(getValue ? getValue() : true);
    };
    $('#dialog-cancel').onclick = onCancel;
    $('#dialog-form').onsubmit = onSubmit;
    dlg.addEventListener('close', () => finish(null), { once: true });
  });
}

function confirmDialog(text, okText = t('ok')) {
  return dialog(text, null, okText);
}

// ---- Titlebar & Multi-Tab Management ----

function renderTabs() {
  const homeTab = $('#tab-home');
  const isHome = !$('#library').hidden || !$('#setup').hidden;
  homeTab.classList.toggle('active', isHome);
  homeTab.setAttribute('aria-selected', isHome ? 'true' : 'false');

  const container = $('#notebook-tabs');
  if (!container) return;
  container.innerHTML = '';

  for (const tab of state.openTabs) {
    const isActive = !isHome && state.current?.name === tab.name;
    const tabEl = document.createElement('div');
    tabEl.className = `tab${isActive ? ' active' : ''}`;
    tabEl.setAttribute('role', 'tab');
    tabEl.setAttribute('aria-selected', isActive ? 'true' : 'false');
    tabEl.tabIndex = 0;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'tab-title';
    titleSpan.textContent = tab.title;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'tab-close';
    closeBtn.title = t('closeTab');
    closeBtn.setAttribute('aria-label', t('closeTab'));
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await closeTab(tab.name);
    });

    tabEl.append(titleSpan, closeBtn);
    tabEl.addEventListener('click', () => openNotebook(tab.name, tab.notebook));
    tabEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openNotebook(tab.name, tab.notebook);
      }
    });
    container.appendChild(tabEl);
  }
}

async function closeTab(fileName) {
  if (state.current?.name === fileName) {
    await saveCurrent();
  }
  const idx = state.openTabs.findIndex((t) => t.name === fileName);
  if (idx >= 0) state.openTabs.splice(idx, 1);

  if (state.openTabs.length === 0) {
    state.editor?.close();
    state.current = null;
    await showLibrary();
  } else if (state.current?.name === fileName) {
    const nextTab = state.openTabs[Math.max(0, idx - 1)];
    await openNotebook(nextTab.name, nextTab.notebook);
  } else {
    renderTabs();
  }
}

$('#tab-home').addEventListener('click', async () => {
  await saveCurrent();
  await showLibrary();
});

$('#tab-new-notebook').addEventListener('click', () => openNewNotebookModal());
$('#win-min')?.addEventListener('click', () => bridge.windowMinimize?.());
$('#win-max')?.addEventListener('click', () => bridge.windowMaximize?.());
$('#win-close')?.addEventListener('click', () => bridge.windowClose?.());

$('#btn-theme-cycle').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') || 'anthracite';
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  applyTheme(next);
});

// ---- Setup ----

async function showSetup() {
  show('setup');
  const list = $('#setup-list');
  list.innerHTML = '';
  const res = await bridge.detectFolders();
  const candidates = Array.isArray(res) ? res : (res?.candidates || []);
  const defaultFolder = res?.defaultSuggestion || candidates[0]?.folder || 'C:\\Users\\Demo\\OneDrive\\DocFlow Studio';

  if (candidates.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = t('setupNone');
    list.appendChild(p);
  }

  for (const f of candidates) {
    const folderPath = f.folder || f.path;
    const row = document.createElement('div');
    row.className = 'setup-row';
    row.innerHTML = `
      <div class="provider" aria-hidden="true"></div>
      <div class="setup-info">
        <strong></strong>
        <span class="path"></span>
        <span class="muted small">${f.exists ? t('setupFound', f.notebooks) : t('setupMissing')}</span>
      </div>
      <button type="button" class="btn ${f.exists ? 'primary' : 'ghost'}">${f.exists ? t('setupUse') : t('setupCreate')}</button>`;
    row.querySelector('strong').textContent = f.provider;
    row.querySelector('.path').textContent = folderPath;
    row.querySelector('button').addEventListener('click', async () => {
      await bridge.setFolder(folderPath, true);
      await showLibrary();
    });
    list.appendChild(row);
  }

  $('#setup-use-demo').onclick = async () => {
    await bridge.setFolder(defaultFolder, true);
    await showLibrary();
  };
}

$('#setup-other').addEventListener('click', async () => {
  const res = await bridge.chooseFolder();
  if (res && !res.canceled) await showLibrary();
});

// ---- Library & Workspace Folders ----

async function showLibrary() {
  state.info = await bridge.appInfo();
  const folder = state.info.syncFolder || state.info.folder;
  if (!folder) {
    await showSetup();
    return;
  }
  show('library');
  $('#folder-path').textContent = folder;
  $('#cloud-path-short').textContent = folder;
  await refreshLibrary({ force: true });
}

const fileKey = (f) => `${f.name}@${f.size}`;

async function refreshLibrary({ force = false } = {}) {
  const rawWs = await bridge.readWorkspace?.();
  if (rawWs) state.workspace = normalizeWorkspace(rawWs);

  const files = (await bridge.listFiles?.()) || [];
  state.trashItems = (await bridge.listTrash?.()) || [];
  $('#count-trash').textContent = String(state.trashItems.length);

  const before = state.notebooks.map(fileKey).sort().join('|');
  const after = files.map(fileKey).sort().join('|');
  if (force || before !== after || state.notebooks.length === 0) {
    const entries = [];
    for (const f of files) {
      const mtime = f.mtimeMs ?? f.modifiedAt ?? Date.now();
      const ctime = f.birthtimeMs ?? mtime;
      const known = state.notebooks.find((n) => fileKey(n) === fileKey(f));
      if (known) {
        entries.push({ ...known, modifiedAt: mtime, createdAt: ctime });
      } else {
        let summary = null;
        try {
          const bytes = await bridge.readFile(f.name);
          summary = inspectBundleSummary(bytes instanceof Uint8Array ? bytes : bytes.bytes, f.name);
        } catch { /* fallback below */ }
        entries.push({
          name: f.name,
          size: f.size,
          modifiedAt: mtime,
          createdAt: summary?.createdAt || ctime,
          title: summary?.title || f.name.replace(/\.docflownote$/i, '').replace(/_/g, ' '),
          pageCount: summary?.pageCount ?? 1,
          coverColorArgb: summary?.coverColorArgb ?? COVER_COLORS[0].argb,
          isFavorite: summary?.isFavorite ?? false,
          folderId: summary?.folderId ?? null,
          extractedHandwritingText: summary?.extractedHandwritingText ?? '',
          deviceId: summary?.deviceId ?? '',
          deviceName: summary?.deviceName ?? '',
        });
      }
    }
    state.notebooks = entries;
  }

  updateCountsAndFolderTree();
  renderGrid();
  loadCovers();
}

function updateCountsAndFolderTree() {
  $('#count-all').textContent = String(state.notebooks.length);
  const favCount = state.notebooks.filter((n) => isNotebookFavorite(state.workspace, n)).length;
  $('#count-favorites').textContent = String(favCount);
  renderFolderTree();
}

function renderFolderTree() {
  const treeEl = $('#folder-tree');
  if (!treeEl) return;
  treeEl.innerHTML = '';
  const roots = buildFolderTree(state.workspace, state.notebooks);

  const renderNode = (node, depth = 0) => {
    const row = document.createElement('div');
    const isActive = state.libraryFilter === 'folder' && state.activeFolderId === node.id;
    row.className = `folder-node${isActive ? ' active' : ''}`;
    row.style.paddingLeft = `${8 + depth * 14}px`;

    const dot = document.createElement('span');
    dot.className = 'folder-dot';
    dot.style.background = node.color || FOLDER_COLORS[0];

    const nameSpan = document.createElement('span');
    nameSpan.className = 'folder-node-name';
    nameSpan.textContent = node.name;

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = String(node.totalCount);

    const actionsWrap = document.createElement('span');
    actionsWrap.className = 'folder-node-actions';

    const renBtn = document.createElement('button');
    renBtn.type = 'button';
    renBtn.className = 'icon-btn small';
    renBtn.title = t('renameFolder');
    renBtn.setAttribute('aria-label', t('renameFolder'));
    renBtn.innerHTML = svg('edit');
    renBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const next = await dialog(t('renameFolder'), (body) => {
        body.innerHTML = `<label class="field"><span>${t('folderName')}</span><input type="text" maxlength="60"></label>`;
        body.querySelector('input').value = node.name;
        return () => body.querySelector('input').value.trim();
      }, t('save'));
      if (next && next !== node.name) {
        renameFolder(state.workspace, node.id, next);
        await persistWorkspace();
        updateCountsAndFolderTree();
        renderGrid();
      }
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'icon-btn small';
    delBtn.title = t('deleteFolder');
    delBtn.setAttribute('aria-label', t('deleteFolder'));
    delBtn.innerHTML = svg('trash');
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await confirmDialog(t('confirmDeleteFolder', node.name), t('deleteSelection'))) {
        deleteFolder(state.workspace, node.id);
        if (state.activeFolderId === node.id) {
          state.activeFolderId = null;
          state.libraryFilter = 'all';
        }
        await persistWorkspace();
        updateCountsAndFolderTree();
        renderGrid();
      }
    });

    actionsWrap.append(renBtn, delBtn);
    row.append(dot, nameSpan, badge, actionsWrap);

    // Drag & Drop notebooks onto folders
    row.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types?.includes('text/x-docflow-notebook')) {
        e.preventDefault();
        row.classList.add('drag-over');
      }
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const nbName = e.dataTransfer?.getData('text/x-docflow-notebook');
      if (nbName) {
        moveNotebookToFolder(state.workspace, nbName, node.id);
        await persistWorkspace();
        updateCountsAndFolderTree();
        renderGrid();
      }
    });

    row.addEventListener('click', () => {
      state.libraryFilter = 'folder';
      state.activeFolderId = node.id;
      syncSidebarNavState();
      renderFolderTree();
      renderGrid();
    });
    treeEl.appendChild(row);

    for (const child of node.children || []) {
      renderNode(child, depth + 1);
    }
  };

  for (const root of roots) renderNode(root, 0);
}

function syncSidebarNavState() {
  $$('.sidebar-nav .nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.filter === state.libraryFilter);
  });
}

$('#btn-toggle-sidebar').addEventListener('click', () => {
  const sidebar = $('#sidebar');
  const btn = $('#btn-toggle-sidebar');
  const nextHidden = !sidebar.hidden;
  sidebar.hidden = nextHidden;
  btn.setAttribute('aria-expanded', nextHidden ? 'false' : 'true');
});

for (const navId of ['nav-all', 'nav-favorites', 'nav-recent']) {
  $(`#${navId}`).addEventListener('click', (e) => {
    state.libraryFilter = e.currentTarget.dataset.filter;
    state.activeFolderId = null;
    syncSidebarNavState();
    renderFolderTree();
    renderGrid();
  });
}

$('#nav-trash').addEventListener('click', () => openTrashModal());

$('#btn-new-folder').addEventListener('click', async () => {
  const name = await dialog(t('newFolder'), (body) => {
    body.innerHTML = `<label class="field"><span>${t('folderName')}</span><input id="f-folder-name" type="text" maxlength="60"></label>`;
    return () => body.querySelector('#f-folder-name').value.trim();
  }, t('create'));
  if (!name) return;
  const parentId = state.libraryFilter === 'folder' ? state.activeFolderId : null;
  const created = createFolder(state.workspace, { name, parentId });
  await persistWorkspace();
  updateCountsAndFolderTree();
  return created;
});

$('#library-sort').addEventListener('change', (e) => {
  state.sortOrder = e.target.value;
  renderGrid();
});

$('#search').addEventListener('input', renderGrid);

function renderGrid() {
  const grid = $('#grid');
  if (!grid) return;
  const query = $('#search')?.value || '';
  const items = filterAndSortNotebooks(state.notebooks, state.workspace, {
    filter: state.libraryFilter,
    folderId: state.activeFolderId,
    query,
    sortOrder: state.sortOrder,
  });

  grid.innerHTML = '';
  const hasAny = state.notebooks.length > 0;
  $('#empty').hidden = hasAny || items.length > 0;

  if (hasAny && items.length === 0) {
    const msg = document.createElement('p');
    msg.className = 'muted center';
    msg.textContent = t('noMatches');
    grid.appendChild(msg);
    return;
  }

  for (const n of items) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.testid = 'notebook-card';
    card.tabIndex = 0;

    const cover = state.covers.get(fileKey(n));
    const fav = isNotebookFavorite(state.workspace, n);
    const spineHex = argbToHex(n.coverColorArgb ?? COVER_COLORS[0].argb);
    const fromPhone = Boolean(n.deviceId && n.deviceId !== state.info?.deviceId && !String(n.deviceId).startsWith('windows'));
    const badgeLabel = fromPhone ? t('cloudUpdatedFromPhone') : t('cloudSynced');
    const badgeOrigin = fromPhone ? 'phone' : 'synced';

    card.draggable = true;
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/x-docflow-notebook', n.name);
      e.dataTransfer.effectAllowed = 'move';
    });

    card.innerHTML = `
      <div class="cover">
        <span class="cover-spine" style="background:${spineHex}"></span>
        ${cover ? `<img src="${cover}" alt="">` : '<div class="cover-placeholder"></div>'}
      </div>
      <div class="card-actions">
        <button type="button" class="card-action-btn fav-btn${fav ? ' fav-active' : ''}" title="${t('toggleFavorite')}" aria-label="${t('toggleFavorite')}">${svg('star')}</button>
        <button type="button" class="card-action-btn more-btn" title="${t('moreActions')}" aria-label="${t('moreActions')}">${svg('more')}</button>
        <button type="button" class="card-action-btn del-btn" title="${t('deleteNotebook')}" aria-label="${t('deleteNotebook')}">${svg('trash')}</button>
      </div>
      <div class="card-body">
        <div class="card-title"></div>
        <div class="card-meta muted small"></div>
        <span class="card-sync-badge" data-origin="${badgeOrigin}">${badgeLabel}</span>
      </div>`;

    card.querySelector('.card-title').textContent = n.title;
    card.querySelector('.card-meta').textContent = [
      n.pageCount ? t('pages', n.pageCount) : null,
      t('editedAgo', relativeTime(n.modifiedAt)),
    ].filter(Boolean).join(' · ');

    card.addEventListener('click', () => openNotebook(n.name));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') openNotebook(n.name);
    });

    card.querySelector('.fav-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      setNotebookFavorite(state.workspace, n.name, !fav);
      await persistWorkspace();
      updateCountsAndFolderTree();
      renderGrid();
    });

    card.querySelector('.more-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openCardMenu(e.currentTarget, n);
    });

    card.querySelector('.del-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await confirmDialog(t('confirmDelete', n.title), t('deleteNotebook'))) {
        await bridge.deleteFile(n.name);
        state.openTabs = state.openTabs.filter((tab) => tab.name !== n.name);
        toast(t('movedToTrash', n.title));
        await refreshLibrary({ force: true });
      }
    });

    grid.appendChild(card);
  }
}

function openCardMenu(anchor, nbEntry) {
  document.querySelectorAll('.card-context-menu').forEach((m) => m.remove());
  const menu = document.createElement('div');
  menu.className = 'menu card-context-menu';
  menu.setAttribute('role', 'menu');

  const addItem = (label, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      menu.remove();
      await onClick();
    });
    menu.appendChild(b);
  };

  addItem(t('openNotebook'), () => openNotebook(nbEntry.name));
  addItem(t('openInSplit'), async () => {
    if (!state.current) {
      await openNotebook(nbEntry.name);
    } else {
      show('editor');
    }
    await openSplitScreenWith(nbEntry.name);
  });
  addItem(t('moveToFolder'), async () => {
    const chosen = await dialog(t('moveToFolder'), (body) => {
      const sel = document.createElement('select');
      sel.className = 'select-input';
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = t('noFolder');
      sel.appendChild(noneOpt);
      for (const f of state.workspace.folders) {
        const opt = document.createElement('option');
        opt.value = f.id;
        opt.textContent = getFolderPath(state.workspace, f.id) || f.name;
        if ((state.workspace.notebookFolders[nbEntry.name] ?? nbEntry.folderId) === f.id) opt.selected = true;
        sel.appendChild(opt);
      }
      const field = document.createElement('label');
      field.className = 'field';
      field.innerHTML = `<span>${t('folderLabel')}</span>`;
      field.appendChild(sel);
      body.appendChild(field);
      return () => sel.value || null;
    }, t('save'));
    if (chosen === null && !$('#dialog').returnValue) return;
    moveNotebookToFolder(state.workspace, nbEntry.name, chosen || null);
    await persistWorkspace();
    updateCountsAndFolderTree();
    renderGrid();
  });
  addItem(t('rename'), async () => {
    const nextTitle = await dialog(t('rename'), (body) => {
      body.innerHTML = `<label class="field"><span>${t('titleLabel')}</span><input type="text" maxlength="80"></label>`;
      body.querySelector('input').value = nbEntry.title;
      return () => body.querySelector('input').value.trim();
    }, t('save'));
    if (!nextTitle || nextTitle === nbEntry.title) return;
    const raw = await bridge.readFile(nbEntry.name);
    const bytes = raw instanceof Uint8Array ? raw : raw.bytes;
    const nb = readBundle(bytes, nbEntry.name);
    nb.title = nextTitle;
    await saveNotebook(nb, { quiet: true });
    await refreshLibrary({ force: true });
  });
  addItem(t('duplicateNotebook'), async () => {
    const raw = await bridge.readFile(nbEntry.name);
    const bytes = raw instanceof Uint8Array ? raw : raw.bytes;
    const nb = readBundle(bytes, nbEntry.name);
    nb.title = `${nb.title} (Kopie)`;
    nb.fileName = uniqueFileName(nb.title);
    await saveNotebook(nb, { quiet: true });
    await refreshLibrary({ force: true });
  });

  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.min(window.innerHeight - 220, r.bottom + 4)}px`;
  menu.style.left = `${Math.min(window.innerWidth - 230, Math.max(8, r.left - 140))}px`;
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target)) menu.remove(); }, { once: true }), 0);
}

let coverJob = 0;
async function loadCovers() {
  const job = ++coverJob;
  for (const n of state.notebooks) {
    if (job !== coverJob || $('#library').hidden) return;
    const key = fileKey(n);
    if (state.covers.has(key)) continue;
    try {
      const raw = await bridge.readFile(n.name);
      const bytes = raw instanceof Uint8Array ? raw : raw.bytes;
      const nb = readBundle(bytes, n.name);
      n.title = nb.title;
      n.pageCount = nb.pages.length;
      n.coverColorArgb = nb.coverColorArgb;
      state.covers.set(key, await renderCover(nb));
    } catch {
      state.covers.set(key, null);
    }
    renderGrid();
  }
}

async function renderCover(nb) {
  const page = nb.pages[0];
  const width = 320;
  const scale = width / page.widthPx;
  const canvas = new OffscreenCanvas(width, Math.round(page.heightPx * scale));
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  const bg = nb.backgroundOf(page);
  drawPaper(ctx, page.template, page.widthPx, page.heightPx, { withRuling: !bg });
  if (bg) {
    const pdf = new PdfBackgrounds();
    pdf.setSource(nb.entries);
    try {
      ctx.drawImage(await pdf.render(bg.entry, bg.pageIndex, width * 2), 0, 0, page.widthPx, page.heightPx);
    } finally {
      pdf.dispose();
    }
  }
  drawPageContent(ctx, page.payload, (item) => nb.isItemVisible(item));
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(blob);
  });
}

// ---- Trash Modal ----

async function openTrashModal() {
  state.trashItems = (await bridge.listTrash?.()) || [];
  $('#count-trash').textContent = String(state.trashItems.length);
  renderTrashList();
  const modal = $('#modal-trash');
  if (!modal.open) modal.showModal();
}

function renderTrashList() {
  const list = $('#trash-list');
  list.innerHTML = '';
  if (state.trashItems.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = t('emptyTrashTitle');
    list.appendChild(p);
    return;
  }

  for (const item of state.trashItems) {
    const row = document.createElement('div');
    row.className = 'trash-item';
    row.dataset.testid = 'trash-item';
    const cleanTitle = String(item.originalName || '').replace(/\.docflownote$/i, '').replace(/_/g, ' ');
    const daysLeft = Math.max(1, Math.ceil(((item.expiresAt || Date.now()) - Date.now()) / 86400_000));

    const info = document.createElement('div');
    info.innerHTML = `<strong></strong><div class="muted small">${t('trashDaysLeft', daysLeft)}</div>`;
    info.querySelector('strong').textContent = cleanTitle;

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '6px';

    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'btn small primary';
    restoreBtn.textContent = t('restoreNotebook');
    restoreBtn.addEventListener('click', async () => {
      await bridge.restoreTrash(item.trashId);
      toast(t('restoredFromTrash', cleanTitle));
      await refreshLibrary({ force: true });
      state.trashItems = (await bridge.listTrash?.()) || [];
      renderTrashList();
      if (state.trashItems.length === 0 && $('#modal-trash').open) {
        $('#modal-trash').close();
      }
    });

    const purgeBtn = document.createElement('button');
    purgeBtn.type = 'button';
    purgeBtn.className = 'btn small ghost';
    purgeBtn.textContent = t('deleteForever');
    purgeBtn.addEventListener('click', async () => {
      await bridge.purgeTrash(item.trashId);
      state.trashItems = (await bridge.listTrash?.()) || [];
      $('#count-trash').textContent = String(state.trashItems.length);
      renderTrashList();
    });

    actions.append(restoreBtn, purgeBtn);
    row.append(info, actions);
    list.appendChild(row);
  }
}

$('#btn-empty-trash').addEventListener('click', async () => {
  await bridge.emptyTrash?.();
  state.trashItems = [];
  $('#count-trash').textContent = '0';
  renderTrashList();
  toast(t('trashEmptied'));
});
$('#btn-close-trash').addEventListener('click', () => $('#modal-trash').close());

// ---- New Notebook Modal ----

function populateTemplateOptions() {
  for (const sel of [$('#new-nb-template'), $('#sorter-tpl-select')]) {
    if (!sel) continue;
    const prev = sel.value || 'GRID_5MM';
    sel.innerHTML = '';
    for (const tpl of TEMPLATES) {
      const opt = document.createElement('option');
      opt.value = tpl;
      opt.textContent = t(`tpl_${tpl}`);
      sel.appendChild(opt);
    }
    if (TEMPLATES.includes(prev)) sel.value = prev;
  }
}

function uniqueFileName(title) {
  const stem = sanitizeFileStem(title);
  const taken = new Set(state.notebooks.map((n) => n.name.toLowerCase()));
  let name = `${stem}${BUNDLE_EXTENSION}`;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${stem}_${i}${BUNDLE_EXTENSION}`;
  return name;
}

function openNewNotebookModal() {
  populateTemplateOptions();
  const modal = $('#modal-new-notebook');
  $('#new-nb-title').value = '';
  $('#new-nb-template').value = state.settings.lastTemplate || 'GRID_5MM';
  $('#new-nb-mode').value = 'PAGES';

  const colorsWrap = $('#new-nb-colors');
  colorsWrap.innerHTML = '';
  for (const c of COVER_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `color-swatch${c.argb === state.newNbCoverArgb ? ' active' : ''}`;
    b.style.background = c.hex;
    b.title = c.name;
    b.setAttribute('aria-label', c.name);
    b.addEventListener('click', () => {
      state.newNbCoverArgb = c.argb;
      colorsWrap.querySelectorAll('.color-swatch').forEach((el) => el.classList.toggle('active', el === b));
    });
    colorsWrap.appendChild(b);
  }

  if (!modal.open) modal.showModal();
  $('#new-nb-title').focus();
}

$('#btn-new').addEventListener('click', openNewNotebookModal);
$('#btn-cancel-new-nb').addEventListener('click', () => $('#modal-new-notebook').close());

$('#form-new-notebook').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#new-nb-title').value.trim() || t('untitled');
  const template = $('#new-nb-template').value || 'GRID_5MM';
  const canvasMode = $('#new-nb-mode').value || 'PAGES';
  $('#modal-new-notebook').close();

  saveSettings({ lastTemplate: template });
  const folderId = state.libraryFilter === 'folder' ? state.activeFolderId : null;
  const folderPath = folderId ? getFolderPath(state.workspace, folderId) : '';
  const nb = createNotebook({
    title,
    deviceId: state.info?.deviceId || 'windows-local',
    template,
    canvasMode,
    coverColorArgb: state.newNbCoverArgb,
    folderId,
    folderPath,
  });
  nb.fileName = uniqueFileName(title);
  if (folderId) {
    moveNotebookToFolder(state.workspace, nb.fileName, folderId);
    await persistWorkspace();
  }
  await saveNotebook(nb, { quiet: true });
  await refreshLibrary({ force: true });
  await openNotebook(nb.fileName, nb);
});

$('#btn-open-pdf').addEventListener('click', async () => {
  const picked = await bridge.pickPdf();
  if (!picked || picked.canceled) return;
  try {
    const sizes = await PdfBackgrounds.pageSizes(picked.bytes);
    const nb = createNotebook({
      title: picked.name,
      deviceId: state.info?.deviceId || 'windows-local',
      pdfBytes: picked.bytes,
      pdfPageSizes: sizes,
      template: 'BLANK',
    });
    nb.fileName = uniqueFileName(picked.name);
    await saveNotebook(nb, { quiet: true });
    await refreshLibrary({ force: true });
    await openNotebook(nb.fileName, nb);
  } catch (err) {
    console.error(err);
    toast(t('pdfImportFailed'), true);
  }
});

$('#btn-change-folder').addEventListener('click', () => showSetup());
$('#btn-reveal').addEventListener('click', () => bridge.revealFolder?.());

// ---- Saving ----

function setStatus(kind) {
  const el = $('#save-status');
  if (!el) return;
  el.dataset.kind = kind;
  el.textContent = t(kind);
}

function scheduleSave() {
  setStatus('unsaved');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveCurrent(), SAVE_DELAY_MS);
}

async function rasterizeTextBox(box, darkPaper = false) {
  const w = Math.max(60, box.width ?? 420);
  const h = Math.max(36, box.height ?? 140);
  const c = new OffscreenCanvas(Math.ceil(w * 2), Math.ceil(h * 2));
  const ctx = c.getContext('2d');
  ctx.scale(2, 2);
  ctx.translate(-box.left, -box.top);
  drawTextBox(ctx, box, { darkPaper });
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

async function saveNotebook(nb, { quiet = false } = {}) {
  const pdf = await exportNotebookPdf(nb, { rasterizeTextBox });
  const bytes = writeBundle(nb, { deviceId: state.info?.deviceId || 'windows-local', exportedPdf: pdf });
  const res = await bridge.writeFile(nb.fileName, bytes);
  await bridge.writeFile(nb.fileName.replace(/\.docflownote$/i, '.pdf'), pdf);
  if (!quiet) setStatus('saved');
  return typeof res === 'object' && res ? res.mtimeMs : res;
}

async function saveCurrent() {
  const cur = state.current;
  if (!cur) return;
  clearTimeout(state.saveTimer);
  if (state.saving) { state.saveQueued = true; return; }
  if (!cur.notebook.isDirty) { setStatus('saved'); return; }
  state.saving = true;
  setStatus('saving');
  try {
    state.ownWriteAt = Date.now();
    cur.mtime = await saveNotebook(cur.notebook);
  } catch (err) {
    console.error(err);
    setStatus('saveFailed');
    toast(`${t('saveFailed')}: ${err.message ?? err}`, true);
  } finally {
    state.saving = false;
    if (state.saveQueued) {
      state.saveQueued = false;
      saveCurrent();
    }
  }
}

// ---- Editor & Split-Screen ----

function ensureAudioController() {
  if (state.audio) return state.audio;
  state.audio = new StudioAudioController({
    onStateChange: (st) => renderAudioBar(st),
    onError: (errKey) => {
      const msg = t(errKey);
      $('#audio-status-msg').textContent = msg;
      if (toastEl) {
        toastEl.hidden = true;
        toastEl.removeAttribute('id');
      }
    },
  });
  return state.audio;
}

function ensureEditor() {
  if (state.editor) return state.editor;
  const audio = ensureAudioController();
  const editor = new Editor($('#stage'), {
    settings: state.settings,
    onDirty: () => {
      scheduleSave();
      if (state.splitActive && state.secondary?.sameAsPrimary && state.secondaryEditor) {
        state.secondaryEditor.layout();
        state.secondaryEditor.invalidateAll();
        state.secondaryEditor.draw();
      }
    },
    onStatus: setStatus,
    onToast: (m) => toast(m),
    onEditTextBox: (pageIdx, box) => openTextBoxModal(pageIdx, box, state.editor),
    onRequestImage: (pageIdx, x, y) => requestAndInsertImage(pageIdx, x, y, state.editor),
    onAudioSeek: (offsetMs) => audio.seekToMs(offsetMs),
    getAudioRecordingOffsetMs: () => (audio.isRecording ? audio.currentOffsetMs : null),
  });
  state.editor = editor;
  const stage = $('#stage');
  stage.addEventListener('viewchange', updateNav);
  stage.addEventListener('drawn', updateNav);
  stage.addEventListener('historychange', updateHistory);
  stage.addEventListener('selectionchange', () => {
    $('#lasso-bar').hidden = !editor.selection;
  });
  bindToolbarEvents();
  renderFavoritePensBar();
  return editor;
}

async function openNotebook(name, preloaded = null) {
  try {
    if (state.current && state.current.name !== name) {
      await saveCurrent();
    }
    let nb = preloaded;
    let mtime = Date.now();
    if (!nb) {
      const raw = await bridge.readFile(name);
      const bytes = raw instanceof Uint8Array ? raw : raw.bytes;
      nb = readBundle(bytes, name);
      const stat = await bridge.statFile(name);
      mtime = stat?.mtimeMs ?? stat?.modifiedAt ?? Date.now();
    } else {
      const stat = await bridge.statFile(name);
      mtime = stat?.mtimeMs ?? stat?.modifiedAt ?? Date.now();
    }

    state.current = { notebook: nb, name, mtime };
    const existingTab = state.openTabs.find((t) => t.name === name);
    if (existingTab) {
      existingTab.notebook = nb;
      existingTab.title = nb.title;
      existingTab.mtime = mtime;
    } else {
      state.openTabs.push({ name, title: nb.title, notebook: nb, mtime });
    }

    const editor = ensureEditor();
    editor.activeLayerId = null;
    await editor.prewarm(nb);
    show('editor');
    editor.resize();
    editor.open(nb, { preserveAssets: true });
    editor.draw();
    ensureAudioController().attachNotebook(nb);

    $('#nb-title').textContent = nb.title;
    $('#study-banner').hidden = !editor.studyMode;
    $('#reading-banner').hidden = !editor.readingMode;
    $('#btn-center-canvas').hidden = !editor.isInfinite();
    syncMoreMenuState();
    setStatus('saved');
    if (state.splitActive && state.secondary) {
      state.secondary.sameAsPrimary = state.secondary.name === name;
      if (state.secondary.sameAsPrimary) {
        state.secondary.notebook = nb;
        state.secondaryEditor?.open(nb, { preserveAssets: true });
        state.secondaryEditor?.draw();
      }
      populateSplitSelector(state.secondary.name);
      setSecondaryBadge('synced', state.secondary.sameAsPrimary ? 'Live-Sync' : t('saved'));
    }
    renderTabs();
    renderLayers();
    renderPageSorter();
    updateHistory();
    updateNav();
  } catch (err) {
    console.error(err);
    toast(t('loadFailed', name), true);
  }
}

$('#btn-back').addEventListener('click', async () => {
  await saveCurrent();
  await showLibrary();
});

$('#nb-title').addEventListener('dblclick', async () => {
  const nb = state.current?.notebook;
  if (!nb) return;
  const title = await dialog(t('rename'), (body) => {
    body.innerHTML = `<label class="field"><span>${t('titleLabel')}</span><input id="f-title" type="text" maxlength="80"></label>`;
    body.querySelector('input').value = nb.title;
    return () => body.querySelector('input').value.trim();
  }, t('save'));
  if (!title || title === nb.title) return;
  nb.title = title;
  $('#nb-title').textContent = title;
  const tab = state.openTabs.find((x) => x.name === nb.fileName);
  if (tab) tab.title = title;
  renderTabs();
  scheduleSave();
});

// ---- Split-Screen & Resizer ----

function syncToolSettingsToSecondary() {
  if (!state.secondaryEditor || !state.editor) return;
  state.secondaryEditor.toolSettings = structuredClone(state.editor.toolSettings);
  state.secondaryEditor.setTool(state.editor.tool);
  state.secondaryEditor.setDarkPaper(state.editor.darkPaper);
  state.secondaryEditor.setReadingMode(state.editor.readingMode);
}

function updateSecondaryNav() {
  const se = state.secondaryEditor;
  const label = $('#split-page-label');
  if (!se?.notebook || !label) return;
  if (se.isInfinite()) {
    label.textContent = t('infiniteCanvasBadge');
  } else {
    label.textContent = t('pageOf', se.currentPageIndex() + 1, se.notebook.pages.length);
  }
}

function populateSplitSelector(selectedFileName) {
  const sel = $('#split-nb-select');
  if (!sel) return;
  sel.innerHTML = '';
  if (state.current) {
    const sameOpt = document.createElement('option');
    sameOpt.value = state.current.name;
    sameOpt.textContent = `${state.current.notebook.title} (${t('splitSameNotebook')})`;
    sel.appendChild(sameOpt);
  }
  for (const nb of state.notebooks) {
    if (nb.name === state.current?.name) continue;
    const opt = document.createElement('option');
    opt.value = nb.name;
    opt.textContent = nb.title;
    sel.appendChild(opt);
  }
  if (selectedFileName) sel.value = selectedFileName;
}

function setSecondaryBadge(kind, text) {
  const badge = $('#split-sync-badge');
  if (!badge) return;
  badge.dataset.kind = kind;
  badge.textContent = text;
}

function scheduleSecondarySave() {
  if (!state.secondary) return;
  if (state.secondary.sameAsPrimary) {
    scheduleSave();
    return;
  }
  setSecondaryBadge('unsaved', t('unsaved'));
  clearTimeout(state.secondarySaveTimer);
  state.secondarySaveTimer = setTimeout(() => saveSecondary(), SAVE_DELAY_MS);
}

async function saveSecondary() {
  const sec = state.secondary;
  if (!sec || sec.sameAsPrimary || !sec.notebook?.isDirty || state.secondarySaving) return;
  clearTimeout(state.secondarySaveTimer);
  state.secondarySaving = true;
  setSecondaryBadge('unsaved', t('saving'));
  try {
    state.ownWriteAt = Date.now();
    sec.mtime = await saveNotebook(sec.notebook, { quiet: true });
    setSecondaryBadge('synced', t('saved'));
  } catch (err) {
    console.error(err);
    toast(`${t('saveFailed')}: ${err.message ?? err}`, true);
  } finally {
    state.secondarySaving = false;
  }
}

$('#btn-split-screen').addEventListener('click', async () => {
  if (state.splitActive) {
    await closeSplitScreen();
    return;
  }
  // Prefer opening a DIFFERENT notebook if one exists (instead of blindly duplicating the current one!)
  const otherNb = state.notebooks.find((n) => n.name !== state.current?.name);
  const targetName = otherNb?.name || state.current?.name || state.notebooks[0]?.name;
  if (!targetName) return;
  await openSplitScreenWith(targetName);
});

$('#split-nb-select').addEventListener('change', async (e) => {
  const nextName = e.target.value;
  if (nextName) await openSplitScreenWith(nextName);
});

$('#btn-close-split').addEventListener('click', () => closeSplitScreen());

async function openSplitScreenWith(fileName) {
  if (state.secondary && !state.secondary.sameAsPrimary && state.secondary.name !== fileName) {
    await saveSecondary();
  }
  const sameAsPrimary = Boolean(state.current && state.current.name === fileName);
  let nb = sameAsPrimary ? state.current.notebook : null;
  let mtime = state.current?.mtime ?? Date.now();
  if (!nb) {
    const openTab = state.openTabs.find((x) => x.name === fileName);
    if (openTab?.notebook) {
      nb = openTab.notebook;
      mtime = openTab.mtime ?? Date.now();
    } else {
      const raw = await bridge.readFile(fileName);
      const bytes = raw instanceof Uint8Array ? raw : raw.bytes;
      nb = readBundle(bytes, fileName);
      const stat = await bridge.statFile(fileName);
      mtime = stat?.mtimeMs ?? stat?.modifiedAt ?? Date.now();
    }
  }
  state.secondary = { name: fileName, notebook: nb, mtime, sameAsPrimary };
  state.splitActive = true;
  const primary = $('#stage');
  const resizer = $('#split-resizer');
  const secondary = $('#stage-secondary');
  primary.style.flex = '0 0 50%';
  resizer.hidden = false;
  secondary.hidden = false;
  $('#btn-split-screen').classList.add('active');

  populateSplitSelector(fileName);
  setSecondaryBadge('synced', sameAsPrimary ? 'Live-Sync' : t('saved'));

  if (!state.secondaryEditor) {
    state.secondaryEditor = new Editor(secondary, {
      settings: state.settings,
      onDirty: () => {
        if (state.secondary?.sameAsPrimary) {
          scheduleSave();
          if (state.editor) {
            state.editor.layout();
            state.editor.invalidateAll();
            state.editor.draw();
          }
        } else {
          scheduleSecondarySave();
        }
      },
      onToast: (m) => toast(m),
      onEditTextBox: (pageIdx, box) => openTextBoxModal(pageIdx, box, state.secondaryEditor),
      onRequestImage: (pageIdx, x, y) => requestAndInsertImage(pageIdx, x, y, state.secondaryEditor),
    });
    secondary.addEventListener('viewchange', updateSecondaryNav);
    secondary.addEventListener('drawn', updateSecondaryNav);
  }
  syncToolSettingsToSecondary();
  state.editor?.resize();
  state.secondaryEditor.resize();
  await state.secondaryEditor.prewarm(nb);
  state.secondaryEditor.open(nb, { preserveAssets: true });
  state.secondaryEditor.draw();
  updateSecondaryNav();
}

async function closeSplitScreen() {
  if (state.secondary && !state.secondary.sameAsPrimary) {
    await saveSecondary();
  }
  state.splitActive = false;
  state.secondary = null;
  const primary = $('#stage');
  primary.style.flex = '1 1 50%';
  $('#split-resizer').hidden = true;
  $('#stage-secondary').hidden = true;
  $('#btn-split-screen').classList.remove('active');
  state.secondaryEditor?.close();
  state.editor?.resize();
}

// Draggable split resizer with min/max 220px clamping
(() => {
  const resizer = $('#split-resizer');
  let dragging = false;
  resizer.addEventListener('pointerdown', (e) => {
    dragging = true;
    resizer.setPointerCapture?.(e.pointerId);
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragging || !state.splitActive) return;
    const wsRect = $('.workspace').getBoundingClientRect();
    const minPane = 220;
    const maxPane = Math.max(minPane, wsRect.width - minPane - 8);
    const nextW = Math.max(minPane, Math.min(maxPane, e.clientX - wsRect.left));
    $('#stage').style.flex = `0 0 ${Math.round(nextW)}px`;
    state.editor?.resize();
    state.secondaryEditor?.resize();
  });
  window.addEventListener('pointerup', () => {
    dragging = false;
  });
})();

// ---- Tools & Favorite Pens Bar ----

let toolbarBound = false;
function bindToolbarEvents() {
  if (toolbarBound) return;
  toolbarBound = true;

  $$('#tools .tool').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tool = btn.dataset.tool;
      if (tool === 'GEODREIECK') {
        const enabled = state.editor.toggleGeodreieck();
        btn.classList.toggle('active', enabled);
        btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        return;
      }
      if (tool === 'IMAGE') {
        selectTool('IMAGE');
        await requestAndInsertImage(state.editor.currentPageIndex());
        return;
      }
      selectTool(tool);
    });
    btn.addEventListener('dblclick', () => {
      if (btn.dataset.toolGroup === 'pen') openPenPicker(btn);
    });
  });

  const lastPen = state.settings.lastPen && PEN_TOOLS.includes(state.settings.lastPen) ? state.settings.lastPen : 'FOUNTAIN_PEN';
  const penBtn = $('[data-testid="tool-pen"]');
  if (penBtn) penBtn.dataset.tool = lastPen;
  selectTool(lastPen);
}

function openPenPicker(anchor) {
  const menu = document.createElement('div');
  menu.className = 'menu pen-menu';
  for (const tool of PEN_TOOLS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `${svg(tool)}<span>${t(`tool_${tool}`)}</span>`;
    b.classList.toggle('active', tool === state.editor.tool);
    b.addEventListener('click', () => {
      anchor.dataset.tool = tool;
      anchor.dataset.tTitle = `tool_${tool}`;
      anchor.title = t(`tool_${tool}`);
      anchor.setAttribute('aria-label', anchor.title);
      anchor.innerHTML = `${svg(tool)}<span class="swatch"></span>`;
      saveSettings({ lastPen: tool });
      selectTool(tool);
      menu.remove();
    });
    menu.appendChild(b);
  }
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, r.left)}px`;
  menu.style.bottom = `${window.innerHeight - r.top + 8}px`;
  menu.style.top = 'auto';
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target)) menu.remove(); }, { once: true }), 0);
}

function selectTool(tool) {
  const editor = state.editor;
  if (!editor) return;
  if (PEN_TOOLS.includes(tool)) {
    const penBtn = $('[data-testid="tool-pen"]');
    if (penBtn) {
      penBtn.dataset.tool = tool;
      penBtn.title = t(`tool_${tool}`);
      penBtn.setAttribute('aria-label', penBtn.title);
    }
  }
  editor.setTool(tool);
  if (state.secondaryEditor) state.secondaryEditor.setTool(tool);
  saveSettings({ tool });

  $$('#tools .tool').forEach((b) => {
    if (b.dataset.tool === 'GEODREIECK') return;
    const isActive = b.dataset.tool === tool || (b.dataset.toolGroup === 'pen' && PEN_TOOLS.includes(tool));
    b.classList.toggle('active', isActive);
    b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
  renderToolOptions();
}

function renderToolOptions() {
  const editor = state.editor;
  if (!editor) return;
  const tool = editor.tool;
  const box = $('#tool-options');
  box.innerHTML = '';
  const ts = editor.toolSettings[tool];
  if (!ts) return;

  if (ts.color) {
    const colors = tool === 'HIGHLIGHTER' ? HIGHLIGHT_COLORS : COLORS;
    for (const c of colors) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `color${c === ts.color ? ' active' : ''}`;
      b.style.setProperty('--c', c);
      b.title = `${t('color')} ${c}`;
      b.setAttribute('aria-label', `${t('color')} ${c}`);
      b.addEventListener('click', () => {
        ts.color = c;
        persistTools();
        syncToolSettingsToSecondary();
        renderToolOptions();
      });
      box.appendChild(b);
    }
    const customLabel = document.createElement('label');
    customLabel.className = 'color custom';
    customLabel.title = t('customColor');
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = ts.color.startsWith('#') ? ts.color : '#0f172a';
    colorInput.setAttribute('aria-label', t('customColor'));
    colorInput.addEventListener('input', () => {
      ts.color = colorInput.value;
      syncToolSettingsToSecondary();
    });
    colorInput.addEventListener('change', () => {
      persistTools();
      renderToolOptions();
    });
    customLabel.appendChild(colorInput);
    box.appendChild(customLabel);
  }

  if (tool === 'ERASER') {
    const pills = document.createElement('div');
    pills.className = 'eraser-mode-pills';
    const curMode = ts.mode || 'STROKE';
    for (const [mode, key] of [['STROKE', 'eraserModeStroke'], ['AREA', 'eraserModeArea']]) {
      const mb = document.createElement('button');
      mb.type = 'button';
      mb.className = curMode === mode ? 'active' : '';
      mb.textContent = t(key);
      mb.addEventListener('click', () => {
        ts.mode = mode;
        persistTools();
        syncToolSettingsToSecondary();
        renderToolOptions();
      });
      pills.appendChild(mb);
    }
    box.appendChild(pills);
  }

  if (ts.width) {
    const baseW = DEFAULT_TOOL_SETTINGS[tool]?.width || 5;
    const slider = document.createElement('label');
    slider.className = 'width';
    slider.title = t('width');
    slider.innerHTML = `<input type="range" min="${Math.max(1, baseW / 4)}" max="${baseW * 3}" step="0.5" aria-label="${t('width')}">`;
    const input = slider.querySelector('input');
    input.value = ts.width;
    input.addEventListener('input', () => {
      ts.width = +input.value;
      syncToolSettingsToSecondary();
    });
    input.addEventListener('change', persistTools);
    box.appendChild(slider);
  }

  $$('#tools .tool').forEach((b) => {
    const swatch = b.querySelector('.swatch');
    if (swatch) {
      const s = editor.toolSettings[b.dataset.tool];
      swatch.style.background = s?.color ?? 'transparent';
    }
  });
}

function renderFavoritePensBar() {
  const bar = $('#favorite-pens-bar');
  if (!bar) return;
  bar.innerHTML = '';

  for (const fav of state.favoritePens) {
    const wrap = document.createElement('span');
    wrap.className = 'fav-pen-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fav-pen-btn';
    const label = `${t(`tool_${fav.tool}`)} (${fav.width}px)`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = `<span class="fav-pen-dot" style="background:${fav.color}"></span><span>${t(`tool_${fav.tool}`)}</span>`;
    btn.addEventListener('click', () => {
      if (state.editor) {
        state.editor.toolSettings[fav.tool] = { ...state.editor.toolSettings[fav.tool], color: fav.color, width: fav.width };
        selectTool(fav.tool);
        syncToolSettingsToSecondary();
      }
    });

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'fav-pen-remove';
    rm.title = t('removeFavoritePen');
    rm.setAttribute('aria-label', t('removeFavoritePen'));
    rm.textContent = '×';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      state.favoritePens = state.favoritePens.filter((p) => p.id !== fav.id);
      saveSettings({ favoritePens: state.favoritePens });
      renderFavoritePensBar();
    });

    wrap.append(btn, rm);
    bar.appendChild(wrap);
  }

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'fav-pen-btn';
  addBtn.title = t('addFavoritePen');
  addBtn.setAttribute('aria-label', t('addFavoritePen'));
  addBtn.textContent = `+ ${t('addFavoritePen')}`;
  addBtn.addEventListener('click', () => {
    const editor = state.editor;
    if (!editor) return;
    const tool = INK_TOOLS.includes(editor.tool) ? editor.tool : 'FOUNTAIN_PEN';
    const ts = editor.toolSettings[tool] || DEFAULT_TOOL_SETTINGS.FOUNTAIN_PEN;
    state.favoritePens.push({
      id: `fav_${Date.now()}`,
      tool,
      color: ts.color || '#0f172a',
      width: ts.width || 5,
    });
    saveSettings({ favoritePens: state.favoritePens });
    renderFavoritePensBar();
  });
  bar.appendChild(addBtn);
}

function persistTools() {
  if (state.editor) saveSettings({ toolSettings: state.editor.toolSettings });
}

function updateHistory() {
  const e = state.editor;
  $('#btn-undo').disabled = !e?.undoStack.length;
  $('#btn-redo').disabled = !e?.redoStack.length;
}

function updateNav() {
  const e = state.editor;
  if (!e?.notebook) return;
  if (e.isInfinite()) {
    $('#page-label').textContent = t('infiniteCanvasBadge');
  } else {
    const cur = e.currentPageIndex() + 1;
    const total = e.notebook.pages.length;
    $('#page-label').textContent = t('pageOf', cur, total);
    $('#sorter-page-count').textContent = `${cur} / ${total}`;
  }
  $('#zoom-label').textContent = `${Math.round((e.zoom / e.fitZoom()) * 100)} %`;
}

$('#btn-undo').addEventListener('click', () => state.editor?.undo());
$('#btn-redo').addEventListener('click', () => state.editor?.redo());
$('#btn-delete-sel').addEventListener('click', () => state.editor?.deleteSelection());
$('#btn-dup-sel').addEventListener('click', () => state.editor?.duplicateSelection());
$('#btn-recolor-sel').addEventListener('click', () => {
  const nextColor = COLORS[Math.floor(Math.random() * COLORS.length)];
  state.editor?.recolorSelection(nextColor);
});
$('#btn-ocr-sel').addEventListener('click', () => runOcrFlow({ selectionOnly: true }));

$('#btn-zoom-in').addEventListener('click', () => state.editor?.zoomAt(1.25, state.editor.vw / 2, state.editor.vh / 2));
$('#btn-zoom-out').addEventListener('click', () => state.editor?.zoomAt(0.8, state.editor.vw / 2, state.editor.vh / 2));
$('#btn-fit').addEventListener('click', () => { state.editor?.fitWidth(); updateNav(); });
$('#btn-center-canvas').addEventListener('click', () => state.editor?.centerView());
$('#btn-add-page').addEventListener('click', () => {
  const e = state.editor;
  if (!e?.notebook) return;
  const page = e.notebook.addPage();
  e.layout();
  e.goToPage(e.notebook.pages.indexOf(page));
  renderPageSorter();
  scheduleSave();
});

// ---- Textbox / Sticky Note Modal ----

let selectedTbBgArgb = 0xfffef3c7;

function openTextBoxModal(pageIndex, box = {}, targetEditor = state.editor) {
  state.editingTextBoxContext = { pageIndex, box, targetEditor: targetEditor || state.editor };
  $('#tb-text').value = box.text || '';
  $('#tb-checklist').checked = Boolean(box.isChecklist);
  $('#tb-bold').checked = Boolean(box.isBold);
  $('#tb-italic').checked = Boolean(box.isItalic);
  selectedTbBgArgb = box.backgroundColorArgb ?? 0xfffef3c7;

  const colorsWrap = $('#tb-bg-colors');
  colorsWrap.innerHTML = '';
  for (const c of STICKY_BG_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `color-swatch${c.argb === selectedTbBgArgb ? ' active' : ''}`;
    b.style.background = c.hex === 'transparent' ? 'var(--surface-2)' : c.hex;
    b.title = c.label;
    b.setAttribute('aria-label', c.label);
    b.addEventListener('click', () => {
      selectedTbBgArgb = c.argb;
      colorsWrap.querySelectorAll('.color-swatch').forEach((el) => el.classList.toggle('active', el === b));
    });
    colorsWrap.appendChild(b);
  }

  const modal = $('#modal-textbox');
  if (!modal.open) modal.showModal();
  $('#tb-text').focus();
}

$('#btn-cancel-tb').addEventListener('click', () => $('#modal-textbox').close());
$('#form-textbox').addEventListener('submit', (e) => {
  e.preventDefault();
  const ctx = state.editingTextBoxContext;
  $('#modal-textbox').close();
  const targetEd = ctx?.targetEditor || state.editor;
  if (!ctx || !targetEd) return;
  const text = $('#tb-text').value.trim();
  if (!text && !ctx.box.id) return;
  targetEd.upsertTextBox(ctx.pageIndex, {
    ...ctx.box,
    text,
    isChecklist: $('#tb-checklist').checked,
    isBold: $('#tb-bold').checked,
    isItalic: $('#tb-italic').checked,
    backgroundColorArgb: selectedTbBgArgb,
  });
});

// ---- Image Insertion ----

async function requestAndInsertImage(pageIndex = 0, x = 240, y = 240, targetEditor = state.editor) {
  const ed = targetEditor || state.editor;
  const nb = ed?.notebook || state.current?.notebook;
  if (!nb || !ed) return;
  try {
    const picked = await bridge.pickImage?.();
    if (!picked || picked.canceled || !picked.bytes) return;
    const ext = (picked.mime || '').includes('jpeg') ? 'jpg' : 'png';
    const imgPath = nb.addImageEntry(picked.bytes, ext);
    ed.insertImageOnPage(pageIndex, imgPath, { x, y, width: 380, height: 240 });
    toast(t('imageAdded'));
  } catch (err) {
    console.error(err);
    toast(t('imageLoadFailed'), true);
  }
}

// ---- Page Sorter Drawer ----

$('#btn-page-sorter').addEventListener('click', () => {
  const drawer = $('#page-sorter-drawer');
  drawer.hidden = !drawer.hidden;
  $('#btn-page-sorter').classList.toggle('active', !drawer.hidden);
  renderPageSorter();
});

function renderPageSorter() {
  const nb = state.current?.notebook;
  const editor = state.editor;
  const drawer = $('#page-sorter-drawer');
  if (!nb || !editor || !drawer) return;

  populateTemplateOptions();
  const curIdx = editor.currentPageIndex();
  $('#sorter-page-count').textContent = `${curIdx + 1} / ${nb.pages.length}`;
  if (nb.pages[curIdx]) {
    $('#sorter-tpl-select').value = nb.pages[curIdx].template;
  }

  const list = $('#sorter-list');
  list.innerHTML = '';
  nb.pages.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = `sorter-item${idx === curIdx ? ' active' : ''}`;
    const bm = p.payload?.isBookmarked ? ' ★' : '';
    row.innerHTML = `<span>${t('pageNumber', idx + 1)}${bm}</span> <span class="muted small">${t(`tpl_${p.template}`)}</span>`;
    row.addEventListener('click', () => {
      editor.goToPage(idx);
      renderPageSorter();
    });
    list.appendChild(row);
  });
}

$('#btn-sorter-add').addEventListener('click', () => {
  const nb = state.current?.notebook;
  if (!nb) return;
  const page = nb.addPage();
  state.editor.layout();
  state.editor.goToPage(nb.pages.indexOf(page));
  renderPageSorter();
  scheduleSave();
});

$('#btn-sorter-dup').addEventListener('click', () => {
  const nb = state.current?.notebook;
  if (!nb || !state.editor) return;
  const curIdx = state.editor.currentPageIndex();
  const copy = nb.duplicatePage(curIdx);
  state.editor.layout();
  state.editor.invalidateAll();
  if (copy) state.editor.goToPage(nb.pages.indexOf(copy));
  renderPageSorter();
  updateNav();
  scheduleSave();
});

$('#btn-sorter-bm').addEventListener('click', () => {
  const nb = state.current?.notebook;
  if (!nb || !state.editor) return;
  nb.toggleBookmark(state.editor.currentPageIndex());
  renderPageSorter();
  scheduleSave();
});

$('#btn-sorter-del').addEventListener('click', () => {
  const nb = state.current?.notebook;
  if (!nb || !state.editor) return;
  if (nb.pages.length <= 1) {
    toast(t('cannotDeleteLastPage'), true);
    return;
  }
  nb.deletePage(state.editor.currentPageIndex());
  state.editor.layout();
  state.editor.invalidateAll();
  renderPageSorter();
  updateNav();
  scheduleSave();
});

$('#sorter-tpl-select').addEventListener('change', (e) => {
  const nb = state.current?.notebook;
  if (!nb || !state.editor) return;
  const idx = state.editor.currentPageIndex();
  nb.setPageTemplate(idx, e.target.value);
  state.editor.invalidatePage(idx);
  renderPageSorter();
  scheduleSave();
});

// ---- Layers Panel ----

$('#btn-layers').addEventListener('click', () => {
  const panel = $('#layers-panel');
  panel.hidden = !panel.hidden;
  $('#btn-layers').classList.toggle('active', !panel.hidden);
  renderLayers();
});

$('#btn-add-layer').addEventListener('click', () => {
  const nb = state.current?.notebook;
  if (!nb || !state.editor) return;
  const layer = nb.addLayer();
  state.editor.activeLayerId = String(layer.id);
  renderLayers();
  scheduleSave();
});

function renderLayers() {
  const nb = state.current?.notebook;
  const editor = state.editor;
  if (!nb || !editor) return;
  const list = $('#layer-list');
  list.innerHTML = '';
  const layers = nb.sortedLayers().reverse();

  for (const layer of layers) {
    const row = document.createElement('div');
    const active = String(layer.id) === String(editor.activeLayerId);
    row.className = `layer${active ? ' active' : ''}${layer.isVisible === false ? ' hidden-layer' : ''}`;
    const name = nb.layerDisplayName(layer, t);
    const opacityPct = Math.round((layer.opacity ?? 1) * 100);

    row.innerHTML = `
      <div class="layer-row">
        <button type="button" class="icon-btn small vis" title="${t('toggleVisible')}" aria-label="${t('toggleVisible')}">${svg(layer.isVisible === false ? 'eyeOff' : 'eye')}</button>
        <span class="layer-name" data-layer-name></span>
        <button type="button" class="icon-btn small ren" title="${t('renameLayer')}" aria-label="${t('renameLayer')}">${svg('edit')}</button>
        <button type="button" class="icon-btn small lock${layer.isLocked ? ' active' : ''}" title="${t('toggleLock')}" aria-label="${t('toggleLock')}">${svg(layer.isLocked ? 'lock' : 'unlock')}</button>
        ${layers.length > 1 ? `<button type="button" class="icon-btn small del" title="${t('deleteLayer')}" aria-label="${t('deleteLayer')}">${svg('trash')}</button>` : ''}
      </div>
      <div class="layer-opacity-row">
        <span>${t('layerOpacity')}</span>
        <input type="range" min="10" max="100" step="5" value="${opacityPct}" aria-label="${t('layerOpacity')}">
      </div>`;

    row.querySelector('.layer-name').textContent = name;
    row.addEventListener('click', () => {
      editor.activeLayerId = String(layer.id);
      renderLayers();
    });

    const triggerRename = async (e) => {
      e?.stopPropagation();
      const next = await dialog(t('renameLayer'), (body) => {
        body.innerHTML = `<label class="field"><span>${t('layers')}</span><input type="text" maxlength="40"></label>`;
        body.querySelector('input').value = name;
        return () => body.querySelector('input').value.trim();
      }, t('save'));
      if (next === null || next === name) return;
      nb.renameLayer(layer, next);
      renderLayers();
      scheduleSave();
    };
    row.querySelector('.layer-name').addEventListener('dblclick', triggerRename);
    row.querySelector('.ren').addEventListener('click', triggerRename);

    row.querySelector('.vis').addEventListener('click', (e) => {
      e.stopPropagation();
      layer.isVisible = layer.isVisible === false;
      nb.metaDirty = true;
      editor.invalidateAll();
      renderLayers();
      scheduleSave();
    });

    row.querySelector('.lock').addEventListener('click', (e) => {
      e.stopPropagation();
      layer.isLocked = !layer.isLocked;
      nb.metaDirty = true;
      renderLayers();
      scheduleSave();
    });

    const slider = row.querySelector('input[type="range"]');
    slider.addEventListener('click', (e) => e.stopPropagation());
    const onOpacity = () => {
      const val = Number(slider.value);
      const norm = val <= 1 ? val : val / 100;
      nb.setLayerOpacity(layer, norm);
      editor.invalidateAll();
      scheduleSave();
    };
    slider.addEventListener('input', onOpacity);
    slider.addEventListener('change', onOpacity);

    row.querySelector('.del')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!(await confirmDialog(t('confirmDeleteLayer', name), t('deleteLayer')))) return;
      nb.removeLayer(layer);
      editor.undoStack = [];
      editor.redoStack = [];
      if (String(editor.activeLayerId) === String(layer.id)) editor.activeLayerId = null;
      editor.open(nb, { keepView: true });
      renderLayers();
      updateHistory();
      scheduleSave();
    });

    list.appendChild(row);
  }
}

// ---- Lecture Audio Bar ----

$('#btn-audio').addEventListener('click', () => {
  const bar = $('#audio-bar');
  bar.hidden = !bar.hidden;
  $('#btn-audio').classList.toggle('active', !bar.hidden);
  ensureAudioController().emit();
});

function renderAudioBar(st) {
  const recBtn = $('#btn-audio-record');
  const playBtn = $('#btn-audio-play');
  const jumpBtn = $('#btn-audio-jump');
  const sel = $('#audio-entry-select');

  recBtn.textContent = st.isRecording ? t('audioStop') : t('audioRecord');
  playBtn.textContent = st.isPlaying ? t('audioPause') : t('audioPlay');
  $('#audio-time').textContent = `${formatAudioTime(st.offsetMs)} / ${formatAudioTime(st.durationMs)}`;

  jumpBtn.classList.toggle('active', st.jumpMode);
  jumpBtn.setAttribute('aria-pressed', st.jumpMode ? 'true' : 'false');
  if (state.editor) {
    state.editor.audioJumpMode = st.jumpMode;
    state.editor.activeAudioOffsetMs = st.isPlaying ? st.offsetMs : null;
    if (st.isPlaying) state.editor.invalidateAll();
  }

  sel.innerHTML = '';
  if (st.entries.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = t('audioNoRecordings');
    sel.appendChild(opt);
  } else {
    for (const entry of st.entries) {
      const opt = document.createElement('option');
      opt.value = entry.entryName;
      opt.textContent = entry.label || entry.fileName;
      if (entry.entryName === st.activeEntryName) opt.selected = true;
      sel.appendChild(opt);
    }
  }
}

$('#btn-audio-record').addEventListener('click', async () => {
  const audio = ensureAudioController();
  if (audio.isRecording) {
    const bm = await audio.stopRecording();
    if (bm) {
      toast(t('audioSaved'));
      scheduleSave();
    }
  } else {
    $('#audio-status-msg').textContent = '';
    await audio.startRecording(state.editor?.currentPageIndex() || 0);
  }
});

$('#btn-audio-play').addEventListener('click', () => ensureAudioController().togglePlay());
$('#audio-entry-select').addEventListener('change', (e) => {
  if (e.target.value) ensureAudioController().selectEntry(e.target.value);
});
$('#audio-rate-select').addEventListener('change', (e) => {
  ensureAudioController().setPlaybackRate(Number(e.target.value) || 1);
});
$('#btn-audio-jump').addEventListener('click', () => {
  const audio = ensureAudioController();
  audio.setJumpMode(!audio.jumpMode);
});

// ---- Offline OCR Modal ----

async function runOcrFlow({ selectionOnly = false } = {}) {
  const nb = state.current?.notebook;
  if (!nb || !state.editor) return;
  let text = '';
  if (selectionOnly && state.editor.selection) {
    const res = await recognizeStrokesOcr(bridge, state.editor.getSelectedStrokes());
    text = res?.text || '';
  } else {
    const res = await indexNotebookText(bridge, nb, state.editor.pdf, {
      pageIndex: state.editor.currentPageIndex(),
    });
    text = res?.text || '';
    state.workspace.ocrIndex[nb.fileName] = { text, updatedAt: Date.now() };
    await persistWorkspace();
    scheduleSave();
  }
  $('#ocr-result-text').value = text || t('ocrEmpty');
  const modal = $('#modal-ocr');
  if (!modal.open) modal.showModal();
}

$('#btn-ocr').addEventListener('click', () => runOcrFlow({ selectionOnly: false }));
$('#btn-close-ocr').addEventListener('click', () => $('#modal-ocr').close());
$('#btn-ocr-copy').addEventListener('click', async () => {
  const text = $('#ocr-result-text').value;
  try { await navigator.clipboard?.writeText(text); } catch { /* ignore */ }
  toast(t('ocrCopied'));
});
$('#btn-ocr-insert-box').addEventListener('click', () => {
  const text = $('#ocr-result-text').value.trim();
  $('#modal-ocr').close();
  if (!text || !state.editor) return;
  state.editor.upsertTextBox(state.editor.currentPageIndex(), {
    text,
    left: 160,
    top: 180,
    width: 480,
    height: 160,
    backgroundColorArgb: 0xfffef3c7,
  });
});

// ---- More Menu & Study / Dark Paper / Margin Toggles ----

function syncMoreMenuState() {
  const ed = state.editor;
  const nb = state.current?.notebook;
  $('#menu-dark-paper')?.classList.toggle('active-toggle', Boolean(ed?.darkPaper));
  $('#menu-margin-notes')?.classList.toggle('active-toggle', Boolean(nb?.marginNotesEnabled));
  $('#menu-study-mode')?.classList.toggle('active-toggle', Boolean(ed?.studyMode));
  $('#menu-reading-mode')?.classList.toggle('active-toggle', Boolean(ed?.readingMode));
}

$('#btn-more').addEventListener('click', () => {
  const menu = $('#more-menu');
  syncMoreMenuState();
  menu.hidden = !menu.hidden;
});

document.addEventListener('pointerdown', (e) => {
  const menu = $('#more-menu');
  if (menu && !menu.hidden && !menu.contains(e.target) && !$('#btn-more').contains(e.target)) {
    menu.hidden = true;
  }
});

$('#menu-dark-paper').addEventListener('click', () => {
  $('#more-menu').hidden = true;
  if (!state.editor) return;
  state.editor.setDarkPaper(!state.editor.darkPaper);
  if (state.secondaryEditor) state.secondaryEditor.setDarkPaper(state.editor.darkPaper);
  syncMoreMenuState();
});

$('#menu-margin-notes').addEventListener('click', () => {
  $('#more-menu').hidden = true;
  const nb = state.current?.notebook;
  if (!nb || !state.editor) return;
  nb.marginNotesEnabled = !nb.marginNotesEnabled;
  state.editor.layout();
  state.editor.fitWidth();
  state.editor.invalidateAll();
  syncMoreMenuState();
  scheduleSave();
});

$('#menu-study-mode').addEventListener('click', () => {
  $('#more-menu').hidden = true;
  if (!state.editor) return;
  const next = !state.editor.studyMode;
  state.editor.setStudyMode(next);
  $('#study-banner').hidden = !next;
  syncMoreMenuState();
});

$('#btn-study-reveal-all').addEventListener('click', () => state.editor?.revealAllTapes(true));
$('#btn-study-hide-all').addEventListener('click', () => state.editor?.revealAllTapes(false));

function setReadingModeUI(enabled) {
  if (!state.editor) return;
  state.editor.setReadingMode(enabled);
  state.secondaryEditor?.setReadingMode(enabled);
  $('#bottom-dock').hidden = enabled;
  $('#reading-banner').hidden = !enabled;
  syncMoreMenuState();
}

$('#menu-reading-mode').addEventListener('click', () => {
  $('#more-menu').hidden = true;
  setReadingModeUI(!state.editor?.readingMode);
});
$('#btn-exit-reading')?.addEventListener('click', () => setReadingModeUI(false));

$('#menu-append-pdf').addEventListener('click', async () => {
  $('#more-menu').hidden = true;
  const nb = state.current?.notebook;
  if (!nb || !state.editor) return;
  const picked = await bridge.pickPdfMulti?.();
  if (!picked || picked.canceled || !picked.files?.length) return;
  for (const file of picked.files) {
    const sizes = await PdfBackgrounds.pageSizes(file.bytes);
    nb.appendPdfPages(file.bytes, sizes);
  }
  state.editor.pdf.setSource(nb.entries);
  state.editor.layout();
  state.editor.invalidateAll();
  renderPageSorter();
  updateNav();
  scheduleSave();
});

$('#menu-fullscreen').addEventListener('click', () => {
  $('#more-menu').hidden = true;
  bridge.setFullscreen?.();
});

// ---- Export Studio Modal ----

$('#menu-export').addEventListener('click', () => {
  $('#more-menu').hidden = true;
  $('#exp-dark-paper').checked = Boolean(state.editor?.darkPaper);
  const modal = $('#modal-export');
  if (!modal.open) modal.showModal();
});

$('#btn-cancel-export').addEventListener('click', () => $('#modal-export').close());

$('#form-export').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nb = state.current?.notebook;
  const modal = $('#modal-export');
  if (!nb) { modal.close(); return; }

  const format = modal.querySelector('input[name="exportFormat"]:checked')?.value || 'pdf';
  const layerMode = modal.querySelector('input[name="exportLayerMode"]:checked')?.value || EXPORT_LAYER_MODES.ALL_VISIBLE;
  const includeTapes = $('#exp-include-tapes').checked;
  const darkPaper = $('#exp-dark-paper').checked;
  modal.close();

  try {
    const stem = sanitizeFileStem(nb.title);
    if (format === 'png') {
      const pngBytes = await exportPagePng(nb, state.editor?.currentPageIndex() || 0, {
        layerMode,
        includeTapes,
        darkPaper,
        pdfBg: state.editor?.pdf,
      });
      const res = await bridge.saveExportFile({
        suggestedName: `${stem}_page_${(state.editor?.currentPageIndex() || 0) + 1}.png`,
        ext: 'png',
        bytes: pngBytes,
      });
      if (res && !res.canceled) toast(t('exported'));
    } else if (format === 'docflownote') {
      const pdf = await exportNotebookPdf(nb, { layerMode, includeTapes, darkPaper, rasterizeTextBox });
      const bundleBytes = writeBundle(nb, { deviceId: state.info?.deviceId || 'windows-local', exportedPdf: pdf });
      const res = await bridge.saveExportFile({
        suggestedName: `${stem}.docflownote`,
        ext: 'docflownote',
        bytes: bundleBytes,
      });
      if (res && !res.canceled) toast(t('exported'));
    } else {
      const pdfBytes = await exportNotebookPdf(nb, { layerMode, includeTapes, darkPaper, rasterizeTextBox });
      const res = await bridge.saveExportFile({
        suggestedName: `${stem}.pdf`,
        ext: 'pdf',
        bytes: pdfBytes,
      });
      if (res && !res.canceled) toast(t('exported'));
    }
  } catch (err) {
    console.error(err);
    toast(t('exportFailed'), true);
  }
});

// ---- Cloud Overview & Settings Modals ----

$('#cloud-card').addEventListener('click', () => {
  const folder = state.info?.syncFolder || state.info?.folder || '';
  $('#cloud-modal-path').textContent = folder;
  $('#cloud-modal-count').textContent = t('cloudNotebooksCount', state.notebooks.length);
  const list = $('#cloud-modal-list');
  if (list) {
    list.innerHTML = '';
    for (const nb of state.notebooks) {
      const row = document.createElement('div');
      row.className = 'cloud-nb-row';
      const fromPhone = Boolean(nb.deviceId && nb.deviceId !== state.info?.deviceId && !String(nb.deviceId).startsWith('windows'));
      row.innerHTML = `<strong></strong><span class="muted small">${fromPhone ? t('cloudUpdatedFromPhone') : t('cloudSynced')} · ${relativeTime(nb.modifiedAt)}</span>`;
      row.querySelector('strong').textContent = nb.title;
      list.appendChild(row);
    }
  }
  const modal = $('#modal-cloud');
  if (!modal.open) modal.showModal();
});

$('#btn-cloud-sync-now').addEventListener('click', async () => {
  await refreshLibrary({ force: true });
  toast(t('cloudCheckedDone'));
});
$('#btn-close-cloud').addEventListener('click', () => $('#modal-cloud').close());

$('#btn-settings').addEventListener('click', () => {
  $('#set-theme').value = document.documentElement.getAttribute('data-theme') || 'anthracite';
  $('#set-lang').value = getLanguage() === 'auto' ? getEffectiveLanguage() : getLanguage();
  $('#set-side-btn').value = state.settings.sideButtonAction || 'ERASER';
  $('#set-finger').checked = Boolean(state.settings.fingerDraws);
  $('#set-hold-snap').checked = state.settings.holdToSnap !== false;
  $('#set-scribble').checked = state.settings.scribbleToErase !== false;
  $('#update-status-text').textContent = '';
  const modal = $('#modal-settings');
  if (!modal.open) modal.showModal();
});

$('#set-theme').addEventListener('change', (e) => applyTheme(e.target.value));
$('#set-lang').addEventListener('change', (e) => applyLanguage(e.target.value));
$('#set-side-btn').addEventListener('change', (e) => saveSettings({ sideButtonAction: e.target.value }));
$('#set-finger').addEventListener('change', (e) => saveSettings({ fingerDraws: e.target.checked }));
$('#set-hold-snap').addEventListener('change', (e) => saveSettings({ holdToSnap: e.target.checked }));
$('#set-scribble').addEventListener('change', (e) => saveSettings({ scribbleToErase: e.target.checked }));
$('#btn-open-backups').addEventListener('click', () => bridge.openBackupsFolder?.());
let latestReleaseUrl = null;
$('#btn-update-download')?.addEventListener('click', () => {
  if (latestReleaseUrl) window.open(latestReleaseUrl, '_blank', 'noopener');
});
$('#btn-check-updates').addEventListener('click', async () => {
  $('#update-status-text').textContent = t('updateChecking');
  if ($('#btn-update-download')) $('#btn-update-download').hidden = true;
  const res = await bridge.checkUpdate?.();
  if (res?.ok) {
    const msg = res.hasUpdate ? t('updateAvailable', res.latestVersion) : t('updateUpToDate', res.currentVersion);
    $('#update-status-text').textContent = msg;
    if (res.hasUpdate && res.releaseUrl && $('#btn-update-download')) {
      latestReleaseUrl = res.releaseUrl;
      $('#btn-update-download').hidden = false;
    }
    toast(msg);
  } else {
    const msg = t('updateCheckFailed');
    $('#update-status-text').textContent = msg;
    toast(msg, true);
  }
});
$('#btn-close-settings').addEventListener('click', () => $('#modal-settings').close());

// ---- Command Palette (Ctrl+K) ----

let paletteMatches = [];

function openCommandPalette() {
  const modal = $('#command-palette');
  const input = $('#palette-input');
  input.value = '';
  renderCommandPaletteResults('');
  if (!modal.open) modal.showModal();
  input.focus();
}

function renderCommandPaletteResults(query) {
  const list = $('#palette-results');
  list.innerHTML = '';
  const q = String(query || '').trim().toLowerCase();

  const nbMatches = filterAndSortNotebooks(state.notebooks, state.workspace, {
    filter: 'all',
    query: q,
    sortOrder: 'UPDATED_DESC',
  });

  const commands = [
    { label: t('newNotebook'), action: () => openNewNotebookModal() },
    { label: t('settings'), action: () => $('#btn-settings').click() },
  ].filter((cmd) => !q || cmd.label.toLowerCase().includes(q));

  paletteMatches = [
    ...nbMatches.map((nb) => ({
      label: nb.title,
      sub: getFolderPath(state.workspace, state.workspace.notebookFolders[nb.name] ?? nb.folderId) || t('library'),
      action: () => openNotebook(nb.name),
    })),
    ...commands.map((c) => ({ label: c.label, sub: t('commandPaletteCommands'), action: c.action })),
  ];

  if (paletteMatches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted small';
    empty.style.padding = '12px';
    empty.textContent = `${t('noMatches')} (0)`;
    list.appendChild(empty);
    return;
  }

  paletteMatches.forEach((item, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `palette-item${idx === 0 ? ' active' : ''}`;
    btn.innerHTML = `<strong></strong><span class="muted small"></span>`;
    btn.querySelector('strong').textContent = item.label;
    btn.querySelector('span').textContent = item.sub;
    btn.addEventListener('click', () => {
      $('#command-palette').close();
      item.action();
    });
    list.appendChild(btn);
  });
}

$('#btn-command-palette').addEventListener('click', openCommandPalette);
$('#palette-input').addEventListener('input', (e) => renderCommandPaletteResults(e.target.value));
$('#palette-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    $('#command-palette').close();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const first = paletteMatches[0];
    if (first) {
      $('#command-palette').close();
      first.action();
    }
  }
});

// ---- Global Keyboard Shortcuts ----

document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === 'k') {
    e.preventDefault();
    if ($('#command-palette').open) $('#command-palette').close();
    else openCommandPalette();
    return;
  }

  if ($('#editor').hidden || document.querySelector('dialog[open]') || e.target.closest('input, textarea, select')) return;
  const editor = state.editor;
  if (!editor) return;

  if (e.ctrlKey && key === 'z' && !e.shiftKey) { e.preventDefault(); editor.undo(); }
  else if (e.ctrlKey && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); editor.redo(); }
  else if (e.ctrlKey && key === 's') { e.preventDefault(); saveCurrent(); }
  else if (e.ctrlKey && (key === '+' || key === '=')) { e.preventDefault(); editor.zoomAt(1.25, editor.vw / 2, editor.vh / 2); }
  else if (e.ctrlKey && key === '-') { e.preventDefault(); editor.zoomAt(0.8, editor.vw / 2, editor.vh / 2); }
  else if (e.ctrlKey && key === '0') { e.preventDefault(); editor.fitWidth(); }
  else if (key === 'delete' || key === 'backspace') editor.deleteSelection();
  else if (key === 'pagedown') editor.goToPage(editor.currentPageIndex() + 1);
  else if (key === 'pageup') editor.goToPage(editor.currentPageIndex() - 1);
  else if (key === 'f11') bridge.setFullscreen?.();
  else if (key === ' ') { editor.spaceDown = true; $('#stage').classList.add('panning'); }
  else if (key === 'escape' && editor.selection) {
    editor.selection = null;
    editor.requestDraw();
    $('#lasso-bar').hidden = true;
  } else if (!e.ctrlKey && !e.altKey) {
    const shortcuts = {
      p: state.settings.lastPen || 'FOUNTAIN_PEN',
      h: 'HIGHLIGHTER',
      e: 'ERASER',
      l: 'LASSO',
      g: 'GEODREIECK',
    };
    if (shortcuts[key] === 'GEODREIECK') {
      $('[data-testid="tool-geodreieck"]')?.click();
    } else if (shortcuts[key]) {
      selectTool(shortcuts[key]);
    }
  }
});

document.addEventListener('keyup', (e) => {
  if (e.key === ' ' && state.editor) {
    state.editor.spaceDown = false;
    $('#stage').classList.remove('panning');
  }
});

// ---- Clipboard Image Paste (Ctrl+V) & Drag-and-Drop onto Editor ----

document.addEventListener('paste', async (e) => {
  if ($('#editor').hidden || document.querySelector('dialog[open]') || e.target.closest('input, textarea, select')) return;
  const nb = state.current?.notebook;
  if (!nb || !state.editor) return;
  const items = [...(e.clipboardData?.items || [])];
  const imgItem = items.find((it) => it.type.startsWith('image/'));
  if (!imgItem) return;
  const file = imgItem.getAsFile();
  if (!file) return;
  e.preventDefault();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = file.type.includes('jpeg') ? 'jpg' : 'png';
  const imgPath = nb.addImageEntry(bytes, ext);
  state.editor.insertImageOnPage(state.editor.currentPageIndex(), imgPath, { x: 220, y: 220, width: 420, height: 280 });
  toast(t('imageAdded'));
});

$('#stage')?.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
});
$('#stage')?.addEventListener('drop', async (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length || !state.current?.notebook || !state.editor) return;
  e.preventDefault();
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const ext = file.type.includes('jpeg') ? 'jpg' : 'png';
      const imgPath = state.current.notebook.addImageEntry(bytes, ext);
      state.editor.insertImageOnPage(state.editor.currentPageIndex(), imgPath, { x: 220, y: 220, width: 420, height: 280 });
      toast(t('imageAdded'));
    } else if (file.name.toLowerCase().endsWith('.pdf')) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sizes = await PdfBackgrounds.pageSizes(bytes);
      state.current.notebook.appendPdfPages(bytes, sizes);
      state.editor.pdf.setSource(state.current.notebook.entries);
      state.editor.layout();
      state.editor.invalidateAll();
      renderPageSorter();
      updateNav();
      scheduleSave();
    }
  }
});

// ---- Phone Sync & Lifecycle ----

async function checkForPhoneVersion() {
  const cur = state.current;
  if (!cur) return 'none';
  const stat = await bridge.statFile(cur.name);
  const remoteMtime = stat?.mtimeMs ?? stat?.modifiedAt ?? 0;
  if (!stat || Math.abs(remoteMtime - cur.mtime) <= 1) return 'none';
  const raw = await bridge.readFile(cur.name);
  const bytes = raw instanceof Uint8Array ? raw : raw.bytes;
  cur.mtime = remoteMtime;
  let remote;
  try {
    remote = readBundle(bytes, cur.name);
  } catch {
    return 'none';
  }
  const remoteVersion = remote.manifest.exportedAtMillis ?? 0;
  const localVersion = cur.notebook.manifest.exportedAtMillis ?? 0;
  if (remote.manifest.deviceId === state.info?.deviceId || remoteVersion <= localVersion) return 'none';

  if (cur.notebook.isDirty) {
    mergeRemote(cur.notebook, remote);
    state.editor.open(cur.notebook, { keepView: true });
    renderLayers();
    toast(t('mergedRemote'));
    return 'merged';
  }
  cur.notebook = remote;
  state.editor.open(cur.notebook, { keepView: true });
  $('#nb-title').textContent = cur.notebook.title;
  renderLayers();
  updateHistory();
  toast(t('reloadedRemote'));
  return 'reloaded';
}

bridge.onFolderChanged?.(async (payload) => {
  const name = typeof payload === 'string' ? payload : (payload?.filename || '');
  if (!name.toLowerCase().endsWith(BUNDLE_EXTENSION)) return;
  const cur = state.current;
  if (cur && name === cur.name) {
    if (state.saving || Date.now() - (state.ownWriteAt ?? 0) < 5000) return;
    if ((await checkForPhoneVersion()) === 'merged') scheduleSave();
  } else if (!$('#library').hidden) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => refreshLibrary({ force: true }), 500);
  }
});

$('#btn-refresh-lib').addEventListener('click', () => refreshLibrary({ force: true }));
$('#btn-refresh').addEventListener('click', async () => {
  const result = await checkForPhoneVersion();
  if (result === 'merged') scheduleSave();
  if (result === 'none') toast(t('noNewVersion'));
});

bridge.onWindowCloseRequested?.(async () => {
  try {
    await saveCurrent();
    await saveSecondary();
  } finally {
    bridge.closeNow?.();
  }
});

async function openExternalBundlePath(filePath) {
  if (!filePath || !bridge.readExternal) return;
  try {
    const ext = await bridge.readExternal(filePath);
    if (!ext?.bytes) return;
    const nb = readBundle(ext.bytes, ext.name);
    await openNotebook(ext.name, nb);
  } catch (err) {
    console.error(err);
    toast(t('loadFailed', filePath), true);
  }
}

bridge.onOpenFile?.((filePath) => openExternalBundlePath(filePath));

// ---- Startup ----

(async () => {
  state.info = await bridge.appInfo();
  state.settings = state.info.settings ?? {};
  if (Array.isArray(state.settings.favoritePens) && state.settings.favoritePens.length > 0) {
    state.favoritePens = state.settings.favoritePens;
  }

  let savedTheme = state.settings.theme;
  let savedLang = state.settings.language;
  try {
    savedTheme = localStorage.getItem(PREF_THEME_KEY) || savedTheme;
    savedLang = localStorage.getItem(PREF_LANG_KEY) || savedLang;
  } catch { /* ignore */ }

  applyTheme(savedTheme || 'anthracite', false);
  applyLanguage(savedLang || 'de', false);
  await showLibrary();
  if (state.info?.openFile) {
    await openExternalBundlePath(state.info.openFile);
  }
})();
