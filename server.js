import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
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

function loadScores() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveScores(scores) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(scores, null, 2));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  // ---- API: leaderboard ----
  if (pathname === '/api/scores' && req.method === 'GET') {
    const scores = loadScores()
      .sort((a, b) => b.score - a.score)
      .slice(0, 100);
    res.writeHead(200, {
      'Content-Type': MIME['.json'],
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ scores }));
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

        const scores = loadScores();
        scores.push({ name, score, song, accuracy, combo, difficulty, ts: Date.now() });
        saveScores(scores);

        const top = scores
          .sort((a, b) => b.score - a.score)
          .slice(0, 100);
        const rank = top.findIndex((s) => s.name === name && s.score === score && s.ts >= (Date.now() - 10000));

        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ rank: rank === -1 ? top.length + 1 : rank + 1, count: top.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ error: 'bad request' }));
      }
    });
    return;
  }

  // ---- static files ----
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? '/index.html' : pathname);
  const ext = path.extname(filePath).toLowerCase();

  if (!MIME[ext]) {
    res.writeHead(404, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({ error: 'not found' }));
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
  console.log(`Rhythm game running at http://localhost:${PORT}`);
});
