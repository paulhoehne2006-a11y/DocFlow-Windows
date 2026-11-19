// The only bridge between the page and the file system: a fixed set of calls, no Node access.
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, mapArgs) {
  return (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_event, ...args) => cb(...(mapArgs ? mapArgs(...args) : args));
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('docflow', {
  isDemo: false,
  appInfo: () => ipcRenderer.invoke('app:info'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  detectFolders: () => ipcRenderer.invoke('folder:detect'),
  setFolder: (folderPath, create = true) => ipcRenderer.invoke('folder:set', folderPath, create),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  listFiles: () => ipcRenderer.invoke('folder:list'),
  revealFolder: () => ipcRenderer.invoke('folder:reveal'),
  readFile: (name) => ipcRenderer.invoke('file:read', name),
  statFile: (name) => ipcRenderer.invoke('file:stat', name),
  writeFile: (name, bytes) => ipcRenderer.invoke('file:write', name, bytes),
  deleteFile: (name) => ipcRenderer.invoke('file:delete', name),
  readExternalFile: (filePath) => ipcRenderer.invoke('file:read-external', filePath),
  pickPdf: () => ipcRenderer.invoke('pdf:pick'),
  pickPdfMulti: () => ipcRenderer.invoke('pdf:pick-multi'),
  pickImage: () => ipcRenderer.invoke('image:pick'),
  savePdfAs: (suggestedName, bytes) => ipcRenderer.invoke('pdf:save-as', suggestedName, bytes),
  saveExportFile: (opts) => ipcRenderer.invoke('export:save-file', opts),
  readWorkspace: () => ipcRenderer.invoke('workspace:read'),
  writeWorkspace: (data) => ipcRenderer.invoke('workspace:write', data),
  listTrash: () => ipcRenderer.invoke('trash:list'),
  restoreTrash: (trashId) => ipcRenderer.invoke('trash:restore', trashId),
  purgeTrash: (trashId) => ipcRenderer.invoke('trash:purge', trashId),
  emptyTrash: () => ipcRenderer.invoke('trash:empty'),
  openBackupsFolder: () => ipcRenderer.invoke('backups:open-folder'),
  recognizeOcr: (pngBytes, preferredLang) => ipcRenderer.invoke('ocr:recognize-png', pngBytes, preferredLang),
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  openExternalUrl: (url) => ipcRenderer.invoke('shell:open-external', url),
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximize: () => ipcRenderer.invoke('window:maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  setFullscreen: (flag) => ipcRenderer.invoke('window:fullscreen', flag),
  closeNow: () => ipcRenderer.invoke('app:close-now'),
  onFolderChanged: subscribe('folder:changed', (payload) => [payload]),
  onOpenExternalFile: subscribe('app:open-file', (filePath) => [filePath]),
  onWindowCloseRequested: subscribe('app:close-requested', () => []),
  onWindowMaximized: subscribe('window:maximized-changed', (maximized) => [Boolean(maximized)]),
});
