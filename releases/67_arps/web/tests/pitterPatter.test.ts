import assert from "node:assert/strict";
import {
  advancePitterState,
  createDefaultPitterState,
  handlePitterGridKey,
  PITTER_STEP_COUNT,
  setPitterTrackParam
} from "../src/pitterPatter";

const always = () => 0;

let state = createDefaultPitterState();
assert.equal(state.tracks.length, 4);
assert.equal(state.tracks[0].patterns.length, 16);
assert.equal(state.tracks[0].patterns[0].length, PITTER_STEP_COUNT);

state = handlePitterGridKey(state, 0, 6, true, 0);
let track = state.tracks[0];
let noteIndex = (1 + track.noteOffset - 1) % 42;
assert.equal(track.patterns[0][0][noteIndex], 1);

state = handlePitterGridKey(state, 0, 6, true, 10);
track = state.tracks[0];
assert.equal(track.patterns[0][0][noteIndex], 0);

state = createDefaultPitterState();
state = handlePitterGridKey(state, 0, 6, true, 0);
state = handlePitterGridKey(state, 0, 6, false, 5);
state = setPitterTrackParam(state, "direction", "FORWARD");
let stepped = advancePitterState(state, 0, always);
assert.equal(stepped.events.length, 1);
assert.equal(stepped.state.tracks[0].step, 1);

state = handlePitterGridKey(stepped.state, 1, 6, true, 10);
state = handlePitterGridKey(state, 1, 6, false, 11);
state = handlePitterGridKey(state, 1, 6, true, 12);
track = state.tracks[0];
assert.equal(track.patterns[0][1][noteIndex], 2);
state = { ...state, tracks: state.tracks.map((track, index) => index === 0 ? { ...track, step: 0 } : track) };
stepped = advancePitterState(state, 0, always);
assert.equal(stepped.events[0].gateSteps, 2);

state = setPitterTrackParam(createDefaultPitterState(), "direction", "BACKWARD");
stepped = advancePitterState(state, 0, always);
assert.equal(stepped.state.tracks[0].step, 15);

state = setPitterTrackParam(createDefaultPitterState(), "direction", "PINGPONG");
state = setPitterTrackParam(state, "length", 4);
for (const expected of [1, 2, 3, 2, 1, 0, 1]) {
  stepped = advancePitterState(state, 0, always);
  assert.equal(stepped.state.tracks[0].step, expected);
  state = stepped.state;
}

state = createDefaultPitterState();
state = handlePitterGridKey(state, 15, 7, true, 0);
state = handlePitterGridKey(state, 15, 7, false, 100);
assert.equal(state.mode, "SEQUENCE");
state = handlePitterGridKey(state, 2, 7, true, 120);
assert.equal(state.tracks[0].activePattern, 2);
state = handlePitterGridKey(state, 3, 1, true, 130);
assert.equal(state.tracks[0].chain[3], 1);

state = handlePitterGridKey(state, 11, 7, true, 140);
assert.equal(state.playing, false);
state = handlePitterGridKey(state, 12, 7, true, 150);
assert.equal(state.tracks[0].muted, true);
const offset = state.tracks[0].noteOffset;
state = handlePitterGridKey(state, 13, 7, true, 160);
assert.equal(state.tracks[0].noteOffset, offset - 1);
state = handlePitterGridKey(state, 14, 7, true, 170);
assert.equal(state.tracks[0].noteOffset, offset);
state = handlePitterGridKey(state, 13, 7, true, 180);
state = handlePitterGridKey(state, 2, 7, true, 190);
assert.equal(state.tracks[0].activePattern, 2);

state = createDefaultPitterState();
state = handlePitterGridKey(state, 0, 6, true, 0);
state = handlePitterGridKey(state, 0, 6, false, 1);
state = handlePitterGridKey(state, 0, 5, true, 2);
stepped = advancePitterState(state, 0, always);
assert.equal(stepped.events.length, 2);

state = setPitterTrackParam(state, "monophonic", true);
stepped = advancePitterState(state, 0, () => 0.99);
assert.equal(stepped.events.length, 1);
assert.equal(stepped.events[0].noteIndex, 22);

console.log("pitter-patter tests passed");
