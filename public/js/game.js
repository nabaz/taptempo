import { AudioEngine, analyzeAudio, estimateBpm } from './audio.js';
import { SONGS, buildChart, LEVELS, starsFor } from './songs.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const COLS = 4;

// Note color themes (persisted so it survives reloads)
const THEMES = {
  midnight: {
    name: 'Midnight', colors: ['#f2a65a', '#e37b7b', '#5fbdb0', '#9d8cff'],
    page: {
      bg: '#090812', 'panel': 'rgba(20,17,32,0.82)', 'panel-2': 'rgba(27,22,43,0.9)',
      border: 'rgba(255,255,255,0.09)', text: '#f5f1ff', muted: '#918ba8',
      orange: '#ffad45', pink: '#ff5d7d', purple: '#9b72ff', cyan: '#57e1d0', green: '#6df0b1',
    },
  },
  cyber: {
    name: 'Cyber', colors: ['#35e0ff', '#ff4fd8', '#b6ff4d', '#9a6bff'],
    page: {
      bg: '#05060f', 'panel': 'rgba(14,20,46,0.82)', 'panel-2': 'rgba(21,27,58,0.9)',
      border: 'rgba(150,190,255,0.14)', text: '#eaf6ff', muted: '#7f92c0',
      orange: '#ffb25e', pink: '#ff4fd8', purple: '#9a6bff', cyan: '#35e0ff', green: '#b6ff4d',
    },
  },
  sunrise: {
    name: 'Sunrise', colors: ['#ffb066', '#ff6b6b', '#ffd77a', '#ff87ab'],
    page: {
      bg: '#150d10', 'panel': 'rgba(40,24,28,0.82)', 'panel-2': 'rgba(52,33,40,0.9)',
      border: 'rgba(255,214,190,0.13)', text: '#fff3e8', muted: '#b99c92',
      orange: '#ffb066', pink: '#ff87ab', purple: '#ffa94d', cyan: '#ffd77a', green: '#ffb066',
    },
  },
  forest: {
    name: 'Forest', colors: ['#4ade80', '#34d3b0', '#a3e635', '#6dd5ed'],
    page: {
      bg: '#08110c', 'panel': 'rgba(16,32,24,0.82)', 'panel-2': 'rgba(22,40,31,0.9)',
      border: 'rgba(150,255,200,0.12)', text: '#eafff3', muted: '#8fb0a0',
      orange: '#4ade80', pink: '#34d3b0', purple: '#a3e635', cyan: '#6dd5ed', green: '#4ade80',
    },
  },
};
let COLORS = THEMES.midnight.colors.slice();
function applyTheme(name) {
  const t = THEMES[name] || THEMES.midnight;
  COLORS = t.colors.slice();
  localStorage.setItem('mt-theme', name);
  document.body.setAttribute('data-theme', name);
  // re-apply lane key colors
  const keys = document.querySelectorAll('.lane-key');
  for (let c = 0; c < COLS; c++) keys[c] && keys[c].style.setProperty('--k', COLORS[c]);
  // full page palette via CSS custom properties
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.page || {})) root.style.setProperty('--' + k, v);
  document.querySelectorAll('.theme-btn').forEach((b) => b.classList.toggle('active', b.dataset.theme === name));
}

// Difficulty tuning: precision windows (PERFECT / GOOD / MISS, seconds) per level
const LEVEL_TUNE = [
  { perfect: 0.09, good: 0.15, miss: 0.28 },   // Easy
  { perfect: 0.06, good: 0.12, miss: 0.22 },   // Normal
  { perfect: 0.045, good: 0.09, miss: 0.19 },  // Hard
];

const audio = new AudioEngine();
window.audio = audio;

const el = (id) => document.getElementById(id);

// persisted settings
let speedMult = clamp(parseFloat(localStorage.getItem('mt-speed') || '1'), 1, 2);

// Base scroll speed ramps by difficulty so harder songs move notes noticeably
// faster (Easy .92 / Normal 1 / Hard 1.18) — a visual difficulty ramp tuned so
// taps still land on the beat regardless of speed.
function speed() { return (canvas.height / getDPR()) * 0.62 * speedMult * speedRamp(); }
function speedRamp() { return [0.92, 1, 1.18][clamp(state.level, 0, 2)]; }

const state = {
  mode: 'menu', // menu | playing | done
  paused: false,
  song: null,
  level: 1,
  notes: [],
  auto: false,
  totalNotes: 0,
  score: 0,
  combo: 0,
  maxCombo: 0,
  perfect: 0,
  good: 0,
  miss: 0,
  perfectChain: 0,
  maxPerfectChain: 0,
  accuracy: 100,
  precision: 100,
  timingErrSum: 0,
  timingErrN: 0,
  lastJudge: '', // 'PERFECT' | 'GOOD' | 'MISS'
  judge: null,
  judgeT: 0,
  hold: null,
  particles: [],
  popups: [], // floating +/- text: { x, y, vy, life, text, color }
  clockOffset: 0,
  pauseStart: 0,
  flash: null, // { text, color, at, big } — center milestone flash
  playerName: localStorage.getItem('mt-name') || '',
};

window.state = state;

function playerName() { return state.playerName; }

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---- imported audio (onset-synced mode) ----
const importState = { name: null, buffer: null, bpm: 120, view: false, duration: 60, analysis: null, notes: [] };
window.importState = importState;
const PLAY_ALONG_SEC = 60;
const tapSamples = []; // timestamps (ms) from the tap-to-tempo button

function isImport() { return importState.view && !!importState.buffer; }
function exitImport() { importState.view = false; renderSong(); }
function enterImport() { importState.view = true; renderSong(); }

// Tap-to-tempo: average the reciprocal interval of recent taps -> BPM (override).
function tapTempo() {
  const now = performance.now();
  tapSamples.push(now);
  while (tapSamples.length && now - tapSamples[0] > 4000) tapSamples.shift();
  if (tapSamples.length >= 3) {
    let sum = 0, n = 0;
    for (let i = 1; i < tapSamples.length; i++) {
      const d = tapSamples[i] - tapSamples[i - 1];
      if (d > 150) { sum += d; n++; }
    }
    if (n) {
      const bpm = clamp(60 / (sum / n / 1000), 60, 180);
      setImportBpm(Math.round(bpm));
    }
  }
}

function setImportBpm(bpm) {
  importState.bpm = clamp(bpm, 60, 180);
  const sl = el('bpmSlider'); const sv = el('bpmVal');
  if (sl) sl.value = importState.bpm;
  if (sv) sv.textContent = importState.bpm + ' BPM';
  if (isImport()) renderSong();
}

// Build a 4-lane chart from the analyzed onset timeline. One tile is placed at
// each real onset (the song's actual beats/hits), flowed across lanes so it's
// playable, with hold tiles wherever the energy sustains after a hit. BPM is
// only used for density/display, not to force a grid.
function buildImportChart(analysis, bpm, level, holdFloor = 0.45) {
  const notes = [];
  const { onsets, energy, hop, sr } = analysis;
  const duration = analysis.duration || importState.duration || PLAY_ALONG_SEC;
  const holdChance = { 0: 0.10, 1: 0.18, 2: 0.26 }[level] ?? 0.18;

  const energyAt = (sec) => {
    if (sec < 0 || sec > duration) return 0;
    const idx = Math.min(energy.length - 1, Math.max(0, Math.floor(sec * sr / hop)));
    return energy[idx];
  };

  const busy = [0, 0, 0, 0];
  let prevCol = -1;
  for (let i = 0; i < onsets.length; i++) {
    const t = onsets[i];
    if (t > duration) break;

    // flow lane, skipping lanes still busy from a hold
    let col = -1;
    const hint = (prevCol + 1 + (Math.random() < 0.5 ? 0 : 1)) % COLS;
    for (let o = 0; o < COLS && col < 0; o++) {
      const c = (hint + o) % COLS;
      if (busy[c] <= t) col = c;
    }
    if (col < 0) continue;

    // hold where energy stays elevated after this onset
    let dur = 0;
    const en0 = energyAt(t);
    if (en0 > 0 && Math.random() < holdChance) {
      let held = 0;
      for (let b = 1; b <= 4; b++) {
        const tb = t + b * (60 / bpm);
        if (tb > duration) break;
        if (energyAt(tb) >= en0 * holdFloor) held = b; else break;
      }
      if (held >= 1) dur = held * (60 / bpm);
      if (dur > 1.6) dur = 1.6;
    }
    if (dur > 0.05) busy[col] = t + dur;

    notes.push({ time: t, col, mel: true, type: dur > 0.05 ? 'hold' : 'tap', dur: dur > 0.05 ? dur : 0, hit: false, missed: false });
    prevCol = col;
  }
  return notes;
}
window.buildImportChart = buildImportChart;

// ---------- canvas sizing ----------
function getDPR() { return Math.min(window.devicePixelRatio || 1, 2); }

function resizeCanvas() {
  const stage = el('stage');
  if (!stage) return;
  // Use the stage's border-box so the canvas fills it exactly with no gap.
  const rect = stage.getBoundingClientRect();
  const w = Math.max(1, rect.width);
  const h = Math.max(1, rect.height);
  const dpr = getDPR();
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width === bw && canvas.height === bh) return;
  canvas.width = bw;
  canvas.height = bh;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 0));
window.addEventListener('pageshow', resizeCanvas);
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(resizeCanvas).observe(el('stage'));
}

// ---------- accent color ----------
const LANE_KEYS = ['D', 'F', 'J', 'K'];
function buildLanes() {
  const lanesEl = el('lanes');
  lanesEl.innerHTML = '';
  for (let c = 0; c < COLS; c++) {
    const key = document.createElement('div');
    key.className = 'lane-key';
    key.textContent = LANE_KEYS[c];
    key.style.setProperty('--k', COLORS[c]);
    key.addEventListener('pointerdown', (e) => { e.preventDefault(); tap(c); });
    key.addEventListener('pointerup', () => releaseCol(c));
    lanesEl.appendChild(key);
  }
  laneFlash = [0, 0, 0, 0];
}

function applyAccent(song) {
  const ACCENTS = {
    amber: '#f2a65a', rose: '#e37b7b', teal: '#5fbdb0', violet: '#9d8cff',
  };
  const ac = ACCENTS[song.accent] || '#f2a65a';
  document.documentElement.style.setProperty('--song-accent', ac);
  const keys = document.querySelectorAll('.lane-key');
  for (let c = 0; c < COLS; c++) {
    keys[c] && keys[c].style.setProperty('--k', COLORS[c]);
  }
}

// ---------- game flow ----------
export function startGame(song, auto, level = 1) {
  audio.ensure();
  // Force-resume AudioContext on iOS — it can re-suspend after idle
  if (audio.ctx && audio.ctx.state === 'suspended') {
    audio.ctx.resume();
  }
  state.song = song;
  state.level = level;
  state.mode = 'playing';
  state.auto = auto;
  state.paused = false;
  state.score = 0;
  state.combo = 0;
  state.maxCombo = 0;
  state.perfect = 0;
  state.good = 0;
  state.miss = 0;
  state.perfectChain = 0;
  state.maxPerfectChain = 0;
  state.accuracy = 100;
  state.precision = 100;
  state.timingErrSum = 0;
  state.timingErrN = 0;
  state.clockOffset = 0;
  state.flash = null;
  state.particles = [];
  state.popups = [];
  state.importStartAudio = null;
  lastHUDCombo = 0;
  lastHUDMult = 1;
  if (isImport()) {
    state.notes = importState.notes.slice();
    audio.playBuffer(importState.buffer, false);
    state.importStartAudio = audio.ctx.currentTime;
  } else {
    state.notes = buildChart(song, song.build(level));
    audio.start(song, {});
  }
  state.totalNotes = state.notes.length;
  state.notePtr = 0;
  state.remainingNotes = [...state.notes];
  state.hold = null;

  state.startedAt = performance.now();
  state.frameCount = 0;

  setDeckLocked(true);
  el('autoBadge').style.display = auto ? 'block' : 'none';
  el('playBtn').textContent = '■ Stop';
  hideOverlays();
  updateHUD(true);
  updateLaneKeys(true);
  requestAnimationFrame(loop);
}

// Elapsed game time in seconds. For imported tracks we clock from the actual
// audio (ctx.currentTime) so tiles land exactly on the song's onsets; for the
// built-in procedural songs we use wall-clock with pause offset.
function gameElapsed() {
  if (isImport() && state.importStartAudio != null && audio.ctx) {
    return audio.ctx.currentTime - state.importStartAudio;
  }
  return (performance.now() - state.startedAt - state.clockOffset) / 1000;
}

function loop() {
  if (state.mode !== 'playing') return;
  resizeCanvas();
  const now = performance.now();
  let e = gameElapsed();
  if (state.paused) {
    draw(Math.max(0.0001, e), true);
    requestAnimationFrame(loop);
    return;
  }
  const elapsed = gameElapsed();

  audio.schedule(6);

  resolveNotes(elapsed);
  updateHoldTicks(elapsed);
  updateHUD();
  updateLaneKeys(false);

  const last = state.notes[state.notes.length - 1];
  const stillPlaying = last ? elapsed < (noteGameTime(last) + 1.0) : false;
  if (!stillPlaying && state.notePtr >= state.notes.length) {
    finishGame();
    return;
  }

  draw(elapsed, false);
  requestAnimationFrame(loop);
}

function togglePause() {
  if (state.mode !== 'playing') return;
  if (state.paused) {
    state.clockOffset += performance.now() - state.pauseStart;
    state.pauseStart = 0;
    state.paused = false;
    audio.resume();
    el('pauseOverlay') && (el('pauseOverlay').hidden = true);
    el('deck') && el('deck').classList.remove('paused');
  } else {
    state.paused = true;
    state.pauseStart = performance.now();
    audio.pause();
    el('pauseOverlay') && (el('pauseOverlay').hidden = false);
    el('deck') && el('deck').classList.add('paused');
  }
}
window.togglePause = togglePause;

// ---------- note timing ----------
function noteGameTime(note) { return note.time; }

function tune() { return LEVEL_TUNE[state.level] || LEVEL_TUNE[1]; }

function resolveNotes(elapsed) {
  const missWin = tune().miss;
  if (state.auto) {
    while (state.notePtr < state.notes.length && noteGameTime(state.notes[state.notePtr]) < elapsed) {
      hit(state.notes[state.notePtr], elapsed, true);
      state.notePtr++;
    }
    while (state.notePtr < state.notes.length && noteGameTime(state.notes[state.notePtr]) < elapsed - missWin) {
      registerMiss(state.notes[state.notePtr], elapsed);
      state.notePtr++;
    }
    if (state.hold && elapsed >= state.hold.releaseAt) {
      release(state.hold, elapsed, true);
    }
    return;
  }
  while (state.notePtr < state.notes.length &&
         noteGameTime(state.notes[state.notePtr]) < elapsed - missWin) {
    registerMiss(state.notes[state.notePtr], elapsed);
    state.notePtr++;
  }
  if (state.hold && elapsed >= state.hold.releaseAt) {
    registerMiss(state.hold.note, elapsed);
    state.hold = null;
  }
}

function hit(note, elapsed, forced = false) {
  const T = tune();
  const diff = Math.abs(elapsed - noteGameTime(note));
  const pz = forced || diff <= T.perfect;
  // precision: accumulate timing offset (0 for forced/auto)
  state.timingErrSum += forced ? 0 : diff;
  state.timingErrN++;
  reconcilePrecision();
  if (pz) { state.perfect++; packScore(10); setJudge('PERFECT', Math.round(diff * 1000)); spawnBurst(note.col, true); spawnPopup('+10', note.col, COLORS[note.col]); }
  else    { state.good++;    packScore(5);  setJudge('GOOD', Math.round(diff * 1000));    spawnBurst(note.col, false); spawnPopup('+5', note.col, '#cfcfcf'); }
  if (pz) {
    state.perfectChain++;
    state.maxPerfectChain = Math.max(state.maxPerfectChain, state.perfectChain);
  } else {
    state.perfectChain = 0;
  }
  state.lastJudge = pz ? 'PERFECT' : 'GOOD';
  note.hit = true;
  note.missed = false;
  if (note.type === 'hold') {
    state.hold = { note, col: note.col, releaseAt: note.time + note.dur, lastTick: elapsed };
    note.holding = true;
  }
  reconcileAccuracy();
  flashKey(note.col);
  const idx = state.remainingNotes.indexOf(note);
  if (idx >= 0) state.remainingNotes.splice(idx, 1);
}

function release(hold, elapsed, forced = false) {
  if (!state.hold || state.hold.note !== hold.note) return;
  const note = hold.note;
  note.holding = false;
  state.hold = null;
  // slid (held) the full length → completion bonus
  if (!forced && elapsed >= hold.releaseAt - tune().perfect) {
    state.perfect++;
    packScore(8);
    setJudge('HOLD +8', 0);
    spawnPopup('HOLD', note.col, COLORS[note.col]);
  }
}

// While a long tile is held/slid, each beat of sustained contact ticks +2
// points and +1 combo — the longer you keep sliding, the more you earn.
function holdTickInterval() {
  const s = state.song;
  const beatDur = s && s.bpm ? 60 / s.bpm : 0.5;
  return beatDur / 2; // tick twice per beat for a lively slide feel
}
function updateHoldTicks(elapsed) {
  const h = state.hold;
  if (!h) return;
  const iv = holdTickInterval();
  while (elapsed - h.lastTick >= iv) {
    h.lastTick += iv;
    state.combo++;
    state.maxCombo = Math.max(state.maxCombo, state.combo);
    packScore(2);
    reconcileAccuracy();
    spawnPopup('+2', h.col, COLORS[h.col] || COLORS[0]);
    setHoldJudge();
  }
}
let lastHoldJudgeAt = 0;
function setHoldJudge() {
  const now = performance.now();
  if (now - lastHoldJudgeAt > 160) {
    lastHoldJudgeAt = now;
    setJudge('SLIDE', 0);
  }
}

function registerMiss(note, elapsed) {
  state.miss++;
  state.combo = 0;
  state.perfectChain = 0;
  note.missed = true;
  note.holding = false;
  state.lastJudge = 'MISS';
  if (state.hold && state.hold.note === note) state.hold = null;
  setJudge('MISS');
  spawnPopup('MISS', note.col, '#ff8c8c');
  shakeStage(8);
  reconcileAccuracy();
  const idx = state.remainingNotes.indexOf(note);
  if (idx >= 0) state.remainingNotes.splice(idx, 1);
}

function spawnPopup(text, col, color) {
  const x = col * laneW() + laneW() / 2;
  state.popups.push({ x, y: hitY() - 28, vy: -60, life: 0.7, text, color, size: 16 });
  if (state.popups.length > 24) state.popups.shift();
}

// Briefly shake the game stage for a "hit" feel on misses.
let shakeUntil = 0;
let shakeMag = 0;
function shakeStage(mag) {
  shakeMag = Math.max(shakeMag, mag);
  shakeUntil = performance.now() + 180;
  const stage = el('stage');
  if (stage) stage.classList.add('shaking');
  setTimeout(() => el('stage') && el('stage').classList.remove('shaking'), 200);
}

function packScore(points) {
  state.combo++;
  state.maxCombo = Math.max(state.maxCombo, state.combo);
  state.score += Math.round(points * multiplier());
  // Combo streak milestone celebration every 25 hits.
  if (state.combo > 0 && state.combo % 25 === 0) {
    centerFlash(`${state.combo} COMBO!`, COLORS[(state.combo / 25) % COLORS.length | 0], true);
  } else if (state.combo === 10 || state.combo === 20) {
    centerFlash(`${state.combo} combo`, '#cfcfcf');
  }
}

function centerFlash(text, color, big = false) {
  state.flash = { text, color, at: performance.now(), big };
}
function multiplier() {
  return Math.min(8, Math.floor(state.combo / 10) + 1);
}
function reconcilePrecision() {
  if (!state.timingErrN) { state.precision = 100; return; }
  const avgErrSec = state.timingErrSum / state.timingErrN;
  state.precision = Math.max(0, Math.min(100, 100 - avgErrSec * 400));
}
function reconcileAccuracy() {
  const total = state.perfect + state.good + state.miss;
  state.accuracy = total === 0 ? 100 : ((state.perfect + state.good * 0.5) / total) * 100;
}
function setJudge(label, ms) {
  state.judge = label;
  state.judgeMs = ms;
  state.judgeT = performance.now();
}

function spawnBurst(col, big) {
  const w = canvas.width / getDPR() / COLS;
  const x = col * w + w / 2;
  const y = hitY();
  const n = big ? 20 : 11;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 100 + Math.random() * (big ? 200 : 130);
    state.particles.push({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 50,
      life: 0.5 + Math.random() * 0.4, size: 2 + Math.random() * 3, color: COLORS[col],
    });
  }
  if (big) state.particles.push({ x, y, vx: 0, vy: 0, life: 0.3, size: w * 0.7, color: '#fff', ring: true });
}

// ---------- input ----------
function inputToCol(clientX) {
  const r = canvas.getBoundingClientRect();
  return Math.min(COLS - 1, Math.max(0, Math.floor((clientX - r.left) / (r.width / COLS))));
}
function tap(col) {
  if (state.mode !== 'playing' || state.auto || state.paused) return;
  const elapsed = gameElapsed();
  if (state.hold && state.hold.col === col) return;
  let best = null, bestDiff = Infinity;
  for (const note of state.remainingNotes) {
    if (note.col !== col) continue;
    const diff = Math.abs(elapsed - noteGameTime(note));
    if (diff <= tune().miss && diff < bestDiff) { best = note; bestDiff = diff; }
  }
  if (best) {
    hit(best, elapsed);
    while (state.notePtr < state.notes.length && state.notes[state.notePtr].hit) state.notePtr++;
  }
  // A tap with no tile in range is simply ignored — no penalty, no freeze.
}
function releaseCol(col) {
  if (state.mode !== 'playing') return;
  const elapsed = gameElapsed();
  if (state.hold && state.hold.col === col && !state.auto) {
    if (elapsed < state.hold.releaseAt - 0.05) registerMiss(state.hold.note, elapsed);
    else release(state.hold, elapsed);
  }
}

canvas.addEventListener('pointerdown', (e) => tap(inputToCol(e.clientX)));
canvas.addEventListener('pointerup', (e) => releaseCol(inputToCol(e.clientX)));
window.addEventListener('keydown', (e) => {
  const map = { D: 0, F: 1, J: 2, K: 3 };
  const k = e.key.toUpperCase();
  if (k in map) tap(map[k]);
});
window.addEventListener('keyup', (e) => {
  const map = { D: 0, F: 1, J: 2, K: 3 };
  const k = e.key.toUpperCase();
  if (k in map) releaseCol(map[k]);
});

// ---- lock screen zoom (iOS pinch, Safari gestures, double-tap) ----
// iOS Safari uses the older gesture* events for pinch; modern browsers fire
// a multi-touch touchmove. Block both so the game surface never zooms, while
// still allowing single-finger play taps and single-finger menu scrolling.
document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => {
  // Only block multi-touch pinches on the game stage, not site-wide scrolling
  if (e.target.closest('.stage') && e.touches && e.touches.length > 1) e.preventDefault();
}, { passive: false });

// ---------- HUD ----------
function updateHUD(force) {
  el('scoreDigits').textContent = String(state.score).padStart(4, '0');
  el('comboDigits').textContent = state.combo;
  el('accDigits').textContent = Math.round(state.accuracy) + '%';
  el('precisionDigits').textContent = Math.round(state.precision) + '%';
  const m = multiplier();
  el('multDigits').textContent = 'x' + m;
  // keep the compact bottom metric grid in sync (duplicate "…2" ids)
  const g = (id, v) => { const e = el(id); if (e) e.textContent = v; };
  g('scoreDigits2', String(state.score).padStart(4, '0'));
  g('comboDigits2', state.combo);
  g('accDigits2', Math.round(state.accuracy) + '%');
  g('precisionDigits2', Math.round(state.precision) + '%');
  g('multDigits2', 'x' + m);
  if (!force) {
    const comboEl = el('comboDigits');
    if (comboEl) {
      if (state.combo === 0 && lastHUDCombo > 0) {
        comboEl.classList.remove('combo-pop', 'mult-pop');
        void comboEl.offsetWidth;
        comboEl.classList.add('combo-broken');
      } else if (state.combo > lastHUDCombo) {
        comboEl.classList.remove('combo-broken');
        void comboEl.offsetWidth;
        comboEl.classList.add('combo-pop');
      }
      if (lastHUDMult < m && m > 1) {
        const multEl = el('multDigits');
        multEl.classList.remove('mult-pop');
        void multEl.offsetWidth;
        multEl.classList.add('mult-pop');
      }
    }
  }
  lastHUDCombo = state.combo;
  lastHUDMult = m;
}
let lastHUDCombo = 0;
let lastHUDMult = 1;

let laneFlash = [0, 0, 0, 0];
function flashKey(col) {
  const keys = document.querySelectorAll('.lane-key');
  keys[col] && keys[col].classList.add('hit');
  laneFlash[col] = performance.now();
}
function updateLaneKeys(clear) {
  const keys = document.querySelectorAll('.lane-key');
  const now = performance.now();
  for (let c = 0; c < COLS; c++) {
    if (clear || (laneFlash[c] && now - laneFlash[c] > 90)) {
      keys[c] && keys[c].classList.remove('hit');
      laneFlash[c] = 0;
    }
  }
}

// ---------- drawing ----------
function hitY() { return (canvas.height / getDPR()) * 0.62; }
function laneW() { return canvas.width / getDPR() / COLS; }

function pillRect(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawPills(note, x, yTop, yBot, cw, color) {
  const pad = cw * 0.12;
  const pw = cw - pad * 2;
  const h = Math.max(20, yBot - yTop);
  const grad = ctx.createLinearGradient(x, yTop, x, yBot);
  const light = shade(color, 40);
  const dark = shade(color, -30);
  grad.addColorStop(0, light);
  grad.addColorStop(0.5, color);
  grad.addColorStop(1, dark);
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  ctx.fillStyle = grad;
  pillRect(x + pad, yTop, pw, h, Math.min(10, pw / 2));
  ctx.fill();
  ctx.restore();
  // top highlight band (glass edge)
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  pillRect(x + pad, yTop + 2, pw, Math.min(6, h * 0.25), 3);
  ctx.fill();
  ctx.restore();
  void note;
}
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.max(0, Math.min(255, r + amt));
  g = Math.max(0, Math.min(255, g + amt));
  b = Math.max(0, Math.min(255, b + amt));
  return `rgb(${r},${g},${b})`;
}

// ---- beat-reactive background helpers ----
const ACCENT_HEX = { amber: '#f2a65a', rose: '#e37b7b', teal: '#5fbdb0', violet: '#9d8cff' };
function currentAccent() {
  const s = state.song || {};
  const hex = ACCENT_HEX[s.accent] || '#f2a65a';
  const n = parseInt(hex.slice(1), 16);
  const rgb = { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  return {
    ...rgb,
    fade(a) { return `rgba(${rgb.r},${rgb.g},${rgb.b},${a})`; },
  };
}
// Hue-shift the ambient tint per chord-section (bar) so sections feel distinct.
function accentBase(bar) {
  const a = currentAccent();
  const section = ((bar % 16) / 16) * 2 - 1; // -1..1 cycling
  return {
    r: Math.round(clamp(a.r - section * 16, 0, 255)),
    g: Math.round(clamp(a.g + section * 20, 0, 255)),
    b: Math.round(clamp(a.b + section * 8, 0, 255)),
  };
}
function darkBgTint(tint, amount) {
  const t = tint || { r: 19, g: 15, b: 30 };
  const f = Math.max(0, Math.min(1, amount));
  return `rgba(${Math.round(t.r * f + 19 * (1 - f))},${Math.round(t.g * f + 15 * (1 - f))},${Math.round(t.b * f + 30 * (1 - f))},1)`;
}

function draw(elapsed, paused) {
  const W = canvas.width / getDPR();
  const H = canvas.height / getDPR();
  ctx.clearRect(0, 0, W, H);

  // Beat-synced background: the tint shifts per chord section and a soft
  // pulse breathes on every downbeat so the visuals follow the music.
  const song = state.song;
  const beatDur = song && song.bpm ? 60 / song.bpm : 0.5;
  const beats = beatDur ? Math.max(0, elapsed / beatDur) : 0;
  const bar = Math.floor(beats / 4);
  const beatPhase = beats % 1;              // 0..1 within the current beat
  const pulse = Math.pow(Math.max(0, 1 - beatPhase), 2.2); // decays after each beat
  const accent = currentAccent();
  const tint = accentBase(bar);

  const hy = hitY();
  ctx.fillStyle = darkBgTint(tint, pulse * 0.08);
  ctx.fillRect(0, 0, W, H);
  // glow band rising from the hit line on each beat
  const glowA = pulse * 0.16;
  if (glowA > 0.01) {
    ctx.fillStyle = accent.fade(glowA);
    ctx.fillRect(0, hy, H * 0.5, H - hy);
  }

  // layered glowing hit line
  ctx.save();
  ctx.fillStyle = 'rgba(245,239,230,0.06)';
  ctx.fillRect(0, hy - 10, W, 20);
  ctx.strokeStyle = 'rgba(245,239,230,0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, hy - 4); ctx.lineTo(W, hy - 4); ctx.stroke();
  ctx.strokeStyle = 'rgba(245,239,230,0.5)';
  ctx.lineWidth = 2;
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 8;
  ctx.beginPath(); ctx.moveTo(0, hy); ctx.lineTo(W, hy); ctx.stroke();
  ctx.restore();
  // lane dividers
  ctx.strokeStyle = 'rgba(245,239,230,0.05)';
  ctx.lineWidth = 1;
  for (let c = 0; c < COLS; c++) {
    ctx.beginPath(); ctx.moveTo(c * laneW(), 0); ctx.lineTo(c * laneW(), H); ctx.stroke();
  }

  const cw = laneW();
  const nowT = elapsed;
  for (let i = 0; i < state.notes.length; i++) {
    const note = state.notes[i];
    const t = noteGameTime(note);
    if (note.hit) continue;
    const x = note.col * cw;
    const color = note.missed ? 'rgba(168,155,196,0.45)' : COLORS[note.col];
    if (note.type === 'hold') {
      const yTop = hy - (t + note.dur - nowT) * speed();
      const yBot = hy - (t - nowT) * speed();
      if (yBot < -80 || yTop > H + 80) continue;
      ctx.globalAlpha = note.missed ? 0.5 : (note.holding ? 0.45 : 1);
      drawPills(note, x, yTop, Math.max(yTop + 6, yBot - 14), cw, color);
      ctx.globalAlpha = 1;
      // rounded glowing head at the bottom
      const headY = yBot - 24;
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
      ctx.fillStyle = note.holding ? '#ffffff' : shade(color, 30);
      pillRect(x + cw * 0.18, headY, cw * 0.64, 24, 8);
      ctx.fill();
      ctx.restore();
      continue;
    }
    const y = hy - (t - nowT) * speed();
    if (y < -90 || y > H + 90) continue;
    drawPills(note, x, y - 13, y + 13, cw, color);
  }

  // particles
  if (state.particles.length) {
    const dt = nowT - (state.particleLast == null ? nowT : state.particleLast);
    state.particleLast = nowT;
    for (let i = state.particles.length - 1; i >= 0; i--) {
      const p = state.particles[i];
      p.life -= dt;
      if (p.life <= 0) { state.particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 300 * dt;
      const alpha = Math.max(0, p.life / 0.6);
      ctx.globalAlpha = alpha;
      if (p.ring) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 3 * alpha;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1 - (0.3 - p.life) / 0.3), 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
      ctx.globalAlpha = 1;
    }
  } else {
    state.particleLast = null;
  }

  // floating score popups
  if (state.popups.length) {
    const dt = nowT - (state.popupLast == null ? nowT : state.popupLast);
    state.popupLast = nowT;
    ctx.textAlign = 'center';
    for (let i = state.popups.length - 1; i >= 0; i--) {
      const p = state.popups[i];
      p.life -= dt;
      if (p.life <= 0) { state.popups.splice(i, 1); continue; }
      p.y += p.vy * dt;
      const alpha = Math.max(0, p.life / 0.7);
      ctx.globalAlpha = alpha;
      ctx.font = `bold ${p.size}px -apple-system, sans-serif`;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8;
      ctx.fillText(p.text, p.x, p.y);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  } else {
    state.popupLast = null;
  }

  // judge pop
  if (state.judge) {
    const age = (performance.now() - state.judgeT) / 1000;
    if (age < 0.42) {
      const alpha = 1 - age / 0.42;
      let txt = state.judge, col = '#fff';
      if (state.judge === 'PERFECT') col = COLORS[0];
      if (state.judge === 'GOOD') col = '#cfcfcf';
      if (state.judge === 'MISS') col = COLORS[1];
      ctx.globalAlpha = alpha;
      ctx.font = 'bold 22px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = col;
      ctx.fillText(txt, W / 2, hy - 46);
      if (state.judge !== 'MISS' && state.judgeMs != null) {
        ctx.font = '13px "Courier New", monospace';
        ctx.fillStyle = col;
        ctx.fillText(`±${state.judgeMs}ms`, W / 2, hy - 30);
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
    }
  }

  // combo milestone / center flash
  if (state.flash) {
    const fage = (performance.now() - state.flash.at) / 1000;
    if (fage < 0.9) {
      const alpha = fage < 0.6 ? 1 : 1 - (fage - 0.6) / 0.3;
      const scale = 1 + Math.min(0.3, fage * 0.5);
      ctx.save();
      ctx.translate(W / 2, H * 0.34);
      ctx.scale(scale, scale);
      ctx.globalAlpha = alpha;
      ctx.textAlign = 'center';
      ctx.font = state.flash.big ? 'bold 42px -apple-system, sans-serif' : 'bold 26px -apple-system, sans-serif';
      ctx.fillStyle = state.flash.color;
      ctx.shadowColor = state.flash.color;
      ctx.shadowBlur = 20;
      ctx.fillText(state.flash.text, 0, 0);
      ctx.shadowBlur = 0;
      ctx.font = 'bold 20px -apple-system, sans-serif';
      ctx.fillStyle = 'rgba(245,239,230,0.95)';
      ctx.fillText('KEEP GOING!', 0, 34);
      ctx.restore();
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
    } else {
      state.flash = null;
    }
  }

  // perfect-chain counter (top center)
  if (state.perfectChain > 1) {
    ctx.textAlign = 'center';
    ctx.globalAlpha = Math.min(1, 0.35 + state.perfectChain * 0.02);
    ctx.font = 'bold 13px -apple-system, sans-serif';
    ctx.fillStyle = COLORS[0];
    ctx.shadowColor = COLORS[0];
    ctx.shadowBlur = 12;
    ctx.fillText(`PERFECT CHAIN x${state.perfectChain}`, W / 2, 26);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }

  if (paused) {
    // dim only; the actual pause overlay is DOM
    ctx.fillStyle = 'rgba(13,11,22,0.4)';
    ctx.fillRect(0, 0, W, H);
  }
}

// ---------- finish / results ----------
function finishGame() {
  state.mode = 'done';
  audio.stop();
  setDeckLocked(false);
  el('playBtn').textContent = '▶ Play';
  el('autoBadge').style.display = 'none';

  const btn = el('submitBtn');
  if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  const msg = el('submitMsg');
  if (msg) msg.textContent = '';

  const rank = rankFor();
  const stars = starsFor(rank);
  el('finalRank').textContent = rank;
  el('finalScore').textContent = fmtScore(state.score);
  el('finalPerfect').textContent = state.perfect;
  el('finalGood').textContent = state.good;
  el('finalMiss').textContent = state.miss;
  el('finalCombo').textContent = state.maxCombo;
  el('finalPrec').textContent = Math.round(state.precision) + '%';
  el('scoreName').value = state.playerName;

  // show earned stars in results
  const starBox = el('finalStars');
  if (starBox) starBox.innerHTML = starString(stars);

  const { isNew, unlockedNext, unlockedTitle } = recordResult(state.song, state.level, state.score, state.accuracy, state.maxCombo, rank, stars);
  applyProgressRun(state.song, rank, stars, state.accuracy, state.miss, state.maxPerfectChain);
  el('newBest').hidden = !isNew;
  const pb = el('prevBest');
  const prevBest = getBestLevel(state.song, state.level);
  if (prevBest) { pb.textContent = `Previous best (${LEVELS[state.level]}): ${fmtScore(prevBest.score)} (${prevBest.acc.toFixed(0)}%)`; pb.hidden = false; }
  else pb.hidden = true;

  // unlock toast
  const unlockToast = el('unlockToast');
  if (unlockToast) {
    if (unlockedNext) {
      unlockToast.hidden = false;
      unlockToast.textContent = unlockedTitle
        ? `🎉 ${unlockedTitle} is now unlocked!`
        : '🎉 New song unlocked!';
    } else {
      unlockToast.hidden = true;
    }
  }

  el('resultOverlay').hidden = false;
  renderSong();
  loadLeaderboard();
}

function rankFor() {
  const total = state.perfect + state.good + state.miss;
  if (total === 0) return 'P';
  const acc = (state.perfect + state.good * 0.6) / total;
  if (acc >= 0.97 && state.miss === 0) return 'S';
  if (acc >= 0.88) return 'A';
  if (acc >= 0.75) return 'B';
  if (acc >= 0.55) return 'C';
  return 'D';
}

// ---------- progression (stars + sequential unlock) ----------
function bestKey(song, level) { return `mt-best-${song.id}-${level}`; }

function getBestLevel(song, level) {
  try { return JSON.parse(localStorage.getItem(bestKey(song, level))) || null; }
  catch { return null; }
}

function readProgress() {
  try { return JSON.parse(localStorage.getItem('mt-progress')) || { unlocked: {}, stars: {} }; }
  catch { return { unlocked: {}, stars: {} }; }
}
function writeProgress(p) { localStorage.setItem('mt-progress', JSON.stringify(p)); }

function isUnlocked(idx) {
  if (idx === 0) return true;
  const p = readProgress();
  return !!p.unlocked[idx];
}

// A song is "substantially cleared" once it has earned at least 1 star (B+)
// on ANY difficulty — that's the sequential gate to unlock the next song.
function bestStars(songId) {
  const p = readProgress();
  return p.stars[songId] || 0;
}

function recordResult(song, level, score, acc, combo, rank, stars) {
  const key = bestKey(song, level);
  const prev = getBestLevel(song, level);
  // a 0-point/blank run shouldn't count as a "new record" on a fresh song
  const isNew = prev ? score > prev.score : score > 0;
  if (isNew) {
    localStorage.setItem(key, JSON.stringify({ score, acc, combo, rank, stars, level }));
  }
  if (song.id === '__import__') return { isNew, unlockedNext: false, unlockedTitle: null };
  // Resolve this song's index. Fall back to the current deck position so the
  // unlock always targets the song the player is actually looking at next.
  let idx = SONGS.findIndex((s) => s.id === song.id);
  if (idx === -1 && typeof songIndex === 'number' && song.id === (SONGS[songIndex] || {}).id) {
    idx = songIndex;
  }
  // update progress: per-song best stars
  const p = readProgress();
  const prevStars = p.stars[song.id] || 0;
  if (stars > prevStars) p.stars[song.id] = stars;
  // sequential unlock: earning >=1 star on this song unlocks the next one.
  // The toast only fires when we are certain the exact next song exists,
  // is not already unlocked, and we successfully write it this run.
  const nextIndex = idx + 1;
  let unlockedNext = false;
  let unlockedTitle = null;
  if (stars >= 1 && idx !== -1 && nextIndex < SONGS.length && !p.unlocked[nextIndex]) {
    p.unlocked[nextIndex] = true;
    writeProgress(p);
    const written = readProgress();
    unlockedNext = !!written.unlocked[nextIndex];
    unlockedTitle = unlockedNext ? SONGS[nextIndex].title : null;
  } else {
    writeProgress(p);
  }
  return { isNew, unlockedNext, unlockedTitle };
}

function starString(n) {
  let out = '';
  for (let i = 0; i < 3; i++) out += i < n ? '★' : '☆';
  return out;
}

// ---------- XP / levels / achievements / profile ----------
const XP_LEVELS = 200;            // xp needed per level
function levelForXp(xp) { return Math.floor(xp / XP_LEVELS) + 1; }
function xpIntoLevel(xp) { return xp % XP_LEVELS; }

function readProfl() {
  try { return JSON.parse(localStorage.getItem('mt-profile')) || { xp: 0, ach: {}, titles: {} }; }
  catch { return { xp: 0, ach: {}, titles: {} }; }
}
function writeProfl(q) { localStorage.setItem('mt-profile', JSON.stringify(q)); }

// song mastery title thresholds (per song, uses best stars across difficulties)
const MASTERY = [
  { stars: 3, title: '⭐ Conqueror' },
  { stars: 6, title: '🎖 Master' },
];

function achievementsDef() {
  return [
    { id: 'first',  icon: '🎯', name: 'First Step',        desc: 'Play your first song', test: (a) => a.played >= 1 },
    { id: 's10',    icon: '🗂',  name: 'Ten Tracks',        desc: 'Earn 10 songs worth of plays', test: (a) => a.played >= 10 },
    { id: 'rankS',  icon: '🏆', name: 'S Rank',            desc: 'Earn an S rank', test: (a) => a.ranks.S >= 1 },
    { id: 'fc',     icon: '💯', name: 'Full Combo',        desc: 'A run with zero misses', test: (a) => a.fullCombo >= 1 },
    { id: 'pc25',   icon: '🔗', name: 'Chain 25',          desc: 'A 25+ perfect chain', test: (a) => a.maxPChain >= 25 },
    { id: 'star9',  icon: '🌟', name: 'Nine Stars',        desc: 'Collect 9 stars total', test: (a) => a.stars >= 9 },
    { id: 'lvl5',   icon: '⚡', name: 'Level 5',           desc: 'Reach player level 5', test: (a) => a.lvl >= 5 },
    { id: 'master', icon: '👑', name: 'Song Master',       desc: 'Master any song', test: (a) => a.mastered >= 1 },
  ];
}

function awardXp(amount, opts = {}) {
  const q = readProfl();
  q.xp += amount;
  const prevLvl = levelForXp(q.xp - amount);
  const newLvl = levelForXp(q.xp);
  writeProfl(q);
  if (newLvl > prevLvl && opts.levelUp) {
    opts.levelUp(newLvl);
  }
  return q.xp;
}

function grantAchievements(updates, perform) {
  const q = readProfl();
  let earned = 0;
  const defs = achievementsDef();
  for (const d of defs) {
    if (q.ach[d.id]) continue;
    if (d.test(updates)) {
      q.ach[d.id] = true;
      earned++;
      if (earned > 0 && perform) perform(d);
    }
  }
  if (earned > 0) writeProfl(q);
  return earned;
}

function achievementState() {
  const q = readProfl();
  // re-hydrate aggregate counters from stored bests
  const p = readProgress();
  let stars = 0;
  let mastered = 0;
  for (const s of SONGS) {
    const bs = p.stars[s.id] || 0;
    stars += bs;
    if (bs >= 6) mastered++;
  }
  const a = {
    played: q.played || 0,
    ranks: q.ranks || {},
    fullCombo: q.fullCombo || 0,
    maxPChain: q.maxPChain || 0,
    stars,
    mastered,
    lvl: levelForXp(q.xp),
  };
  return a;
}

// on finishing a run: aggregate stats, award xp + achievements, render toasts
function applyProgressRun(song, rank, stars, acc, missed, perfectChainMax) {
  const q = readProfl();
  q.played = (q.played || 0) + 1;
  q.ranks = q.ranks || {};
  q.ranks[rank] = (q.ranks[rank] || 0) + 1;
  if (missed === 0) q.fullCombo = (q.fullCombo || 0) + 1;
  q.maxPChain = Math.max(q.maxPChain || 0, perfectChainMax);
  writeProfl(q);

  const earned = [];
  let levelBefore = levelForXp(q.xp);
  const xpGained = baseXpFor(stars) + (missed === 0 ? 40 : 0);
  awardXp(xpGained, {
    levelUp: (lvl) => earned.push({ icon: '⬆️', name: `LEVEL UP! Level ${lvl}` }),
  });
  grantAchievements(achievementState(), (d) => earned.push(d));

  const toasts = el('achieveToasts');
  if (toasts) toasts.innerHTML = '';
  if (earned.length) {
    for (const e of earned) {
      const t = document.createElement('div');
      t.className = 'achieve-toast';
      t.textContent = `${e.icon} ${e.name}`;
      toasts.appendChild(t);
    }
  }
  // xp gain line in results
  const xpEl = el('xpGain');
  if (xpEl) {
    xpEl.hidden = false;
    xpEl.textContent = `+${xpGained} XP · LV ${levelBefore} → LV ${levelForXp(readProfl().xp)}`;
  }
  refreshProfileBadge();
  return earned;
}

function baseXpFor(stars) {
  // stars awarded: 0 = 15, 1 = 40, 2 = 70, 3 = 110 + multi/rank bonus handled above
  return [15, 40, 70, 110][Math.min(3, stars)] + (stars > 0 ? 10 : 0);
}

function refreshProfileBadge() {
  const q = readProfl();
  const lv = levelForXp(q.xp);
  const into = xpIntoLevel(q.xp);
  const pct = Math.round((into / XP_LEVELS) * 100);
  const lvNum = el('lvNum');
  if (lvNum) lvNum.textContent = lv;
  const bar = el('xpBarSmall');
  if (bar) bar.textContent = `${pct}%`;
}

function openProfile() {
  const q = readProfl();
  const lv = levelForXp(q.xp);
  const into = xpIntoLevel(q.xp);
  const a = achievementState();
  el('profLv').textContent = lv;
  el('profXpLabel').textContent = `${into} / ${XP_LEVELS} XP`;
  el('profXpFill').style.width = `${Math.round((into / XP_LEVELS) * 100)}%`;

  // achievements
  const grid = el('profileAchievements');
  grid.innerHTML = '';
  for (const d of achievementsDef()) {
    const done = !!q.ach[d.id];
    const c = document.createElement('div');
    c.className = 'achieve-cell' + (done ? '' : ' locked');
    c.innerHTML = `<div class="ac-ico">${done ? d.icon : '🔒'}</div><div class="ac-name">${d.name}</div><div class="ac-desc">${d.desc}</div>`;
    grid.appendChild(c);
  }

  // song mastery
  const list = el('profileMastery');
  list.innerHTML = '';
  if (!SONGS.length) {
    const it = document.createElement('div');
    it.className = 'mastery-item empty';
    it.textContent = 'No songs yet';
    list.appendChild(it);
  } else {
    for (const s of SONGS) {
      const p = readProgress();
      const bs = p.stars[s.id] || 0;
      const it = document.createElement('div');
      it.className = 'mastery-item';
      let title = 'Locked';
      for (const m of MASTERY) if (bs >= m.stars) title = m.title;
      it.innerHTML = `<div class="m-name">${s.title}</div><div class="m-title">${bs > 0 ? `${bs}★ · ${title}` : 'Not played'}</div>`;
      list.appendChild(it);
    }
  }

  el('profileOverlay').hidden = false;
}

// ---------- leaderboard ----------
async function loadLeaderboard() {
  const song = state.song || SONGS[songIndex];
  const listEl = el('lbList');
  if (isImport()) {
    el('lbSong').textContent = '🎵 ' + song.title;
    const best = getBestLevel(song, state.level);
    el('songBest').textContent = best
      ? `Local best (${LEVELS[state.level]}): ${fmtScore(best.score)} (${best.acc.toFixed(0)}%)`
      : `No ${LEVELS[state.level]} local score yet.`;
    listEl.innerHTML = '<li class="lb-empty">Imported track — tap the TAP button to sync, scores saved locally.</li>';
    return;
  }
  const locked = !isUnlocked(songIndex);
  el('lbSong').textContent = locked ? '🔒 ' + song.title : song.title;
  if (locked) {
    el('songBest').textContent = `Locked — earn a B+ (1★) on the previous song to unlock ${song.title}.`;
    listEl.innerHTML = '<li class="lb-empty">🔒 Locked</li>';
    return;
  }
  const best = getBestLevel(song, state.level);
  el('songBest').textContent = best
    ? `Your best (${LEVELS[state.level]}): ${fmtScore(best.score)} (${best.acc.toFixed(0)}%)`
    : `No ${LEVELS[state.level]} score yet — set a record!`;
  listEl.innerHTML = '<li class="lb-empty">Loading…</li>';
  try {
    const res = await fetch('/api/scores');
    const { scores } = await res.json();
    const rows = scores
      .filter((s) => s.song === song.title && (s.difficulty === LEVELS[state.level] || !s.difficulty))
      .sort((a, b) => b.score - a.score).slice(0, 8);
    if (!rows.length) { listEl.innerHTML = '<li class="lb-empty">No scores yet — be the first!</li>'; return; }
    listEl.innerHTML = rows.map((s, i) => {
      const you = s.name === playerName() ? ' you' : '';
      return `<li class="lb-row${you}"><span class="lb-rank">${i + 1}</span><span class="lb-name">${escapeHtml(s.name)}${you ? '<em> (you)</em>' : ''}</span><span class="lb-score">${fmtScore(s.score)}</span></li>`;
    }).join('');
  } catch (e) {
    listEl.innerHTML = '<li class="lb-empty">Leaderboard unavailable</li>';
  }
}

let lastSubmittedScoreKey = null;

async function submitScore() {
  const name = el('scoreName').value.trim() || 'Anonymous';
  state.playerName = name;
  localStorage.setItem('mt-name', name);
  if (isImport()) {
    el('submitMsg').textContent = 'Imported play-along scores are kept locally only.';
    return;
  }
  const btn = el('submitBtn');
  // disable immediately so rapid double-clicks can't fire twice
  if (btn) { btn.disabled = true; }
  // guard against double-submitting the exact same game result
  const key = JSON.stringify({
    name, score: state.score, song: state.song.title,
    diff: LEVELS[state.level], acc: Math.round(state.accuracy), combo: state.maxCombo,
  });
  if (key === lastSubmittedScoreKey) {
    el('submitMsg').textContent = 'That score is already saved — play again for a new entry.';
    return;
  }
  try {
    const res = await fetch('/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, score: state.score, song: state.song.title,
        accuracy: Math.round(state.accuracy), combo: state.maxCombo,
        difficulty: LEVELS[state.level],
      }),
    });
    const { rank } = await res.json();
    lastSubmittedScoreKey = key;
    if (btn) { btn.disabled = true; btn.textContent = 'Saved ✓'; }
    el('submitMsg').textContent =
      rank <= 8 ? `Nice! You placed #${rank} on this song!` : `Score saved (ranks ~#${rank}).`;
    loadLeaderboard();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    el('submitMsg').textContent = 'Could not reach server.';
  }
}

// locale-independent thousand separators (iPad Safari's toLocaleString can
// return undefined because it doesn't load locale data synchronously)
function fmtScore(n) {
  const s = String(Math.round(Number(n) || 0));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- deck / navigation ----------
function setDeckLocked(locked) {
  el('prevSong').disabled = locked;
  el('nextSong').disabled = locked;
}

let songIndex = 0;
function importSongObj() {
  return { id: '__import__', title: importState.name || 'Imported Track',
    genre: 'Imported · onset-synced', accent: 'violet', bpm: importState.bpm,
    difficulty: 1, playAlong: true, durSec: importState.duration || 60 };
}
function renderSong() {
  if (isImport()) {
    const im = importSongObj();
    state.song = im;
    el('songTitle').textContent = im.title;
    el('songGenre').textContent = `Imported · onset-synced · ~${im.bpm} BPM · ${LEVELS[state.level]}`;
    el('bpmReadout').textContent = `${im.bpm} BPM`;
    el('diffNum').textContent = importState.notes.length ? `${importState.notes.length} notes` : String(state.level + 1);
    const starsEl = el('deckStars');
    if (starsEl) { starsEl.textContent = starString(0); starsEl.classList.add('dim'); }
    const lockEl = el('lockBadge') || el('deck').querySelector('.lock-badge');
    if (lockEl) lockEl.style.display = 'none';
    el('bpmRow').style.display = '';
    el('playBtn').disabled = false;
    autoAble(false);
    applyAccent(im);
    loadLeaderboard();
    return;
  }
  const song = SONGS[songIndex];
  state.song = song;
  const locked = !isUnlocked(songIndex);
  el('songTitle').textContent = song.title;
  el('songGenre').textContent = `${song.genre} · ${song.bpm} BPM · ${LEVELS[state.level]}`;
  el('bpmReadout').textContent = `${song.bpm} BPM`;
  el('diffNum').textContent = song.difficulty;
  // stars + lock in the deck
  const starsEl = el('deckStars');
  if (starsEl) {
    starsEl.textContent = starString(bestStars(song.id));
    starsEl.classList.toggle('dim', bestStars(song.id) === 0);
  }
  const lockEl = el('lockBadge') || el('deck').querySelector('.lock-badge');
  if (lockEl) lockEl.style.display = locked ? '' : 'none';
  el('bpmRow').style.display = 'none';
  el('playBtn').disabled = locked;
  autoAble(locked);
  applyAccent(song);
  loadLeaderboard();
}

function setLevel(l) {
  state.level = clamp(l, 0, LEVELS.length - 1);
  if (isImport() && importState.analysis) {
    importState.notes = buildImportChart(importState.analysis, importState.bpm, state.level);
  }
  const btns = document.querySelectorAll('.diff-btn');
  btns.forEach((b) => b.classList.toggle('active', Number(b.dataset.level) === state.level));
  el('diffNum').textContent = isImport()
    ? (importState.notes.length ? `${importState.notes.length} notes` : String(state.level + 1))
    : SONGS[songIndex].difficulty;
  renderSong();
  updateHUD(true);
}

function autoAble(locked) { el('autoBtn').disabled = locked; }

function hideOverlays() {
  el('pauseOverlay').hidden = true;
  el('resultOverlay').hidden = true;
  el('deck').classList.remove('paused');
}

export function goMenu() {
  state.mode = 'menu';
  audio.stop();
  setDeckLocked(false);
  el('playBtn').textContent = '▶ Play';
  el('autoBadge').style.display = 'none';
  hideOverlays();
  renderSong();
  audio.ensure();
}

// ---------- wiring ----------
el('prevSong').addEventListener('click', () => {
  if (state.mode === 'playing') return;
  if (isImport()) { exitImport(); return; }
  songIndex = (songIndex - 1 + SONGS.length) % SONGS.length;
  renderSong();
});
el('nextSong').addEventListener('click', () => {
  if (state.mode === 'playing') return;
  if (isImport()) { exitImport(); return; }
  songIndex = (songIndex + 1) % SONGS.length;
  renderSong();
});

el('playBtn').addEventListener('click', () => {
  if (state.mode === 'playing') { stopEarly(); return; }
  if (isImport()) { startGame(importSongObj(), state.auto, state.level); return; }
  if (!isUnlocked(songIndex)) return;
  startGame(SONGS[songIndex], state.auto, state.level);
});
el('autoBtn').addEventListener('click', () => {
  if (state.mode === 'playing') return;
  if (isImport()) {
    state.auto = !state.auto;
    el('autoBtn').classList.toggle('active', state.auto);
    el('autoBtn').textContent = state.auto ? 'Auto-Play: ON' : 'Auto-Play Demo';
    return;
  }
  if (!isUnlocked(songIndex)) return;
  state.auto = !state.auto;
  el('autoBtn').classList.toggle('active', state.auto);
  el('autoBtn').textContent = state.auto ? 'Auto-Play: ON' : 'Auto-Play Demo';
});
document.querySelectorAll('.diff-btn').forEach((b) => {
  b.addEventListener('click', () => setLevel(Number(b.dataset.level)));
});
const speedSlider = el('speedSlider');
if (speedSlider) {
  speedSlider.value = speedMult;
  speedSlider.addEventListener('input', () => {
    speedMult = clamp(parseFloat(speedSlider.value) || 1, 1, 2);
    localStorage.setItem('mt-speed', String(speedMult));
    el('speedVal').textContent = speedMult.toFixed(2) + '×';
  });
}
el('retryBtn').addEventListener('click', () => startGame(state.song, state.auto, state.level));
const importBtn = el('importBtn');
const importInput = el('importInput');
const bpmSlider = el('bpmSlider');
if (importBtn && importInput) {
  importBtn.addEventListener('click', () => {
    if (state.mode === 'playing') return;
    if (importState.buffer) { enterImport(); return; }
    importInput.click();
  });
  importInput.addEventListener('change', () => {
    const file = importInput.files && importInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const data = reader.result;
      (async () => {
        try {
          const buf = await audio.ensure().decodeAudioData(data);
          importState.buffer = buf;
          importState.name = file.name;
          importState.duration = buf.duration;
          let analysis, bpm = 120;
          try {
            analysis = await new Promise((res) => {
              setTimeout(() => res(analyzeAudio(buf)), 30); // let the UI paint "Charting…"
            });
            bpm = estimateBpm(analysis.onsets);
          } catch (e) {
            console.error('analysis failed', e);
            analysis = { onsets: [], energy: new Float64Array(1), hop: 512, sr: buf.sampleRate, duration: buf.duration };
          }
          importState.analysis = analysis;
          importState.bpm = bpm;
          importState.notes = buildImportChart(analysis, bpm, state.level);
          const st = el('importStatus');
          if (st) st.textContent = `Charted ${importState.notes.length} notes at ~${bpm} BPM`;
          enterImport();
        } catch (e) { console.error('decode failed', e); alert('Could not decode that audio file.'); }
      })();
    };
    reader.readAsArrayBuffer(file);
    importInput.value = '';
  });
}
if (bpmSlider) {
  bpmSlider.value = importState.bpm;
  bpmSlider.addEventListener('input', () => {
    setImportBpm(parseInt(bpmSlider.value || '120', 10));
  });
}
const tapBtn = el('tapBtn');
if (tapBtn) {
  tapBtn.addEventListener('click', () => {
    if (state.mode === 'playing' && !state.auto) return;
    tapTempo();
  });
}
el('backBtn').addEventListener('click', goMenu);
el('quitBtn').addEventListener('click', goMenu);
el('resumeBtn').addEventListener('click', togglePause);
el('submitBtn').addEventListener('click', submitScore);

el('muteBtn').addEventListener('click', () => {
  audio.ensure();
  audio.toggleMute();
  el('muteBtn').textContent = audio.muted ? '🔇' : '🔊';
});

function fsFullscreenElement() {
  return document.fullscreenElement
    || document.webkitFullscreenElement
    || document.webkitCurrentFullScreenElement
    || null;
}
function fsEnter(el) {
  return (el.requestFullscreen && el.requestFullscreen())
    || (el.webkitRequestFullscreen && el.webkitRequestFullscreen())
    || Promise.resolve();
}
function fsExit() {
  return (document.exitFullscreen && document.exitFullscreen())
    || (document.webkitExitFullscreen && document.webkitExitFullscreen())
    || Promise.resolve();
}
function fsEnabled() { return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled); }
function toggleFullscreen() {
  if (fsFullscreenElement()) {
    fsExit();
    if (el('fullscreenBtn')) el('fullscreenBtn').textContent = '⛶';
  } else if (fsEnabled()) {
    fsEnter(el('app') || document.documentElement).catch(() => {});
    if (el('fullscreenBtn')) el('fullscreenBtn').textContent = '✕';
  } else {
    // Fullscreen API unsupported (e.g. most iPhone Safari) — show a hint.
    const hint = el('hint');
    if (hint) {
      hint.textContent = 'Full screen isn\u2019t available in this browser — add the page to your Home Screen to play edge-to-edge.';
      setTimeout(() => {
        if (hint) hint.textContent = 'Tap keys D·F·J·K (or touch) as tiles hit the line · hold long notes · P pause';
      }, 3000);
    }
  }
}
el('fullscreenBtn').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  const btn = el('fullscreenBtn');
  if (btn) btn.textContent = fsFullscreenElement() ? '✕' : '⛶';
  resizeCanvas();
});

// pause HUD button + bottom-nav shortcuts
const pauseBtn = el('pauseBtn');
if (pauseBtn) pauseBtn.addEventListener('click', () => togglePause());
const navProfile = el('navProfile');
if (navProfile) navProfile.addEventListener('click', () => { if (state.mode === 'play') togglePause(); openProfile(); });


function stopEarly() {
  state.mode = 'menu';
  audio.stop();
  setDeckLocked(false);
  el('playBtn').textContent = '▶ Play';
  el('autoBadge').style.display = 'none';
  hideOverlays();
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.mode === 'playing') togglePause();
  if ((e.key === 'p' || e.key === 'P') && state.mode === 'playing') togglePause();
  if (e.code === 'Space') e.preventDefault();
});

// init
resizeCanvas();
hideOverlays();
buildLanes();
setLevel(1);
renderSong();
refreshProfileBadge();
el('profileBtn').addEventListener('click', () => { if (state.mode === 'play') togglePause(); openProfile(); });
el('profileCloseBtn').addEventListener('click', () => el('profileOverlay').hidden = true);
el('profileOverlay').addEventListener('pointerdown', (e) => { if (e.target === e.currentTarget) el('profileOverlay').hidden = true; });
if (el('speedVal')) el('speedVal').textContent = speedMult.toFixed(2) + '×';

// note theme picker
const savedTheme = localStorage.getItem('mt-theme') || 'midnight';
(function initThemes() {
  const host = el('themeBtns');
  if (!host) return;
  host.innerHTML = '';
  for (const name of Object.keys(THEMES)) {
    const b = document.createElement('button');
    b.className = 'theme-btn' + (name === savedTheme ? ' active' : '');
    b.dataset.theme = name;
    b.type = 'button';
    b.title = THEMES[name].name;
    b.style.setProperty('--g1', THEMES[name].colors[0]);
    b.style.setProperty('--g2', THEMES[name].colors[2]);
    const chip = document.createElement('span');
    chip.className = 'theme-chip';
    const lab = document.createElement('span');
    lab.className = 'theme-label';
    lab.textContent = THEMES[name].name;
    b.append(chip, lab);
    b.addEventListener('click', () => applyTheme(name));
    host.appendChild(b);
  }
  applyTheme(savedTheme);
})();

audio.ensure();

// iOS requires a user gesture to unlock AudioContext.  We listen on both
// pointer and touch events (iOS Safari only fires touchstart reliably) and
// resume + play a silent buffer to fully unlock playback.
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    const ctx = audio.ensure();
    if (ctx.state === 'suspended') ctx.resume();
    // iOS also needs an actual source to be started from a gesture
    const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  } catch (e) {}
}
window.addEventListener('pointerdown', unlockAudio, { once: true });
window.addEventListener('touchstart', unlockAudio, { once: true });
updateHUD(true);
