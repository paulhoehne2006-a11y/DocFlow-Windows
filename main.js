// Electron main process: window, settings and file access to the locally synced cloud folder
// (OneDrive / Google Drive for desktop). The renderer never touches the file system directly.

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const BUNDLE_EXT = '.docflownote';
const DEFAULT_FOLDER_NAME = 'DocFlow Studio';

let mainWindow = null;
let watcher = null;
let allowClose = false;
let pendingOpenFile = process.argv.find((a) => a.toLowerCase().endsWith(BUNDLE_EXT)) ?? null;

// ---- Settings ----

const configPath = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
  return next;
}

function deviceId() {
  const cfg = readConfig();
  if (cfg.deviceId) return cfg.deviceId;
  return writeConfig({ deviceId: `windows-${crypto.randomUUID()}` }).deviceId;
}

// ---- Cloud folder detection ----

/** Folders where OneDrive / Google Drive for desktop keep their files on this PC. */
function cloudRoots() {
  const roots = [];
  for (const key of ['OneDriveConsumer', 'OneDrive', 'OneDriveCommercial']) {
    const p = process.env[key];
    if (p) roots.push({ provider: 'OneDrive', path: p });
  }
  const home = app.getPath('home');
  roots.push({ provider: 'OneDrive', path: path.join(home, 'OneDrive') });
  if (process.platform === 'win32') {
    for (let c = 67; c <= 90; c++) { // C: … Z:
      const drive = `${String.fromCharCode(c)}:\\`;
      for (const name of ['Meine Ablage', 'My Drive']) roots.push({ provider: 'Google Drive', path: path.join(drive, name) });
    }
  }
  roots.push({ provider: 'Google Drive', path: path.join(home, 'Google Drive', 'Meine Ablage') });
  roots.push({ provider: 'Google Drive', path: path.join(home, 'Google Drive', 'My Drive') });
  roots.push({ provider: 'Google Drive', path: path.join(home, 'Google Drive') });

  const seen = new Set();
  return roots.filter((r) => {
    const key = r.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    try {
      return fs.statSync(r.path).isDirectory();
    } catch {
      return false;
    }
  });
}

function detectFolders() {
  return cloudRoots().map((root) => {
    const folder = path.join(root.path, DEFAULT_FOLDER_NAME);
    let exists = false;
    let notebooks = 0;
    try {
      exists = fs.statSync(folder).isDirectory();
      if (exists) notebooks = fs.readdirSync(folder).filter((f) => f.toLowerCase().endsWith(BUNDLE_EXT)).length;
    } catch { /* not there yet */ }
    return { provider: root.provider, root: root.path, folder, exists, notebooks };
  });
}

/** Folders mirrored by Google Drive for desktop ("Meine Ablage" / "My Drive"). */
function isGoogleDriveFolder(folder) {
  if (!folder) return false;
  const lower = folder.toLowerCase();
  return lower.includes('meine ablage') || lower.includes('my drive') || lower.includes('google drive');
}

function currentFolder() {
  const folder = readConfig().folder;
  if (folder) {
    try {
      if (fs.statSync(folder).isDirectory()) return folder;
    } catch { /* folder gone (e.g. drive not mounted) */ }
  }
  return null;
}

/** Only plain file names inside the chosen folder – never paths from the renderer. */
function resolveInFolder(name) {
  const folder = currentFolder();
  if (!folder) throw new Error('Kein Ordner gewählt');
  const base = path.basename(String(name));
  if (!base || base !== name || base.startsWith('.')) throw new Error(`Ungültiger Dateiname: ${name}`);
  return path.join(folder, base);
}

// ---- Folder watching ----

function startWatching() {
  watcher?.close();
  watcher = null;
  const folder = currentFolder();
  if (!folder) return;
  const timers = new Map();
  try {
    watcher = fs.watch(folder, (_event, filename) => {
      if (!filename || filename.startsWith('.')) return;
      clearTimeout(timers.get(filename));
      // Sync clients write in several steps – report once the file has settled
      timers.set(filename, setTimeout(() => {
        timers.delete(filename);
        mainWindow?.webContents.send('folder:changed', filename);
      }, 800));
    });
  } catch (err) {
    console.warn('watch failed', err);
  }
}

// ---- IPC ----

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    deviceId: deviceId(),
    folder: currentFolder(),
    settings: readConfig().settings ?? {},
    isGoogleDrive: isGoogleDriveFolder(currentFolder()),
    openFile: pendingOpenFile,
  }));

  ipcMain.handle('settings:save', (_e, settings) => {
    writeConfig({ settings });
  });

  ipcMain.handle('folder:detect', () => detectFolders());

  ipcMain.handle('folder:set', async (_e, folder, create) => {
    if (create) await fsp.mkdir(folder, { recursive: true });
    const stat = await fsp.stat(folder);
    if (!stat.isDirectory()) throw new Error('Kein Ordner');
    writeConfig({ folder });
    startWatching();
    return folder;
  });

  ipcMain.handle('folder:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Ordner mit DocFlow-Notizbüchern wählen',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: currentFolder() ?? cloudRoots()[0]?.path ?? app.getPath('documents'),
    });
    if (result.canceled || !result.filePaths[0]) return null;
    writeConfig({ folder: result.filePaths[0] });
    startWatching();
    return result.filePaths[0];
  });

  ipcMain.handle('folder:list', async () => {
    const folder = currentFolder();
    if (!folder) return [];
    const names = (await fsp.readdir(folder)).filter((f) => f.toLowerCase().endsWith(BUNDLE_EXT) && !f.startsWith('.'));
    const out = [];
    for (const name of names) {
      try {
        const st = await fsp.stat(path.join(folder, name));
        out.push({ name, size: st.size, modifiedAt: st.mtimeMs });
      } catch { /* deleted meanwhile */ }
    }
    return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  });

  ipcMain.handle('folder:reveal', () => {
    const folder = currentFolder();
    if (folder) shell.openPath(folder);
  });

  ipcMain.handle('file:read', async (_e, name) => {
    const file = resolveInFolder(name);
    const [bytes, st] = await Promise.all([fsp.readFile(file), fsp.stat(file)]);
    return { bytes: new Uint8Array(bytes), modifiedAt: st.mtimeMs };
  });

  ipcMain.handle('file:stat', async (_e, name) => {
    try {
      const st = await fsp.stat(resolveInFolder(name));
      return { exists: true, modifiedAt: st.mtimeMs };
    } catch {
      return { exists: false, modifiedAt: 0 };
    }
  });

  // New files: write a hidden temp file, then rename, so no sync client uploads half a file.
  // Existing files are overwritten in place: replacing them would give the file a new identity
  // in Google Drive, and the phone app (which may only see files it created) would lose it.
  ipcMain.handle('file:write', async (_e, name, bytes) => {
    const file = resolveInFolder(name);
    const data = Buffer.from(bytes);
    if (fs.existsSync(file)) {
      await fsp.writeFile(file, data);
    } else {
      const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
      await fsp.writeFile(tmp, data);
      await fsp.rename(tmp, file);
    }
    return (await fsp.stat(file)).mtimeMs;
  });

  ipcMain.handle('file:delete', async (_e, name) => {
    await shell.trashItem(resolveInFolder(name));
  });

  ipcMain.handle('file:read-external', async (_e, filePath) => {
    if (!String(filePath).toLowerCase().endsWith(BUNDLE_EXT)) throw new Error('Keine DocFlow-Datei');
    pendingOpenFile = null;
    return { name: path.basename(filePath), dir: path.dirname(filePath), bytes: new Uint8Array(await fsp.readFile(filePath)) };
  });

  ipcMain.handle('pdf:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'PDF öffnen',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile'],
      defaultPath: currentFolder() ? path.dirname(currentFolder()) : undefined,
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    return { name: path.basename(file, path.extname(file)), bytes: new Uint8Array(await fsp.readFile(file)) };
  });

  ipcMain.handle('pdf:save-as', async (_e, suggestedName, bytes) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Als PDF speichern',
      defaultPath: path.join(app.getPath('documents'), suggestedName),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fsp.writeFile(result.filePath, Buffer.from(bytes));
    shell.showItemInFolder(result.filePath);
    return result.filePath;
  });

  ipcMain.handle('app:close-now', () => {
    allowClose = true;
    mainWindow?.close();
  });

  ipcMain.handle('window:fullscreen', () => {
    mainWindow?.setFullScreen(!mainWindow.isFullScreen());
  });
}

// ---- Window ----

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 500,
    backgroundColor: '#0f172a',
    title: 'DocFlow Studio',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'src', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Links (e.g. to the help page) open in the browser, never inside the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  // Unsaved strokes are written before the window goes away
  mainWindow.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    mainWindow.webContents.send('app:close-requested');
    setTimeout(() => { allowClose = true; mainWindow?.close(); }, 15000);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const file = argv.find((a) => a.toLowerCase().endsWith(BUNDLE_EXT));
    if (file) mainWindow?.webContents.send('app:open-file', file);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    startWatching();
  });
  app.on('window-all-closed', () => app.quit());
}
