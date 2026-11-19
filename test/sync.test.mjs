// Cross-device state sync: folder, favorite and metadata changes made on one device must reach
// the other through the `.docflownote` bundle, because the phone never sees `.docflow-workspace.json`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8, unzipSync, strFromU8 } from '../src/vendor/fflate.js';
import {
  readBundle,
  writeBundle,
  createNotebook,
  inspectBundleSummary,
  mergeRemote,
  DEFAULT_MARGIN_WIDTH,
  MARGIN_NOTES_WIDTH_RATIO,
} from '../src/js/model.js';
import {
  emptyWorkspace,
  normalizeWorkspace,
  createFolder,
  renameFolder,
  deleteFolder,
  moveNotebookToFolder,
  setNotebookFavorite,
  isNotebookFavorite,
  getFolderPath,
  parseFolderPath,
  ensureFolderPath,
  bundleFolderFields,
  notebooksInSubtree,
  reconcileWorkspaceWithBundles,
  filterAndSortNotebooks,
  WORKSPACE_VERSION,
} from '../src/js/folders.js';
import { bookmarkOffsetMs } from '../src/js/audio.js';

/** A bundle as the Android app writes it (StudioNoteBundleCodec.buildManifestJson). */
function phoneBundle({ title = 'Mathe', folderPath = '', folderId = null, isFavorite = false, exportedAtMillis = 5000, extra = {} } = {}) {
  const manifest = {
    schemaVersion: 1,
    format: 'docflownote',
    exportedAtMillis,
    deviceId: 'android-phone',
    notebook: {
      title,
      localId: 7,
      isFavorite,
      coverColorArgb: 0xff1e293b,
      canvasMode: 'PAGES',
      defaultTemplate: 'GRID_5MM',
      folderId,
      folderPath,
      marginNotesEnabled: false,
      marginWidthPx: 695,
      extractedHandwritingText: '',
      ...extra,
    },
    layers: [{ id: 1, name: '', type: 'WORKSHEET', isVisible: true, isLocked: false, sortOrder: 0, opacity: 1 }],
    pages: [{ pageIndex: 0, template: 'GRID_5MM', widthPx: 1654, heightPx: 2339, payloadEntry: 'pages/page_0.json', updatedAt: 100 }],
    audioBookmarks: [],
  };
  return zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'pages/page_0.json': strToU8(JSON.stringify({ version: 1, strokes: [], tapes: [], textBoxes: [], images: [] })),
  });
}

const libraryEntry = (bytes, name) => ({ name, ...inspectBundleSummary(bytes, name) });
const manifestOf = (bytes) => JSON.parse(strFromU8(unzipSync(bytes)['manifest.json']));

test('parseFolderPath matches Android: " / " separated, trimmed, empty segments dropped', () => {
  assert.deepEqual(parseFolderPath('Uni / Mathe / Analysis'), ['Uni', 'Mathe', 'Analysis']);
  assert.deepEqual(parseFolderPath('  Uni/Mathe  '), ['Uni', 'Mathe']);
  assert.deepEqual(parseFolderPath(''), []);
  assert.deepEqual(parseFolderPath(null), []);
});

test('ensureFolderPath creates missing levels once and reuses folders case-insensitively', () => {
  const ws = emptyWorkspace();
  const uni = createFolder(ws, { name: 'Uni' });
  const id = ensureFolderPath(ws, 'uni / Mathe / Analysis');
  assert.equal(ws.folders.length, 3);
  assert.equal(getFolderPath(ws, id), 'Uni / Mathe / Analysis');
  assert.equal(ws.folders.find((f) => f.name === 'Mathe').parentId, uni.id);
  assert.equal(ensureFolderPath(ws, 'UNI / mathe / analysis'), id);
  assert.equal(ws.folders.length, 3);
  assert.equal(ensureFolderPath(ws, ''), null);
});

test('phone → PC: folder and favorite from a phone bundle appear in the PC library', () => {
  const ws = normalizeWorkspace({ version: WORKSPACE_VERSION });
  const bytes = phoneBundle({ folderPath: 'Schule / Mathe', folderId: '42', isFavorite: true });
  const nb = libraryEntry(bytes, 'Mathe.docflownote');

  const { changed, writes } = reconcileWorkspaceWithBundles(ws, [nb]);
  assert.equal(changed, true);
  assert.deepEqual(writes, []);
  const folderId = ws.notebookFolders['Mathe.docflownote'];
  assert.equal(getFolderPath(ws, folderId), 'Schule / Mathe');
  assert.equal(isNotebookFavorite(ws, nb), true);
  assert.equal(filterAndSortNotebooks([nb], ws, { filter: 'favorites' }).length, 1);
  assert.equal(filterAndSortNotebooks([nb], ws, { filter: 'folder', folderId: ws.folders.find((f) => f.name === 'Schule').id }).length, 1);

  // Running again changes nothing
  assert.deepEqual(reconcileWorkspaceWithBundles(ws, [nb]), { changed: false, writes: [] });
});

test('phone → PC: moving out of a folder and removing the star on the phone wins over the PC mirror', () => {
  const ws = normalizeWorkspace({ version: WORKSPACE_VERSION });
  reconcileWorkspaceWithBundles(ws, [libraryEntry(phoneBundle({ folderPath: 'Uni', isFavorite: true }), 'A.docflownote')]);
  assert.ok(ws.notebookFolders['A.docflownote']);
  assert.equal(ws.favorites['A.docflownote'], true);

  const later = libraryEntry(phoneBundle({ folderPath: '', isFavorite: false, exportedAtMillis: 9000 }), 'A.docflownote');
  const { changed } = reconcileWorkspaceWithBundles(ws, [later]);
  assert.equal(changed, true);
  assert.equal(ws.notebookFolders['A.docflownote'], undefined);
  assert.equal(isNotebookFavorite(ws, later), false);
  // The now empty folder stays on the PC
  assert.equal(ws.folders.length, 1);
});

test('update from v2.0.0: PC-only folders and favorites are carried into the bundles once', () => {
  const ws = normalizeWorkspace({
    version: 1,
    folders: [{ id: 'fld_a', name: 'Uni' }, { id: 'fld_b', name: 'Physik', parentId: 'fld_a' }],
    notebookFolders: { 'P.docflownote': 'fld_b', 'Q.docflownote': 'fld_a' },
    favorites: { 'P.docflownote': true },
  });
  const p = libraryEntry(phoneBundle({ title: 'P' }), 'P.docflownote');
  // Q was moved into another folder on the phone in the meantime: the bundle's path wins
  const q = libraryEntry(phoneBundle({ title: 'Q', folderPath: 'Archiv' }), 'Q.docflownote');

  const { changed, writes } = reconcileWorkspaceWithBundles(ws, [p, q]);
  assert.equal(changed, true);
  assert.equal(ws.version, WORKSPACE_VERSION);
  assert.deepEqual(writes, [{ name: 'P.docflownote', folderId: 'fld_b', folderPath: 'Uni / Physik', isFavorite: true }]);
  assert.equal(getFolderPath(ws, ws.notebookFolders['Q.docflownote']), 'Archiv');

  // After the migration the bundles are the source of truth
  const second = reconcileWorkspaceWithBundles(ws, [{ ...p, folderId: 'fld_b', folderPath: 'Uni / Physik', isFavorite: true }, q]);
  assert.deepEqual(second, { changed: false, writes: [] });
});

test('PC → phone: a move and a star written into the bundle are what Android reads', () => {
  const ws = normalizeWorkspace({ version: WORKSPACE_VERSION });
  const target = createFolder(ws, { name: 'Uni' });
  const sub = createFolder(ws, { name: 'Mathe', parentId: target.id });

  const nb = readBundle(phoneBundle(), 'Mathe.docflownote');
  moveNotebookToFolder(ws, nb.fileName, sub.id);
  const fields = bundleFolderFields(ws, sub.id);
  nb.setFolder(fields.folderId, fields.folderPath);
  setNotebookFavorite(ws, nb.fileName, true);
  nb.isFavorite = true;
  const bytes = writeBundle(nb, { deviceId: 'windows-pc', now: 20000 });

  const m = manifestOf(bytes);
  assert.equal(m.deviceId, 'windows-pc');
  assert.equal(m.exportedAtMillis, 20000);
  assert.equal(m.notebook.folderPath, 'Uni / Mathe');
  assert.equal(m.notebook.folderId, sub.id);
  assert.equal(m.notebook.isFavorite, true);
  assert.equal(m.notebook.localId, 7, 'unknown Android fields survive');

  // The PC library reading its own file again stays consistent
  assert.deepEqual(reconcileWorkspaceWithBundles(ws, [libraryEntry(bytes, nb.fileName)]), { changed: false, writes: [] });
});

test('renaming or deleting a folder on the PC lists every notebook whose bundle path must change', () => {
  const ws = normalizeWorkspace({ version: WORKSPACE_VERSION });
  const uni = createFolder(ws, { name: 'Uni' });
  const mathe = createFolder(ws, { name: 'Mathe', parentId: uni.id });
  moveNotebookToFolder(ws, 'A.docflownote', mathe.id);
  moveNotebookToFolder(ws, 'B.docflownote', uni.id);
  moveNotebookToFolder(ws, 'C.docflownote', null);

  assert.deepEqual(notebooksInSubtree(ws, uni.id).sort(), ['A.docflownote', 'B.docflownote']);
  renameFolder(ws, uni.id, 'Studium');
  assert.equal(bundleFolderFields(ws, ws.notebookFolders['A.docflownote']).folderPath, 'Studium / Mathe');

  const affected = notebooksInSubtree(ws, mathe.id);
  deleteFolder(ws, mathe.id);
  assert.deepEqual(affected, ['A.docflownote']);
  assert.deepEqual(bundleFolderFields(ws, ws.notebookFolders['A.docflownote']), { folderId: uni.id, folderPath: 'Studium' });
  assert.deepEqual(bundleFolderFields(ws, null), { folderId: null, folderPath: '' });
});

test('mergeRemote keeps only the metadata edited here; phone favorite/folder changes survive', () => {
  const base = phoneBundle({ folderPath: 'Uni', isFavorite: false });
  const local = readBundle(base, 'Mathe.docflownote');
  local.extractedHandwritingText = 'Kettenregel'; // OCR on the PC

  const remote = readBundle(phoneBundle({ folderPath: 'Archiv', isFavorite: true, exportedAtMillis: 9000 }), 'Mathe.docflownote');
  mergeRemote(local, remote);

  assert.equal(local.extractedHandwritingText, 'Kettenregel');
  assert.equal(local.isFavorite, true);
  assert.equal(local.folderPath, 'Archiv');
  assert.equal(local.isDirty, true);

  // After saving, nothing counts as locally edited anymore
  writeBundle(local, { deviceId: 'windows-pc' });
  assert.equal(local.dirtyMetaKeys.size, 0);
  const newer = readBundle(phoneBundle({ folderPath: '', isFavorite: false, exportedAtMillis: 12000 }), 'Mathe.docflownote');
  mergeRemote(local, newer);
  assert.equal(local.isFavorite, false);
  assert.equal(local.folderPath, '');
});

test('margin notes match Android: every page, 42 % of the page width', () => {
  assert.equal(MARGIN_NOTES_WIDTH_RATIO, 0.42);
  assert.equal(DEFAULT_MARGIN_WIDTH, 695);
  const nb = createNotebook({ title: 'Papier', deviceId: 'pc', template: 'LINED' });
  const page = nb.pages[0];
  assert.equal(nb.pageTotalWidth(page), page.widthPx);
  nb.marginNotesEnabled = true;
  assert.equal(nb.pageTotalWidth(page), page.widthPx + DEFAULT_MARGIN_WIDTH);
  nb.canvasMode = 'INFINITE';
  assert.equal(nb.pageTotalWidth(page), page.widthPx);
});

test('audio bookmarks from Android start at their offset inside the recording', () => {
  assert.equal(bookmarkOffsetMs({ offsetMs: 83_500 }), 83_500);
  assert.equal(bookmarkOffsetMs({ offsetMs: -5 }), 0);
  assert.equal(bookmarkOffsetMs({}), 0);
  assert.equal(bookmarkOffsetMs(null), 0);
});
