// Copies the browser builds of the runtime libraries next to the renderer code so the app
// loads them via relative ES-module imports (works unpacked and inside the packaged app).
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'src', 'vendor');
mkdirSync(vendor, { recursive: true });
writeFileSync(join(vendor, 'package.json'), '{\n  "type": "module"\n}\n');

const files = [
  ['node_modules/pdfjs-dist/build/pdf.min.mjs', 'pdf.min.mjs'],
  ['node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  ['node_modules/pdf-lib/dist/pdf-lib.esm.min.js', 'pdf-lib.esm.min.js'],
  ['node_modules/fflate/esm/browser.js', 'fflate.js'],
];
for (const [from, to] of files) {
  cpSync(join(root, from), join(vendor, to));
}
// Fonts, character maps, colour profiles and image decoders pdf.js loads on demand
for (const dir of ['cmaps', 'standard_fonts', 'iccs', 'wasm']) {
  cpSync(join(root, 'node_modules/pdfjs-dist', dir), join(vendor, 'pdfjs', dir), { recursive: true });
}
console.log(`vendored ${files.length} files and the pdf.js assets into src/vendor`);
