# TapTempo — Rhythm Arcade

A Magic Tiles 3–style rhythm game you can play right in the browser, built for
friendly competition with a shared online leaderboard.

## How to run

```bash
node server.js
```

Then open **http://localhost:3000** in your browser.

The server serves the game and hosts the leaderboard (persisted to
`leaderboard.json`). Anyone who can reach the server on your network can play
and compete on the same board.

## How to play

- **Tap keys `1`–`4`** (or the on-screen lane keys, or the canvas) as the
  colored tiles hit the horizontal line in their lane.
- Tiles right on the line are **PERFECT** (+10), slightly off are **GOOD**
  (+5). Miss them and you lose your combo.
- **HOLD** tiles (taller bright bars): press and hold your key for the whole
  length — releasing early counts as a miss.
- Your **combo** builds a **multiplier (x1→x8)** every 10 hits, feeding your
  score and **accuracy %** → your rank (S/A/B/C/D).

### Controls

| Key | Action |
|-----|--------|
| `1`–`4` | Hit lane 1–4 (hold for holds) |
| `P` | Pause / resume |
| `Esc` | Quit during play |

### Choose a song

The **cassette deck** spins as you use the **‹ ›** arrows to switch between six
procedurally generated tracks, each with its own genre accent color:

| Song | Style | BPM | Difficulty | Notes |
|------|-------|-----|------------|-------|
| Midnight Groove | Lo-fi | 92 | 1 · Easy | 64 / 8 holds |
| Neon Drive | Synthwave | 118 | 2 · Medium | 80 / 4 holds |
| Bass Drop | EDM | 128 | 3 · Hard | 144 |
| Solar Flare | Chiptune | 132 | 2 · Medium | 88 / 5 holds |
| Thunder Road | Rock/Breakbeat | 150 | 3 · Hard | 168 / 4 holds |
| Starlight Waltz | Ballad | 72 | 1 · Easy | 64 / 37 holds |

Turn on **Auto-Play Demo** to preview timing, or just use **▶ Play** to start.

### Leaderboard

Each song has its own **global leaderboard** (top 8 shown). At the end of a run
you can save your name to post your score and see where you ranked. Your best
per-song score is also remembered locally, with a **NEW RECORD** callout.

## Structure

```
server.js            Node HTTP server: static files + /api/scores leaderboard
public/
  index.html         Cassette deck, stage, scoreboard, leaderboard, overlays
  css/style.css      Cassette-deck styling, grain, flip-digit scoreboard
  js/audio.js        WebAudio synthesizer (procedural music, sample-accurate)
  js/songs.js        Song recipes + beatmap/chart generation
  js/game.js         Game loop, rendering, input, holds, scoring, leaderboard UI
```

Music, and tiles are generated from the **same** source, so the audio and note
timing are always perfectly in sync — no audio files needed.

## Notes

- Add more songs by adding entries to the `SONGS` array in `public/js/songs.js`
  (include `genre` and `accent` — `amber`, `rose`, `teal`, or `violet`).
- Add `leaderboard.json` (auto-created on first score) to `.gitignore`.
