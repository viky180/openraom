const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const storage = require('./storage');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3100);
const ROOT = __dirname;
const MAX_BODY_BYTES = 25 * 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function sendMethodNotAllowed(res) {
  sendJson(res, 405, { ok: false, error: 'Method not allowed' });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let body = '';

    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : null);
      } catch {
        reject(new Error('Invalid JSON request body'));
      }
    });

    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(ROOT, normalized);
  const relative = path.relative(ROOT, filePath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const cacheControl = ext === '.html' ? 'no-store' : 'no-cache';
    const contents = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': cacheControl
    });
    res.end(contents);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/storage/load') {
    if (req.method !== 'GET') return sendMethodNotAllowed(res);
    return sendJson(res, 200, await storage.loadData());
  }

  if (pathname === '/api/storage/save') {
    if (req.method !== 'POST') return sendMethodNotAllowed(res);
    try {
      const body = await readJsonBody(req);
      const hasWrappedPayload = body
        && typeof body === 'object'
        && Object.prototype.hasOwnProperty.call(body, 'data');
      const data = hasWrappedPayload ? body.data : body;
      const options = hasWrappedPayload ? (body.options || {}) : {};
      return sendJson(res, 200, await storage.saveData(data, options));
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/storage/backup') {
    if (req.method !== 'POST') return sendMethodNotAllowed(res);
    try {
      const body = await readJsonBody(req);
      const hasWrappedPayload = body
        && typeof body === 'object'
        && Object.prototype.hasOwnProperty.call(body, 'data');
      const data = hasWrappedPayload ? body.data : body;
      const options = hasWrappedPayload ? (body.options || {}) : {};
      return sendJson(res, 200, await storage.createUserBackup(data, options));
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/storage/path') {
    if (req.method !== 'GET') return sendMethodNotAllowed(res);
    return sendJson(res, 200, { ok: true, path: storage.getDataFilePath() });
  }

  return sendJson(res, 404, { ok: false, error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url.pathname);
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

storage.ensureDataFile()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`Local Roam web app running at http://${HOST}:${PORT}`);
      console.log(`Using notes file: ${storage.getDataFilePath()}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start local server:', err);
    process.exit(1);
  });
