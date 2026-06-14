export interface ParsedNote {
  midi: number;
  name: string;
}

export interface NoteCluster {
  source: string;
  notes: ParsedNote[];
}

export interface ParseError {
  token: string;
  reason: string;
}

export interface ParseResult {
  clusters: NoteCluster[];
  errors: ParseError[];
  truncated: string[];
}

const NOTE_TO_PC: Record<string, number> = {
  c: 0,
  "c#": 1,
  db: 1,
  d: 2,
  "d#": 3,
  eb: 3,
  e: 4,
  fb: 4,
  "e#": 5,
  f: 5,
  "f#": 6,
  gb: 6,
  g: 7,
  "g#": 8,
  ab: 8,
  a: 9,
  "a#": 10,
  bb: 10,
  b: 11,
  cb: 11,
  "b#": 0
};

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

const CHORD_INTERVALS: Record<string, number[]> = {
  "": [0, 4, 7],
  m: [0, 3, 7],
  min: [0, 3, 7],
  "7": [0, 4, 7, 10],
  M: [0, 4, 7],
  maj: [0, 4, 7],
  M7: [0, 4, 7, 11],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  min7: [0, 3, 7, 10],
  "6": [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  sus: [0, 5, 7],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8]
};

export function parseClusterText(input: string, maxClusters = 16): ParseResult {
  const tokens = tokenizeClusters(input);
  const clusters: NoteCluster[] = [];
  const errors: ParseError[] = [];
  const truncated: string[] = [];
  let previousClusterLastMidi: number | null = null;

  for (const token of tokens) {
    const parsed = parseToken(token, previousClusterLastMidi);
    if (!parsed) {
      errors.push({ token, reason: "not a supported note cluster or chord" });
      continue;
    }

    if (clusters.length >= maxClusters) {
      truncated.push(token);
      continue;
    }

    clusters.push(parsed);
    previousClusterLastMidi = parsed.notes.at(-1)?.midi ?? previousClusterLastMidi;
  }

  return { clusters, errors, truncated };
}

function tokenizeClusters(input: string): string[] {
  const tokens: string[] = [];
  let token = "";

  const push = () => {
    const trimmed = token.trim();
    if (trimmed) tokens.push(trimmed);
    token = "";
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (/\s|,/.test(char)) {
      push();
      continue;
    }

    token += char;
  }

  push();
  return tokens;
}

export function parseToken(token: string, previousClusterLastMidi: number | null = null): NoteCluster | null {
  return parseChord(token, previousClusterLastMidi) ?? parseCompactNotes(token, previousClusterLastMidi);
}

function parseChord(token: string, previousClusterLastMidi: number | null): NoteCluster | null {
  const match = /^([A-Ga-g])([#b]?)(maj7|maj|min7|min|sus2|sus4|sus|dim|aug|M7|M|m7|m6|m|7|6)?(?:;([0-9]))?$/.exec(token);
  if (!match) return null;

  const [, letter, accidental = "", suffix = "", octaveText] = match;
  const rootKey = `${letter.toLowerCase()}${accidental.toLowerCase()}`;
  const rootPc = NOTE_TO_PC[rootKey];
  const intervals = CHORD_INTERVALS[suffix];
  if (rootPc === undefined || !intervals) return null;

  const preferFlats = accidental === "b" || suffix.includes("m") || suffix === "dim";
  const rootMidi = octaveText
    ? 12 * (Number(octaveText) + 1) + rootPc
    : inferredChordRootMidi(rootPc, intervals, previousClusterLastMidi);
  const notes = intervals.map((interval) => midiNote(rootMidi + interval, preferFlats));
  if (notes.some((note) => note.midi < 0 || note.midi > 127)) return null;

  return {
    source: token,
    notes
  };
}

function parseCompactNotes(token: string, previousClusterLastMidi: number | null): NoteCluster | null {
  const parts: Array<{ pc: number; octaveText: string; preferFlats: boolean }> = [];
  const notes: ParsedNote[] = [];
  let index = 0;

  while (index < token.length) {
    const letter = token[index];
    if (!/[a-gA-G]/.test(letter)) return null;
    index += 1;

    let accidental = "";
    if (token[index] === "#" || token[index] === "b") {
      accidental = token[index];
      index += 1;
    }

    let octaveText = "";
    while (/[0-9]/.test(token[index] ?? "")) {
      octaveText += token[index];
      index += 1;
    }

    const key = `${letter.toLowerCase()}${accidental.toLowerCase()}`;
    const pc = NOTE_TO_PC[key];
    if (pc === undefined) return null;

    parts.push({ pc, octaveText, preferFlats: accidental === "b" });
  }

  if (parts.length > 0 && previousClusterLastMidi !== null && parts.every((part) => !part.octaveText)) {
    let nextMidi: number | null = previousClusterLastMidi;
    const anchored = Array<ParsedNote>(parts.length);

    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      const midi = closestMidi(part.pc, nextMidi);
      if (midi < 0 || midi > 127) return null;
      anchored[partIndex] = midiNote(midi, part.preferFlats);
      nextMidi = midi;
    }

    return { source: token, notes: anchored };
  }

  let previousMidi = previousClusterLastMidi;
  for (const part of parts) {
    const octave: number = part.octaveText ? Number(part.octaveText) : closestOctave(part.pc, previousMidi);
    const midi: number = 12 * (octave + 1) + part.pc;
    if (midi < 0 || midi > 127) return null;
    previousMidi = midi;
    notes.push(midiNote(midi, part.preferFlats));
  }

  return notes.length ? { source: token, notes } : null;
}

function closestOctave(pc: number, previousMidi: number | null): number {
  if (previousMidi === null) return 4;

  let bestOctave = 4;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let octave = 0; octave <= 9; octave += 1) {
    const midi = 12 * (octave + 1) + pc;
    const distance = Math.abs(midi - previousMidi);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestOctave = octave;
    }
  }
  return bestOctave;
}

function closestMidi(pc: number, previousMidi: number | null): number {
  const octave = closestOctave(pc, previousMidi);
  return 12 * (octave + 1) + pc;
}

function inferredChordRootMidi(rootPc: number, intervals: number[], previousMidi: number | null): number {
  if (previousMidi === null) return 60 + rootPc;

  const topInterval = intervals.at(-1) ?? 0;
  const topPc = (rootPc + topInterval) % 12;
  return closestMidi(topPc, previousMidi) - topInterval;
}

function midiNote(midi: number, preferFlats = false): ParsedNote {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const name = `${preferFlats ? FLAT_NAMES[pc] : SHARP_NAMES[pc]}${octave}`;
  return { midi, name };
}
