# AGENTS.md

## Project

This folder is a Vite + React + TypeScript browser app for a monome grid arpeggiator.

The app lives in `web/` and vendors/adapts browser-side grid serial and WebAudio code from `reference/grid-hello`. Treat everything under `reference/` as read-only unless the user explicitly asks to change the reference material.

## Commands

- Install dependencies: `npm install`
- Parser tests: `npm test`
- Production/type check: `npm run build`
- Dev server: `npm run dev`

Do not start a dev server unless the user explicitly asks for it.

## Implementation Notes

- `src/App.tsx` owns React state, grid LED levels, and the arpeggiator clock.
- `src/gridSerial.ts` owns Web Serial connection, size reports, key packets, LED clearing, varibright frame packing, queued drawing, and hardware LED level mapping.
- `src/audioEngine.ts` owns WebAudio setup and synth voice parameters.
- `src/noteParser.ts` owns note, chord, chord octave, and cluster octave inference behavior.
- Parser regressions belong in `tests/noteParser.test.ts`.

## Behavior To Preserve

- Only bottom-row grid keys select clusters.
- Chord changes are queued and commit on the next eighth-note tick.
- Explicit chord octave syntax like `Cmaj7;3` means the chord root starts at octave 3.
- Semicolons are not cluster separators; use spaces, commas, or newlines between clusters.
- Compact note clusters with no octave anchor their final note near the previous cluster's final note to avoid octave drift.
- `node_modules/` and `dist/` are local build artifacts and should not be committed.
