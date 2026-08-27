// AudioEngine: procedurally synthesizes music via WebAudio.
// Each song has a tempo, scale, and a sequence of chord/note events.
// The scheduler uses lookahead to stay sample-accurate so the tiles
// (beatmap notes) stay in sync with what you hear.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.volume = 0.5;
    this.current = null;
    this.importSrc = null;
  }

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    this.muted = this.volume === 0;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }

  toggleMute() {
    this.setVolume(this.muted && this.volume === 0 ? 0.5 : this.muted ? 0.5 : 0);
  }

  pause() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  start(song, opts = {}) {
    const ctx = this.ensure();
    this.stop();
    const beatDur = 60 / song.bpm;
    const beatTime = ctx.currentTime + 0.05;

    this.current = {
      song,
      bpm: song.bpm,
      beatDur,
      steps: song.build(),
      nextStep: 0,
      nextEventTime: beatTime,
    };
    return beatTime;
  }

  // Called every frame with current audio time; schedules beats slightly ahead.
  schedule(stepsAhead = 4) {
    const c = this.current;
    if (!c) return;
    const ctx = this.ctx;
    const stepDur = c.beatDur / c.song.stepsPerBeat;

    while (c.nextEventTime < ctx.currentTime + stepsAhead * stepDur) {
      const beat = c.nextStep / c.song.stepsPerBeat;
      this.playStep(c.steps, c.nextStep, c.nextEventTime);
      if (c.nextStep % c.song.stepsPerBeat === 0) {
        // beat tick (unused for now)
      }
      c.nextStep++;
      c.nextEventTime += stepDur;
    }
  }

  playStep(steps, step, time) {
    const s = steps;
    const idx = step % s.length;
    const cell = s[idx];
    if (!cell) return;
    const ctx = this.ctx;

    if (cell.kick) this.kick(time);
    if (cell.snare) this.snare(time);
    if (cell.hat) this.hat(time);

    if (cell.notes) {
      for (const n of cell.notes) {
        this.melody(time, n.freq || n, n.dur || 0.18, n.vol || 0.18, n.type);
      }
    }
    if (cell.bass) {
      this.bass(time, cell.bass, cell.bassDur || 0.2);
    }
  }

  // ---- instruments ----
  tone(time, freq, dur, type, vol, glide) {
    if (!Number.isFinite(freq) || freq <= 0) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type || 'square';
    osc.frequency.setValueAtTime(freq, time);
    if (glide) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, glide), time + dur);
    }
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(vol, time + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(g).connect(this.master);
    osc.start(time);
    osc.stop(time + dur + 0.05);
  }

  kick(time) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(40, time + 0.12);
    g.gain.setValueAtTime(0.7, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.22);
    osc.connect(g).connect(this.master);
    osc.start(time);
    osc.stop(time + 0.3);
  }

  snare(time) {
    const ctx = this.ctx;
    const bufferSize = ctx.sampleRate * 0.2;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 2.5);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.4, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.18);
    src.connect(g).connect(this.master);
    src.start(time);
  }

  hat(time) {
    const ctx = this.ctx;
    const bufferSize = ctx.sampleRate * 0.05;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 3);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.04);
    src.connect(hp).connect(g).connect(this.master);
    src.start(time);
  }

  bass(time, freq, dur) {
    this.tone(time, freq, dur, 'triangle', 0.3);
  }

  melody(time, freq, dur, vol, type) {
    this.tone(time, freq, dur, type || 'square', vol || 0.16);
  }

  stop() {
    if (this.current) {
      this.current = null;
    }
    this.stopImported();
  }

  // Play a decoded AudioBuffer (imported user track) looped through the master
  // gain, so mute/volume/pause all keep working. No beatmap is associated, so
  // game.js schedules a generated play-along chart independently.
  playBuffer(buffer, loop = true) {
    const ctx = this.ensure();
    this.stopImported();
    if (this.current) { this.current = null; }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = loop;
    const g = ctx.createGain();
    g.gain.value = 0.7;
    src.connect(g).connect(this.master);
    src.start();
    this.importSrc = src;
    this.importGain = g;
  }

  stopImported() {
    if (this.importSrc) {
      try { this.importSrc.stop(); } catch (e) {}
      this.importSrc = null;
      this.importGain = null;
    }
  }

  // A simple note frequency helper (used when building songs)
  static n(name) {
    const semis = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
    const m = name.match(/^([A-G][#b]?)(\d)$/);
    if (!m) return 0;
    const midi = semis[m[1]] + (parseInt(m[2]) + 1) * 12 + 12;
    return 440 * Math.pow(2, (midi - 69) / 12);
  }
}

// Analyze an AudioBuffer to find musical onsets (transients like kicks, snares,
// plucks) plus a per-frame energy envelope. Works fully in-browser, no server.
// Returns { onsets:[seconds], energy:Float64Array per ~11.6ms hop, hop, sr, peak }.
export function analyzeAudio(buffer) {
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const chs = Math.max(1, buffer.numberOfChannels);

  // downmix to mono
  const mono = new Float32Array(len);
  for (let c = 0; c < chs; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[i] / chs;
  }

  // short-time RMS energy in ~512-sample hops (frame 2048 for smoothing)
  const hop = 512;
  const frame = 2048;
  const frames = Math.max(1, Math.floor((len - frame) / hop) + 1);
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    let s = 0;
    const e = Math.min(frame, len - o);
    for (let i = 0; i < e; i++) s += mono[o + i] * mono[o + i];
    energy[f] = Math.sqrt(s / frame);
  }

  // onset strength = positive spectral/energy flux
  let fluxMax = 0;
  const flux = new Float64Array(frames);
  for (let f = 1; f < frames; f++) {
    flux[f] = Math.max(0, energy[f] - energy[f - 1]);
    if (flux[f] > fluxMax) fluxMax = flux[f];
  }

  // adaptive threshold: local mean over ~0.3s window, scaled
  const win = Math.max(1, Math.floor(0.3 * sr / hop));
  const thresh = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let m = 0, n = 0;
    for (let w = f - win; w <= f + win; w++) {
      if (w >= 0 && w < frames) { m += flux[w]; n++; }
    }
    thresh[f] = (m / n) * 2.1;
  }

  // detect peaks in flux above the adaptive threshold (with refractory)
  const onsets = [];
  const refractory = 0.06; // seconds — no two hits closer than this
  let last = -1e9;
  for (let f = 2; f < frames - 1; f++) {
    if (flux[f] > thresh[f] && flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1]) {
      const t = f * hop / sr;
      if (t - last > refractory) { onsets.push(t); last = t; }
    }
  }

  return { onsets, energy, hop, sr, peak: fluxMax, duration: buffer.duration };
}

// Estimate tempo (BPM, 60..180) from a set of onset timestamps using a folded
// inter-onset-interval scoring, then compute the best beat period in seconds.
export function estimateBpm(onsets) {
  if (!onsets || onsets.length < 4) return 120;
  // collect adjacent+ tempo-related intervals (up to 4 beats apart, within range)
  const diffs = [];
  for (let i = 0; i < onsets.length; i++) {
    for (let j = i + 1; j < Math.min(onsets.length, i + 6); j++) {
      const d = onsets[j] - onsets[i];
      if (d < 0.35 || d > 2.0) continue; // only 30..170bpm candidates
      diffs.push(d);
    }
  }
  if (!diffs.length) return 120;
  let best = 120, bestScore = -1;
  // score each candidate period by how many diffs are integer multiples of it
  for (let bpm = 60; bpm <= 180; bpm += 0.5) {
    const period = 60 / bpm;
    let score = 0;
    for (const d of diffs) {
      const mult = Math.round(d / period);
      const err = Math.abs(d - mult * period);
      if (mult >= 1 && err < period * 0.2) score += 1 / (1 + Math.abs(mult - 1) * 0.5);
    }
    if (score > bestScore) { bestScore = score; best = bpm; }
  }
  return Math.round(best);
}
