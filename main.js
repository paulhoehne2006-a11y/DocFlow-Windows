// Electron main process: frameless window, settings, cloud folder sync, atomic workspace metadata,
// 30-day trash, rolling backups + in-place writes, native offline WinRT OCR, and update checks.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const https = require('node:https');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const electron = (() => {
  try {
    const mod = require('electron');
    return mod && typeof mod === 'object' ? mod : null;
  } catch {
    return null;
  }
})();
const isElectron = Boolean(process.versions?.electron && electron?.app);
const { app, BrowserWindow, ipcMain, dialog, shell, session, screen } = electron || {};

const BUNDLE_EXT = '.docflownote';
const DEFAULT_FOLDER_NAME = 'DocFlow Studio';
const WORKSPACE_FILE = '.docflow-workspace.json';
const TRASH_DIR = '.docflow-trash';
const TRASH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BACKUPS_PER_NOTEBOOK = 5;
const MAX_OCR_BYTES = 32 * 1024 * 1024;
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/paulhoehne2006-a11y/DocFlow-Windows/releases/latest';
const TRASH_ID_RE = /^[a-zA-Z0-9_-]{4,100}$/;

let mainWindow = null;
let watcher = null;
let allowClose = false;
let closeForceTimer = null;
let pendingOpenFile = process.argv.find((a) => a.toLowerCase().endsWith(BUNDLE_EXT)) ?? null;

// ---- Path & Settings Helpers ----

function getUserDataDir() {
  return app ? app.getPath('userData') : path.join(os.tmpdir(), 'docflow-studio-node');
}

function getHomeDir() {
  return app ? app.getPath('home') : os.homedir();
}

function getDocumentsDir() {
  return app ? app.getPath('documents') : path.join(getHomeDir(), 'Documents');
}

function getAppVersion() {
  if (app) return app.getVersion();
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

const configPath = () => path.join(getUserDataDir(), 'config.json');
const backupsDir = () => path.join(getUserDataDir(), 'backups');

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

// ---- Security & Semver Helpers ----

function isAllowedExternalUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl ?? '').trim());
    return parsed.protocol === 'https:' && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function parseSemver(raw) {
  const clean = String(raw ?? '').trim().replace(/^[vV]/, '');
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
  };
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return String(a ?? '').localeCompare(String(b ?? ''));
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1; // release > prerelease
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const dx = Number(x);
      const dy = Number(y);
      if (dx !== dy) return dx > dy ? 1 : -1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

// ---- Cloud Folder Detection ----

function parseNextcloudCfg(cfgText) {
  const paths = [];
  for (const line of String(cfgText || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:\d+\\)?localPath\s*=\s*(.+?)\s*$/i);
    if (m && m[1]) {
      const cleaned = m[1].replace(/^["']|["']$/g, '').replace(/\\\\/g, '\\');
      if (cleaned) paths.push(path.normalize(cleaned));
    }
  }
  return paths;
}

function parseDropboxInfo(jsonText) {
  try {
    const parsed = JSON.parse(String(jsonText || '{}'));
    const out = [];
    if (parsed?.personal?.path) out.push(path.normalize(parsed.personal.path));
    if (parsed?.business?.path) out.push(path.normalize(parsed.business.path));
    return out;
  } catch {
    return [];
  }
}

/** Folders where OneDrive / Google Drive / Nextcloud / Dropbox / iCloud keep synced files. */
function cloudRoots(home = getHomeDir()) {
  const roots = [];

  // OneDrive
  for (const key of ['OneDriveConsumer', 'OneDrive', 'OneDriveCommercial']) {
    const p = process.env[key];
    if (p) roots.push({ provider: 'OneDrive', path: p });
  }
  roots.push({ provider: 'OneDrive', path: path.join(home, 'OneDrive') });

  // Google Drive for desktop
  if (process.platform === 'win32') {
    for (let c = 67; c <= 90; c++) { // C: … Z:
      const drive = `${String.fromCharCode(c)}:\\`;
      for (const name of ['Meine Ablage', 'My Drive']) {
        roots.push({ provider: 'Google Drive', path: path.join(drive, name) });
      }
    }
  }
  roots.push({ provider: 'Google Drive', path: path.join(home, 'Google Drive', 'Meine Ablage') });
  roots.push({ provider: 'Google Drive', path: path.join(home, 'Google Drive', 'My Drive') });
  roots.push({ provider: 'Google Drive', path: path.join(home, 'Google Drive') });

  // Nextcloud
  roots.push({ provider: 'Nextcloud', path: path.join(home, 'Nextcloud') });
  roots.push({ provider: 'Nextcloud', path: path.join(home, 'Nextcloud2') });
  const appData = process.env.APPDATA || '';
  if (appData) {
    try {
      const cfg = fs.readFileSync(path.join(appData, 'Nextcloud', 'nextcloud.cfg'), 'utf8');
      for (const p of parseNextcloudCfg(cfg)) {
        roots.push({ provider: 'Nextcloud', path: p });
      }
    } catch { /* Nextcloud not installed or cfg missing */ }
  }

  // Dropbox
  roots.push({ provider: 'Dropbox', path: path.join(home, 'Dropbox') });
  const localAppData = process.env.LOCALAPPDATA || '';
  for (const baseDir of [localAppData, appData].filter(Boolean)) {
    try {
      const infoRaw = fs.readFileSync(path.join(baseDir, 'Dropbox', 'info.json'), 'utf8');
      for (const p of parseDropboxInfo(infoRaw)) {
        roots.push({ provider: 'Dropbox', path: p });
      }
    } catch { /* Dropbox info.json missing */ }
  }

  // iCloud Drive
  roots.push({ provider: 'iCloud Drive', path: path.join(home, 'iCloudDrive') });
  roots.push({ provider: 'iCloud Drive', path: path.join(home, 'iCloud Drive') });
  roots.push({ provider: 'iCloud Drive', path: path.join(home, 'Apple', 'iCloudDrive') });

  const seen = new Set();
  return roots.filter((r) => {
    if (!r.path) return false;
    const key = path.normalize(r.path).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    try {
      return fs.statSync(r.path).isDirectory();
    } catch {
      return false;
    }
  });
}

function detectFolders(home = getHomeDir()) {
  const candidates = cloudRoots(home).map((root) => {
    const folder = path.join(root.path, DEFAULT_FOLDER_NAME);
    let exists = false;
    let notebooks = 0;
    try {
      exists = fs.statSync(folder).isDirectory();
      if (exists) {
        notebooks = fs.readdirSync(folder).filter((f) => f.toLowerCase().endsWith(BUNDLE_EXT) && !f.startsWith('.')).length;
      }
    } catch { /* not created yet */ }
    return {
      provider: root.provider,
      label: `${root.provider} (${DEFAULT_FOLDER_NAME})`,
      path: folder,
      root: root.path,
      folder,
      exists,
      notebooks,
    };
  });

  const preferred = candidates.find((c) => c.exists) || candidates[0];
  const defaultSuggestion = preferred?.path ?? path.join(getDocumentsDir(), DEFAULT_FOLDER_NAME);
  return { candidates, defaultSuggestion };
}

/** Folders mirrored by Google Drive for desktop ("Meine Ablage" / "My Drive"). */
function isGoogleDriveFolder(folder) {
  if (!folder) return false;
  const lower = String(folder).toLowerCase();
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

// ---- Path Safety & Workspace / Trash / Backup Helpers ----

function assertValidFileName(name) {
  const raw = String(name ?? '');
  if (!raw || raw === '.' || raw === '..' || raw.includes('..')) {
    throw new Error(`Ungültiger Dateiname: ${name}`);
  }
  if (raw.includes('/') || raw.includes('\\') || raw.includes(':') || raw.includes('\0')) {
    throw new Error(`Ungültiger Dateiname: ${name}`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\u0000-\u001F]/.test(raw) || raw.startsWith('.')) {
    throw new Error(`Ungültiger Dateiname: ${name}`);
  }
  const base = path.basename(raw);
  if (!base || base !== raw || base.startsWith('.')) {
    throw new Error(`Ungültiger Dateiname: ${name}`);
  }
  return base;
}

/** Only plain file names inside the chosen folder – never paths or dotfiles from the renderer. */
function resolveInFolder(name, folder = currentFolder()) {
  if (!folder) throw new Error('Kein Ordner gewählt');
  const base = assertValidFileName(name);
  return path.join(folder, base);
}

function workspaceFilePath(folder = currentFolder()) {
  if (!folder) throw new Error('Kein Ordner gewählt');
  return path.join(folder, WORKSPACE_FILE);
}

function trashDirPath(folder = currentFolder()) {
  if (!folder) throw new Error('Kein Ordner gewählt');
  return path.join(folder, TRASH_DIR);
}

function assertSafeTrashId(trashId) {
  if (typeof trashId !== 'string' || !TRASH_ID_RE.test(trashId)) {
    throw new Error(`Ungültige trashId: ${trashId}`);
  }
  return trashId;
}

async function readWorkspaceFromFolder(folder = currentFolder()) {
  if (!folder) return null;
  const target = workspaceFilePath(folder);
  try {
    const raw = await fsp.readFile(target, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    console.warn('workspace:read failed', err);
    return null;
  }
}

async function writeWorkspaceToFolder(data, folder = currentFolder()) {
  if (!folder) throw new Error('Kein Ordner gewählt');
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Ungültige Workspace-Daten');
  }
  const target = workspaceFilePath(folder);
  const payload = JSON.stringify(data, null, 2);
  const tmp = path.join(folder, `${WORKSPACE_FILE}.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tmp, payload, 'utf8');
  try {
    await fsp.rename(tmp, target);
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EBUSY')) {
      await fsp.writeFile(target, payload, 'utf8');
      await fsp.unlink(tmp).catch(() => {});
    } else {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    }
  }
  return { ok: true };
}

async function backupBeforeOverwrite(file, name, backupsRoot = backupsDir()) {
  if (!fs.existsSync(file)) return null;
  if (!String(name).toLowerCase().endsWith(BUNDLE_EXT)) return null;

  const rawStem = path.basename(name, path.extname(name));
  const cleanStem = rawStem.replace(/[^a-zA-Z0-9._-]/g, '_') || 'notebook';
  const shortHash = crypto.createHash('sha1').update(rawStem).digest('hex').slice(0, 6);
  const stemDirName = cleanStem === rawStem ? cleanStem : `${cleanStem}_${shortHash}`;
  const dir = path.join(backupsRoot, stemDirName);
  await fsp.mkdir(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const uniq = process.hrtime.bigint().toString().slice(-6);
  const dest = path.join(dir, `${stamp}-${uniq}${BUNDLE_EXT}`);
  await fsp.copyFile(file, dest);

  const entries = (await fsp.readdir(dir))
    .filter((f) => f.toLowerCase().endsWith(BUNDLE_EXT))
    .sort()
    .reverse();

  for (const oldFile of entries.slice(MAX_BACKUPS_PER_NOTEBOOK)) {
    await fsp.unlink(path.join(dir, oldFile)).catch(() => {});
  }
  return dest;
}

async function writeInPlace(file, data) {
  const fh = await fsp.open(file, 'r+');
  try {
    let written = 0;
    while (written < data.length) {
      const { bytesWritten } = await fh.write(data, written, data.length - written, written);
      if (bytesWritten <= 0) break;
      written += bytesWritten;
    }
    await fh.truncate(data.length);
    await fh.sync().catch(() => {});
  } finally {
    await fh.close();
  }
}

async function writeNotebookFile(name, bytes, { folder = currentFolder(), backupsRoot = backupsDir() } = {}) {
  const file = resolveInFolder(name, folder);
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const isBundle = String(name).toLowerCase().endsWith(BUNDLE_EXT);
  if (isBundle && data.length === 0) {
    throw new Error('Leere .docflownote-Datei wird nicht geschrieben');
  }

  if (fs.existsSync(file)) {
    if (isBundle) {
      await backupBeforeOverwrite(file, name, backupsRoot);
    }
    await writeInPlace(file, data);
  } else {
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    await fsp.writeFile(tmp, data);
    try {
      await fsp.rename(tmp, file);
    } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'EBUSY')) {
        await fsp.writeFile(file, data);
        await fsp.unlink(tmp).catch(() => {});
      } else {
        await fsp.unlink(tmp).catch(() => {});
        throw err;
      }
    }
  }
  const st = await fsp.stat(file);
  return { ok: true, mtimeMs: st.mtimeMs, size: st.size };
}

// ---- 30-Day Trash (.docflow-trash/) ----

function trashExtFor(fileName) {
  const ext = path.extname(String(fileName)).toLowerCase();
  return ext === BUNDLE_EXT ? BUNDLE_EXT : (ext || BUNDLE_EXT);
}

async function purgeExpiredTrash(folder = currentFolder(), now = Date.now()) {
  if (!folder) return 0;
  const dir = trashDirPath(folder);
  if (!fs.existsSync(dir)) return 0;

  let removed = 0;
  const entries = await fsp.readdir(dir);
  const metaFiles = entries.filter((f) => f.endsWith('.meta.json'));
  const activeIds = new Set();

  for (const metaName of metaFiles) {
    const trashId = metaName.slice(0, -'.meta.json'.length);
    const metaPath = path.join(dir, metaName);
    let expired = false;
    let ext = BUNDLE_EXT;
    try {
      const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
      ext = meta.trashedExt || trashExtFor(meta.originalName || BUNDLE_EXT);
      const expiresAt = Number(meta.expiresAt);
      const deletedAt = Number(meta.deletedAt);
      if (Number.isFinite(expiresAt) && now >= expiresAt) expired = true;
      else if (Number.isFinite(deletedAt) && now - deletedAt >= TRASH_MAX_AGE_MS) expired = true;
    } catch {
      try {
        const st = await fsp.stat(metaPath);
        if (now - st.mtimeMs >= TRASH_MAX_AGE_MS) expired = true;
      } catch { expired = true; }
    }

    const dataPath = path.join(dir, `${trashId}${ext}`);
    if (expired) {
      await fsp.unlink(metaPath).catch(() => {});
      await fsp.unlink(dataPath).catch(() => {});
      await fsp.unlink(path.join(dir, `${trashId}${BUNDLE_EXT}`)).catch(() => {});
      removed++;
    } else {
      activeIds.add(trashId);
    }
  }

  // Clean orphaned files without metadata that are older than 30 days
  for (const entry of entries) {
    if (entry.endsWith('.meta.json')) continue;
    const stem = entry.replace(/\.[^.]+$/, '');
    if (activeIds.has(stem)) continue;
    const full = path.join(dir, entry);
    try {
      const st = await fsp.stat(full);
      if (now - st.mtimeMs >= TRASH_MAX_AGE_MS) {
        await fsp.unlink(full).catch(() => {});
        removed++;
      }
    } catch { /* ignore */ }
  }
  return removed;
}

async function moveToTrash(name, folder = currentFolder(), now = Date.now()) {
  const src = resolveInFolder(name, folder);
  let st;
  try {
    st = await fsp.stat(src);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false };
    throw err;
  }

  const dir = trashDirPath(folder);
  await fsp.mkdir(dir, { recursive: true });
  const trashId = `${now}-${crypto.randomUUID().slice(0, 8)}`;
  const ext = trashExtFor(name);
  const dest = path.join(dir, `${trashId}${ext}`);
  const metaPath = path.join(dir, `${trashId}.meta.json`);

  const meta = {
    trashId,
    originalName: path.basename(src),
    trashedExt: ext,
    deletedAt: now,
    expiresAt: now + TRASH_MAX_AGE_MS,
    size: st.size,
  };

  await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      await fsp.copyFile(src, dest);
      await fsp.unlink(src);
    } else {
      await fsp.unlink(metaPath).catch(() => {});
      throw err;
    }
  }

  await purgeExpiredTrash(folder, now).catch(() => {});
  return { ok: true, trashedName: trashId };
}

async function listTrashInFolder(folder = currentFolder(), now = Date.now()) {
  if (!folder) return [];
  const dir = trashDirPath(folder);
  if (!fs.existsSync(dir)) return [];

  await purgeExpiredTrash(folder, now).catch(() => {});
  const entries = await fsp.readdir(dir);
  const items = [];
  for (const metaName of entries) {
    if (!metaName.endsWith('.meta.json')) continue;
    const trashId = metaName.slice(0, -'.meta.json'.length);
    if (!TRASH_ID_RE.test(trashId)) continue;
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(dir, metaName), 'utf8'));
      const ext = meta.trashedExt || trashExtFor(meta.originalName || BUNDLE_EXT);
      const dataPath = path.join(dir, `${trashId}${ext}`);
      if (!fs.existsSync(dataPath)) continue;
      const st = await fsp.stat(dataPath);
      items.push({
        trashId,
        originalName: String(meta.originalName || `${trashId}${ext}`),
        deletedAt: Number(meta.deletedAt) || st.mtimeMs,
        expiresAt: Number(meta.expiresAt) || (st.mtimeMs + TRASH_MAX_AGE_MS),
        size: Number(meta.size) || st.size,
      });
    } catch { /* skip corrupt entry */ }
  }
  return items.sort((a, b) => b.deletedAt - a.deletedAt);
}

async function restoreFromTrash(trashId, folder = currentFolder()) {
  if (!folder) throw new Error('Kein Ordner gewählt');
  assertSafeTrashId(trashId);
  const dir = trashDirPath(folder);
  const metaPath = path.join(dir, `${trashId}.meta.json`);
  const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
  const originalName = assertValidFileName(meta.originalName);
  const ext = meta.trashedExt || trashExtFor(originalName);
  const trashedPath = path.join(dir, `${trashId}${ext}`);
  if (!fs.existsSync(trashedPath)) throw new Error('Papierkorb-Eintrag nicht gefunden');

  const origExt = path.extname(originalName) || BUNDLE_EXT;
  const origStem = path.basename(originalName, origExt);
  let restoredName = originalName;
  let targetPath = path.join(folder, restoredName);
  if (fs.existsSync(targetPath)) {
    restoredName = `${origStem}_restored${origExt}`;
    targetPath = path.join(folder, restoredName);
    let idx = 2;
    while (fs.existsSync(targetPath)) {
      restoredName = `${origStem}_restored_${idx}${origExt}`;
      targetPath = path.join(folder, restoredName);
      idx++;
    }
  }

  await fsp.rename(trashedPath, targetPath);
  await fsp.unlink(metaPath).catch(() => {});
  return { ok: true, restoredName };
}

async function purgeFromTrash(trashId, folder = currentFolder()) {
  if (!folder) throw new Error('Kein Ordner gewählt');
  assertSafeTrashId(trashId);
  const dir = trashDirPath(folder);
  const metaPath = path.join(dir, `${trashId}.meta.json`);
  let ext = BUNDLE_EXT;
  try {
    const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    ext = meta.trashedExt || trashExtFor(meta.originalName || BUNDLE_EXT);
  } catch { /* ignore */ }
  await fsp.unlink(path.join(dir, `${trashId}${ext}`)).catch(() => {});
  await fsp.unlink(path.join(dir, `${trashId}${BUNDLE_EXT}`)).catch(() => {});
  await fsp.unlink(metaPath).catch(() => {});
  return { ok: true };
}

async function emptyTrashInFolder(folder = currentFolder()) {
  if (!folder) return { ok: true, removed: 0 };
  const dir = trashDirPath(folder);
  if (!fs.existsSync(dir)) return { ok: true, removed: 0 };
  const entries = await fsp.readdir(dir);
  const ids = new Set();
  for (const entry of entries) {
    if (entry.endsWith('.meta.json')) ids.add(entry.slice(0, -'.meta.json'.length));
    else ids.add(entry.replace(/\.[^.]+$/, ''));
  }
  for (const entry of entries) {
    await fsp.unlink(path.join(dir, entry)).catch(() => {});
  }
  return { ok: true, removed: ids.size };
}

// ---- Native Offline Windows OCR (Windows.Media.Ocr.OcrEngine) ----

const WINRT_OCR_PS_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
  })[0]

  function Await-WinRT($WinRtTask, $ResultType) {
    $netTask = $asTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
    $netTask.GetAwaiter().GetResult()
  }

  $available = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)
  if ($available.Count -eq 0) {
    [ordered]@{ ok = $false; text = ''; lines = @(); engine = 'winrt'; error = 'no-language-pack' } | ConvertTo-Json -Compress
    exit 0
  }

  $pref = [string]$env:DOCFLOW_OCR_LANG
  $engine = $null

  if (-not [string]::IsNullOrWhiteSpace($pref)) {
    try {
      $langObj = [Windows.Globalization.Language]::new($pref)
      if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($langObj)) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($langObj)
      }
    } catch {}
  }

  if ($null -eq $engine -and -not [string]::IsNullOrWhiteSpace($pref)) {
    $prefix = ($pref -split '[-_]')[0].ToLowerInvariant()
    $match = $available | Where-Object { $_.LanguageTag.ToLowerInvariant().StartsWith($prefix) } | Select-Object -First 1
    if ($null -ne $match) {
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($match)
    }
  }

  if ($null -eq $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  }

  if ($null -eq $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($available[0])
  }

  if ($null -eq $engine) {
    [ordered]@{ ok = $false; text = ''; lines = @(); engine = 'winrt'; error = 'no-language-pack' } | ConvertTo-Json -Compress
    exit 0
  }

  $pngPath = [string]$env:DOCFLOW_OCR_PNG
  $file = Await-WinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($pngPath)) ([Windows.Storage.StorageFile])
  $stream = $null
  $softBmp = $null
  $bgraBmp = $null
  try {
    $stream = Await-WinRT ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $softBmp = Await-WinRT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $targetBmp = $softBmp
    if ($softBmp.BitmapPixelFormat -ne [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8 -or $softBmp.BitmapAlphaMode -ne [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied) {
      $bgraBmp = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert(
        $softBmp,
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied
      )
      $targetBmp = $bgraBmp
    }
    $ocrResult = Await-WinRT ($engine.RecognizeAsync($targetBmp)) ([Windows.Media.Ocr.OcrResult])
    $lines = @($ocrResult.Lines | ForEach-Object { $_.Text })
    $text = ($lines -join "\`n")
    [ordered]@{
      ok = $true
      text = $text
      lines = @($lines)
      language = $engine.RecognizerLanguage.LanguageTag
      engine = 'winrt'
    } | ConvertTo-Json -Compress -Depth 4
  } finally {
    if ($null -ne $bgraBmp) { $bgraBmp.Dispose() }
    if ($null -ne $softBmp) { $softBmp.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
  }
} catch {
  [ordered]@{
    ok = $false
    text = ''
    lines = @()
    engine = 'winrt'
    error = $_.Exception.Message
  } | ConvertTo-Json -Compress
}
`;

const WINRT_OCR_ENCODED = Buffer.from(WINRT_OCR_PS_SCRIPT, 'utf16le').toString('base64');

async function recognizePngOcr(pngBytes, preferredLang = 'de-DE') {
  if (process.platform !== 'win32') {
    return { ok: false, text: '', lines: [], engine: 'unavailable', error: 'unsupported-platform' };
  }
  let buf;
  if (Buffer.isBuffer(pngBytes)) buf = pngBytes;
  else if (pngBytes instanceof Uint8Array || ArrayBuffer.isView(pngBytes)) {
    buf = Buffer.from(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
  } else {
    return { ok: false, text: '', lines: [], engine: 'winrt', error: 'invalid-input' };
  }

  if (buf.length === 0) return { ok: true, text: '', lines: [], engine: 'empty' };
  if (buf.length > MAX_OCR_BYTES) {
    return { ok: false, text: '', lines: [], engine: 'winrt', error: 'image-too-large' };
  }
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) {
    return { ok: false, text: '', lines: [], engine: 'winrt', error: 'invalid-png' };
  }

  const tmpPng = path.join(
    os.tmpdir(),
    `docflow-ocr-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`,
  );

  try {
    await fsp.writeFile(tmpPng, buf);
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', WINRT_OCR_ENCODED],
      {
        env: {
          ...process.env,
          DOCFLOW_OCR_PNG: tmpPng,
          DOCFLOW_OCR_LANG: String(preferredLang || 'de-DE'),
        },
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
    );
    const line = String(stdout || '').trim().split(/\r?\n/).pop() || '';
    if (!line) {
      return { ok: false, text: '', lines: [], engine: 'winrt', error: 'empty-ocr-output' };
    }
    const parsed = JSON.parse(line);
    const lines = Array.isArray(parsed.lines)
      ? parsed.lines.map((l) => String(l))
      : (parsed.lines ? [String(parsed.lines)] : []);
    return {
      ok: Boolean(parsed.ok),
      text: String(parsed.text || ''),
      lines,
      ...(parsed.language ? { language: String(parsed.language) } : {}),
      engine: String(parsed.engine || 'winrt'),
      ...(parsed.error ? { error: String(parsed.error) } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      text: '',
      lines: [],
      engine: 'winrt',
      error: err?.message || 'winrt-ocr-failed',
    };
  } finally {
    await fsp.unlink(tmpPng).catch(() => {});
  }
}

// ---- Update Check ----

function fetchJsonHttps(urlStr, currentVersion, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    if (!isAllowedExternalUrl(urlStr)) return reject(new Error('Invalid update URL'));
    const req = https.get(urlStr, {
      headers: {
        'User-Agent': `DocFlow-Studio-Windows/${currentVersion}`,
        Accept: 'application/vnd.github+json',
      },
      timeout: 8000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        return resolve(fetchJsonHttps(res.headers.location, currentVersion, redirectsLeft - 1));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (body.length < 1024 * 1024) body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Invalid JSON response'));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('Update check timeout'));
    });
    req.on('error', reject);
  });
}

async function checkUpdate(currentVersion = getAppVersion()) {
  try {
    const release = await fetchJsonHttps(GITHUB_RELEASES_URL, currentVersion);
    const rawTag = String(release.tag_name || release.name || '').trim();
    const latestVersion = rawTag.replace(/^[vV]/, '') || currentVersion;
    const hasUpdate = Boolean(rawTag) && compareSemver(latestVersion, currentVersion) > 0;
    const fallbackUrl = 'https://github.com/paulhoehne2006-a11y/DocFlow-Windows/releases';
    const url = isAllowedExternalUrl(release.html_url) ? release.html_url : fallbackUrl;
    return {
      ok: true,
      currentVersion,
      latestVersion,
      hasUpdate,
      url,
      notes: String(release.body || ''),
    };
  } catch (err) {
    return {
      ok: false,
      currentVersion,
      error: err?.message || 'update-check-failed',
    };
  }
}

// ---- Folder Watching ----

function startWatching() {
  watcher?.close();
  watcher = null;
  const folder = currentFolder();
  if (!folder) return;
  const pending = new Map();
  try {
    watcher = fs.watch(folder, (eventType, filename) => {
      if (!filename) return;
      const norm = String(filename).replace(/\\/g, '/');
      if (!norm || norm.startsWith('.') || norm.includes('/.')) return;
      const prev = pending.get(norm);
      if (prev) clearTimeout(prev.timer);
      // Sync clients write in several steps – report once the file has settled
      const timer = setTimeout(() => {
        pending.delete(norm);
        mainWindow?.webContents.send('folder:changed', {
          event: String(eventType || 'change'),
          filename: String(filename),
        });
      }, 800);
      pending.set(norm, { timer, event: eventType });
    });
  } catch (err) {
    console.warn('watch failed', err);
  }
}

// ---- Window Bounds Persistence ----

function clampWindowBounds(saved, displays = []) {
  const minW = 720;
  const minH = 500;
  const rawW = Number(saved?.width);
  const rawH = Number(saved?.height);
  let width = Number.isFinite(rawW) && rawW > 0 ? Math.max(minW, Math.round(rawW)) : 1400;
  let height = Number.isFinite(rawH) && rawH > 0 ? Math.max(minH, Math.round(rawH)) : 900;
  const isMaximized = Boolean(saved?.isMaximized);

  let x = Number.isFinite(Number(saved?.x)) ? Math.round(Number(saved.x)) : undefined;
  let y = Number.isFinite(Number(saved?.y)) ? Math.round(Number(saved.y)) : undefined;

  if (Array.isArray(displays) && displays.length > 0) {
    const primaryWork = displays[0].workArea || { x: 0, y: 0, width: 1920, height: 1080 };
    width = Math.min(width, Math.max(minW, primaryWork.width));
    height = Math.min(height, Math.max(minH, primaryWork.height));

    if (x !== undefined && y !== undefined) {
      const visibleOnAny = displays.some((d) => {
        const wa = d.workArea;
        if (!wa) return false;
        const overlapX = Math.min(x + width, wa.x + wa.width) - Math.max(x, wa.x);
        const overlapY = Math.min(y + height, wa.y + wa.height) - Math.max(y, wa.y);
        return overlapX >= 80 && overlapY >= 60;
      });
      if (!visibleOnAny) {
        x = undefined;
        y = undefined;
      }
    }
  }

  return {
    ...(x !== undefined && y !== undefined ? { x, y } : {}),
    width,
    height,
    isMaximized,
  };
}

// ---- IPC Registration ----

function registerIpc() {
  ipcMain.handle('app:info', () => {
    const folder = currentFolder();
    return {
      version: getAppVersion(),
      deviceId: deviceId(),
      platform: process.platform,
      syncFolder: folder,
      folder,
      backupsDir: backupsDir(),
      settings: readConfig().settings ?? {},
      isGoogleDrive: isGoogleDriveFolder(folder),
      openFile: pendingOpenFile,
    };
  });

  ipcMain.handle('settings:save', (_e, patch) => {
    const prev = readConfig().settings ?? {};
    const nextSettings = { ...prev, ...(patch && typeof patch === 'object' ? patch : {}) };
    writeConfig({ settings: nextSettings });
    return { ok: true, settings: nextSettings };
  });

  ipcMain.handle('folder:detect', () => detectFolders());

  ipcMain.handle('folder:set', async (_e, folderPath, create = true) => {
    const target = String(folderPath || '').trim();
    if (!target) throw new Error('Kein Ordner angegeben');
    const existed = fs.existsSync(target);
    if (create) await fsp.mkdir(target, { recursive: true });
    const stat = await fsp.stat(target);
    if (!stat.isDirectory()) throw new Error('Kein Ordner');
    writeConfig({ folder: target });
    startWatching();
    await purgeExpiredTrash(target).catch(() => {});
    return { ok: true, folder: target, created: !existed && Boolean(create) };
  });

  ipcMain.handle('folder:choose', async () => {
    const { candidates } = detectFolders();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Ordner mit DocFlow-Notizbüchern wählen',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: currentFolder() ?? candidates[0]?.root ?? getDocumentsDir(),
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const chosen = result.filePaths[0];
    writeConfig({ folder: chosen });
    startWatching();
    await purgeExpiredTrash(chosen).catch(() => {});
    return { canceled: false, path: chosen };
  });

  ipcMain.handle('folder:list', async () => {
    const folder = currentFolder();
    if (!folder) return [];
    const names = (await fsp.readdir(folder)).filter((f) => f.toLowerCase().endsWith(BUNDLE_EXT) && !f.startsWith('.'));
    const out = [];
    for (const name of names) {
      try {
        const st = await fsp.stat(path.join(folder, name));
        out.push({
          name,
          size: st.size,
          mtimeMs: st.mtimeMs,
          birthtimeMs: st.birthtimeMs,
        });
      } catch { /* deleted meanwhile */ }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  });

  ipcMain.handle('folder:reveal', async () => {
    const folder = currentFolder();
    if (!folder) return { ok: false };
    const err = await shell.openPath(folder);
    return { ok: !err };
  });

  ipcMain.handle('file:read', async (_e, name) => {
    const file = resolveInFolder(name);
    const bytes = await fsp.readFile(file);
    return new Uint8Array(bytes);
  });

  ipcMain.handle('file:stat', async (_e, name) => {
    try {
      const st = await fsp.stat(resolveInFolder(name));
      return { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  });

  ipcMain.handle('file:write', async (_e, name, bytes) => writeNotebookFile(name, bytes));

  ipcMain.handle('file:delete', async (_e, name) => moveToTrash(name));

  ipcMain.handle('file:read-external', async (_e, filePath) => {
    const cleanPath = String(filePath || '');
    if (!cleanPath.toLowerCase().endsWith(BUNDLE_EXT)) throw new Error('Keine DocFlow-Datei');
    pendingOpenFile = null;
    return {
      name: path.basename(cleanPath),
      dir: path.dirname(cleanPath),
      bytes: new Uint8Array(await fsp.readFile(cleanPath)),
    };
  });

  ipcMain.handle('pdf:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'PDF öffnen',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile'],
      defaultPath: currentFolder() ? path.dirname(currentFolder()) : undefined,
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const file = result.filePaths[0];
    return {
      canceled: false,
      name: path.basename(file, path.extname(file)),
      bytes: new Uint8Array(await fsp.readFile(file)),
    };
  });

  ipcMain.handle('pdf:pick-multi', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'PDF-Dateien anhängen',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile', 'multiSelections'],
      defaultPath: currentFolder() ? path.dirname(currentFolder()) : undefined,
    });
    if (result.canceled || !result.filePaths?.length) return { canceled: true };
    const files = [];
    for (const file of result.filePaths) {
      files.push({
        name: path.basename(file),
        bytes: new Uint8Array(await fsp.readFile(file)),
      });
    }
    return { canceled: false, files };
  });

  ipcMain.handle('image:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Bild einfügen',
      filters: [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile'],
      defaultPath: getDocumentsDir(),
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const file = result.filePaths[0];
    const ext = path.extname(file).toLowerCase();
    const mime = ext === '.png'
      ? 'image/png'
      : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
    return {
      canceled: false,
      name: path.basename(file),
      mime,
      bytes: new Uint8Array(await fsp.readFile(file)),
    };
  });

  ipcMain.handle('pdf:save-as', async (_e, suggestedName, bytes) => {
    const cleanName = path.basename(String(suggestedName || 'Export.pdf'));
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Als PDF speichern',
      defaultPath: path.join(getDocumentsDir(), cleanName),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fsp.writeFile(result.filePath, Buffer.from(bytes));
    shell.showItemInFolder(result.filePath);
    return { canceled: false, path: result.filePath };
  });

  ipcMain.handle('export:save-file', async (_e, opts) => {
    const extRaw = String(opts?.ext || 'pdf').toLowerCase().replace(/^\./, '');
    const ext = ['pdf', 'png', 'docflownote'].includes(extRaw) ? extRaw : 'pdf';
    const filterMap = {
      pdf: { name: 'PDF-Dokument', extensions: ['pdf'] },
      png: { name: 'PNG-Bild', extensions: ['png'] },
      docflownote: { name: 'DocFlow Notizbuch', extensions: ['docflownote'] },
    };
    const baseName = path.basename(String(opts?.suggestedName || `Export.${ext}`));
    const suggested = baseName.toLowerCase().endsWith(`.${ext}`) ? baseName : `${baseName}.${ext}`;
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export speichern',
      defaultPath: path.join(getDocumentsDir(), suggested),
      filters: [filterMap[ext]],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fsp.writeFile(result.filePath, Buffer.from(opts?.bytes || []));
    shell.showItemInFolder(result.filePath);
    return { canceled: false, path: result.filePath };
  });

  ipcMain.handle('workspace:read', async () => readWorkspaceFromFolder());

  ipcMain.handle('workspace:write', async (_e, data) => writeWorkspaceToFolder(data));

  ipcMain.handle('trash:list', async () => listTrashInFolder());

  ipcMain.handle('trash:restore', async (_e, trashId) => restoreFromTrash(trashId));

  ipcMain.handle('trash:purge', async (_e, trashId) => purgeFromTrash(trashId));

  ipcMain.handle('trash:empty', async () => emptyTrashInFolder());

  ipcMain.handle('backups:open-folder', async () => {
    const dir = backupsDir();
    await fsp.mkdir(dir, { recursive: true });
    const err = await shell.openPath(dir);
    return { ok: !err, path: dir };
  });

  ipcMain.handle('ocr:recognize-png', async (_e, pngBytes, preferredLang) => recognizePngOcr(pngBytes, preferredLang));

  ipcMain.handle('app:check-update', async () => checkUpdate(getAppVersion()));

  ipcMain.handle('shell:open-external', async (_e, url) => {
    if (!isAllowedExternalUrl(url)) return { ok: false };
    await shell.openExternal(new URL(String(url).trim()).toString());
    return { ok: true };
  });

  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return { maximized: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { maximized: mainWindow.isMaximized() };
  });

  ipcMain.handle('window:close', () => {
    mainWindow?.close();
  });

  ipcMain.handle('window:is-maximized', () => Boolean(mainWindow?.isMaximized()));

  ipcMain.handle('window:fullscreen', (_e, flag) => {
    if (!mainWindow) return { fullscreen: false };
    const next = typeof flag === 'boolean' ? flag : !mainWindow.isFullScreen();
    mainWindow.setFullScreen(next);
    return { fullscreen: mainWindow.isFullScreen() };
  });

  ipcMain.handle('app:close-now', () => {
    if (closeForceTimer) {
      clearTimeout(closeForceTimer);
      closeForceTimer = null;
    }
    allowClose = true;
    mainWindow?.close();
  });
}

// ---- Window Creation ----

function resolveWindowIcon() {
  const ico = path.join(__dirname, 'build', 'icon.ico');
  if (fs.existsSync(ico)) return ico;
  const buildPng = path.join(__dirname, 'build', 'icon.png');
  if (fs.existsSync(buildPng)) return buildPng;
  return path.join(__dirname, 'src', 'icon.png');
}

function createWindow() {
  const displays = screen ? screen.getAllDisplays() : [];
  const bounds = clampWindowBounds(readConfig().windowBounds, displays);

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 500,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0E1117',
    title: 'DocFlow Studio',
    autoHideMenuBar: true,
    icon: resolveWindowIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.removeMenu();
  if (bounds.isMaximized) mainWindow.maximize();
  mainWindow.show();
  mainWindow.focus();

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  let boundsTimer = null;
  const persistBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const isMaximized = mainWindow.isMaximized();
    const prev = readConfig().windowBounds || {};
    if (!isMaximized && !mainWindow.isMinimized() && !mainWindow.isFullScreen()) {
      const b = mainWindow.getBounds();
      writeConfig({ windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height, isMaximized: false } });
    } else {
      writeConfig({ windowBounds: { ...prev, isMaximized } });
    }
  };
  const schedulePersistBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(persistBounds, 250);
  };

  mainWindow.on('resize', schedulePersistBounds);
  mainWindow.on('move', schedulePersistBounds);
  mainWindow.on('maximize', () => {
    persistBounds();
    mainWindow?.webContents.send('window:maximized-changed', true);
  });
  mainWindow.on('unmaximize', () => {
    persistBounds();
    mainWindow?.webContents.send('window:maximized-changed', false);
  });

  // Links (e.g. to help or release page) open in the browser, never inside the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      shell.openExternal(new URL(url).toString());
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  // Unsaved strokes are written before the window goes away
  mainWindow.on('close', (e) => {
    clearTimeout(boundsTimer);
    persistBounds();
    if (allowClose) return;
    e.preventDefault();
    mainWindow.webContents.send('app:close-requested');
    if (closeForceTimer) clearTimeout(closeForceTimer);
    closeForceTimer = setTimeout(() => {
      allowClose = true;
      mainWindow?.close();
    }, 15000);
  });

  mainWindow.on('closed', () => {
    if (closeForceTimer) {
      clearTimeout(closeForceTimer);
      closeForceTimer = null;
    }
    mainWindow = null;
  });
}

function configureMediaPermissions() {
  if (!session?.defaultSession) return;
  const allowed = new Set(['media', 'microphone', 'audioCapture', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => allowed.has(permission));
}

if (isElectron) {
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
      configureMediaPermissions();
      purgeExpiredTrash().catch(() => {});
      registerIpc();
      createWindow();
      startWatching();
    });
    app.on('window-all-closed', () => app.quit());
  }
}

module.exports = {
  BUNDLE_EXT,
  DEFAULT_FOLDER_NAME,
  WORKSPACE_FILE,
  TRASH_DIR,
  TRASH_MAX_AGE_MS,
  MAX_BACKUPS_PER_NOTEBOOK,
  isAllowedExternalUrl,
  parseSemver,
  compareSemver,
  parseNextcloudCfg,
  parseDropboxInfo,
  cloudRoots,
  detectFolders,
  isGoogleDriveFolder,
  resolveInFolder,
  workspaceFilePath,
  readWorkspaceFromFolder,
  writeWorkspaceToFolder,
  backupBeforeOverwrite,
  writeInPlace,
  writeNotebookFile,
  purgeExpiredTrash,
  moveToTrash,
  listTrashInFolder,
  restoreFromTrash,
  purgeFromTrash,
  emptyTrashInFolder,
  recognizePngOcr,
  checkUpdate,
  clampWindowBounds,
};
