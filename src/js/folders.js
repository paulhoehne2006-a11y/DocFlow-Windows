// Pure, Android-sync-safe Folder Hierarchy, Favorites, Sorting & Global OCR/Full-Text Search.
// Because Android's StudioCloudSyncCoordinator scans `.docflownote` files flat inside
// "DocFlow Studio", files never move into subfolders.
//
// Source of truth for a notebook's folder and favorite state is its bundle manifest
// (`notebook.folderPath`, `notebook.folderId`, `notebook.isFavorite`), because that is the only
// thing the phone reads and writes. `.docflow-workspace.json` only keeps what the bundles cannot
// carry (folder colors, empty folders, the OCR index) plus a mirror of the bundle state.

export const FOLDER_COLORS = [
  '#4F46E5', // Indigo (DocFlow Primary)
  '#7C3AED', // Violet
  '#0284C7', // Sky
  '#0F766E', // Teal
  '#15803D', // Emerald
  '#D97706', // Amber
  '#DC2626', // Crimson
  '#475569', // Slate
];

export const COVER_COLORS = [
  { hex: '#1E293B', argb: 0xff1e293b, name: 'Slate' },
  { hex: '#1D4ED8', argb: 0xff1d4ed8, name: 'Royal' },
  { hex: '#4F46E5', argb: 0xff4f46e5, name: 'Indigo' },
  { hex: '#6D28D9', argb: 0xff6d28d9, name: 'Violet' },
  { hex: '#0F766E', argb: 0xff0f766e, name: 'Teal' },
  { hex: '#047857', argb: 0xff047857, name: 'Emerald' },
  { hex: '#B45309', argb: 0xffb45309, name: 'Amber' },
  { hex: '#BE123C', argb: 0xffbe123c, name: 'Crimson' },
];

/** Workspace format: 1 = folder/favorite state only in the workspace file, 2 = mirrored from bundles. */
export const WORKSPACE_VERSION = 2;
/** Separator of `notebook.folderPath`, identical to Android's StudioBundleMerge.FOLDER_PATH_SEPARATOR. */
export const FOLDER_PATH_SEPARATOR = ' / ';

export function emptyWorkspace() {
  return {
    version: WORKSPACE_VERSION,
    folders: [], // [{ id, name, parentId, color, createdAt, updatedAt }]
    notebookFolders: {}, // { [fileName]: folderId }
    favorites: {}, // { [fileName]: boolean }
    ocrIndex: {}, // { [fileName]: { text, updatedAt } }
    lastSyncedAt: 0,
  };
}

export function normalizeWorkspace(raw) {
  const base = emptyWorkspace();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    version: Number(raw.version) || 1,
    folders: Array.isArray(raw.folders) ? raw.folders.map((f) => ({
      id: String(f.id),
      name: String(f.name || 'Ordner').trim() || 'Ordner',
      parentId: f.parentId ? String(f.parentId) : null,
      color: f.color || FOLDER_COLORS[0],
      createdAt: Number(f.createdAt) || Date.now(),
      updatedAt: Number(f.updatedAt) || Date.now(),
    })) : [],
    notebookFolders: raw.notebookFolders && typeof raw.notebookFolders === 'object' ? { ...raw.notebookFolders } : {},
    favorites: raw.favorites && typeof raw.favorites === 'object' ? { ...raw.favorites } : {},
    ocrIndex: raw.ocrIndex && typeof raw.ocrIndex === 'object' ? { ...raw.ocrIndex } : {},
    lastSyncedAt: Number(raw.lastSyncedAt) || 0,
  };
}

export function createFolder(ws, { name, parentId = null, color = FOLDER_COLORS[0] }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Folder name required');
  const validParent = parentId && ws.folders.some((f) => f.id === parentId) ? parentId : null;
  const now = Date.now();
  const folder = {
    id: `fld_${now}_${Math.random().toString(36).slice(2, 7)}`,
    name: cleanName,
    parentId: validParent,
    color: color || FOLDER_COLORS[0],
    createdAt: now,
    updatedAt: now,
  };
  ws.folders.push(folder);
  return folder;
}

export function renameFolder(ws, folderId, newName) {
  const clean = String(newName || '').trim();
  const f = ws.folders.find((item) => item.id === folderId);
  if (!f || !clean) return null;
  f.name = clean;
  f.updatedAt = Date.now();
  return f;
}

export function recolorFolder(ws, folderId, color) {
  const f = ws.folders.find((item) => item.id === folderId);
  if (!f) return null;
  f.color = color;
  f.updatedAt = Date.now();
  return f;
}

/**
 * Safely deletes a folder: child subfolders and notebooks are preserved and moved up to parentId.
 */
export function deleteFolder(ws, folderId) {
  const target = ws.folders.find((f) => f.id === folderId);
  if (!target) return false;
  const fallbackParent = target.parentId ?? null;
  for (const child of ws.folders) {
    if (child.parentId === folderId) child.parentId = fallbackParent;
  }
  for (const [fileName, assignedId] of Object.entries(ws.notebookFolders)) {
    if (assignedId === folderId) {
      if (fallbackParent) ws.notebookFolders[fileName] = fallbackParent;
      else delete ws.notebookFolders[fileName];
    }
  }
  ws.folders = ws.folders.filter((f) => f.id !== folderId);
  return true;
}

export function moveNotebookToFolder(ws, fileName, folderId) {
  if (!folderId || !ws.folders.some((f) => f.id === folderId)) {
    delete ws.notebookFolders[fileName];
    return null;
  }
  ws.notebookFolders[fileName] = folderId;
  return folderId;
}

export function setNotebookFavorite(ws, fileName, isFavorite) {
  if (isFavorite) ws.favorites[fileName] = true;
  else delete ws.favorites[fileName];
}

export function isNotebookFavorite(ws, nb) {
  if (Object.prototype.hasOwnProperty.call(ws.favorites, nb.name)) return !!ws.favorites[nb.name];
  return !!nb.isFavorite;
}

export function getFolderPath(ws, folderId) {
  if (!folderId) return '';
  const parts = [];
  const visited = new Set();
  let cur = ws.folders.find((f) => f.id === folderId);
  while (cur && !visited.has(cur.id)) {
    visited.add(cur.id);
    parts.unshift(cur.name);
    cur = cur.parentId ? ws.folders.find((f) => f.id === cur.parentId) : null;
  }
  return parts.join(' / ');
}

/** Returns folderId plus all nested descendant folder IDs. */
export function getFolderSubtreeIds(ws, folderId) {
  const out = new Set([folderId]);
  let added = true;
  while (added) {
    added = false;
    for (const f of ws.folders) {
      if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
        out.add(f.id);
        added = true;
      }
    }
  }
  return out;
}

/** Builds a nested tree of folders with notebook counts (including descendants). */
export function buildFolderTree(ws, notebooks = []) {
  const byId = new Map(ws.folders.map((f) => [f.id, { ...f, children: [], directCount: 0, totalCount: 0 }]));
  for (const nb of notebooks) {
    const fid = ws.notebookFolders[nb.name] ?? nb.folderId ?? null;
    if (fid && byId.has(fid)) byId.get(fid).directCount++;
  }
  const roots = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId) && node.parentId !== node.id) {
      byId.get(node.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortNodes = (list) => {
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    for (const n of list) {
      sortNodes(n.children);
      n.totalCount = n.directCount + n.children.reduce((s, c) => s + c.totalCount, 0);
    }
  };
  sortNodes(roots);
  return roots;
}

/**
 * Filters and sorts notebooks by view ('all' | 'favorites' | 'recent' | 'folder'),
 * selected folder (including nested subfolders), search query (title, folder, OCR text),
 * and sort order ('UPDATED_DESC' | 'CREATED_DESC' | 'TITLE_ASC').
 */
export function filterAndSortNotebooks(notebooks, ws, {
  filter = 'all',
  folderId = null,
  query = '',
  sortOrder = 'UPDATED_DESC',
} = {}) {
  const q = String(query || '').trim().toLowerCase();
  const subtree = filter === 'folder' && folderId ? getFolderSubtreeIds(ws, folderId) : null;

  let list = notebooks.filter((nb) => {
    const assignedFolder = ws.notebookFolders[nb.name] ?? nb.folderId ?? null;
    if (filter === 'favorites' && !isNotebookFavorite(ws, nb)) return false;
    if (subtree && !subtree.has(assignedFolder)) return false;
    if (q) {
      const title = (nb.title || nb.name || '').toLowerCase();
      const folderPath = getFolderPath(ws, assignedFolder).toLowerCase();
      const ocrText = (ws.ocrIndex[nb.name]?.text || nb.extractedHandwritingText || '').toLowerCase();
      if (!title.includes(q) && !folderPath.includes(q) && !ocrText.includes(q)) return false;
    }
    return true;
  });

  if (filter === 'recent') {
    list = [...list].sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0)).slice(0, 12);
    return list;
  }

  list = [...list].sort((a, b) => {
    if (sortOrder === 'TITLE_ASC') {
      return (a.title || a.name).localeCompare(b.title || b.name, undefined, { sensitivity: 'base' });
    }
    if (sortOrder === 'CREATED_DESC') {
      return (b.createdAt || b.modifiedAt || 0) - (a.createdAt || a.modifiedAt || 0);
    }
    return (b.modifiedAt || 0) - (a.modifiedAt || 0);
  });
  return list;
}


/** Splits a `folderPath` like "Uni / Mathe" into trimmed, non-empty segments. */
export function parseFolderPath(path) {
  return String(path ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
}

const sameName = (a, b) => String(a).trim().localeCompare(String(b).trim(), undefined, { sensitivity: 'accent' }) === 0;

/** Existing folder for the segments of a path (case-insensitive), or null. */
export function findFolderByPath(ws, segments) {
  let parent = null;
  let found = null;
  for (const name of segments) {
    found = ws.folders.find((f) => (f.parentId ?? null) === parent && sameName(f.name, name)) ?? null;
    if (!found) return null;
    parent = found.id;
  }
  return found;
}

/**
 * Folder for `folderPath`, creating every missing level (like Android's ensureFolderPath).
 * Returns the folder id, or null for an empty path. Sets `ws.dirty` when folders were created.
 */
export function ensureFolderPath(ws, folderPath) {
  const segments = parseFolderPath(folderPath);
  if (!segments.length) return null;
  let parent = null;
  let folder = null;
  for (const name of segments) {
    folder = ws.folders.find((f) => (f.parentId ?? null) === parent && sameName(f.name, name)) ?? null;
    if (!folder) {
      folder = createFolder(ws, { name, parentId: parent });
      ws.dirty = true;
    }
    parent = folder.id;
  }
  return folder.id;
}

/** Folder a library entry belongs to according to its bundle (path first, then a known id). */
export function resolveBundleFolderId(ws, nb) {
  const path = String(nb.folderPath || '').trim();
  if (path) {
    const byId = nb.folderId ? ws.folders.find((f) => f.id === nb.folderId) : null;
    if (byId && sameName(getFolderPath(ws, byId.id), parseFolderPath(path).join(FOLDER_PATH_SEPARATOR))) return byId.id;
    return ensureFolderPath(ws, path);
  }
  if (nb.folderId && ws.folders.some((f) => f.id === nb.folderId)) return nb.folderId;
  return null;
}

/** The manifest fields that put a notebook into [folderId] (null = top level). */
export function bundleFolderFields(ws, folderId) {
  const valid = folderId && ws.folders.some((f) => f.id === folderId) ? folderId : null;
  return { folderId: valid, folderPath: valid ? getFolderPath(ws, valid) : '' };
}

/**
 * Brings the workspace in line with the folder/favorite state stored in the bundles.
 *
 * `notebooks` are library entries with `name`, `folderId`, `folderPath` and `isFavorite` read from
 * each bundle. Returns the bundle writes that are still needed: on the first run after an update
 * from workspace version 1, PC-only folder and favorite assignments are carried into the bundles
 * so the phone sees them. Afterwards the bundles always win, because every local change is
 * written into the bundle right away.
 */
export function reconcileWorkspaceWithBundles(ws, notebooks) {
  const legacy = (Number(ws.version) || 1) < WORKSPACE_VERSION;
  const writes = [];
  let changed = legacy;
  for (const nb of notebooks) {
    const patch = {};
    const legacyFolder = legacy ? ws.notebookFolders[nb.name] : null;
    let folderId;
    if (legacyFolder && ws.folders.some((f) => f.id === legacyFolder) && !String(nb.folderPath || '').trim()) {
      folderId = legacyFolder;
      Object.assign(patch, bundleFolderFields(ws, folderId));
    } else {
      folderId = resolveBundleFolderId(ws, nb);
    }
    if ((ws.notebookFolders[nb.name] ?? null) !== folderId) {
      if (folderId) ws.notebookFolders[nb.name] = folderId;
      else delete ws.notebookFolders[nb.name];
      changed = true;
    }

    let favorite = !!nb.isFavorite;
    if (legacy && ws.favorites[nb.name] === true && !favorite) {
      favorite = true;
      patch.isFavorite = true;
    }
    if (!!ws.favorites[nb.name] !== favorite) {
      if (favorite) ws.favorites[nb.name] = true;
      else delete ws.favorites[nb.name];
      changed = true;
    }
    if (Object.keys(patch).length) writes.push({ name: nb.name, ...patch });
  }
  if (ws.dirty) changed = true;
  delete ws.dirty;
  ws.version = WORKSPACE_VERSION;
  return { changed, writes };
}

/** Notebooks whose folder path changes when [folderId] (and its subfolders) is renamed or deleted. */
export function notebooksInSubtree(ws, folderId) {
  const subtree = getFolderSubtreeIds(ws, folderId);
  return Object.entries(ws.notebookFolders)
    .filter(([, id]) => subtree.has(id))
    .map(([name]) => name);
}
