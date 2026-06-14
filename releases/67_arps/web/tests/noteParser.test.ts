import assert from "node:assert/strict";
import { parseClusterText } from "../src/noteParser";

const compact = parseClusterText("c4eg");
assert.deepEqual(compact.clusters[0].notes.map((note) => note.name), ["C4", "E4", "G4"]);

const chords = parseClusterText("CM7 Cmin7 Csus C6 C7");
assert.equal(chords.errors.length, 0);
assert.equal(chords.clusters.length, 5);
assert.deepEqual(chords.clusters.map((cluster) => cluster.notes.length), [4, 4, 3, 4, 4]);

const compactAcrossClusters = parseClusterText("b4d eg");
assert.deepEqual(compactAcrossClusters.clusters[0].notes.map((note) => note.name), ["B4", "D5"]);
assert.deepEqual(compactAcrossClusters.clusters[1].notes.map((note) => note.name), ["E5", "G5"]);

const repeatedCompactClusters = parseClusterText("c4eg ceg ceg");
assert.deepEqual(repeatedCompactClusters.clusters[0].notes.map((note) => note.name), ["C4", "E4", "G4"]);
assert.deepEqual(repeatedCompactClusters.clusters[1].notes.map((note) => note.name), ["C4", "E4", "G4"]);
assert.deepEqual(repeatedCompactClusters.clusters[2].notes.map((note) => note.name), ["C4", "E4", "G4"]);

const mixedExplicitCompact = parseClusterText("c4eg c5eg");
assert.deepEqual(mixedExplicitCompact.clusters[1].notes.map((note) => note.name), ["C5", "E5", "G5"]);

const chordRootsAcrossClusters = parseClusterText("g4b C F");
assert.deepEqual(chordRootsAcrossClusters.clusters[0].notes.map((note) => note.name), ["G4", "B4"]);
assert.deepEqual(chordRootsAcrossClusters.clusters[1].notes.map((note) => note.name), ["C4", "E4", "G4"]);
assert.deepEqual(chordRootsAcrossClusters.clusters[2].notes.map((note) => note.name), ["F4", "A4", "C5"]);

const commonProgression = parseClusterText("C Em Am F");
assert.deepEqual(commonProgression.clusters[0].notes.map((note) => note.name), ["C4", "E4", "G4"]);
assert.deepEqual(commonProgression.clusters[1].notes.map((note) => note.name), ["E4", "G4", "B4"]);
assert.deepEqual(commonProgression.clusters[2].notes.map((note) => note.name), ["A4", "C5", "E5"]);
assert.deepEqual(commonProgression.clusters[3].notes.map((note) => note.name), ["F4", "A4", "C5"]);

const explicitChordOctaves = parseClusterText("C;3 Cmin7;2 F#M7;5");
assert.deepEqual(explicitChordOctaves.clusters[0].notes.map((note) => note.name), ["C3", "E3", "G3"]);
assert.deepEqual(explicitChordOctaves.clusters[1].notes.map((note) => note.name), ["C2", "Eb2", "G2", "Bb2"]);
assert.deepEqual(explicitChordOctaves.clusters[2].notes.map((note) => note.name), ["F#5", "A#5", "C#6", "F6"]);

const semicolonsAreNotSeparators = parseClusterText("C;D;E");
assert.equal(semicolonsAreNotSeparators.clusters.length, 0);
assert.equal(semicolonsAreNotSeparators.errors[0].token, "C;D;E");

const many = parseClusterText("C D E F G A B C D E F G A B C D E F");
assert.equal(many.clusters.length, 16);
assert.equal(many.truncated.length, 2);

const invalid = parseClusterText("C nope D");
assert.equal(invalid.clusters.length, 2);
assert.equal(invalid.errors.length, 1);
assert.equal(invalid.errors[0].token, "nope");

console.log("note parser tests passed");
