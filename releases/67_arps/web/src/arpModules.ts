export type Ordering = "UP" | "DOWN" | "CONVERGE" | "DIVERGE" | "ALTERNATE";
export type Movement = "FORWARD" | "BACKWARD" | "PENDULUM" | "RANDOM" | "WALK";
export type Anchor = "NONE" | "LOWEST" | "HIGHEST" | "BOTH" | "ALTERNATING";
export type OctaveMode = "NONE" | "UP_1" | "UP_2" | "PINGPONG" | "RANDOM";
export type RepeatMode = "X1" | "X2" | "X3" | "X4" | "RATCHET";
export type ProbabilityMode = "NONE" | "SKIP_25" | "REPEAT_20" | "OCTAVE_20" | "MUTATE_10";
export type Neighborhood = "FREE" | "DIST_1" | "DIST_2" | "DIST_3" | "STICKY";

export interface ArpSettings {
  ordering: Ordering;
  movement: Movement;
  anchor: Anchor;
  octave: OctaveMode;
  repeat: RepeatMode;
  probability: ProbabilityMode;
  neighborhood: Neighborhood;
}

export const DEFAULT_ARP_SETTINGS: ArpSettings = {
  ordering: "UP",
  movement: "FORWARD",
  anchor: "NONE",
  octave: "NONE",
  repeat: "X1",
  probability: "NONE",
  neighborhood: "FREE"
};

export const ARP_MODULES = [
  { key: "ordering", label: "Ordering", options: ["UP", "DOWN", "CONVERGE", "DIVERGE", "ALTERNATE"] },
  { key: "movement", label: "Movement", options: ["FORWARD", "BACKWARD", "PENDULUM", "RANDOM", "WALK"] },
  { key: "anchor", label: "Anchors", options: ["NONE", "LOWEST", "HIGHEST", "BOTH", "ALTERNATING"] },
  { key: "octave", label: "Octaves", options: ["NONE", "UP_1", "UP_2", "PINGPONG", "RANDOM"] },
  { key: "repeat", label: "Repeats", options: ["X1", "X2", "X3", "X4", "RATCHET"] },
  { key: "probability", label: "Probability", options: ["NONE", "SKIP_25", "REPEAT_20", "OCTAVE_20", "MUTATE_10"] },
  { key: "neighborhood", label: "Neighborhood", options: ["FREE", "DIST_1", "DIST_2", "DIST_3", "STICKY"] }
] as const satisfies readonly {
  key: keyof ArpSettings;
  label: string;
  options: readonly string[];
}[];

export interface MidiNote {
  midi: number;
  name?: string;
}

export function applyOrdering<T>(notes: readonly T[], ordering: Ordering): T[] {
  switch (ordering) {
    case "UP":
      return notes.slice();
    case "DOWN":
      return notes.slice().reverse();
    case "CONVERGE":
      return converge(notes);
    case "DIVERGE":
      return diverge(notes);
    case "ALTERNATE":
      return notes.filter((_, index) => index % 2 === 0).concat(notes.filter((_, index) => index % 2 === 1));
  }
}

export function applyOctaves<T extends MidiNote>(notes: readonly T[], octaveMode: OctaveMode): T[] {
  switch (octaveMode) {
    case "NONE":
    case "RANDOM":
      return notes.slice();
    case "UP_1":
      return notes.slice().concat(notes.map((note) => transposeNote(note, 12)));
    case "UP_2":
      return notes
        .slice()
        .concat(notes.map((note) => transposeNote(note, 12)))
        .concat(notes.map((note) => transposeNote(note, 24)));
    case "PINGPONG": {
      if (notes.length === 0) return [];
      const octaveRoot = transposeNote(notes[0], 12);
      const descending = notes.slice(1).reverse();
      return notes.slice().concat(octaveRoot, descending);
    }
  }
}

export function applyEmissionOctave<T extends MidiNote>(note: T, octaveMode: OctaveMode, rng: () => number = Math.random): T {
  if (octaveMode !== "RANDOM") return note;
  const shift = [0, 12, 24][Math.min(2, Math.floor(rng() * 3))] ?? 0;
  return transposeNote(note, shift);
}

export function getMovementIndex(
  length: number,
  movement: Movement,
  step: number,
  rng: () => number = Math.random,
  previousIndex = 0
): number {
  if (length <= 0) return -1;
  if (length === 1) return 0;

  switch (movement) {
    case "FORWARD":
      return positiveModulo(step, length);
    case "BACKWARD":
      return length - 1 - positiveModulo(step, length);
    case "PENDULUM": {
      const period = movementCycleLength(length, movement);
      const position = positiveModulo(step, period);
      return position < length ? position : period - position;
    }
    case "RANDOM":
      return Math.min(length - 1, Math.floor(rng() * length));
    case "WALK": {
      const direction = rng() < 0.5 ? -1 : 1;
      const candidate = previousIndex + direction;
      if (candidate < 0) return 1;
      if (candidate >= length) return length - 2;
      return candidate;
    }
  }
}

export function movementCycleLength(length: number, movement: Movement): number {
  if (length <= 1) return 1;
  return movement === "PENDULUM" ? length * 2 - 2 : length;
}

export function stepAfterMovementIndex(index: number, length: number, movement: Movement): number {
  if (length <= 0) return 0;
  if (movement === "RANDOM" || movement === "WALK") return 0;

  const cycle = movementCycleLength(length, movement);
  for (let step = 0; step < cycle; step += 1) {
    if (getMovementIndex(length, movement, step, () => 0, index) === index) {
      return step + 1;
    }
  }

  return 0;
}

export function applyNeighborhood(
  candidateIndex: number,
  previousIndex: number | null | undefined,
  length: number,
  neighborhood: Neighborhood,
  rng: () => number = Math.random
): number {
  if (length <= 0) return -1;
  const candidate = clampIndex(candidateIndex, length);
  if (previousIndex === null || previousIndex === undefined || neighborhood === "FREE") return candidate;

  const previous = clampIndex(previousIndex, length);
  const delta = candidate - previous;
  const distance = Math.abs(delta);
  if (distance === 0) return candidate;

  if (neighborhood === "STICKY") {
    if (distance > 1 && rng() < 0.8) return clampIndex(previous + Math.sign(delta), length);
    return candidate;
  }

  const maxDistance = Number(neighborhood.slice(-1));
  if (distance <= maxDistance) return candidate;
  return clampIndex(previous + Math.sign(delta) * maxDistance, length);
}

export function applyAnchor<T extends MidiNote>(notes: readonly T[], anchor: Anchor, anchorEvent = 0): T[] {
  if (anchor === "NONE" || notes.length === 0) return [];

  const low = lowestNote(notes);
  const high = highestNote(notes);

  switch (anchor) {
    case "LOWEST":
      return [low];
    case "HIGHEST":
      return [high];
    case "BOTH":
      return [low, high];
    case "ALTERNATING":
      return [anchorEvent % 2 === 0 ? low : high];
  }
}

export function applyProbability<T extends MidiNote>(
  selectedNote: T,
  probability: ProbabilityMode,
  orderedPool: readonly T[] = [],
  lastEmittedNote: T | null = null,
  rng: () => number = Math.random
): T | null {
  switch (probability) {
    case "NONE":
      return selectedNote;
    case "SKIP_25":
      return rng() < 0.25 ? null : selectedNote;
    case "REPEAT_20":
      return rng() < 0.2 && lastEmittedNote ? lastEmittedNote : selectedNote;
    case "OCTAVE_20":
      return rng() < 0.2 ? transposeNote(selectedNote, 12) : selectedNote;
    case "MUTATE_10":
      if (rng() >= 0.1 || orderedPool.length <= 1) return selectedNote;
      return nearbyPoolNote(selectedNote, orderedPool, rng);
  }
}

export function repeatTickCount(repeat: RepeatMode): number {
  switch (repeat) {
    case "X1":
      return 1;
    case "X2":
    case "RATCHET":
      // The current audio engine has immediate triggers only, so ratchet falls back to a 2-tick repeat.
      return 2;
    case "X3":
      return 3;
    case "X4":
      return 4;
  }
}

export function selectArpOption(settings: ArpSettings, x: number, y: number): ArpSettings {
  const module = ARP_MODULES[x];
  const option = module?.options[y];
  if (!module || !option) return settings;
  if (settings[module.key] === option) return settings;
  return { ...settings, [module.key]: option };
}

export function reconcileArpSettingsByCluster(
  settingsByCluster: readonly ArpSettings[],
  clusterCount: number
): ArpSettings[] {
  const count = Math.max(0, Math.floor(clusterCount));
  return Array.from({ length: count }, (_, index) => settingsByCluster[index] ?? DEFAULT_ARP_SETTINGS);
}

export function findLiveTransitionIndex<T extends MidiNote>(
  currentNote: T | number | null | undefined,
  newNotes: readonly T[],
  fallbackIndex = 0
): number {
  if (newNotes.length === 0) return 0;
  const currentMidi = typeof currentNote === "number" ? currentNote : currentNote?.midi;
  if (currentMidi !== undefined) {
    const exact = newNotes.findIndex((note) => note.midi === currentMidi);
    if (exact >= 0) return exact;

    const pitchClass = positiveModulo(currentMidi, 12);
    const equivalent = newNotes.findIndex((note) => positiveModulo(note.midi, 12) === pitchClass);
    if (equivalent >= 0) return equivalent;
  }

  return positiveModulo(fallbackIndex, newNotes.length);
}

export function buildArpPool<T extends MidiNote>(notes: readonly T[], settings: ArpSettings): T[] {
  return applyOctaves(applyOrdering(notes, settings.ordering), settings.octave);
}

function converge<T>(notes: readonly T[]): T[] {
  const result: T[] = [];
  let left = 0;
  let right = notes.length - 1;

  while (left <= right) {
    result.push(notes[left]);
    if (left !== right) result.push(notes[right]);
    left += 1;
    right -= 1;
  }

  return result;
}

function diverge<T>(notes: readonly T[]): T[] {
  const result: T[] = [];
  if (notes.length === 0) return result;

  if (notes.length % 2 === 0) {
    let left = notes.length / 2 - 1;
    let right = notes.length / 2;
    while (left >= 0 || right < notes.length) {
      if (left >= 0) result.push(notes[left]);
      if (right < notes.length) result.push(notes[right]);
      left -= 1;
      right += 1;
    }
    return result;
  }

  const center = Math.floor(notes.length / 2);
  result.push(notes[center]);
  let left = center - 1;
  let right = center + 1;
  while (left >= 0 || right < notes.length) {
    if (left >= 0) result.push(notes[left]);
    if (right < notes.length) result.push(notes[right]);
    left -= 1;
    right += 1;
  }
  return result;
}

function nearbyPoolNote<T extends MidiNote>(selectedNote: T, orderedPool: readonly T[], rng: () => number): T {
  const index = orderedPool.findIndex((note) => note.midi === selectedNote.midi);
  if (index < 0) return orderedPool[Math.min(orderedPool.length - 1, Math.floor(rng() * orderedPool.length))];

  const candidates = [orderedPool[index - 1], orderedPool[index + 1]].filter((note): note is T => Boolean(note));
  if (candidates.length === 0) return selectedNote;
  return candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))];
}

function lowestNote<T extends MidiNote>(notes: readonly T[]): T {
  return notes.reduce((lowest, note) => note.midi < lowest.midi ? note : lowest, notes[0]);
}

function highestNote<T extends MidiNote>(notes: readonly T[]): T {
  return notes.reduce((highest, note) => note.midi > highest.midi ? note : highest, notes[0]);
}

function transposeNote<T extends MidiNote>(note: T, semitones: number): T {
  if (semitones === 0) return note;
  const midi = note.midi + semitones;
  const next = { ...note, midi };
  if (note.name) {
    return { ...next, name: midiName(midi, note.name.includes("b")) } as T;
  }
  return next as T;
}

function midiName(midi: number, preferFlats = false): string {
  const sharpNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const flatNames = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  const pc = positiveModulo(midi, 12);
  const octave = Math.floor(midi / 12) - 1;
  return `${preferFlats ? flatNames[pc] : sharpNames[pc]}${octave}`;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length - 1, Math.round(index)));
}
