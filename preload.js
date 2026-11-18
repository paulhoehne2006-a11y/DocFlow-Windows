// The only bridge between the page and the file system: a fixed set of calls, no Node access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('docflow', {
  info: () => ipcRenderer.invoke('app:info'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  detectFolders: () => ipcRenderer.invoke('folder:detect'),
  setFolder: (folder, create) => ipcRenderer.invoke('folder:set', folder, create),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  listNotebooks: () => ipcRenderer.invoke('folder:list'),
  revealFolder: () => ipcRenderer.invoke('folder:reveal'),
  readFile: (name) => ipcRenderer.invoke('file:read', name),
  statFile: (name) => ipcRenderer.invoke('file:stat', name),
  writeFile: (name, bytes) => ipcRenderer.invoke('file:write', name, bytes),
  deleteFile: (name) => ipcRenderer.invoke('file:delete', name),
  readExternal: (filePath) => ipcRenderer.invoke('file:read-external', filePath),
  pickPdf: () => ipcRenderer.invoke('pdf:pick'),
  savePdfAs: (name, bytes) => ipcRenderer.invoke('pdf:save-as', name, bytes),
  toggleFullscreen: () => ipcRenderer.invoke('window:fullscreen'),
  closeNow: () => ipcRenderer.invoke('app:close-now'),
  onFolderChanged: (cb) => ipcRenderer.on('folder:changed', (_e, name) => cb(name)),
  onCloseRequested: (cb) => ipcRenderer.on('app:close-requested', () => cb()),
  onOpenFile: (cb) => ipcRenderer.on('app:open-file', (_e, file) => cb(file)),
});
