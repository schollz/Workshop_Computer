import assert from "node:assert/strict";
import {
  applyAnchor,
  applyOctaves,
  applyOrdering,
  DEFAULT_ARP_SETTINGS,
  findLiveTransitionIndex,
  getMovementIndex,
  reconcileArpSettingsByCluster,
  selectArpOption,
  type MidiNote
} from "../src/arpModules";

const notes: MidiNote[] = [
  { midi: 60, name: "C4" },
  { midi: 64, name: "E4" },
  { midi: 67, name: "G4" },
  { midi: 71, name: "B4" }
];

const names = (input: readonly MidiNote[]) => input.map((note) => note.name);

assert.deepEqual(names(applyOrdering(notes, "UP")), ["C4", "E4", "G4", "B4"]);
assert.deepEqual(names(applyOrdering(notes, "DOWN")), ["B4", "G4", "E4", "C4"]);
assert.deepEqual(names(applyOrdering(notes, "CONVERGE")), ["C4", "B4", "E4", "G4"]);
assert.deepEqual(names(applyOrdering(notes, "DIVERGE")), ["E4", "G4", "C4", "B4"]);
assert.deepEqual(names(applyOrdering(notes, "ALTERNATE")), ["C4", "G4", "E4", "B4"]);
assert.deepEqual(applyOrdering([], "CONVERGE"), []);
assert.deepEqual(names(applyOrdering(notes.slice(0, 1), "DIVERGE")), ["C4"]);
assert.deepEqual(names(applyOrdering(notes.slice(0, 2), "CONVERGE")), ["C4", "E4"]);
assert.deepEqual(names(applyOrdering(notes.slice(0, 3), "ALTERNATE")), ["C4", "G4", "E4"]);

assert.deepEqual([0, 1, 2, 3, 4, 5].map((step) => getMovementIndex(4, "FORWARD", step)), [0, 1, 2, 3, 0, 1]);
assert.deepEqual([0, 1, 2, 3, 4, 5].map((step) => getMovementIndex(4, "BACKWARD", step)), [3, 2, 1, 0, 3, 2]);
assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((step) => getMovementIndex(4, "PENDULUM", step)), [0, 1, 2, 3, 2, 1, 0]);

const up = applyOrdering(notes, "UP");
assert.deepEqual(names(applyAnchor(notes, "LOWEST").concat(up)), ["C4", "C4", "E4", "G4", "B4"]);

assert.deepEqual(names(applyOctaves(notes, "UP_1")), ["C4", "E4", "G4", "B4", "C5", "E5", "G5", "B5"]);

const converge = applyOrdering(notes, "CONVERGE");
assert.equal(findLiveTransitionIndex({ midi: 67, name: "G4" }, converge), 3);

const customSettings = selectArpOption(DEFAULT_ARP_SETTINGS, 0, 2);
assert.deepEqual(reconcileArpSettingsByCluster([customSettings], 3), [
  customSettings,
  DEFAULT_ARP_SETTINGS,
  DEFAULT_ARP_SETTINGS
]);
assert.deepEqual(reconcileArpSettingsByCluster([customSettings, DEFAULT_ARP_SETTINGS], 1), [customSettings]);
assert.deepEqual(reconcileArpSettingsByCluster([customSettings], 0), []);

console.log("arp module tests passed");
