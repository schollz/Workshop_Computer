import { makeGridLevels, type GridLevels } from "./gridSerial";

export type PitterMode = "NOTE" | "SEQUENCE";
export type PitterDirection = "BACKWARD" | "PINGPONG" | "RANDOM" | "FORWARD";
export type PitterCell = 0 | 1 | 2;

export interface PitterTrack {
  id: number;
  patterns: PitterCell[][][];
  activePattern: number;
  chain: number[];
  chainStep: number;
  chainColumn: number;
  step: number;
  movement: 1 | -1;
  noteOffset: number;
  direction: PitterDirection;
  divisionIndex: number;
  length: number;
  muted: boolean;
  monophonic: boolean;
  probability: number;
  velocityProfileIndex: number;
}

export interface PitterState {
  mode: PitterMode;
  playing: boolean;
  activeTrack: number;
  tracks: PitterTrack[];
  pressed: Record<string, number>;
}

export interface PitterNoteEvent {
  trackId: number;
  midi: number;
  velocity: number;
  step: number;
  noteIndex: number;
  divisionIndex: number;
  gateSteps: number;
}

export const PITTER_TRACK_COUNT = 4;
export const PITTER_PATTERN_COUNT = 16;
export const PITTER_STEP_COUNT = 64;
export const PITTER_NOTE_COUNT = 42;
export const PITTER_VISIBLE_NOTES = 7;
export const PITTER_DIVISIONS = [4, 2, 1, 1 / 2, 1 / 4, 1 / 8, 1 / 16, 1 / 32] as const;
export const PITTER_DIVISION_LABELS = ["4 beats", "2 beats", "1 beat", "1/2", "1/4", "1/8", "1/16", "1/32"] as const;
export const PITTER_DIRECTIONS: PitterDirection[] = ["BACKWARD", "PINGPONG", "RANDOM", "FORWARD"];
const PITTER_PLAY_COL = 11;
const PITTER_MUTE_COL = 12;
const PITTER_VIEW_DOWN_COL = 13;
const PITTER_VIEW_UP_COL = 14;

const ROOT_MIDI = 48;
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const VELOCITY_PROFILES = [
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
  [1, 0, 1, 0, 1, 0],
  [1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1],
  [0, 0, 1, 0, 0, 1, 0, 0],
  [1, 1, 0, 1, 1, 0, 1, 0]
] as const;

export function createDefaultPitterState(): PitterState {
  return {
    mode: "NOTE",
    playing: true,
    activeTrack: 0,
    tracks: Array.from({ length: PITTER_TRACK_COUNT }, (_, index) => createDefaultTrack(index)),
    pressed: {}
  };
}

export function normalizePitterState(value: unknown): PitterState {
  if (!isRecord(value)) return createDefaultPitterState();
  const defaults = createDefaultPitterState();
  const tracksValue = Array.isArray(value.tracks) ? value.tracks : [];

  return {
    mode: value.mode === "SEQUENCE" ? "SEQUENCE" : "NOTE",
    playing: typeof value.playing === "boolean" ? value.playing : defaults.playing,
    activeTrack: boundedInteger(value.activeTrack, 0, PITTER_TRACK_COUNT - 1, defaults.activeTrack),
    tracks: Array.from({ length: PITTER_TRACK_COUNT }, (_, index) => normalizeTrack(tracksValue[index], index)),
    pressed: {}
  };
}

export function handlePitterGridKey(
  state: PitterState,
  x: number,
  y: number,
  down: boolean,
  nowMs: number,
  cols = 16,
  rows = 8
): PitterState {
  if (x < 0 || y < 0 || x >= cols || y >= rows) return state;
  const bottom = rows - 1;
  const right = cols - 1;
  const key = `${x},${y}`;
  const pressed = { ...state.pressed };
  let next = clonePitterState(state);

  if (down) {
    pressed[key] = nowMs;
  } else {
    delete pressed[key];
  }
  next.pressed = pressed;

  if (down && y === bottom && x === PITTER_PLAY_COL) {
    return { ...next, playing: !state.playing };
  }

  if (down && y === bottom && x === PITTER_MUTE_COL) {
    return updateActiveTrack(next, (track) => ({ ...track, muted: !track.muted }));
  }

  if (down && y === bottom && x === PITTER_VIEW_DOWN_COL) {
    return updateActiveTrack(next, (track) => ({ ...track, noteOffset: positiveModulo(track.noteOffset - 1, PITTER_NOTE_COUNT) }));
  }

  if (down && y === bottom && x === PITTER_VIEW_UP_COL) {
    return updateActiveTrack(next, (track) => ({ ...track, noteOffset: positiveModulo(track.noteOffset + 1, PITTER_NOTE_COUNT) }));
  }

  if (state.mode === "SEQUENCE") {
    if (down && y < bottom) {
      next = updateActiveTrack(next, (track) => {
        const chain = track.chain.slice();
        chain[x] = chain[x] === y ? -1 : y;
        return { ...track, chain };
      });
    } else if (down && y === bottom && x < right && !isBottomControlColumn(x)) {
      next = updateActiveTrack(next, (track) => ({ ...track, activePattern: x, chainStep: 0, chainColumn: x }));
    } else if (!down && y === bottom && x === right) {
      next = { ...next, mode: "NOTE" };
    }
    return next;
  }

  if (down && y === bottom && x < right) {
    return updateActiveTrack(next, (track) => toggleKeyboardNote(track, x));
  }

  if (down && y < bottom) {
    const other = findOtherPressedEditCell(pressed, x, y, bottom);
    return updateActiveTrack(next, (track) => {
      if (!other) return toggleGridCell(track, x, visibleRowFromY(y, rows));
      return toggleRange(track, other.x, visibleRowFromY(other.y, rows), x, visibleRowFromY(y, rows));
    });
  }

  if (!down && y === bottom && x === right) {
    const heldMs = nowMs - (state.pressed[key] ?? nowMs);
    if (heldMs < 250) {
      return { ...next, mode: "SEQUENCE" };
    }
    return updateActiveTrack(next, (track) => ({
      ...track,
      noteOffset: positiveModulo(Math.floor((track.noteOffset + PITTER_VISIBLE_NOTES) / PITTER_VISIBLE_NOTES) * PITTER_VISIBLE_NOTES, PITTER_NOTE_COUNT)
    }));
  }

  return next;
}

export function advancePitterState(
  state: PitterState,
  baseTick: number,
  rng: () => number = Math.random
): { state: PitterState; events: PitterNoteEvent[] } {
  if (!state.playing) return { state, events: [] };

  const tracks = state.tracks.slice();
  const events: PitterNoteEvent[] = [];
  for (const track of state.tracks) {
    if (!shouldTrackAdvance(track, baseTick)) continue;
    const { track: nextTrack, events: trackEvents } = advanceTrack(track, rng);
    tracks[track.id] = nextTrack;
    events.push(...trackEvents);
  }

  return { state: { ...state, tracks }, events };
}

export function buildPitterLevels(state: PitterState, cols = 16, rows = 8): GridLevels {
  const levels = makeGridLevels(cols, rows, 0);
  const track = state.tracks[state.activeTrack];
  if (!track) return levels;

  const bottom = rows - 1;
  const right = cols - 1;
  const pattern = track.patterns[track.activePattern];

  if (state.mode === "SEQUENCE") {
    for (let x = 0; x < Math.min(cols, PITTER_PATTERN_COUNT); x += 1) {
      const chainRow = track.chain[x];
      if (chainRow >= 0 && chainRow < bottom) {
        levels[chainRow][x] = track.activePattern === chainRow ? 10 : 5;
      }
    }
    for (let y = 0; y < bottom; y += 1) {
      levels[y][track.chainColumn % cols] = Math.min(15, levels[y][track.chainColumn % cols] + 2);
    }
    levels[bottom][Math.min(right - 1, track.activePattern)] = 15;
    applyBottomControlLevels(levels, bottom, state, track);
    levels[bottom][right] = 6;
    return levels;
  }

  const stepOffset = Math.floor(track.step / cols) * cols;
  for (let x = 0; x < cols; x += 1) {
    const step = stepOffset + x;
    if (step >= PITTER_STEP_COUNT) continue;
    for (let y = 0; y < bottom; y += 1) {
      const noteIndex = noteIndexForVisibleRow(track, visibleRowFromY(y, rows));
      const value = pattern[step][noteIndex];
      if (value > 0) {
        levels[y][x] = value === 2 ? 3 : noteLevel(noteMidi(noteIndex));
      }
    }
  }

  const stepColumn = track.step % cols;
  for (let y = 0; y < bottom; y += 1) {
    levels[y][stepColumn] = Math.min(15, levels[y][stepColumn] + 4);
  }

  for (let x = 0; x < right; x += 1) {
    if (isBottomControlColumn(x)) continue;
    levels[bottom][x] = noteLevel(noteMidi(noteIndexForKeyboard(track, x)));
  }
  applyBottomControlLevels(levels, bottom, state, track);
  levels[bottom][right] = 8;

  for (const key of Object.keys(state.pressed)) {
    const [xText, yText] = key.split(",");
    const px = Number(xText);
    const py = Number(yText);
    if (py < rows && px < cols) levels[py][px] = 15;
  }

  return levels;
}

export function setPitterTrackParam<K extends keyof Pick<PitterTrack, "direction" | "divisionIndex" | "length" | "muted" | "monophonic" | "probability" | "velocityProfileIndex">>(
  state: PitterState,
  key: K,
  value: PitterTrack[K]
): PitterState {
  return updateActiveTrack(state, (track) => ({ ...track, [key]: value }));
}

export function setPitterActiveTrack(state: PitterState, activeTrack: number): PitterState {
  return { ...state, activeTrack: clampInteger(activeTrack, 0, PITTER_TRACK_COUNT - 1) };
}

export function setPitterPlaying(state: PitterState, playing: boolean): PitterState {
  return {
    ...state,
    playing,
    tracks: playing ? state.tracks : state.tracks.map((track) => ({ ...track, step: 0, movement: 1 }))
  };
}

export function clearPitterVisible(state: PitterState): PitterState {
  return updateActiveTrack(state, (track) => {
    const patterns = clonePatterns(track.patterns);
    const pattern = patterns[track.activePattern];
    for (let step = 0; step < PITTER_STEP_COUNT; step += 1) {
      for (let row = 1; row <= PITTER_VISIBLE_NOTES; row += 1) {
        pattern[step][noteIndexForVisibleRow(track, row)] = 0;
      }
    }
    return { ...track, patterns };
  });
}

export function clearPitterTrack(state: PitterState): PitterState {
  return updateActiveTrack(state, (track) => ({ ...track, patterns: createPatterns() }));
}

function createDefaultTrack(id: number): PitterTrack {
  return {
    id,
    patterns: createPatterns(),
    activePattern: 0,
    chain: Array(PITTER_PATTERN_COUNT).fill(-1),
    chainStep: 0,
    chainColumn: 0,
    step: 0,
    movement: 1,
    noteOffset: 21,
    direction: "FORWARD",
    divisionIndex: 6,
    length: 16,
    muted: false,
    monophonic: false,
    probability: 1,
    velocityProfileIndex: 1
  };
}

function normalizeTrack(value: unknown, id: number): PitterTrack {
  const defaults = createDefaultTrack(id);
  if (!isRecord(value)) return defaults;

  return {
    ...defaults,
    patterns: normalizePatterns(value.patterns),
    activePattern: boundedInteger(value.activePattern, 0, PITTER_PATTERN_COUNT - 1, defaults.activePattern),
    chain: normalizeChain(value.chain),
    chainStep: boundedInteger(value.chainStep, 0, PITTER_PATTERN_COUNT - 1, defaults.chainStep),
    chainColumn: boundedInteger(value.chainColumn, 0, PITTER_PATTERN_COUNT - 1, defaults.chainColumn),
    step: boundedInteger(value.step, 0, PITTER_STEP_COUNT - 1, defaults.step),
    movement: value.movement === -1 ? -1 : 1,
    noteOffset: boundedInteger(value.noteOffset, 0, PITTER_NOTE_COUNT - 1, defaults.noteOffset),
    direction: isPitterDirection(value.direction) ? value.direction : defaults.direction,
    divisionIndex: boundedInteger(value.divisionIndex, 0, PITTER_DIVISIONS.length - 1, defaults.divisionIndex),
    length: boundedInteger(value.length, 2, PITTER_STEP_COUNT, defaults.length),
    muted: typeof value.muted === "boolean" ? value.muted : defaults.muted,
    monophonic: typeof value.monophonic === "boolean" ? value.monophonic : defaults.monophonic,
    probability: boundedNumber(value.probability, 0, 1, defaults.probability),
    velocityProfileIndex: boundedInteger(value.velocityProfileIndex, 0, VELOCITY_PROFILES.length - 1, defaults.velocityProfileIndex)
  };
}

function createPatterns(): PitterCell[][][] {
  return Array.from({ length: PITTER_PATTERN_COUNT }, () =>
    Array.from({ length: PITTER_STEP_COUNT }, () => Array<PitterCell>(PITTER_NOTE_COUNT).fill(0))
  );
}

function normalizePatterns(value: unknown): PitterCell[][][] {
  const patterns = createPatterns();
  if (!Array.isArray(value)) return patterns;

  for (let p = 0; p < Math.min(PITTER_PATTERN_COUNT, value.length); p += 1) {
    const patternValue = value[p];
    if (!Array.isArray(patternValue)) continue;
    for (let step = 0; step < Math.min(PITTER_STEP_COUNT, patternValue.length); step += 1) {
      const rowValue = patternValue[step];
      if (!Array.isArray(rowValue)) continue;
      for (let note = 0; note < Math.min(PITTER_NOTE_COUNT, rowValue.length); note += 1) {
        patterns[p][step][note] = rowValue[note] === 2 ? 2 : rowValue[note] === 1 ? 1 : 0;
      }
    }
  }
  return patterns;
}

function normalizeChain(value: unknown): number[] {
  const chain = Array(PITTER_PATTERN_COUNT).fill(-1);
  if (!Array.isArray(value)) return chain;
  for (let index = 0; index < Math.min(PITTER_PATTERN_COUNT, value.length); index += 1) {
    chain[index] = boundedInteger(value[index], -1, PITTER_PATTERN_COUNT - 1, -1);
  }
  return chain;
}

function advanceTrack(track: PitterTrack, rng: () => number): { track: PitterTrack; events: PitterNoteEvent[] } {
  const pattern = track.patterns[track.activePattern];
  let events: PitterNoteEvent[] = [];
  if (!track.muted) {
    for (let noteIndex = 0; noteIndex < PITTER_NOTE_COUNT; noteIndex += 1) {
      if (pattern[track.step][noteIndex] === 1 && rng() <= track.probability) {
        events.push({
          trackId: track.id,
          midi: noteMidi(noteIndex),
          velocity: velocityForStep(track, rng),
          step: track.step,
          noteIndex,
          divisionIndex: track.divisionIndex,
          gateSteps: tiedGateSteps(track, noteIndex)
        });
      }
    }
    if (track.monophonic && events.length > 1) {
      events = [events[Math.min(events.length - 1, Math.floor(rng() * events.length))]];
    }
  }

  const { step, movement } = nextStep(track, rng);
  let nextTrack = { ...track, step, movement };
  if (track.step === track.length - 1) {
    nextTrack = advancePatternChain(nextTrack);
  }
  return { track: nextTrack, events };
}

function advancePatternChain(track: PitterTrack): PitterTrack {
  const entries = track.chain
    .map((pattern, column) => ({ pattern, column }))
    .filter((entry) => entry.pattern >= 0);
  if (entries.length === 0) return { ...track, activePattern: 0, chainColumn: 0 };

  const chainStep = track.chainStep + 1;
  const entry = entries[positiveModulo(chainStep - 1, entries.length)];
  return { ...track, activePattern: entry.pattern, chainStep, chainColumn: entry.column };
}

function nextStep(track: PitterTrack, rng: () => number): { step: number; movement: 1 | -1 } {
  const limit = track.length;
  if (track.direction === "FORWARD") return { step: track.step === limit - 1 ? 0 : track.step + 1, movement: 1 };
  if (track.direction === "BACKWARD") return { step: track.step === 0 ? limit - 1 : track.step - 1, movement: -1 };
  if (track.direction === "RANDOM") return { step: Math.floor(rng() * limit), movement: track.movement };

  let step = track.step + track.movement;
  let movement = track.movement;
  if (step >= limit) {
    step = Math.max(0, limit - 2);
    movement = -1;
  }
  if (step < 0) {
    step = Math.min(limit - 1, 1);
    movement = 1;
  }
  return { step, movement };
}

function toggleKeyboardNote(track: PitterTrack, keyboardColumn: number): PitterTrack {
  return toggleCell(track, track.step, noteIndexForKeyboard(track, keyboardColumn));
}

function toggleGridCell(track: PitterTrack, x: number, visibleRow: number): PitterTrack {
  const step = Math.min(PITTER_STEP_COUNT - 1, Math.floor(track.step / 16) * 16 + x);
  return toggleCell(track, step, noteIndexForVisibleRow(track, visibleRow));
}

function toggleRange(track: PitterTrack, x1: number, row1: number, x2: number, row2: number): PitterTrack {
  let next = track;
  const points = linePoints(x1, row1, x2, row2);
  for (let index = 1; index < points.length; index += 1) {
    next = toggleGridCell(next, points[index].x, points[index].row);
  }
  return next;
}

function toggleCell(track: PitterTrack, step: number, noteIndex: number): PitterTrack {
  const patterns = clonePatterns(track.patterns);
  const pattern = patterns[track.activePattern];
  const current = pattern[step][noteIndex];
  if (current === 0) {
    pattern[step][noteIndex] = 1;
  } else if (current === 1 && pattern[leftStep(step, track.length)][noteIndex] > 0) {
    pattern[step][noteIndex] = 2;
  } else {
    pattern[step][noteIndex] = 0;
    const right = rightStep(step, track.length);
    if (pattern[right][noteIndex] === 2) pattern[right][noteIndex] = 1;
  }
  return { ...track, patterns };
}

function tiedGateSteps(track: PitterTrack, noteIndex: number): number {
  const pattern = track.patterns[track.activePattern];
  let gateSteps = 1;
  let step = rightStep(track.step, track.length);

  while (gateSteps < track.length && pattern[step][noteIndex] === 2) {
    gateSteps += 1;
    step = rightStep(step, track.length);
  }

  return gateSteps;
}

function noteIndexForVisibleRow(track: PitterTrack, visibleRow: number): number {
  return positiveModulo(visibleRow + track.noteOffset - 1, PITTER_NOTE_COUNT);
}

function noteIndexForKeyboard(track: PitterTrack, keyboardColumn: number): number {
  return positiveModulo(keyboardColumn + track.noteOffset, PITTER_NOTE_COUNT);
}

function isBottomControlColumn(x: number): boolean {
  return x === PITTER_PLAY_COL || x === PITTER_MUTE_COL || x === PITTER_VIEW_DOWN_COL || x === PITTER_VIEW_UP_COL;
}

function applyBottomControlLevels(levels: GridLevels, bottom: number, state: PitterState, track: PitterTrack): void {
  if (!levels[bottom]) return;
  if (PITTER_PLAY_COL < levels[bottom].length) levels[bottom][PITTER_PLAY_COL] = state.playing ? 15 : 5;
  if (PITTER_MUTE_COL < levels[bottom].length) levels[bottom][PITTER_MUTE_COL] = track.muted ? 15 : 5;
  if (PITTER_VIEW_DOWN_COL < levels[bottom].length) levels[bottom][PITTER_VIEW_DOWN_COL] = 7;
  if (PITTER_VIEW_UP_COL < levels[bottom].length) levels[bottom][PITTER_VIEW_UP_COL] = 7;
}

function noteMidi(noteIndex: number): number {
  const octave = Math.floor(noteIndex / MAJOR_SCALE.length);
  return ROOT_MIDI + octave * 12 + MAJOR_SCALE[noteIndex % MAJOR_SCALE.length];
}

function noteLevel(midi: number): number {
  return 12 - (midi % 12) + 2;
}

function velocityForStep(track: PitterTrack, rng: () => number): number {
  const profile = VELOCITY_PROFILES[track.velocityProfileIndex] ?? VELOCITY_PROFILES[0];
  const accent = profile[track.step % profile.length] === 1;
  const min = accent ? 80 : 20;
  const max = accent ? 125 : 60;
  return Math.round(min + rng() * (max - min));
}

function shouldTrackAdvance(track: PitterTrack, baseTick: number): boolean {
  const division = PITTER_DIVISIONS[track.divisionIndex] ?? 1 / 16;
  const ticksPerStep = Math.max(1, Math.round(division * 16));
  return baseTick % ticksPerStep === 0;
}

function updateActiveTrack(state: PitterState, update: (track: PitterTrack) => PitterTrack): PitterState {
  const tracks = state.tracks.slice();
  tracks[state.activeTrack] = update(tracks[state.activeTrack]);
  return { ...state, tracks };
}

function clonePitterState(state: PitterState): PitterState {
  return {
    ...state,
    tracks: state.tracks.map((track) => ({
      ...track,
      patterns: clonePatterns(track.patterns),
      chain: track.chain.slice()
    })),
    pressed: { ...state.pressed }
  };
}

function clonePatterns(patterns: PitterCell[][][]): PitterCell[][][] {
  return patterns.map((pattern) => pattern.map((step) => step.slice()));
}

function findOtherPressedEditCell(pressed: Record<string, number>, x: number, y: number, bottom: number): { x: number; y: number } | null {
  for (const key of Object.keys(pressed)) {
    const [xText, yText] = key.split(",");
    const px = Number(xText);
    const py = Number(yText);
    if (px === x && py === y) continue;
    if (py < bottom) return { x: px, y: py };
  }
  return null;
}

function linePoints(x1: number, row1: number, x2: number, row2: number): Array<{ x: number; row: number }> {
  if (x1 > x2) {
    return linePoints(x2, row2, x1, row1);
  }
  if (x1 === x2) {
    const start = Math.min(row1, row2);
    const end = Math.max(row1, row2);
    return Array.from({ length: end - start + 1 }, (_, index) => ({ x: x1, row: start + index }));
  }

  const points: Array<{ x: number; row: number }> = [];
  const slope = (row2 - row1) / (x2 - x1);
  for (let x = x1; x <= x2; x += 1) {
    points.push({ x, row: Math.round(row1 + (x - x1) * slope) });
  }
  return points;
}

function visibleRowFromY(y: number, rows: number): number {
  return rows - 1 - y;
}

function leftStep(step: number, length: number): number {
  return step === 0 ? length - 1 : step - 1;
}

function rightStep(step: number, length: number): number {
  return step === length - 1 ? 0 : step + 1;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clampInteger(Math.round(value), min, max) : fallback;
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function isPitterDirection(value: unknown): value is PitterDirection {
  return value === "BACKWARD" || value === "PINGPONG" || value === "RANDOM" || value === "FORWARD";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
