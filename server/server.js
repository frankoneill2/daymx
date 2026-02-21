// Lightweight static server + JSON file persistence API
// No dependencies. Run: node server/server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 5173;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.resolve(__dirname, 'db.json');
const MAX_JSON_BYTES = 1024 * 1024; // 1MB

// Ensure DB file exists
function ensureDb() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      fs.writeFileSync(DB_PATH, JSON.stringify({ threads: [] }, null, 2));
    }
  } catch (e) {
    console.error('Failed to init DB', e);
  }
}

function readDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    return { threads: [] };
  }
}

function writeDb(data) {
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function safeRequestPath(reqPath) {
  try {
    const decoded = decodeURIComponent(reqPath || '');
    if (decoded.includes('\0')) return null;
    const resolved = path.resolve(ROOT, '.' + decoded);
    const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : `${ROOT}${path.sep}`;
    if (!resolved.startsWith(rootPrefix)) return null;
    return resolved;
  } catch {
    return null;
  }
}

function parseJsonPayload(req, res, cb) {
  let body = '';
  let size = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      aborted = true;
      send(res, 413, JSON.stringify({ ok: false, error: 'Payload too large' }), { 'Content-Type': 'application/json' });
      req.destroy();
      return;
    }
    body += chunk;
  });
  req.on('error', () => {
    if (!aborted) {
      aborted = true;
      send(res, 400, JSON.stringify({ ok: false, error: 'Invalid request body' }), { 'Content-Type': 'application/json' });
    }
  });
  req.on('end', () => {
    if (aborted) return;
    cb(body);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function serveStatic(req, res, reqPath) {
  const normalized = safeRequestPath(reqPath);
  if (!normalized) return send(res, 403, 'Forbidden');
  const filePath = reqPath === '/' || reqPath === '' ? path.join(ROOT, 'index.html') : normalized;
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return send(res, 404, 'Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-store',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function handleApi(req, res) {
  // Simple single-user data blob stored as JSON
  if (req.method === 'GET' && req.url.startsWith('/api/data')) {
    const data = readDb();
    return send(res, 200, JSON.stringify(data), { 'Content-Type': 'application/json' });
  }
  if ((req.method === 'POST' || req.method === 'PUT') && req.url.startsWith('/api/data')) {
    parseJsonPayload(req, res, (body) => {
      try {
        const json = body ? JSON.parse(body) : {};
        if (!json || typeof json !== 'object') throw new Error('Invalid payload');
        writeDb(json);
        return send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json' });
      } catch (e) {
        return send(res, 400, JSON.stringify({ ok: false, error: 'Invalid JSON' }), { 'Content-Type': 'application/json' });
      }
    });
    return;
  }
  return send(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  const { pathname } = url.parse(req.url);
  // CORS for API if accessed cross-origin during dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return send(res, 200, 'ok');

  if (pathname.startsWith('/api/')) {
    return handleApi(req, res);
  }
  return serveStatic(req, res, pathname);
});

ensureDb();
server.listen(PORT, HOST, () => {
  console.log(`FrankApp server running at http://${HOST}:${PORT}`);
});
