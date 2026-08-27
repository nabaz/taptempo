import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'leaderboard.json');
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

// ---- persistence: Turso (serverless) with a local JSON fallback ----
// On Vercel the filesystem is read-only/ephemeral, so we persist the shared
// leaderboard to a Turso database. Locally (node server.js) you can still run
// with no env vars, and it falls back to leaderboard.json.
const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const usingTurso = !!(TURSO_URL && TURSO_TOKEN);

const db = usingTurso
  ? createClient({ url: TURSO_URL, authToken: TURSO_TOKEN })
  : null;

async function ensureTable() {
  if (!db) return;
  await db.execute(`
    CREATE TABLE IF NOT EXISTS scores (
      name TEXT NOT NULL,
      score INTEGER NOT NULL,
      song TEXT NOT NULL,
      accuracy REAL NOT NULL DEFAULT 0,
      combo INTEGER NOT NULL DEFAULT 0,
      difficulty TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL
    )
  `);
}

// ---- local file fallback ----
function loadFileScores() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
function saveFileScores(scores) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(scores, null, 2));
}

async function loadScores() {
  if (usingTurso) {
    const res = await db.execute('SELECT * FROM scores ORDER BY score DESC LIMIT 100');
    return res.rows.map((r) => ({
      name: r.name, score: Number(r.score), song: r.song,
      accuracy: Number(r.accuracy), combo: Number(r.combo),
      difficulty: r.difficulty, ts: Number(r.ts),
    }));
  }
  return loadFileScores();
}

async function saveScore(entry) {
  if (usingTurso) {
    await db.execute({
      sql: 'INSERT INTO scores (name, score, song, accuracy, combo, difficulty, ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [entry.name, entry.score, entry.song, entry.accuracy, entry.combo, entry.difficulty, entry.ts],
    });
    return;
  }
  const scores = loadFileScores();
  scores.push(entry);
  saveFileScores(scores);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  const sendJson = (code, obj) => {
    res.writeHead(code, { 'Content-Type': MIME['.json'], 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
  };

  // ---- API: leaderboard ----
  if (pathname === '/api/scores' && req.method === 'GET') {
    loadScores().then((scores) => sendJson(200, { scores }))
      .catch((e) => { console.error('load failed', e); sendJson(500, { error: 'load failed' }); });
    return;
  }

  if (pathname === '/api/scores' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const entry = JSON.parse(body);
        const name = String(entry.name || 'Anonymous').slice(0, 20);
        const score = Math.max(0, Math.min(999999999, Number(entry.score) || 0));
        const song = String(entry.song || '').slice(0, 40);
        const accuracy = Math.max(0, Math.min(100, Number(entry.accuracy) || 0));
        const combo = Math.max(0, Math.floor(Number(entry.combo) || 0));
        const difficulty = String(entry.difficulty || '').slice(0, 12);
        const row = { name, score, song, accuracy, combo, difficulty, ts: Date.now() };

        saveScore(row)
          .then(() => loadScores())
          .then((scores) => {
            const top = scores.sort((a, b) => b.score - a.score).slice(0, 100);
            const rank = top.findIndex((s) => s.name === name && s.score === score && s.ts >= (Date.now() - 10000));
            sendJson(200, { rank: rank === -1 ? top.length + 1 : rank + 1, count: top.length });
          })
          .catch((e) => { console.error('save failed', e); sendJson(500, { error: 'save failed' }); });
      } catch (e) {
        sendJson(400, { error: 'bad request' });
      }
    });
    return;
  }

  // ---- static files ----
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? '/index.html' : pathname);
  const ext = path.extname(filePath).toLowerCase();

  if (!MIME[ext]) {
    sendJson(404, { error: 'not found' });
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] });
    res.end(content);
  });
});

server.listen(PORT, () => {
  ensureTable().then(() => {
    console.log(`Rhythm game running at http://localhost:${PORT} (${usingTurso ? 'Turso' : 'local JSON'})`);
  }).catch((e) => console.error('ensureTable failed', e));
});
