// App shell: setup, library and the editor chrome around Editor. Talks to the main process
// through window.docflow (see preload.js); in a plain browser a demo bridge is used instead.

import { t, relativeTime } from './i18n.js';
import { readBundle, writeBundle, createNotebook, mergeRemote, sanitizeFileStem, BUNDLE_EXTENSION, TEMPLATES } from './model.js';
import { Editor, DEFAULT_TOOL_SETTINGS } from './editor.js';
import { drawPaper, drawPageContent, drawTextBox } from './render.js';
import { PdfBackgrounds } from './pdfbg.js';
import { exportNotebookPdf } from './export.js';

const bridge = window.docflow ?? await (await import('./demo-bridge.js')).createDemoBridge();
const $ = (sel) => document.querySelector(sel);

const PEN_TOOLS = ['FOUNTAIN_PEN', 'FINELINER', 'BALLPOINT_PEN', 'PENCIL', 'BRUSH_PEN', 'CALLIGRAPHY_PEN'];
const COLORS = ['#0f172a', '#475569', '#1d4ed8', '#0ea5e9', '#16a34a', '#dc2626', '#ea580c', '#9333ea'];
const HIGHLIGHT_COLORS = ['#facc15', '#4ade80', '#38bdf8', '#f472b6', '#fb923c', '#a78bfa'];
const SAVE_DELAY_MS = 2500;

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
};
const svg = (name) => `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`;

const state = {
  info: null,
  settings: {},
  notebooks: [], // library entries
  covers: new Map(), // `${name}@${mtime}` → dataURL
  current: null, // { notebook, name, mtime }
  editor: null,
  saving: false,
  saveTimer: null,
  saveQueued: false,
};

// ---- Helpers ----

function applyTexts(root = document) {
  root.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
  root.querySelectorAll('[data-t-title]').forEach((el) => { el.title = t(el.dataset.tTitle); el.setAttribute('aria-label', el.title); });
  root.querySelectorAll('[data-t-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.tPlaceholder); });
}

function show(screen) {
  for (const id of ['setup', 'library', 'editor']) $(`#${id}`).hidden = id !== screen;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  bridge.saveSettings(state.settings);
}

/** Small promise-based dialog; [build] fills the body and returns a value getter. */
function dialog(title, build, okText = t('ok')) {
  const dlg = $('#dialog');
  $('#dialog-title').textContent = title;
  const body = $('#dialog-body');
  body.innerHTML = '';
  const getValue = build(body);
  $('#dialog-ok').textContent = okText;
  dlg.showModal();
  body.querySelector('input')?.select();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? (getValue ? getValue() : true) : null), { once: true });
  });
}

function confirmDialog(text, okText) {
  return dialog(text, null, okText);
}

// ---- Setup ----

async function showSetup() {
  show('setup');
  const list = $('#setup-list');
  list.innerHTML = '';
  const found = await bridge.detectFolders();
  if (found.length === 0) {
    list.innerHTML = `<p class="warn">${t('setupNone')}</p>`;
  }
  for (const f of found) {
    const row = document.createElement('div');
    row.className = 'setup-row';
    row.innerHTML = `
      <div class="provider ${f.provider === 'OneDrive' ? 'onedrive' : 'gdrive'}"></div>
      <div class="setup-info">
        <strong>${f.provider}</strong>
        <span class="path"></span>
        <span class="muted small">${f.exists ? t('setupFound', f.notebooks) : t('setupMissing')}</span>
      </div>
      <button class="btn ${f.exists ? 'primary' : 'ghost'}">${f.exists ? t('setupUse') : t('setupCreate')}</button>`;
    row.querySelector('.path').textContent = f.folder;
    row.querySelector('button').addEventListener('click', async () => {
      await bridge.setFolder(f.folder, !f.exists);
      await showLibrary();
    });
    list.appendChild(row);
  }
}

$('#setup-other').addEventListener('click', async () => {
  if (await bridge.chooseFolder()) await showLibrary();
});

// ---- Library ----

async function showLibrary() {
  state.info = await bridge.info();
  if (!state.info.folder) {
    await showSetup();
    return;
  }
  show('library');
  $('#folder-path').textContent = state.info.folder;
  await refreshLibrary();
}

async function refreshLibrary() {
  const files = await bridge.listNotebooks();
  const entries = [];
  for (const f of files) {
    const known = state.notebooks.find((n) => n.name === f.name && n.modifiedAt === f.modifiedAt);
    entries.push(known ?? { ...f, title: f.name.replace(/\.docflownote$/i, '').replace(/_/g, ' '), pageCount: null });
  }
  state.notebooks = entries;
  renderGrid();
  loadCovers();
}

function renderGrid() {
  const grid = $('#grid');
  const q = $('#search').value.trim().toLowerCase();
  const items = state.notebooks.filter((n) => !q || n.title.toLowerCase().includes(q));
  grid.innerHTML = '';
  $('#empty').hidden = state.notebooks.length > 0;
  if (state.notebooks.length > 0 && items.length === 0) grid.innerHTML = `<p class="muted center">${t('noMatches')}</p>`;
  for (const n of items) {
    const card = document.createElement('article');
    card.className = 'card';
    card.tabIndex = 0;
    const cover = state.covers.get(`${n.name}@${n.modifiedAt}`);
    card.innerHTML = `
      <div class="cover">${cover ? `<img src="${cover}" alt="">` : '<div class="cover-placeholder"></div>'}</div>
      <div class="card-body">
        <div class="card-title"></div>
        <div class="card-meta muted small"></div>
      </div>
      <button class="card-menu icon-btn small" title="${t('deleteNotebook')}">${svg('trash')}</button>`;
    card.querySelector('.card-title').textContent = n.title;
    card.querySelector('.card-meta').textContent = [n.pageCount ? t('pages', n.pageCount) : null, t('editedAgo', relativeTime(n.modifiedAt))].filter(Boolean).join(' · ');
    card.addEventListener('click', () => openNotebook(n.name));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') openNotebook(n.name); });
    card.querySelector('.card-menu').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await confirmDialog(t('confirmDelete', n.title), t('deleteNotebook'))) {
        await bridge.deleteFile(n.name);
        await refreshLibrary();
      }
    });
    grid.appendChild(card);
  }
}

$('#search').addEventListener('input', renderGrid);

let coverJob = 0;
/** Reads each bundle once (newest first) for its title and a cover of the first page. */
async function loadCovers() {
  const job = ++coverJob;
  for (const n of state.notebooks) {
    if (job !== coverJob || $('#library').hidden) return;
    const key = `${n.name}@${n.modifiedAt}`;
    if (state.covers.has(key)) continue;
    try {
      const { bytes } = await bridge.readFile(n.name);
      const nb = readBundle(bytes, n.name);
      n.title = nb.title;
      n.pageCount = nb.pages.length;
      state.covers.set(key, await renderCover(nb));
    } catch (err) {
      console.warn('cover failed', n.name, err);
      state.covers.set(key, null);
    }
    renderGrid();
  }
}

async function renderCover(nb) {
  const page = nb.pages[0];
  const width = 360;
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
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(blob);
  });
}

function uniqueFileName(title) {
  const stem = sanitizeFileStem(title);
  const taken = new Set(state.notebooks.map((n) => n.name.toLowerCase()));
  let name = `${stem}${BUNDLE_EXTENSION}`;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${stem}_${i}${BUNDLE_EXTENSION}`;
  return name;
}

$('#btn-new').addEventListener('click', async () => {
  const result = await dialog(t('newNotebookTitle'), (body) => {
    body.innerHTML = `
      <label class="field"><span>${t('titleLabel')}</span><input id="f-title" required maxlength="80"></label>
      <div class="field"><span>${t('templateLabel')}</span><div class="template-picker" id="f-tpl"></div></div>`;
    const picker = body.querySelector('#f-tpl');
    let chosen = state.settings.lastTemplate || 'GRID_5MM';
    for (const tpl of TEMPLATES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `tpl${tpl === chosen ? ' active' : ''}`;
      const c = document.createElement('canvas');
      c.width = 84; c.height = 118;
      const cx = c.getContext('2d');
      cx.scale(84 / 1654, 118 / 2339);
      drawPaper(cx, tpl, 1654, 2339);
      b.append(c, Object.assign(document.createElement('span'), { textContent: t(`tpl_${tpl}`) }));
      b.addEventListener('click', () => {
        chosen = tpl;
        picker.querySelectorAll('.tpl').forEach((x) => x.classList.toggle('active', x === b));
      });
      picker.appendChild(b);
    }
    return () => ({ title: body.querySelector('#f-title').value.trim() || t('untitled'), template: chosen });
  }, t('create'));
  if (!result) return;
  saveSettings({ lastTemplate: result.template });
  const nb = createNotebook({ title: result.title, deviceId: state.info.deviceId, template: result.template });
  nb.fileName = uniqueFileName(result.title);
  await saveNotebook(nb, { quiet: true });
  await openNotebook(nb.fileName, nb);
});

$('#btn-open-pdf').addEventListener('click', async () => {
  const picked = await bridge.pickPdf();
  if (!picked) return;
  try {
    const sizes = await PdfBackgrounds.pageSizes(picked.bytes);
    const nb = createNotebook({ title: picked.name, deviceId: state.info.deviceId, pdfBytes: picked.bytes, pdfPageSizes: sizes, template: 'BLANK' });
    nb.fileName = uniqueFileName(picked.name);
    await saveNotebook(nb, { quiet: true });
    await openNotebook(nb.fileName, nb);
  } catch (err) {
    console.error(err);
    toast(t('pdfImportFailed'), true);
  }
});

$('#btn-change-folder').addEventListener('click', () => showSetup());
$('#btn-reveal').addEventListener('click', () => bridge.revealFolder());

// ---- Saving ----

function setStatus(kind) {
  const el = $('#save-status');
  el.dataset.kind = kind;
  el.textContent = t(kind);
}

function scheduleSave() {
  setStatus('unsaved');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveCurrent(), SAVE_DELAY_MS);
}

async function rasterizeTextBox(box) {
  const w = Math.max(40, box.width ?? 420);
  const h = Math.max(24, box.height ?? 140);
  const c = new OffscreenCanvas(Math.ceil(w * 2), Math.ceil(h * 2));
  const ctx = c.getContext('2d');
  ctx.scale(2, 2);
  ctx.translate(-box.left, -box.top);
  drawTextBox(ctx, box);
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

/** Writes bundle + PDF. The PDF sits next to the bundle like the phone's upload. */
async function saveNotebook(nb, { quiet = false } = {}) {
  const pdf = await exportNotebookPdf(nb, { rasterizeTextBox });
  const bytes = writeBundle(nb, { deviceId: state.info.deviceId, exportedPdf: pdf });
  const mtime = await bridge.writeFile(nb.fileName, bytes);
  await bridge.writeFile(nb.fileName.replace(/\.docflownote$/i, '.pdf'), pdf);
  if (!quiet) setStatus('saved');
  return mtime;
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
    // The phone may have uploaded a newer version in the meantime: merge instead of overwriting
    const stat = await bridge.statFile(cur.name);
    if (stat.exists && Math.abs(stat.modifiedAt - cur.mtime) > 1) {
      const { bytes, modifiedAt } = await bridge.readFile(cur.name);
      mergeRemote(cur.notebook, readBundle(bytes, cur.name));
      cur.mtime = modifiedAt;
      state.editor.open(cur.notebook, { keepView: true });
      renderLayers();
      toast(t('mergedRemote'));
    }
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

// ---- Editor ----

function ensureEditor() {
  if (state.editor) return state.editor;
  const editor = new Editor($('#stage'), {
    settings: state.settings,
    onDirty: () => scheduleSave(),
    onStatus: setStatus,
    onToast: (m) => toast(m),
  });
  state.editor = editor;
  const stage = $('#stage');
  stage.addEventListener('viewchange', updateNav);
  stage.addEventListener('drawn', updateNav);
  stage.addEventListener('historychange', updateHistory);
  stage.addEventListener('selectionchange', () => { $('#btn-delete-sel').hidden = !editor.selection; });
  buildToolbar();
  return editor;
}

async function openNotebook(name, preloaded = null) {
  try {
    let nb = preloaded;
    let mtime = 0;
    if (!nb) {
      const file = await bridge.readFile(name);
      nb = readBundle(file.bytes, name);
      mtime = file.modifiedAt;
    } else {
      mtime = (await bridge.statFile(name)).modifiedAt;
    }
    state.current = { notebook: nb, name, mtime };
    show('editor');
    const editor = ensureEditor();
    editor.activeLayerId = null;
    $('#layers-panel').hidden = state.settings.layersOpen === false;
    editor.resize();
    editor.open(nb);
    $('#nb-title').textContent = nb.title;
    setStatus('saved');
    renderLayers();
    updateHistory();
    if (nb.pages.some((p) => p.payload.images.length > 0)) toast(t('imagesNotShown'));
  } catch (err) {
    console.error(err);
    toast(t('loadFailed', name), true);
  }
}

async function closeNotebook() {
  await saveCurrent();
  state.editor?.close();
  state.current = null;
  await showLibrary();
}

$('#btn-back').addEventListener('click', closeNotebook);

$('#nb-title').addEventListener('dblclick', async () => {
  const nb = state.current?.notebook;
  if (!nb) return;
  const title = await dialog(t('rename'), (body) => {
    body.innerHTML = `<label class="field"><span>${t('titleLabel')}</span><input id="f-title" maxlength="80"></label>`;
    body.querySelector('input').value = nb.title;
    return () => body.querySelector('input').value.trim();
  });
  if (!title || title === nb.title) return;
  nb.manifest.notebook = { ...nb.manifest.notebook, title };
  nb.metaDirty = true;
  $('#nb-title').textContent = title;
  scheduleSave();
});

function buildToolbar() {
  const editor = state.editor;
  const tools = $('#tools');
  tools.innerHTML = '';
  const add = (tool) => {
    const b = document.createElement('button');
    b.className = 'tool';
    b.dataset.tool = tool;
    b.title = t(`tool_${tool}`);
    b.innerHTML = `${svg(tool)}<span class="swatch"></span>`;
    b.addEventListener('click', () => {
      if (PEN_TOOLS.includes(tool) && editor.tool === tool) {
        openPenPicker(b);
        return;
      }
      selectTool(tool);
    });
    tools.appendChild(b);
  };
  const lastPen = state.settings.lastPen && PEN_TOOLS.includes(state.settings.lastPen) ? state.settings.lastPen : 'FOUNTAIN_PEN';
  add(lastPen);
  for (const tool of ['HIGHLIGHTER', 'ERASER', 'LASSO', 'HAND']) add(tool);
  selectTool(state.settings.tool && (PEN_TOOLS.includes(state.settings.tool) ? lastPen : state.settings.tool) || lastPen);
}

/** Second click on the pen opens the choice of pen types. */
function openPenPicker(anchor) {
  const menu = document.createElement('div');
  menu.className = 'menu pen-menu';
  for (const tool of PEN_TOOLS) {
    const b = document.createElement('button');
    b.innerHTML = `${svg(tool)}<span>${t(`tool_${tool}`)}</span>`;
    b.classList.toggle('active', tool === state.editor.tool);
    b.addEventListener('click', () => {
      anchor.dataset.tool = tool;
      anchor.title = t(`tool_${tool}`);
      anchor.innerHTML = `${svg(tool)}<span class="swatch"></span>`;
      saveSettings({ lastPen: tool });
      selectTool(tool);
      menu.remove();
    });
    menu.appendChild(b);
  }
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${r.left}px`;
  menu.style.top = `${r.bottom + 6}px`;
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target)) menu.remove(); }, { once: true }), 0);
}

function selectTool(tool) {
  const editor = state.editor;
  editor.setTool(tool);
  saveSettings({ tool });
  document.querySelectorAll('#tools .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  renderToolOptions();
}

function renderToolOptions() {
  const editor = state.editor;
  const tool = editor.tool;
  const box = $('#tool-options');
  box.innerHTML = '';
  const ts = editor.toolSettings[tool];
  if (!ts) return;
  if (ts.color) {
    const colors = tool === 'HIGHLIGHTER' ? HIGHLIGHT_COLORS : COLORS;
    for (const c of colors) {
      const b = document.createElement('button');
      b.className = `color${c === ts.color ? ' active' : ''}`;
      b.style.setProperty('--c', c);
      b.title = t('color');
      b.addEventListener('click', () => { ts.color = c; persistTools(); renderToolOptions(); });
      box.appendChild(b);
    }
    const custom = document.createElement('label');
    custom.className = `color custom${colors.includes(ts.color) ? '' : ' active'}`;
    custom.title = t('customColor');
    custom.style.setProperty('--c', ts.color);
    custom.innerHTML = '<input type="color">';
    const input = custom.querySelector('input');
    input.value = ts.color;
    input.addEventListener('change', () => { ts.color = input.value; persistTools(); renderToolOptions(); });
    box.appendChild(custom);
  }
  const range = DEFAULT_TOOL_SETTINGS[tool].width;
  const slider = document.createElement('label');
  slider.className = 'width';
  slider.title = t('width');
  slider.innerHTML = `<span class="dot"></span><input type="range" min="${Math.max(1, range / 4)}" max="${range * 4}" step="0.5">`;
  const input = slider.querySelector('input');
  input.value = ts.width;
  const dot = slider.querySelector('.dot');
  const updateDot = () => {
    const px = Math.max(2, Math.min(22, ts.width * editor.zoom * (tool === 'HIGHLIGHTER' ? 0.6 : 1.2)));
    dot.style.width = dot.style.height = `${px}px`;
    dot.style.background = ts.color ?? '#64748b';
    if (tool === 'HIGHLIGHTER') dot.style.opacity = 0.5;
  };
  updateDot();
  input.addEventListener('input', () => { ts.width = +input.value; updateDot(); });
  input.addEventListener('change', persistTools);
  box.appendChild(slider);
  document.querySelectorAll('#tools .tool').forEach((b) => {
    const s = editor.toolSettings[b.dataset.tool];
    b.querySelector('.swatch').style.background = s?.color ?? 'transparent';
  });
}

function persistTools() {
  saveSettings({ toolSettings: state.editor.toolSettings });
}

function updateHistory() {
  const e = state.editor;
  $('#btn-undo').disabled = !e?.undoStack.length;
  $('#btn-redo').disabled = !e?.redoStack.length;
}

function updateNav() {
  const e = state.editor;
  if (!e?.notebook) return;
  $('#page-label').textContent = t('pageOf', e.currentPageIndex() + 1, e.notebook.pages.length);
  $('#zoom-label').textContent = `${Math.round((e.zoom / e.fitZoom()) * 100)} %`;
}

$('#btn-undo').addEventListener('click', () => state.editor.undo());
$('#btn-redo').addEventListener('click', () => state.editor.redo());
$('#btn-delete-sel').addEventListener('click', () => state.editor.deleteSelection());
$('#btn-zoom-in').addEventListener('click', () => state.editor.zoomAt(1.25, state.editor.vw / 2, state.editor.vh / 2));
$('#btn-zoom-out').addEventListener('click', () => state.editor.zoomAt(0.8, state.editor.vw / 2, state.editor.vh / 2));
$('#btn-fit').addEventListener('click', () => { state.editor.fitWidth(); updateNav(); });
$('#btn-add-page').addEventListener('click', () => {
  const e = state.editor;
  const page = e.notebook.addPage();
  e.layout();
  e.goToPage(e.notebook.pages.indexOf(page));
  scheduleSave();
});

// ---- Layers ----

$('#btn-layers').addEventListener('click', () => {
  const panel = $('#layers-panel');
  panel.hidden = !panel.hidden;
  $('#btn-layers').classList.toggle('active', !panel.hidden);
  saveSettings({ layersOpen: !panel.hidden });
  state.editor.resize();
});

$('#btn-add-layer').addEventListener('click', () => {
  const layer = state.current.notebook.addLayer();
  state.editor.activeLayerId = String(layer.id);
  renderLayers();
  scheduleSave();
});

function renderLayers() {
  const nb = state.current?.notebook;
  const editor = state.editor;
  if (!nb || !editor) return;
  $('#layers-panel').hidden = state.settings.layersOpen === false;
  $('#btn-layers').classList.toggle('active', state.settings.layersOpen !== false);
  const list = $('#layer-list');
  list.innerHTML = '';
  const layers = nb.sortedLayers().reverse(); // top layer first, like Photoshop
  for (const layer of layers) {
    const row = document.createElement('div');
    const active = String(layer.id) === String(editor.activeLayerId);
    row.className = `layer${active ? ' active' : ''}${layer.isVisible === false ? ' hidden-layer' : ''}`;
    const name = nb.layerDisplayName(layer, t);
    row.innerHTML = `
      <button class="icon-btn small vis" title="${t('toggleVisible')}">${svg(layer.isVisible === false ? 'eyeOff' : 'eye')}</button>
      <span class="layer-name"></span>
      <button class="icon-btn small lock${layer.isLocked ? ' on' : ''}" title="${t('toggleLock')}">${svg(layer.isLocked ? 'lock' : 'unlock')}</button>
      ${layers.length > 1 ? `<button class="icon-btn small del" title="${t('deleteLayer')}">${svg('trash')}</button>` : ''}`;
    row.querySelector('.layer-name').textContent = name;
    row.addEventListener('click', () => { editor.activeLayerId = String(layer.id); renderLayers(); });
    row.querySelector('.layer-name').addEventListener('dblclick', async () => {
      const next = await dialog(t('rename'), (body) => {
        body.innerHTML = `<label class="field"><span>${t('layers')}</span><input maxlength="40"></label>`;
        body.querySelector('input').value = name;
        return () => body.querySelector('input').value.trim();
      });
      if (next === null || next === name) return;
      layer.name = next; // blank = default name again
      nb.metaDirty = true;
      renderLayers();
      scheduleSave();
    });
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

// ---- Menu ----

$('#btn-more').addEventListener('click', (e) => {
  const menu = $('#more-menu');
  menu.hidden = !menu.hidden;
  const r = e.currentTarget.getBoundingClientRect();
  menu.style.right = `${window.innerWidth - r.right}px`;
  menu.style.top = `${r.bottom + 6}px`;
  $('#opt-barrel').checked = state.settings.barrelErases !== false;
  $('#opt-finger').checked = !!state.settings.fingerDraws;
});
document.addEventListener('pointerdown', (e) => {
  const menu = $('#more-menu');
  if (!menu.hidden && !menu.contains(e.target) && !$('#btn-more').contains(e.target)) menu.hidden = true;
});
$('#opt-barrel').addEventListener('change', (e) => { saveSettings({ barrelErases: e.target.checked }); state.editor.settings = state.settings; });
$('#opt-finger').addEventListener('change', (e) => { saveSettings({ fingerDraws: e.target.checked }); state.editor.settings = state.settings; });
$('#menu-fullscreen').addEventListener('click', () => { $('#more-menu').hidden = true; bridge.toggleFullscreen(); });
$('#menu-export').addEventListener('click', async () => {
  $('#more-menu').hidden = true;
  const nb = state.current.notebook;
  const pdf = await exportNotebookPdf(nb, { rasterizeTextBox });
  if (await bridge.savePdfAs(`${sanitizeFileStem(nb.title)}.pdf`, pdf)) toast(t('exported'));
});

// ---- Keyboard ----

document.addEventListener('keydown', (e) => {
  if ($('#editor').hidden || $('#dialog').open || e.target.closest('input')) return;
  const editor = state.editor;
  const key = e.key.toLowerCase();
  if (e.ctrlKey && key === 'z' && !e.shiftKey) { e.preventDefault(); editor.undo(); }
  else if (e.ctrlKey && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); editor.redo(); }
  else if (e.ctrlKey && key === 's') { e.preventDefault(); saveCurrent(); }
  else if (e.ctrlKey && (key === '+' || key === '=')) { e.preventDefault(); editor.zoomAt(1.25, editor.vw / 2, editor.vh / 2); }
  else if (e.ctrlKey && key === '-') { e.preventDefault(); editor.zoomAt(0.8, editor.vw / 2, editor.vh / 2); }
  else if (e.ctrlKey && key === '0') { e.preventDefault(); editor.fitWidth(); }
  else if (key === 'delete' || key === 'backspace') editor.deleteSelection();
  else if (key === 'pagedown') editor.goToPage(editor.currentPageIndex() + 1);
  else if (key === 'pageup') editor.goToPage(editor.currentPageIndex() - 1);
  else if (key === 'f11') bridge.toggleFullscreen();
  else if (key === ' ') { editor.spaceDown = true; $('#stage').classList.add('panning'); }
  else if (key === 'escape' && editor.selection) { editor.selection = null; editor.requestDraw(); $('#btn-delete-sel').hidden = true; }
  else if (!e.ctrlKey && !e.altKey) {
    const shortcuts = { p: state.settings.lastPen || 'FOUNTAIN_PEN', h: 'HIGHLIGHTER', e: 'ERASER', l: 'LASSO' };
    if (shortcuts[key]) selectTool(shortcuts[key]);
  }
});
document.addEventListener('keyup', (e) => {
  if (e.key === ' ' && state.editor) { state.editor.spaceDown = false; $('#stage').classList.remove('panning'); }
});

// ---- Sync folder changes ----

bridge.onFolderChanged(async (name) => {
  if (!name.toLowerCase().endsWith(BUNDLE_EXTENSION)) return;
  const cur = state.current;
  if (cur && name === cur.name) {
    if (state.saving) return;
    const stat = await bridge.statFile(name);
    if (!stat.exists || Math.abs(stat.modifiedAt - cur.mtime) <= 1) return; // our own write
    if (cur.notebook.isDirty) {
      saveCurrent(); // merges before writing
    } else {
      const { bytes, modifiedAt } = await bridge.readFile(name);
      cur.notebook = readBundle(bytes, name);
      cur.mtime = modifiedAt;
      state.editor.open(cur.notebook, { keepView: true });
      $('#nb-title').textContent = cur.notebook.title;
      renderLayers();
      toast(t('reloadedRemote'));
    }
  } else if (!$('#library').hidden) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(refreshLibrary, 400);
  }
});

bridge.onCloseRequested(async () => {
  try {
    await saveCurrent();
  } finally {
    bridge.closeNow();
  }
});

bridge.onOpenFile((file) => openExternal(file));

/** A .docflownote double-clicked in Explorer: its folder becomes the library. */
async function openExternal(file) {
  try {
    const ext = await bridge.readExternal(file);
    await bridge.setFolder(ext.dir, false);
    await saveCurrent();
    state.info = await bridge.info();
    await openNotebook(ext.name);
  } catch (err) {
    toast(t('loadFailed', file), true);
  }
}

window.addEventListener('beforeunload', () => { saveCurrent(); });

// ---- Start ----

applyTexts();
state.info = await bridge.info();
state.settings = state.info.settings ?? {};
if (state.info.openFile) {
  await openExternal(state.info.openFile);
} else {
  await showLibrary();
}
