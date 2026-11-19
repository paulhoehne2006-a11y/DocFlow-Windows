import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOLDER_COLORS,
  COVER_COLORS,
  emptyWorkspace,
  normalizeWorkspace,
  createFolder,
  renameFolder,
  recolorFolder,
  deleteFolder,
  moveNotebookToFolder,
  setNotebookFavorite,
  isNotebookFavorite,
  getFolderPath,
  getFolderSubtreeIds,
  buildFolderTree,
  filterAndSortNotebooks,
} from '../src/js/folders.js';

test('FOLDER_COLORS and COVER_COLORS expose 8 valid palette entries', () => {
  assert.equal(FOLDER_COLORS.length, 8);
  for (const hex of FOLDER_COLORS) assert.match(hex, /^#[0-9A-F]{6}$/i);

  assert.equal(COVER_COLORS.length, 8);
  for (const c of COVER_COLORS) {
    assert.match(c.hex, /^#[0-9A-F]{6}$/i);
    assert.equal(typeof c.argb, 'number');
    assert.ok(c.name.length > 0);
  }
});

test('emptyWorkspace & normalizeWorkspace handle malformed inputs safely', () => {
  const empty = emptyWorkspace();
  assert.equal(empty.version, 1);
  assert.deepEqual(empty.folders, []);
  assert.deepEqual(empty.notebookFolders, {});
  assert.deepEqual(empty.favorites, {});
  assert.deepEqual(empty.ocrIndex, {});

  assert.deepEqual(normalizeWorkspace(null), empty);
  assert.deepEqual(normalizeWorkspace('invalid'), empty);

  const norm = normalizeWorkspace({
    folders: [{ id: 123, name: '   ', parentId: 99, color: '' }],
    notebookFolders: null,
    favorites: { 'a.docflownote': true },
    ocrIndex: undefined,
    lastSyncedAt: '42',
  });
  assert.equal(norm.folders[0].id, '123');
  assert.equal(norm.folders[0].name, 'Ordner');
  assert.equal(norm.folders[0].parentId, '99');
  assert.equal(norm.folders[0].color, FOLDER_COLORS[0]);
  assert.deepEqual(norm.notebookFolders, {});
  assert.deepEqual(norm.favorites, { 'a.docflownote': true });
  assert.deepEqual(norm.ocrIndex, {});
  assert.equal(norm.lastSyncedAt, 42);
});

test('createFolder, renameFolder, recolorFolder validate names and parents', () => {
  const ws = emptyWorkspace();
  assert.throws(() => createFolder(ws, { name: '   ' }), /Folder name required/);

  const root = createFolder(ws, { name: '  Uni  ', parentId: 'non-existent', color: FOLDER_COLORS[2] });
  assert.equal(root.name, 'Uni');
  assert.equal(root.parentId, null);
  assert.equal(root.color, FOLDER_COLORS[2]);

  const child = createFolder(ws, { name: 'Mathe', parentId: root.id });
  assert.equal(child.parentId, root.id);

  assert.equal(renameFolder(ws, 'missing', 'X'), null);
  assert.equal(renameFolder(ws, child.id, '   '), null);
  assert.equal(child.name, 'Mathe');

  const renamed = renameFolder(ws, child.id, ' Lineare Algebra ');
  assert.equal(renamed.name, 'Lineare Algebra');

  assert.equal(recolorFolder(ws, 'missing', '#000000'), null);
  const recolored = recolorFolder(ws, child.id, FOLDER_COLORS[4]);
  assert.equal(recolored.color, FOLDER_COLORS[4]);
});

test('deleteFolder reparents child folders and notebook mappings up to parentId', () => {
  const ws = emptyWorkspace();
  const root = createFolder(ws, { name: 'Uni' });
  const mid = createFolder(ws, { name: 'Mathe', parentId: root.id });
  const leaf = createFolder(ws, { name: 'Analysis', parentId: mid.id });

  moveNotebookToFolder(ws, 'Skript.docflownote', mid.id);
  moveNotebookToFolder(ws, 'Uebung.docflownote', leaf.id);

  assert.equal(deleteFolder(ws, 'unknown'), false);

  // Deleting mid reparents leaf and Skript.docflownote up to root
  assert.equal(deleteFolder(ws, mid.id), true);
  assert.equal(leaf.parentId, root.id);
  assert.equal(ws.notebookFolders['Skript.docflownote'], root.id);
  assert.equal(ws.notebookFolders['Uebung.docflownote'], leaf.id);

  // Deleting root promotes leaf to root and clears Skript.docflownote folder mapping
  assert.equal(deleteFolder(ws, root.id), true);
  assert.equal(leaf.parentId, null);
  assert.equal(ws.notebookFolders['Skript.docflownote'], undefined);
});

test('moveNotebookToFolder, setNotebookFavorite, and isNotebookFavorite', () => {
  const ws = emptyWorkspace();
  const fld = createFolder(ws, { name: 'Physik' });

  assert.equal(moveNotebookToFolder(ws, 'a.docflownote', fld.id), fld.id);
  assert.equal(ws.notebookFolders['a.docflownote'], fld.id);

  assert.equal(moveNotebookToFolder(ws, 'a.docflownote', 'unknown'), null);
  assert.equal(ws.notebookFolders['a.docflownote'], undefined);

  assert.equal(moveNotebookToFolder(ws, 'a.docflownote', fld.id), fld.id);
  assert.equal(moveNotebookToFolder(ws, 'a.docflownote', null), null);

  // Favorite precedence: ws.favorites overrides nb.isFavorite when present, otherwise falls back
  assert.equal(isNotebookFavorite(ws, { name: 'a.docflownote', isFavorite: true }), true);
  ws.favorites['a.docflownote'] = false;
  assert.equal(isNotebookFavorite(ws, { name: 'a.docflownote', isFavorite: true }), false);
  setNotebookFavorite(ws, 'a.docflownote', false); // deletes ws override -> falls back to nb.isFavorite
  assert.equal(isNotebookFavorite(ws, { name: 'a.docflownote', isFavorite: false }), false);
  setNotebookFavorite(ws, 'a.docflownote', true);
  assert.equal(isNotebookFavorite(ws, { name: 'a.docflownote', isFavorite: false }), true);
});

test('getFolderPath & getFolderSubtreeIds handle nesting and cycles', () => {
  const ws = emptyWorkspace();
  const root = createFolder(ws, { name: 'Uni' });
  const sub = createFolder(ws, { name: 'Mathe', parentId: root.id });
  const leaf = createFolder(ws, { name: 'Stochastik', parentId: sub.id });

  assert.equal(getFolderPath(ws, null), '');
  assert.equal(getFolderPath(ws, 'missing'), '');
  assert.equal(getFolderPath(ws, leaf.id), 'Uni / Mathe / Stochastik');

  const subtree = getFolderSubtreeIds(ws, root.id);
  assert.deepEqual([...subtree].sort(), [root.id, sub.id, leaf.id].sort());

  // Cycle protection
  root.parentId = leaf.id;
  const cyclicPath = getFolderPath(ws, leaf.id);
  assert.ok(cyclicPath.includes('Stochastik'));
});

test('buildFolderTree computes direct/total counts, workspace overrides, orphan promotion, and sorting', () => {
  const ws = emptyWorkspace();
  const z = createFolder(ws, { name: 'zeta' });
  const a = createFolder(ws, { name: 'Alpha' });
  const b = createFolder(ws, { name: 'Beta', parentId: a.id });
  const orphan = { id: 'fld_orphan', name: 'Orphan', parentId: 'missing', color: FOLDER_COLORS[0] };
  ws.folders.push(orphan);

  moveNotebookToFolder(ws, 'n1.docflownote', b.id);
  const notebooks = [
    { name: 'n1.docflownote', folderId: z.id }, // ws override puts it in Beta
    { name: 'n2.docflownote', folderId: a.id }, // fallback to nb.folderId
    { name: 'n3.docflownote', folderId: z.id },
  ];

  const tree = buildFolderTree(ws, notebooks);
  assert.deepEqual(tree.map((n) => n.name), ['Alpha', 'Orphan', 'zeta']);
  const alphaNode = tree[0];
  assert.equal(alphaNode.directCount, 1);
  assert.equal(alphaNode.totalCount, 2);
  assert.equal(alphaNode.children[0].directCount, 1);
  assert.equal(alphaNode.children[0].totalCount, 1);
  assert.equal(tree[2].totalCount, 1);
});

test('filterAndSortNotebooks filters by view, subtree, OCR/folder/title query, and sorts', () => {
  const ws = emptyWorkspace();
  const root = createFolder(ws, { name: 'Uni' });
  const sub = createFolder(ws, { name: 'Biologie', parentId: root.id });

  moveNotebookToFolder(ws, 'a.docflownote', sub.id);
  setNotebookFavorite(ws, 'b.docflownote', true);
  ws.ocrIndex['c.docflownote'] = { text: 'Quantenmechanik Formel', updatedAt: 100 };

  const notebooks = Array.from({ length: 14 }, (_, i) => {
    const name = i === 0 ? 'a.docflownote' : i === 1 ? 'b.docflownote' : i === 2 ? 'c.docflownote' : `n${i}.docflownote`;
    return {
      name,
      title: i === 0 ? 'Zellen' : i === 1 ? 'Alpha Note' : i === 2 ? 'Physik' : `Note ${String(i).padStart(2, '0')}`,
      createdAt: 100 + i * 10,
      modifiedAt: 1000 - i * 20,
      extractedHandwritingText: i === 3 ? 'Photosynthese' : '',
    };
  });

  // Folder filter includes descendants
  const inUni = filterAndSortNotebooks(notebooks, ws, { filter: 'folder', folderId: root.id });
  assert.deepEqual(inUni.map((n) => n.name), ['a.docflownote']);

  // Favorites filter
  const favs = filterAndSortNotebooks(notebooks, ws, { filter: 'favorites' });
  assert.deepEqual(favs.map((n) => n.name), ['b.docflownote']);

  // Recent caps at 12 sorted by modifiedAt desc
  const recent = filterAndSortNotebooks(notebooks, ws, { filter: 'recent' });
  assert.equal(recent.length, 12);
  assert.equal(recent[0].modifiedAt, 1000);

  // Query across folderPath, ws.ocrIndex, extractedHandwritingText, title
  assert.deepEqual(filterAndSortNotebooks(notebooks, ws, { query: 'biologie' }).map((n) => n.name), ['a.docflownote']);
  assert.deepEqual(filterAndSortNotebooks(notebooks, ws, { query: 'quanten' }).map((n) => n.name), ['c.docflownote']);
  assert.deepEqual(filterAndSortNotebooks(notebooks, ws, { query: 'photosyn' }).map((n) => n.name), ['n3.docflownote']);

  // Sorting
  const byTitle = filterAndSortNotebooks(notebooks.slice(0, 3), ws, { sortOrder: 'TITLE_ASC' });
  assert.deepEqual(byTitle.map((n) => n.title), ['Alpha Note', 'Physik', 'Zellen']);

  const byCreated = filterAndSortNotebooks(notebooks.slice(0, 3), ws, { sortOrder: 'CREATED_DESC' });
  assert.deepEqual(byCreated.map((n) => n.name), ['c.docflownote', 'b.docflownote', 'a.docflownote']);
});
