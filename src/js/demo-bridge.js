// In-memory stand-in for the Electron bridge, used when the page runs in a normal browser
// (development and automated UI tests). Files live only until the page is reloaded.

import { createNotebook, writeBundle } from './model.js';
import { PDFDocument, StandardFonts } from '../vendor/pdf-lib.esm.min.js';

export async function createDemoBridge() {
  const files = new Map(); // name → { bytes, modifiedAt }
  const listeners = { changed: [] };
  let folder = new URLSearchParams(location.search).has('setup') ? null : 'C:\\Users\\Demo\\OneDrive\\DocFlow Studio';
  let settings = {};

  const demo = createNotebook({ title: 'Mathe – Analysis', deviceId: 'phone-demo', template: 'GRID_5MM' });
  demo.addPage('LINED');
  files.set('Mathe_–_Analysis.docflownote', { bytes: writeBundle(demo, { deviceId: 'phone-demo' }), modifiedAt: Date.now() - 3600_000 });

  // A "scanned worksheet" as PDF, like the phone's scanner produces
  {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 2; i++) {
      const page = doc.addPage([595.28, 841.89]);
      page.drawText(`Arbeitsblatt ${i} – Lineare Funktionen`, { x: 50, y: 780, size: 20, font });
      for (let k = 0; k < 8; k++) page.drawText(`${k + 1}) Bestimme die Steigung von f(x) = ${k + 2}x - ${k}.`, { x: 50, y: 720 - k * 60, size: 12, font });
    }
    const bytes = await doc.save();
    const nb = createNotebook({ title: 'Arbeitsblatt Scan', deviceId: 'phone-demo', template: 'BLANK', pdfBytes: bytes, pdfPageSizes: [{ width: 595.28, height: 841.89 }, { width: 595.28, height: 841.89 }] });
    files.set('Arbeitsblatt_Scan.docflownote', { bytes: writeBundle(nb, { deviceId: 'phone-demo' }), modifiedAt: Date.now() - 60_000 });
  }

  const bridge = {
    async info() { return { version: 'demo', deviceId: 'windows-demo', folder, settings, openFile: null }; },
    async saveSettings(s) { settings = s; },
    async detectFolders() {
      return [
        { provider: 'OneDrive', root: 'C:\\Users\\Demo\\OneDrive', folder: 'C:\\Users\\Demo\\OneDrive\\DocFlow Studio', exists: true, notebooks: files.size },
        { provider: 'Google Drive', root: 'G:\\Meine Ablage', folder: 'G:\\Meine Ablage\\DocFlow Studio', exists: false, notebooks: 0 },
      ];
    },
    async setFolder(f) { folder = f; return f; },
    async chooseFolder() { return null; },
    async listNotebooks() {
      return [...files].filter(([n]) => n.endsWith('.docflownote')).map(([name, f]) => ({ name, size: f.bytes.length, modifiedAt: f.modifiedAt }))
        .sort((a, b) => b.modifiedAt - a.modifiedAt);
    },
    async revealFolder() {},
    async readFile(name) {
      const f = files.get(name);
      if (!f) throw new Error('not found');
      return { bytes: f.bytes, modifiedAt: f.modifiedAt };
    },
    async statFile(name) {
      const f = files.get(name);
      return f ? { exists: true, modifiedAt: f.modifiedAt } : { exists: false, modifiedAt: 0 };
    },
    async writeFile(name, bytes) {
      const modifiedAt = Date.now();
      files.set(name, { bytes: new Uint8Array(bytes), modifiedAt });
      return modifiedAt;
    },
    async deleteFile(name) { files.delete(name); },
    async readExternal() { throw new Error('not supported in demo'); },
    async pickPdf() { return null; },
    async savePdfAs() { return null; },
    async toggleFullscreen() { document.documentElement.requestFullscreen?.(); },
    async closeNow() {},
    onFolderChanged(cb) { listeners.changed.push(cb); },
    onCloseRequested() {},
    onOpenFile() {},
    /** Test hook: simulate the phone uploading a file. */
    _external(name, bytes) {
      files.set(name, { bytes, modifiedAt: Date.now() });
      listeners.changed.forEach((cb) => cb(name));
    },
    _files: files,
  };
  window.__demoBridge = bridge; // test hook
  return bridge;
}
