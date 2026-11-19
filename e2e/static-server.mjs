import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_ROOT = path.resolve(__dirname, '..', 'src');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.bcmap': 'application/octet-stream',
  '.icc': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.pdf': 'application/pdf',
  '.webm': 'video/webm',
  '.docflownote': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext && Object.hasOwn(MIME_TYPES, ext)) {
    return MIME_TYPES[ext];
  }
  const base = path.basename(filePath);
  if (base.startsWith('LICENSE') || base.startsWith('README')) {
    return 'text/plain; charset=utf-8';
  }
  return 'application/octet-stream';
}

function hasUnsafeRawTraversal(rawUrl) {
  const rawPath = String(rawUrl || '/').split('?')[0].split('#')[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return true;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    return true;
  }
  const rawSegments = rawPath.split('/');
  const decodedSegments = decoded.split('/');
  return (
    rawSegments.some((seg) => seg === '..' || seg.toLowerCase() === '%2e%2e') ||
    decodedSegments.some((seg) => seg === '..')
  );
}

function resolveSafePath(rawUrl) {
  if (hasUnsafeRawTraversal(rawUrl)) {
    return { status: 403, filePath: null };
  }
  const strUrl = String(rawUrl || '/');
  if (strUrl.startsWith('//') || !strUrl.startsWith('/')) {
    return { status: 400, filePath: null };
  }
  let parsed;
  let pathname;
  try {
    parsed = new URL(strUrl, 'http://127.0.0.1');
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return { status: 400, filePath: null };
  }
  if (pathname === '/') {
    pathname = '/index.html';
  }
  const relativePath = pathname.replace(/^\/+/, '');
  const resolved = path.resolve(SRC_ROOT, relativePath);
  const relFromRoot = path.relative(SRC_ROOT, resolved);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    return { status: 403, filePath: null };
  }
  return { status: 200, filePath: resolved };
}

export function createStaticServer() {
  return http.createServer(async (req, res) => {
    try {
      const method = (req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          Allow: 'GET, HEAD',
        });
        res.end('Method Not Allowed');
        return;
      }

      const { status, filePath } = resolveSafePath(req.url);
      if (status === 400) {
        res.writeHead(400, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end('Bad Request');
        return;
      }
      if (status === 403 || !filePath) {
        res.writeHead(403, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end('Forbidden');
        return;
      }

      let targetPath = filePath;
      let stat;
      try {
        stat = await fs.stat(targetPath);
      } catch {
        res.writeHead(404, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end('Not Found');
        return;
      }

      if (stat.isDirectory()) {
        targetPath = path.join(targetPath, 'index.html');
        try {
          stat = await fs.stat(targetPath);
        } catch {
          res.writeHead(404, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end('Not Found');
          return;
        }
      }

      const contentType = getMimeType(targetPath);
      const headers = {
        'Content-Type': contentType,
        'Content-Length': String(stat.size),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      };

      if (method === 'HEAD') {
        res.writeHead(200, headers);
        res.end();
        return;
      }

      const body = await fs.readFile(targetPath);
      res.writeHead(200, headers);
      res.end(body);
    } catch (err) {
      res.writeHead(500, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(`Internal Server Error: ${err?.message || 'unknown'}`);
    }
  });
}

export async function startStaticServer({ host = '127.0.0.1', port = Number(process.env.PORT || 4173) } = {}) {
  const server = createStaticServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return { server, host, port: actualPort, url: `http://${host}:${actualPort}` };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  const { server, url } = await startStaticServer();
  console.log(`DocFlow E2E static server listening on ${url}`);
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
