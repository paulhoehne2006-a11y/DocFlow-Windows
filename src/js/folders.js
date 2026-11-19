// Pure, Android-sync-safe Folder Hierarchy, Favorites, Sorting & Global OCR/Full-Text Search.
// Because Android's StudioCloudSyncCoordinator scans `.docflownote` files flat inside
// "DocFlow Studio", folders are stored cleanly as workspace metadata (`.docflow-workspace.json`)
// and mirrored into `manifest.notebook.folderName/folderPath` without moving files into subfolders.

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

export function emptyWorkspace() {
  return {
    version: 1,
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
