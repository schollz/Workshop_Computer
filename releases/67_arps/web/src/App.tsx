import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioEngine, type SynthSettings, type SynthWave } from "./audioEngine";
import {
  applyAnchor,
  applyEmissionOctave,
  applyNeighborhood,
  applyProbability,
  ARP_MODULES,
  buildArpPool,
  DEFAULT_ARP_SETTINGS,
  findLiveTransitionIndex,
  getMovementIndex,
  movementCycleLength,
  reconcileArpSettingsByCluster,
  repeatTickCount,
  selectArpOption,
  stepAfterMovementIndex,
  type ArpSettings
} from "./arpModules";
import { makeGridLevels, MonomeGridSerial, type GridLevels } from "./gridSerial";
import { parseClusterText, type ParsedNote } from "./noteParser";
import {
  advancePitterState,
  buildPitterLevels,
  clearPitterTrack,
  clearPitterVisible,
  createDefaultPitterState,
  handlePitterGridKey,
  normalizePitterState,
  PITTER_DIRECTIONS,
  PITTER_DIVISIONS,
  PITTER_DIVISION_LABELS,
  setPitterActiveTrack,
  setPitterPlaying,
  setPitterTrackParam,
  type PitterDirection,
  type PitterState
} from "./pitterPatter";

const DEFAULT_COLS = 16;
const DEFAULT_ROWS = 8;
const MAX_LEVEL = 15;
const DEFAULT_CLUSTERS = "c4eg Cm7 Fmaj7 G7 Csus C6";
const MODULE_COLS = 7;
const MODULE_ROWS = 5;
const DIM_MODULE_LEVEL = 2;
const STORAGE_KEY = "grid-arpeggiator:settings:v1";
type GridApp = "yarp" | "pitter-patter";

const DEFAULT_SYNTH: SynthSettings = {
  wave: "square",
  attack: 0.012,
  release: 0.2,
  filter: 2600,
  q: 0.8,
  drive: 1.4,
  level: 0.55
};

interface StoredAppSettings {
  activeApp: GridApp;
  clusterText: string;
  bpm: number;
  ledCurve: number;
  synth: SynthSettings;
  arpSettingsByCluster: ArpSettings[];
  pitterPatter: PitterState;
}

let cachedStoredSettings: StoredAppSettings | null | undefined;

export default function App() {
  const storedSettings = loadStoredSettings();
  const [cols, setCols] = useState(DEFAULT_COLS);
  const [rows, setRows] = useState(DEFAULT_ROWS);
  const [activeApp, setActiveApp] = useState<GridApp>(() => storedSettings?.activeApp ?? "yarp");
  const [clusterText, setClusterText] = useState(() => storedSettings?.clusterText ?? DEFAULT_CLUSTERS);
  const [activeColumn, setActiveColumn] = useState<number | null>(null);
  const [bpm, setBpm] = useState(() => storedSettings?.bpm ?? 120);
  const [ledCurve, setLedCurve] = useState(() => storedSettings?.ledCurve ?? 45);
  const [status, setStatus] = useState("Waiting for a grid.");
  const [connected, setConnected] = useState(false);
  const [audioOn, setAudioOn] = useState(false);
  const [synth, setSynth] = useState<SynthSettings>(() => storedSettings?.synth ?? DEFAULT_SYNTH);
  const [blanked, setBlanked] = useState(false);
  const [playStep, setPlayStep] = useState(0);
  const [pendingColumn, setPendingColumn] = useState<number | null>(null);
  const [focusedColumn, setFocusedColumn] = useState(0);
  const [arpSettingsByCluster, setArpSettingsByCluster] = useState<ArpSettings[]>(() => storedSettings?.arpSettingsByCluster ?? []);
  const [pitterPatter, setPitterPatter] = useState<PitterState>(() => storedSettings?.pitterPatter ?? createDefaultPitterState());

  const audioRef = useRef<AudioEngine | null>(null);
  const gridRef = useRef<MonomeGridSerial | null>(null);
  const activeAppRef = useRef<GridApp>(storedSettings?.activeApp ?? "yarp");
  const ledCurveRef = useRef(ledCurve);
  const activeRef = useRef(activeColumn);
  const pendingRef = useRef<number | null>(pendingColumn);
  const focusedColumnRef = useRef(0);
  const arpSettingsByClusterRef = useRef<ArpSettings[]>(storedSettings?.arpSettingsByCluster ?? []);
  const pitterPatterRef = useRef<PitterState>(storedSettings?.pitterPatter ?? createDefaultPitterState());
  const clustersRef = useRef(parseClusterText(DEFAULT_CLUSTERS).clusters);
  const movementStepRef = useRef(0);
  const previousIndexRef = useRef<number | null>(null);
  const anchorQueueRef = useRef<ParsedNote[]>([]);
  const anchorEventRef = useRef(0);
  const repeatNoteRef = useRef<ParsedNote | null>(null);
  const repeatRemainingRef = useRef(0);
  const lastEmittedNoteRef = useRef<ParsedNote | null>(null);
  const avoidIndexRef = useRef<number | null>(null);
  const tickCountRef = useRef(0);
  const pitterTickRef = useRef(0);
  const downCellRef = useRef<string | null>(null);
  const clearedStorageSnapshotRef = useRef<string | null>(null);
  const storedSettingsFingerprintRef = useRef<string | null>(null);

  if (!audioRef.current) {
    const engine = new AudioEngine();
    for (const [key, value] of Object.entries(synth) as [keyof SynthSettings, SynthSettings[keyof SynthSettings]][]) {
      engine.setSynthParam(key, value);
    }
    audioRef.current = engine;
  }

  const parsed = useMemo(() => parseClusterText(clusterText), [clusterText]);
  const clusters = parsed.clusters;
  const focusedArpSettings = arpSettingsByCluster[focusedColumn] ?? DEFAULT_ARP_SETTINGS;
  const pitterTrack = pitterPatter.tracks[pitterPatter.activeTrack];

  useEffect(() => {
    activeAppRef.current = activeApp;
  }, [activeApp]);

  useEffect(() => {
    clustersRef.current = clusters;
  }, [clusters]);

  useEffect(() => {
    ledCurveRef.current = ledCurve;
  }, [ledCurve]);

  useEffect(() => {
    activeRef.current = activeColumn;
  }, [activeColumn]);

  useEffect(() => {
    pendingRef.current = pendingColumn;
  }, [pendingColumn]);

  useEffect(() => {
    focusedColumnRef.current = focusedColumn;
  }, [focusedColumn]);

  useEffect(() => {
    arpSettingsByClusterRef.current = arpSettingsByCluster;
  }, [arpSettingsByCluster]);

  useEffect(() => {
    pitterPatterRef.current = pitterPatter;
  }, [pitterPatter]);

  useEffect(() => {
    setArpSettingsByCluster((current) => reconcileArpSettingsByCluster(current, clusters.length));
    if (clusters.length === 0 && focusedColumnRef.current !== 0) {
      focusedColumnRef.current = 0;
      setFocusedColumn(0);
    } else if (focusedColumnRef.current >= clusters.length && clusters.length > 0) {
      focusedColumnRef.current = clusters.length - 1;
      setFocusedColumn(clusters.length - 1);
    }
  }, [clusters.length]);

  useEffect(() => {
    const snapshot = {
      activeApp,
      clusterText,
      bpm,
      ledCurve,
      synth,
      arpSettingsByCluster,
      pitterPatter: pitterStateForStorage(pitterPatter)
    };
    const fingerprint = storedSettingsFingerprint(snapshot);

    if (clearedStorageSnapshotRef.current === fingerprint) {
      clearStoredSettings();
      storedSettingsFingerprintRef.current = null;
      return;
    }

    if (storedSettingsFingerprintRef.current === fingerprint) return;

    clearedStorageSnapshotRef.current = null;
    storedSettingsFingerprintRef.current = fingerprint;
    saveStoredSettings(snapshot);
  }, [activeApp, arpSettingsByCluster, bpm, clusterText, ledCurve, pitterPatter, synth]);

  const clearArpRuntime = useCallback(() => {
    movementStepRef.current = 0;
    previousIndexRef.current = null;
    anchorQueueRef.current = [];
    anchorEventRef.current = 0;
    repeatNoteRef.current = null;
    repeatRemainingRef.current = 0;
    lastEmittedNoteRef.current = null;
    avoidIndexRef.current = null;
    tickCountRef.current = 0;
    setPlayStep(0);
  }, []);

  const alignArpRuntime = useCallback((notes: readonly ParsedNote[], settings: ArpSettings, currentNote: ParsedNote | null) => {
    const fallbackIndex = previousIndexRef.current ?? 0;
    const transitionIndex = findLiveTransitionIndex(currentNote, notes, fallbackIndex);
    movementStepRef.current = currentNote ? stepAfterMovementIndex(transitionIndex, notes.length, settings.movement) : 0;
    previousIndexRef.current = currentNote && notes.length > 0 ? transitionIndex : null;
    anchorQueueRef.current = [];
    repeatNoteRef.current = null;
    repeatRemainingRef.current = 0;
    avoidIndexRef.current = currentNote && notes.length > 1 ? transitionIndex : null;
  }, []);

  const settingsForColumn = useCallback((column: number | null | undefined): ArpSettings => {
    if (column === null || column === undefined || column < 0) return DEFAULT_ARP_SETTINGS;
    return arpSettingsByClusterRef.current[column] ?? DEFAULT_ARP_SETTINGS;
  }, []);

  const applyArpSettingsForColumn = useCallback((column: number, nextSettings: ArpSettings) => {
    if (column < 0 || column >= clustersRef.current.length) return;
    const currentSettings = settingsForColumn(column);
    if (nextSettings === currentSettings) return;

    if (activeRef.current === column) {
      const cluster = clustersRef.current[column];
      const nextPool = cluster ? buildArpPool(cluster.notes, nextSettings) : [];
      alignArpRuntime(nextPool, nextSettings, lastEmittedNoteRef.current);
    }

    const nextSettingsByCluster = reconcileArpSettingsByCluster(arpSettingsByClusterRef.current, clustersRef.current.length);
    nextSettingsByCluster[column] = nextSettings;
    arpSettingsByClusterRef.current = nextSettingsByCluster;
    setArpSettingsByCluster(nextSettingsByCluster);
    setBlanked(false);
  }, [alignArpRuntime, settingsForColumn]);

  const requestArpModuleOption = useCallback((x: number, y: number) => {
    const column = focusedColumnRef.current;
    const nextSettings = selectArpOption(settingsForColumn(column), x, y);
    applyArpSettingsForColumn(column, nextSettings);
  }, [applyArpSettingsForColumn, settingsForColumn]);

  const switchApp = useCallback((nextApp: GridApp) => {
    activeAppRef.current = nextApp;
    setActiveApp(nextApp);
    setBlanked(false);
  }, []);

  const updatePitterPatter = useCallback((update: (state: PitterState) => PitterState) => {
    const nextState = update(pitterPatterRef.current);
    pitterPatterRef.current = nextState;
    setPitterPatter(nextState);
    setBlanked(false);
  }, []);

  const requestPitterGridKey = useCallback((x: number, y: number, down: boolean) => {
    setBlanked(false);
    const nextState = handlePitterGridKey(pitterPatterRef.current, x, y, down, performance.now(), cols, rows);
    pitterPatterRef.current = nextState;
    setPitterPatter(nextState);
    if (down) {
      void audioRef.current?.ensure().then(() => setAudioOn(true)).catch(() => undefined);
    }
  }, [cols, rows]);

  const togglePitterPlaying = useCallback(async () => {
    const nextPlaying = !pitterPatterRef.current.playing;
    if (nextPlaying) {
      try {
        await audioRef.current?.ensure();
        setAudioOn(true);
      } catch (error) {
        setStatus(`Audio failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    updatePitterPatter((state) => setPitterPlaying(state, nextPlaying));
  }, [updatePitterPatter]);

  const requestColumn = useCallback((x: number, validClusters = clustersRef.current.length) => {
    if (x >= validClusters || x >= 16) return;
    setBlanked(false);
    focusedColumnRef.current = x;
    setFocusedColumn(x);

    if (activeRef.current === x) {
      activeRef.current = null;
      pendingRef.current = null;
      setActiveColumn(null);
      setPendingColumn(null);
      clearArpRuntime();
      return;
    }

    pendingRef.current = x;
    setPendingColumn(x);
  }, [clearArpRuntime]);

  const handleGridKey = useCallback((x: number, y: number, down: boolean) => {
    if (activeAppRef.current === "pitter-patter") {
      requestPitterGridKey(x, y, down);
      return;
    }

    if (!down || activeAppRef.current !== "yarp") return;

    if (y === rows - 1) {
      if (x >= clustersRef.current.length || x >= 16) return;
      void audioRef.current?.ensure().then(() => setAudioOn(true)).catch(() => undefined);
      requestColumn(x);
      return;
    }

    if (x < MODULE_COLS && y < MODULE_ROWS) {
      requestArpModuleOption(x, y);
      return;
    }
  }, [requestArpModuleOption, requestColumn, requestPitterGridKey, rows]);

  if (!gridRef.current) {
    gridRef.current = new MonomeGridSerial({
      cols,
      rows,
      mapLevel: (level) => hardwareLevel(level, ledCurveRef.current),
      onKey: handleGridKey,
      onSize: (nextCols, nextRows) => {
        setCols(nextCols || DEFAULT_COLS);
        setRows(nextRows || DEFAULT_ROWS);
        setStatus(`Connected: ${nextCols || DEFAULT_COLS} x ${nextRows || DEFAULT_ROWS} grid.`);
      },
      onStatus: (message) => setStatus(message)
    });
  }

  useEffect(() => {
    if (!gridRef.current) return;
    gridRef.current.onKey = handleGridKey;
    gridRef.current.cols = cols;
    gridRef.current.rows = rows;
  }, [cols, handleGridKey, rows]);

  useEffect(() => {
    if (activeColumn !== null && activeColumn >= clusters.length) {
      activeRef.current = null;
      setActiveColumn(null);
    }
    if (pendingColumn !== null && pendingColumn >= clusters.length) {
      pendingRef.current = null;
      setPendingColumn(null);
    }
  }, [activeColumn, clusters.length, pendingColumn]);

  const levels = useMemo(() => {
    if (blanked) return makeGridLevels(cols, rows, 0);
    if (activeApp === "pitter-patter") return buildPitterLevels(pitterPatter, cols, rows);
    if (activeApp !== "yarp") return makeGridLevels(cols, rows, 0);

    const next = makeGridLevels(cols, rows, 0);
    const bottom = rows - 1;
    for (let x = 0; x < Math.min(cols, MODULE_COLS); x += 1) {
      const module = ARP_MODULES[x];
      for (let y = 0; y < Math.min(rows, MODULE_ROWS); y += 1) {
        if (y === bottom) continue;
        next[y][x] = focusedArpSettings[module.key] === module.options[y] ? 15 : DIM_MODULE_LEVEL;
      }
    }

    for (let x = 0; x < Math.min(cols, clusters.length, 16); x += 1) {
      next[bottom][x] = activeColumn === x ? 15 : 4;
    }

    if (activeColumn !== null && activeColumn < clusters.length) {
      next[bottom][activeColumn] = playStep % 2 === 0 ? 15 : 12;
    }

    return next;
  }, [activeApp, activeColumn, blanked, clusters.length, cols, focusedArpSettings, pitterPatter, playStep, rows]);

  useEffect(() => {
    gridRef.current?.drawQueued(levels);
  }, [levels]);

  useEffect(() => {
    const tick = () => {
      if (activeAppRef.current !== "yarp") return;

      let column = activeRef.current;
      if (pendingRef.current !== null) {
        column = pendingRef.current;
        const pendingSettings = settingsForColumn(column);
        const nextCluster = clustersRef.current[column];
        const nextPool = nextCluster ? buildArpPool(nextCluster.notes, pendingSettings) : [];
        alignArpRuntime(nextPool, pendingSettings, lastEmittedNoteRef.current);
        activeRef.current = column;
        pendingRef.current = null;
        setActiveColumn(column);
        setPendingColumn(null);
      }

      const cluster = clustersRef.current[column ?? -1];
      if (!cluster) return;
      const settings = settingsForColumn(column);
      const pool = buildArpPool(cluster.notes, settings);
      if (pool.length === 0) return;

      let selectedNote: ParsedNote | null = null;
      let selectedIndex: number | null = null;

      if (repeatRemainingRef.current > 0 && repeatNoteRef.current) {
        selectedNote = repeatNoteRef.current;
        repeatRemainingRef.current -= 1;
      } else {
        const cycleLength = movementCycleLength(pool.length, settings.movement);
        if (anchorQueueRef.current.length === 0 && movementStepRef.current % cycleLength === 0) {
          anchorQueueRef.current = applyAnchor(cluster.notes, settings.anchor, anchorEventRef.current);
          if (anchorQueueRef.current.length > 0) anchorEventRef.current += 1;
        }

        const anchorNote = anchorQueueRef.current.shift();
        if (anchorNote) {
          selectedNote = anchorNote;
          selectedIndex = pool.findIndex((note) => note.midi === anchorNote.midi);
        } else {
          const rawIndex = getMovementIndex(
            pool.length,
            settings.movement,
            movementStepRef.current,
            Math.random,
            previousIndexRef.current ?? 0
          );
          let nextIndex = applyNeighborhood(rawIndex, previousIndexRef.current, pool.length, settings.neighborhood, Math.random);
          if (avoidIndexRef.current !== null && nextIndex === avoidIndexRef.current && pool.length > 1) {
            nextIndex = (nextIndex + 1) % pool.length;
          }

          avoidIndexRef.current = null;
          selectedIndex = nextIndex;
          selectedNote = pool[nextIndex];
          previousIndexRef.current = nextIndex;
          movementStepRef.current += 1;
        }

        if (selectedNote) {
          repeatNoteRef.current = selectedNote;
          repeatRemainingRef.current = repeatTickCount(settings.repeat) - 1;
        }
      }

      if (!selectedNote) return;

      const octaveNote = applyEmissionOctave(selectedNote, settings.octave, Math.random);
      const emittedNote = applyProbability(octaveNote, settings.probability, pool, lastEmittedNoteRef.current, Math.random);
      tickCountRef.current += 1;
      setPlayStep(tickCountRef.current);
      if (!emittedNote) return;

      const panIndex = selectedIndex ?? pool.findIndex((note) => note.midi === selectedNote.midi);
      const pan = pool.length > 1 && panIndex >= 0 ? (panIndex / Math.max(1, pool.length - 1)) * 0.8 - 0.4 : 0;
      audioRef.current?.playMidi(emittedNote.midi, eighthMs(bpm) / 1000 * 0.8, 0.16, pan);
      lastEmittedNoteRef.current = emittedNote;
    };

    const timer = window.setInterval(tick, eighthMs(bpm));
    return () => window.clearInterval(timer);
  }, [alignArpRuntime, bpm, settingsForColumn]);

  useEffect(() => {
    const tick = () => {
      if (activeAppRef.current !== "pitter-patter") return;
      const result = advancePitterState(pitterPatterRef.current, pitterTickRef.current);
      pitterTickRef.current += 1;
      if (result.state !== pitterPatterRef.current) {
        pitterPatterRef.current = result.state;
        setPitterPatter(result.state);
      }

      for (const event of result.events) {
        const pan = [-0.45, -0.15, 0.15, 0.45][event.trackId] ?? 0;
        const amp = 0.08 + (event.velocity / 127) * 0.1;
        audioRef.current?.playMidi(event.midi, pitterGateSeconds(bpm, event.divisionIndex, event.gateSteps), amp, pan);
      }
    };

    const timer = window.setInterval(tick, pitterStepMs(bpm));
    return () => window.clearInterval(timer);
  }, [bpm]);

  useEffect(() => {
    return () => {
      if (gridRef.current?.connected) {
        void gridRef.current.disconnect();
      }
    };
  }, []);

  const connect = async () => {
    try {
      await audioRef.current?.ensure();
      setAudioOn(true);
      setStatus("Opening grid port...");
      setCols(DEFAULT_COLS);
      setRows(DEFAULT_ROWS);
      await gridRef.current?.connect();
      setConnected(true);
      setStatus("Connected. Requesting grid size...");
      window.setTimeout(() => {
        if (gridRef.current?.connected) {
          setStatus((current) => current === "Connected. Requesting grid size..." ? "Connected. Using 16 x 8 layout until the grid reports its size." : current);
        }
      }, 700);
    } catch (error) {
      setConnected(false);
      setStatus(`Connection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const disconnect = async () => {
    activeRef.current = null;
    pendingRef.current = null;
    setActiveColumn(null);
    setPendingColumn(null);
    clearArpRuntime();
    await gridRef.current?.disconnect();
    setConnected(false);
    setStatus("Disconnected.");
  };

  const clearLeds = async () => {
    activeRef.current = null;
    pendingRef.current = null;
    setActiveColumn(null);
    setPendingColumn(null);
    setBlanked(true);
    clearArpRuntime();
    await gridRef.current?.clear();
  };

  const resetApp = () => {
    clearedStorageSnapshotRef.current = storedSettingsFingerprint(defaultStoredSettings());
    clearStoredSettings();
    const defaultArpSettingsByCluster = defaultStoredSettings().arpSettingsByCluster;
    activeAppRef.current = "yarp";
    setActiveApp("yarp");
    setClusterText(DEFAULT_CLUSTERS);
    activeRef.current = null;
    pendingRef.current = null;
    focusedColumnRef.current = 0;
    setActiveColumn(null);
    setPendingColumn(null);
    setFocusedColumn(0);
    setBpm(120);
    setLedCurve(45);
    setBlanked(false);
    arpSettingsByClusterRef.current = defaultArpSettingsByCluster;
    setArpSettingsByCluster(defaultArpSettingsByCluster);
    const defaultPitterPatter = createDefaultPitterState();
    pitterPatterRef.current = defaultPitterPatter;
    setPitterPatter(defaultPitterPatter);
    pitterTickRef.current = 0;
    clearArpRuntime();
    const engine = audioRef.current;
    if (engine) {
      for (const [key, value] of Object.entries(DEFAULT_SYNTH) as [keyof SynthSettings, SynthSettings[keyof SynthSettings]][]) {
        engine.setSynthParam(key, value);
      }
      setSynth({ ...engine.synth });
    } else {
      setSynth(DEFAULT_SYNTH);
    }
  };

  const enableAudio = async () => {
    try {
      await audioRef.current?.ensure();
      setAudioOn(true);
      setStatus("Audio on.");
    } catch (error) {
      setStatus(`Audio failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const setSynthParam = <K extends keyof SynthSettings>(key: K, value: SynthSettings[K] | string) => {
    const next = audioRef.current?.setSynthParam(key, value) ?? { ...synth, [key]: value };
    setSynth(next);
  };

  const pressCell = async (x: number, y: number) => {
    if (activeApp === "pitter-patter") {
      requestPitterGridKey(x, y, true);
      return;
    }

    if (activeApp !== "yarp") return;

    if (y === rows - 1) {
      if (x >= clusters.length || x >= 16) return;
      requestColumn(x, clusters.length);
      try {
        await audioRef.current?.ensure();
        setAudioOn(true);
      } catch (error) {
        setStatus(`Audio failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    if (x < MODULE_COLS && y < MODULE_ROWS) {
      requestArpModuleOption(x, y);
    }
  };

  const releaseCell = (x: number, y: number) => {
    if (activeApp === "pitter-patter") {
      requestPitterGridKey(x, y, false);
    }
  };

  const synthControls = (
    <section className="synth-panel" aria-label="shared synth engine">
      <h2>synth</h2>
      <label className="param param-select">
        <span>wave</span>
        <select value={synth.wave} onChange={(event) => setSynthParam("wave", event.target.value as SynthWave)}>
          <option value="square">square</option>
          <option value="sawtooth">saw</option>
          <option value="triangle">tri</option>
          <option value="sine">sine</option>
        </select>
      </label>
      <SynthSlider label="attack" min={0.003} max={0.6} step={0.001} value={synth.attack} display={formatMs(synth.attack)} onChange={(value) => setSynthParam("attack", value)} />
      <SynthSlider label="release" min={0.04} max={1.6} step={0.01} value={synth.release} display={formatMs(synth.release)} onChange={(value) => setSynthParam("release", value)} />
      <SynthSlider label="lowpass" min={220} max={12000} step={10} value={synth.filter} display={formatHz(synth.filter)} onChange={(value) => setSynthParam("filter", value)} />
      <SynthSlider label="q" min={0.1} max={12} step={0.1} value={synth.q} display={synth.q.toFixed(1)} onChange={(value) => setSynthParam("q", value)} />
      <SynthSlider label="drive" min={1} max={8} step={0.1} value={synth.drive} display={synth.drive.toFixed(1)} onChange={(value) => setSynthParam("drive", value)} />
      <SynthSlider label="level" min={0.15} max={0.9} step={0.01} value={synth.level} display={String(Math.round(synth.level * 100))} onChange={(value) => setSynthParam("level", value)} />
    </section>
  );

  return (
    <main>
      <header>
        <div>
          <h1>workshop grid apps</h1>
          <p>select a browser app for monome grid and WebAudio.</p>
        </div>
        <div className="top-actions">
          <button id="connect" type="button" onClick={connect} disabled={connected}>Connect grid</button>
          <button className="secondary" type="button" onClick={enableAudio}>{audioOn ? "Audio on" : "Enable audio"}</button>
        </div>
      </header>

      <nav className="app-switcher" aria-label="apps">
        <button type="button" className={activeApp === "yarp" ? "active" : ""} aria-pressed={activeApp === "yarp"} onClick={() => switchApp("yarp")}>yarp</button>
        <button type="button" className={activeApp === "pitter-patter" ? "active" : ""} aria-pressed={activeApp === "pitter-patter"} onClick={() => switchApp("pitter-patter")}>pitter-patter</button>
      </nav>

      <section className="tempo" aria-label="master tempo">
        <label className="param">
          <span>bpm</span>
          <input type="range" min="40" max="220" step="1" value={bpm} onChange={(event) => setBpm(Number(event.target.value))} />
          <span>{bpm}</span>
        </label>
        <label className="param">
          <span>led curve</span>
          <input type="range" min="0" max="100" step="1" value={ledCurve} onChange={(event) => setLedCurve(Number(event.target.value))} />
          <span>{ledCurveLabel(ledCurve)}</span>
        </label>
      </section>

      <div className="controls">
        <button className="secondary" type="button" onClick={resetApp}>Reset app</button>
        <button className="secondary" type="button" onClick={clearLeds}>Clear LEDs</button>
        <button className="secondary" type="button" onClick={disconnect} disabled={!connected}>Disconnect</button>
        <div id="status" role="status">{status}</div>
      </div>

      <section className="work">
        <div className="grid-wrap">
          <div
            id="grid"
            style={{ "--cols": cols, "--rows": rows } as React.CSSProperties}
            aria-label="monome grid surface"
          >
            {levels.flatMap((row, y) => row.map((level, x) => (
              <button
                key={`${x},${y}`}
                type="button"
                className="cell"
                data-level={clamp(Math.round(level), 0, MAX_LEVEL)}
                data-label={`${x},${y}`}
                aria-label={`grid key ${x}, ${y}`}
                onPointerDown={(event) => {
                  downCellRef.current = `${x},${y}`;
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  void pressCell(x, y);
                }}
                onPointerUp={() => {
                  releaseCell(x, y);
                  downCellRef.current = null;
                }}
                onPointerCancel={() => {
                  releaseCell(x, y);
                  downCellRef.current = null;
                }}
              />
            )))}
          </div>
        </div>

        {activeApp === "yarp" ? (
          <>
        <section className="engine-panel" aria-label="yarp arpeggiator and synth engine">
          <h2>clusters</h2>
          <label className="cluster-editor">
            <span>notes</span>
            <textarea
              value={clusterText}
              spellCheck={false}
              onChange={(event) => {
                setClusterText(event.target.value);
                setBlanked(false);
              }}
            />
          </label>
          <div className="parse-readout">
            {clusters.length ? clusters.map((cluster, index) => (
              <button
                key={`${cluster.source}-${index}`}
                type="button"
                className={[
                  "cluster-pill",
                  activeColumn === index ? "active" : "",
                  pendingColumn === index ? "pending" : "",
                  focusedColumn === index ? "focused" : ""
                ].filter(Boolean).join(" ")}
                onClick={() => void pressCell(index, rows - 1)}
              >
                {index + 1}: {cluster.notes.map((note) => note.name).join(" ")}
              </button>
            )) : <p>No valid clusters.</p>}
          </div>
          {(parsed.errors.length > 0 || parsed.truncated.length > 0) && (
            <div className="errors" aria-live="polite">
              {parsed.errors.map((error) => <p key={error.token}>{error.token}: {error.reason}</p>)}
              {parsed.truncated.length > 0 && <p>Only the first 16 valid clusters are assigned to grid columns.</p>}
            </div>
          )}

          <h2>arp</h2>
          <p className="arp-focus">{clusters[focusedColumn] ? `cluster ${focusedColumn + 1}: ${clusters[focusedColumn].source}` : "no cluster selected"}</p>
          <dl className="arp-readout">
            {ARP_MODULES.map((module) => (
              <div key={module.key}>
                <dt>{module.label}</dt>
                <dd>{focusedArpSettings[module.key]}</dd>
              </div>
            ))}
          </dl>

        </section>

        <aside className="readme" aria-label="arpeggiator instructions">
          <h2>yarp</h2>
          <p>Each valid token becomes one bottom-row key, left to right. Press a populated bottom-row key to make it the only active cluster. Press it again to stop.</p>
          <ul>
            <li>Notes: <code>c4</code>, <code>f#3</code>, <code>bb5</code>.</li>
            <li>Compact clusters: <code>c4eg</code> becomes <code>C4 E4 G4</code>.</li>
            <li>Chords: <code>C</code>, <code>Cm</code>, <code>C7</code>, <code>CM7</code>, <code>Cmin7</code>, <code>Csus</code>, <code>C6</code>, <code>Cdim</code>, <code>Caug</code>.</li>
            <li>Separators: spaces, commas, or newlines. Semicolons only set chord octaves, as in <code>C;3</code>.</li>
          </ul>
        </aside>
          </>
        ) : (
          <section className="pitter-panel" aria-label="pitter-patter sequencer">
            <h2>pitter-patter</h2>
            <div className="track-tabs" aria-label="pitter-patter tracks">
              {pitterPatter.tracks.map((track, index) => (
                <button
                  key={track.id}
                  type="button"
                  className={pitterPatter.activeTrack === index ? "active" : ""}
                  onClick={() => updatePitterPatter((state) => setPitterActiveTrack(state, index))}
                >
                  track {index + 1}
                </button>
              ))}
            </div>
            <div className="pitter-actions">
              <button type="button" onClick={() => void togglePitterPlaying()}>{pitterPatter.playing ? "stop" : "play"}</button>
              <button type="button" className={pitterTrack?.muted ? "active" : ""} onClick={() => updatePitterPatter((state) => setPitterTrackParam(state, "muted", !pitterTrack?.muted))}>mute</button>
              <button type="button" className={pitterTrack?.monophonic ? "active" : ""} onClick={() => updatePitterPatter((state) => setPitterTrackParam(state, "monophonic", !pitterTrack?.monophonic))}>mono</button>
              <button type="button" className={pitterPatter.mode === "NOTE" ? "active" : ""} onClick={() => updatePitterPatter((state) => ({ ...state, mode: "NOTE" }))}>note</button>
              <button type="button" className={pitterPatter.mode === "SEQUENCE" ? "active" : ""} onClick={() => updatePitterPatter((state) => ({ ...state, mode: "SEQUENCE" }))}>sequence</button>
            </div>
            {pitterTrack && (
              <>
                <label className="param param-select">
                  <span>direction</span>
                  <select value={pitterTrack.direction} onChange={(event) => updatePitterPatter((state) => setPitterTrackParam(state, "direction", event.target.value as PitterDirection))}>
                    {PITTER_DIRECTIONS.map((direction) => <option key={direction} value={direction}>{direction.toLowerCase()}</option>)}
                  </select>
                </label>
                <label className="param param-select">
                  <span>division</span>
                  <select value={pitterTrack.divisionIndex} onChange={(event) => updatePitterPatter((state) => setPitterTrackParam(state, "divisionIndex", Number(event.target.value)))}>
                    {PITTER_DIVISION_LABELS.map((label, index) => <option key={label} value={index}>{label}</option>)}
                  </select>
                </label>
                <label className="param">
                  <span>length</span>
                  <input type="range" min="2" max="64" step="1" value={pitterTrack.length} onChange={(event) => updatePitterPatter((state) => setPitterTrackParam(state, "length", Number(event.target.value)))} />
                  <span>{pitterTrack.length}</span>
                </label>
                <label className="param">
                  <span>prob</span>
                  <input type="range" min="0" max="1" step="0.01" value={pitterTrack.probability} onChange={(event) => updatePitterPatter((state) => setPitterTrackParam(state, "probability", Number(event.target.value)))} />
                  <span>{Math.round(pitterTrack.probability * 100)}%</span>
                </label>
                <div className="pitter-actions">
                  <button className="secondary" type="button" onClick={() => updatePitterPatter(clearPitterVisible)}>Clear visible</button>
                  <button className="secondary" type="button" onClick={() => updatePitterPatter(clearPitterTrack)}>Clear track</button>
                </div>
                <dl className="arp-readout">
                  <div>
                    <dt>mode</dt>
                    <dd>{pitterPatter.mode}</dd>
                  </div>
                  <div>
                    <dt>pattern</dt>
                    <dd>{pitterTrack.activePattern + 1}</dd>
                  </div>
                  <div>
                    <dt>step</dt>
                    <dd>{pitterTrack.step + 1}</dd>
                  </div>
                  <div>
                    <dt>offset</dt>
                    <dd>{pitterTrack.noteOffset}</dd>
                  </div>
                </dl>
              </>
            )}
          </section>
        )}
        {synthControls}
      </section>

      <section className="notes" aria-label="connection notes">
        <h2>before connecting</h2>
        <ol>
          <li>Use desktop Chrome or Edge. Safari, Firefox, and iPhone/iPad browsers do not expose Web Serial for this.</li>
          <li>If serialosc is holding the grid port, stop it first with <code>brew services stop serialosc</code>.</li>
          <li>After using this page, restart serialosc with <code>brew services start serialosc</code> if you want normal monome apps to see the grid again.</li>
          <li>For offline/local development, use the Vite dev server and open its localhost URL in Chrome or Edge.</li>
        </ol>
      </section>
    </main>
  );
}

function defaultStoredSettings(): StoredAppSettings {
  return {
    activeApp: "yarp",
    clusterText: DEFAULT_CLUSTERS,
    bpm: 120,
    ledCurve: 45,
    synth: DEFAULT_SYNTH,
    arpSettingsByCluster: reconcileArpSettingsByCluster([], parseClusterText(DEFAULT_CLUSTERS).clusters.length),
    pitterPatter: createDefaultPitterState()
  };
}

function loadStoredSettings(): StoredAppSettings | null {
  if (cachedStoredSettings !== undefined) return cachedStoredSettings;
  if (typeof window === "undefined") {
    cachedStoredSettings = null;
    return cachedStoredSettings;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    cachedStoredSettings = raw ? normalizeStoredSettings(JSON.parse(raw)) : null;
  } catch {
    cachedStoredSettings = null;
  }

  return cachedStoredSettings;
}

function saveStoredSettings(settings: StoredAppSettings): void {
  cachedStoredSettings = settings;
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage may be unavailable or full; the app should keep running with in-memory state.
  }
}

function clearStoredSettings(): void {
  cachedStoredSettings = null;
  if (typeof window === "undefined") return;

  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures; reset still restores the in-memory defaults.
  }
}

function storedSettingsFingerprint(settings: StoredAppSettings): string {
  return JSON.stringify(settings);
}

function pitterStateForStorage(state: PitterState): PitterState {
  return {
    ...state,
    pressed: {},
    tracks: state.tracks.map((track) => ({ ...track, step: 0, movement: 1 }))
  };
}

function normalizeStoredSettings(value: unknown): StoredAppSettings | null {
  if (!isRecord(value)) return null;
  const clusterText = typeof value.clusterText === "string" ? value.clusterText : DEFAULT_CLUSTERS;
  const clusterCount = parseClusterText(clusterText).clusters.length;

  return {
    activeApp: isGridApp(value.activeApp) ? value.activeApp : "yarp",
    clusterText,
    bpm: boundedNumber(value.bpm, 40, 220, 120),
    ledCurve: boundedNumber(value.ledCurve, 0, 100, 45),
    synth: normalizeStoredSynth(value.synth),
    arpSettingsByCluster: normalizeStoredArpSettingsByCluster(value.arpSettingsByCluster, clusterCount, value.arpSettings),
    pitterPatter: normalizePitterState(value.pitterPatter)
  };
}

function normalizeStoredSynth(value: unknown): SynthSettings {
  const record = isRecord(value) ? value : {};

  return {
    wave: isSynthWave(record.wave) ? record.wave : DEFAULT_SYNTH.wave,
    attack: boundedNumber(record.attack, 0.003, 0.6, DEFAULT_SYNTH.attack),
    release: boundedNumber(record.release ?? record.decay, 0.04, 1.6, DEFAULT_SYNTH.release),
    filter: boundedNumber(record.filter, 220, 12000, DEFAULT_SYNTH.filter),
    q: boundedNumber(record.q, 0.1, 12, DEFAULT_SYNTH.q),
    drive: boundedNumber(record.drive, 1, 8, DEFAULT_SYNTH.drive),
    level: boundedNumber(record.level, 0.15, 0.9, DEFAULT_SYNTH.level)
  };
}

function normalizeStoredArpSettingsByCluster(value: unknown, clusterCount: number, legacyValue?: unknown): ArpSettings[] {
  if (Array.isArray(value)) {
    return reconcileArpSettingsByCluster(value.map(normalizeStoredArpSettings), clusterCount);
  }

  if (legacyValue !== undefined) {
    return reconcileArpSettingsByCluster(Array(clusterCount).fill(normalizeStoredArpSettings(legacyValue)), clusterCount);
  }

  return reconcileArpSettingsByCluster([], clusterCount);
}

function normalizeStoredArpSettings(value: unknown): ArpSettings {
  if (!isRecord(value)) return DEFAULT_ARP_SETTINGS;

  let settings = DEFAULT_ARP_SETTINGS;
  ARP_MODULES.forEach((module, x) => {
    const optionIndex = module.options.findIndex((option) => option === value[module.key]);
    if (optionIndex >= 0) settings = selectArpOption(settings, x, optionIndex);
  });
  return settings;
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function isSynthWave(value: unknown): value is SynthWave {
  return value === "square" || value === "sawtooth" || value === "triangle" || value === "sine";
}

function isGridApp(value: unknown): value is GridApp {
  return value === "yarp" || value === "pitter-patter";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface SynthSliderProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  onChange: (value: number) => void;
}

function SynthSlider({ label, min, max, step, value, display, onChange }: SynthSliderProps) {
  return (
    <label className="param">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <span>{display}</span>
    </label>
  );
}

function eighthMs(bpm: number): number {
  return 30000 / bpm;
}

function pitterStepMs(bpm: number): number {
  return 60000 / bpm / 16;
}

function pitterGateSeconds(bpm: number, divisionIndex: number, gateSteps: number): number {
  const division = PITTER_DIVISIONS[divisionIndex] ?? 1 / 16;
  return (60000 / bpm / 1000) * division * Math.max(1, gateSteps) * 0.92;
}

function ledCurveLabel(value: number): string {
  if (value <= 8) return "linear";
  if (value <= 35) return "open";
  if (value <= 70) return "soft";
  if (value <= 90) return "dim";
  return "peak";
}

function hardwareLevel(level: number, ledCurve: number): number {
  const v = clamp(Math.round(level), 0, MAX_LEVEL);
  if (v <= 0) return 0;
  if (v >= 15) return 15;
  const compressed = compressedHardwareLevel(v);
  const blend = clamp(ledCurve / 100, 0, 1);
  return clamp(Math.round(v * (1 - blend) + compressed * blend), 0, MAX_LEVEL);
}

function compressedHardwareLevel(v: number): number {
  if (v >= 14) return 8;
  if (v >= 13) return 6;
  if (v >= 11) return 4;
  if (v >= 8) return 2;
  if (v >= 5) return 1;
  return 0;
}

function formatMs(seconds: number): string {
  return `${Math.round(seconds * 1000)}ms`;
}

function formatHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : `${Math.round(hz)}`;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
