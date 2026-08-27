// Song definitions. Each song's music (steps) and gameplay chart are
// generated from the SAME source, so tiles always match the sound.
//
// Steps are arrays of length (beats * stepsPerBeat). Each step cell:
//   { kick, snare, hat, notes:[{freq,dur,vol,type}], bass:freq }
// The perpendicular-tiles chart is derived from the melody notes and
// bass rhythm: each audible "hit" becomes a tile in a column.
import { AudioEngine } from './audio.js';

const N = AudioEngine.n;

// ---- step helpers ----
function stepsFactory(stepsPerBeat, beats) {
  const arr = new Array(beats * stepsPerBeat).fill(null);
  const set = (beat, t, cell) => {
    const i = beat * stepsPerBeat + t;
    if (i < arr.length) arr[i] = { ...(arr[i] || {}), ...cell };
  };
  return { arr, set, len: beats * stepsPerBeat };
}

// Build a song from a "recipe".
// recipe: { bpm, spp, beats, prog:[chord arrays of root/notes], groove, level }
// level: 0 = Easy (no holds), 1 = Normal, 2 = Hard (adds audible 16th runs)
function buildRecipe(recipe) {
  const { bpm, spp, beats, prog, level = 1 } = recipe;
  const s = stepsFactory(spp, beats);

  for (let beat = 0; beat < beats; beat++) {
    const bar = Math.floor(beat / 4);
    const b = beat % 4;
    const chord = prog[bar % prog.length];
    const base = beat * spp;

    // drums (4-on-floor kick, snare on beats 1&3)
    s.set(beat, 0, { kick: b === 0 || b === 2 ? true : undefined });
    if (b === 1 || b === 3) {
      s.set(beat, 0, { snare: true });
      // clear the kick on snare beats to avoid doubling
      s.arr[base] = s.arr[base] && { ...s.arr[base], kick: undefined };
    }
    // 8th-note hats
    s.set(beat, spp === 2 ? 1 : 0, { hat: true });

    // bass on the beat
    s.set(beat, 0, { bass: chord[0], bassDur: 0.38 });

    // melody: one note per beat, cycling the chord's upper triads
    // some beats hold the note (a sustained "hold" tile)
    const mnotes = chord.slice(1);
    const mel = mnotes[(b + bar * 2) % mnotes.length];
    const isHold = level > 0 && recipe.holds
      ? recipe.holds.some((h) =>
          h[0] === bar && h[1] === b)
      : false;
    const melDur = isHold ? recipe.holdDur || 0.9 : 0.18;
    s.set(beat, 0, { notes: [{ freq: mel, dur: melDur, vol: isHold ? 0.2 : 0.16, type: 'square' }] });
  }

  if (level >= 2) addHardLayer(s, spp);

  // clean up undefined keys (from the undefined:true pattern above)
  for (let i = 0; i < s.arr.length; i++) {
    const c = s.arr[i];
    if (c) Object.keys(c).forEach((k) => { if (c[k] === undefined) delete c[k]; });
  }
  return s;
}

// On Hard, add an audible offbeat layer: an octave-up sparkle trailing each
// on-beat note, creating flowing eighth-note streams. Both the audio and the
// tile for these live in the same step cell, so tiles always match the sound.
function addHardLayer(s, spp) {
  for (let i = 1; i < s.arr.length; i++) {
    if (i % spp !== 1) continue;          // only the offbeat sub-step
    const prev = s.arr[i - 1];
    if (!prev) continue;                  // need a preceding beat to trail
    const cell = s.arr[i];
    if (cell && cell.notes && cell.notes.length) continue;
    if (cell && cell.bass) continue;
    const f = (prev.notes && prev.notes[0] && prev.notes[0].freq) || prev.bass || 220;
    s.arr[i] = { ...(s.arr[i] || {}), notes: [{ freq: f * 2, dur: 0.12, vol: 0.12, type: 'square' }] };
  }
}

// Difficulty labels + rank -> stars mapping (shared with game.js)
export const LEVELS = ['Easy', 'Normal', 'Hard'];
export function starsFor(rank) {
  if (rank === 'S') return 3;
  if (rank === 'A') return 2;
  if (rank === 'B') return 1;
  return 0;
}

export const SONGS = [
  {
    id: 'chillhop',
    title: 'Midnight Groove',
    artist: 'Lo-fi · 92 BPM',
    genre: 'Lo-fi',
    accent: 'amber',
    bpm: 92,
    stepsPerBeat: 2,
    difficulty: 1,
    build(level = 1) {
      return buildRecipe({
        bpm: this.bpm, spp: this.stepsPerBeat, beats: 64, level,
        prog: [
          [N('A2'), N('C4'), N('E4'), N('A4')],
          [N('F2'), N('A3'), N('C4'), N('F4')],
          [N('C3'), N('G3'), N('E4'), N('G4')],
          [N('G2'), N('B3'), N('D4'), N('G4')],
        ],
        holds: [[1,1],[1,3],[3,1],[3,3],[5,1],[5,3],[7,1],[7,3]],
        holdDur: 1.7,
      }).arr;
    },
  },
  {
    id: 'synthwave',
    title: 'Neon Drive',
    artist: 'Synth · 118 BPM',
    genre: 'Synthwave',
    accent: 'violet',
    bpm: 118,
    stepsPerBeat: 2,
    difficulty: 2,
    build(level = 1) {
      const s = buildRecipe({
        bpm: this.bpm, spp: this.stepsPerBeat, beats: 80, level,
        prog: [
          [N('D2'), N('D4'), N('F#4'), N('A4')],
          [N('A2'), N('A3'), N('C#4'), N('E4')],
          [N('B2'), N('D4'), N('F#4'), N('B4')],
          [N('G2'), N('B3'), N('D4'), N('F#4')],
        ],
        holds: [[1,0],[1,2],[4,0],[4,2],[7,0],[7,2]],
        holdDur: 1.9,
      });
      // double 16th-note runs every few bars for energy (synthwave lead)
      if (level > 0) {
        for (let bar = 4; bar < 20; bar += 8) {
          const start = bar * 4;
          const runNotes = [N('A5'), N('B5'), N('C#6'), N('D6')];
          for (let i = 0; i < 8; i++) {
            const beat = start + i / 2;
            const t = (i % 2 === 0) ? 0 : 1;
            const step = Math.round(beat * this.stepsPerBeat) + t;
            if (step < s.arr.length) {
              const freq = runNotes[Math.min(i, runNotes.length - 1)];
              s.arr[step] = { ...(s.arr[step] || {}),
                notes: [{ freq, dur: 0.12, vol: 0.18, type: 'sawtooth' }] };
            }
          }
        }
      }
      return s.arr;
    },
  },
  {
    id: 'bassdrop',
    title: 'Bass Drop',
    artist: 'EDM · 128 BPM',
    genre: 'EDM',
    accent: 'teal',
    bpm: 128,
    stepsPerBeat: 2,
    difficulty: 3,
    build(level = 1) {
      const s = stepsFactory(this.stepsPerBeat, 72);
      const penta = [N('A1'), N('C2'), N('E2'), N('G2'), N('C3')];
      for (let beat = 0; beat < 72; beat++) {
        const base = beat * this.stepsPerBeat;
        // heavy 4-on-floor
        s.set(beat, 0, { kick: beat % 2 === 0 ? true : undefined });
        if (beat % 4 === 2) s.set(beat, 0, { snare: true });
        s.set(beat, 1, { hat: true });
        // driving bass eighth notes
        const noteIdx = (beat / 2) % penta.length;
        s.set(beat, 0, { bass: penta[Math.floor(noteIdx)], bassDur: 0.22 });
        s.set(beat, 1, { bass: penta[Math.floor(noteIdx) + 1 < penta.length ? Math.floor(noteIdx) + 1 : penta.length - 1], bassDur: 0.15 });
        // stabby lead
        if (beat % 2 === 0) {
          const freq = [N('A4'), N('C5'), N('E5')][Math.floor(beat / 4) % 3];
          s.set(beat, 0, { notes: [{ freq, dur: 0.16, vol: 0.2, type: 'sawtooth' }] });
        }
      }
      if (level >= 2) addHardLayer(s, this.stepsPerBeat);
      for (let i = 0; i < s.arr.length; i++) {
        const c = s.arr[i];
        if (c) Object.keys(c).forEach((k) => { if (c[k] === undefined) delete c[k]; });
      }
      return s.arr;
    },
  },
  {
    id: 'solarflare',
    title: 'Solar Flare',
    artist: 'Chiptune · 132 BPM',
    genre: 'Chiptune',
    accent: 'amber',
    bpm: 132,
    stepsPerBeat: 2,
    difficulty: 2,
    build(level = 1) {
      const s = buildRecipe({
        bpm: this.bpm, spp: this.stepsPerBeat, beats: 76, level,
        prog: [
          [N('C3'), N('C4'), N('E4'), N('G4')],
          [N('A2'), N('C4'), N('E4'), N('A4')],
          [N('F2'), N('A3'), N('C4'), N('F4')],
          [N('G2'), N('B3'), N('D4'), N('G4')],
        ],
        holds: [[0,0],[0,2],[2,0],[5,1],[5,3],[7,2]],
        holdDur: 1.3,
      });
      // sparkly 16th runs
      if (level > 0) {
        for (let bar = 2; bar < 19; bar += 6) {
          const startBar = bar * 4;
          const scale = [N('C5'), N('E5'), N('G5'), N('C6'), N('E6')];
          for (let i = 0; i < 8; i++) {
            const beat = startBar + i / 2;
            const step = Math.round(beat * this.stepsPerBeat);
            if (step < s.arr.length) {
              s.arr[step] = { ...(s.arr[step] || {}),
                notes: [{ freq: scale[i % scale.length], dur: 0.1, vol: 0.14, type: 'square' }] };
            }
          }
        }
      }
      return s.arr;
    },
  },
  {
    id: 'thunder',
    title: 'Thunder Road',
    artist: 'Rock · 150 BPM',
    genre: 'Rock/Breakbeat',
    accent: 'rose',
    bpm: 150,
    stepsPerBeat: 2,
    difficulty: 3,
    build(level = 1) {
      const s = buildRecipe({
        bpm: this.bpm, spp: this.stepsPerBeat, beats: 84, level,
        prog: [
          [N('E2'), N('E4'), N('G4'), N('B4')],
          [N('C2'), N('C4'), N('E4'), N('G4')],
          [N('G2'), N('G3'), N('B3'), N('D4')],
          [N('A2'), N('A3'), N('C#4'), N('E4')],
        ],
        holds: [[1,0],[2,2],[5,0],[6,2]],
        holdDur: 0.8,
      });
      // power-chord palm-mute chug on high steps for a rock feel
      if (level > 0) {
        for (let beat = 0; beat < 84; beat++) {
          const base = beat * this.stepsPerBeat;
          if (base + 0 < s.arr.length) {
            const chugFreq = [N('E3'), N('C3'), N('G3'), N('A3')][Math.floor(beat / 4) % 4];
            s.set(beat, 1, { bass: chugFreq, bassDur: 0.12 });
          }
        }
      }
      return s.arr;
    },
  },
  {
    id: 'starlight',
    title: 'Starlight Waltz',
    artist: 'Ballad · 72 BPM',
    genre: 'Ballad',
    accent: 'teal',
    bpm: 72,
    stepsPerBeat: 2,
    difficulty: 1,
    build(level = 1) {
      const s = buildRecipe({
        bpm: this.bpm, spp: this.stepsPerBeat, beats: 64, level,
        prog: [
          [N('C3'), N('E4'), N('G4'), N('C5')],
          [N('F2'), N('F4'), N('A4'), N('C5')],
          [N('G2'), N('G4'), N('B4'), N('D5')],
          [N('C3'), N('E4'), N('G4'), N('C5')],
        ],
        holds: [[0,0],[0,2],[1,1],[2,0],[2,2],[3,1],[4,0]],
        holdDur: 2.5,
      });
      // add gentle sustained arps on the offbeat for waltz feel
      if (level > 0) {
        for (let beat = 0; beat < 64; beat++) {
          const base = beat * this.stepsPerBeat;
          if (beat % 2 === 1 && base < s.arr.length) {
            const arp = [N('E5'), N('C5'), N('A4'), N('G5')][Math.floor(beat / 2) % 4];
            s.set(beat, 0, { notes: [{ freq: arp, dur: 0.6, vol: 0.1, type: 'sine' }] });
          }
        }
      }
      return s.arr;
    },
  },
];

// Build gameplay chart from a song's step data.
// Notes are assigned to columns with a flowing pattern so consecutive
// tiles move across adjacent lanes (perpendicular flow). Hold notes
// reserve their lane for the hold duration so no tap collides with them.
export function buildChart(song, steps) {
  const spp = song.stepsPerBeat;
  const beatDur = 60 / song.bpm;
  const stepDur = beatDur / spp;
  const cols = 4;
  const notes = [];

  let lastCol = -1;
  let dir = 1;
  const reservedUntil = new Array(cols).fill(-1); // per-lane time until which it's busy

  steps.forEach((cell, i) => {
    if (!cell) return;
    if (!cell.notes && !cell.bass) return;

    const time = i * stepDur;
    const melNote = cell.notes && cell.notes[0];
    const isHold = melNote && melNote.dur >= 0.35;
    const holdUntil = isHold ? time + melNote.dur * beatDur : time;

    // choose a lane: prefer adjacent to the last used one, but not a held lane
    let col = -1;
    for (let t = 0; t < cols; t++) {
      const c = ((lastCol + 1 + t) % cols);
      if (reservedUntil[c] <= time) { col = c; break; }
    }
    if (col === -1) {
      for (let c = 0; c < cols; c++) if (reservedUntil[c] <= time) { col = c; break; }
    }
    if (col === -1) col = (lastCol + 1) % cols;

    if (isHold) reservedUntil[col] = holdUntil + 0.05;
    lastCol = col;

    notes.push({
      time,
      col,
      mel: !!(cell.notes && cell.notes.length),
      type: isHold ? 'hold' : 'tap',
      dur: isHold ? melNote.dur * beatDur : 0,
    });
  });
  return notes;
}
