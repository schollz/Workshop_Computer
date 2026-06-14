import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioEngine, type SynthSettings, type SynthWave } from "./audioEngine";
import { makeGridLevels, MonomeGridSerial, type GridLevels } from "./gridSerial";
import { parseClusterText } from "./noteParser";

const DEFAULT_COLS = 16;
const DEFAULT_ROWS = 8;
const MAX_LEVEL = 15;
const DEFAULT_CLUSTERS = "c4eg Cm7 Fmaj7 G7 Csus C6";
const DEFAULT_SYNTH: SynthSettings = {
  wave: "square",
  attack: 0.012,
  decay: 0.2,
  filter: 2600,
  q: 0.8,
  drive: 1.4,
  level: 0.55
};

export default function App() {
  const [cols, setCols] = useState(DEFAULT_COLS);
  const [rows, setRows] = useState(DEFAULT_ROWS);
  const [clusterText, setClusterText] = useState(DEFAULT_CLUSTERS);
  const [activeColumn, setActiveColumn] = useState<number | null>(null);
  const [bpm, setBpm] = useState(120);
  const [ledCurve, setLedCurve] = useState(45);
  const [status, setStatus] = useState("Waiting for a grid.");
  const [connected, setConnected] = useState(false);
  const [audioOn, setAudioOn] = useState(false);
  const [synth, setSynth] = useState<SynthSettings>(DEFAULT_SYNTH);
  const [blanked, setBlanked] = useState(false);
  const [playStep, setPlayStep] = useState(0);
  const [pendingColumn, setPendingColumn] = useState<number | null>(null);

  const audioRef = useRef<AudioEngine | null>(null);
  const gridRef = useRef<MonomeGridSerial | null>(null);
  const ledCurveRef = useRef(ledCurve);
  const activeRef = useRef(activeColumn);
  const pendingRef = useRef<number | null>(pendingColumn);
  const clustersRef = useRef(parseClusterText(DEFAULT_CLUSTERS).clusters);
  const stepRef = useRef(0);
  const downCellRef = useRef<string | null>(null);

  if (!audioRef.current) {
    audioRef.current = new AudioEngine();
  }

  const parsed = useMemo(() => parseClusterText(clusterText), [clusterText]);
  const clusters = parsed.clusters;

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

  const requestColumn = useCallback((x: number, validClusters = clustersRef.current.length) => {
    if (x >= validClusters || x >= 16) return;
    setBlanked(false);

    if (activeRef.current === x) {
      activeRef.current = null;
      pendingRef.current = null;
      setActiveColumn(null);
      setPendingColumn(null);
      stepRef.current = 0;
      setPlayStep(0);
      return;
    }

    pendingRef.current = x;
    setPendingColumn(x);
  }, []);

  const handleGridKey = useCallback((x: number, y: number, down: boolean) => {
    if (!down || y !== rows - 1 || x >= clustersRef.current.length || x >= 16) return;
    void audioRef.current?.ensure().then(() => setAudioOn(true)).catch(() => undefined);
    requestColumn(x);
  }, [requestColumn, rows]);

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

    const next = makeGridLevels(cols, rows, 0);
    const bottom = rows - 1;
    for (let x = 0; x < Math.min(cols, clusters.length, 16); x += 1) {
      next[bottom][x] = activeColumn === x ? 15 : 4;
    }

    if (activeColumn !== null && activeColumn < clusters.length) {
      next[bottom][activeColumn] = playStep % 2 === 0 ? 15 : 12;
    }

    return next;
  }, [activeColumn, blanked, clusters.length, cols, playStep, rows]);

  useEffect(() => {
    gridRef.current?.drawQueued(levels);
  }, [levels]);

  useEffect(() => {
    const tick = () => {
      let column = activeRef.current;
      if (pendingRef.current !== null) {
        column = pendingRef.current;
        activeRef.current = column;
        pendingRef.current = null;
        stepRef.current = 0;
        setActiveColumn(column);
        setPendingColumn(null);
      }

      const cluster = clustersRef.current[column ?? -1];
      if (!cluster) return;

      const note = cluster.notes[stepRef.current % cluster.notes.length];
      const pan = cluster.notes.length > 1 ? ((stepRef.current % cluster.notes.length) / Math.max(1, cluster.notes.length - 1)) * 0.8 - 0.4 : 0;
      audioRef.current?.playMidi(note.midi, eighthMs(bpm) / 1000 * 0.8, 0.16, pan);
      stepRef.current = (stepRef.current + 1) % cluster.notes.length;
      setPlayStep(stepRef.current);
    };

    const timer = window.setInterval(tick, eighthMs(bpm));
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
    stepRef.current = 0;
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
    await gridRef.current?.clear();
  };

  const resetApp = () => {
    setClusterText(DEFAULT_CLUSTERS);
    activeRef.current = null;
    pendingRef.current = null;
    setActiveColumn(null);
    setPendingColumn(null);
    setBpm(120);
    setLedCurve(45);
    setBlanked(false);
    stepRef.current = 0;
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
    if (y !== rows - 1 || x >= clusters.length || x >= 16) return;
    requestColumn(x, clusters.length);
    try {
      await audioRef.current?.ensure();
      setAudioOn(true);
    } catch (error) {
      setStatus(`Audio failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <main>
      <header>
        <div>
          <h1>grid arpeggiator</h1>
          <p>16-column note clusters for monome grid and browser WebAudio.</p>
        </div>
        <div className="top-actions">
          <button id="connect" type="button" onClick={connect} disabled={connected}>Connect grid</button>
          <button className="secondary" type="button" onClick={enableAudio}>{audioOn ? "Audio on" : "Enable audio"}</button>
        </div>
      </header>

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
                  downCellRef.current = null;
                }}
              />
            )))}
          </div>
        </div>

        <section className="engine-panel" aria-label="arpeggiator and synth engine">
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
                  pendingColumn === index ? "pending" : ""
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
          <SynthSlider label="decay" min={0.04} max={1.6} step={0.01} value={synth.decay} display={formatMs(synth.decay)} onChange={(value) => setSynthParam("decay", value)} />
          <SynthSlider label="lowpass" min={220} max={12000} step={10} value={synth.filter} display={formatHz(synth.filter)} onChange={(value) => setSynthParam("filter", value)} />
          <SynthSlider label="q" min={0.1} max={12} step={0.1} value={synth.q} display={synth.q.toFixed(1)} onChange={(value) => setSynthParam("q", value)} />
          <SynthSlider label="drive" min={1} max={8} step={0.1} value={synth.drive} display={synth.drive.toFixed(1)} onChange={(value) => setSynthParam("drive", value)} />
          <SynthSlider label="level" min={0.15} max={0.9} step={0.01} value={synth.level} display={String(Math.round(synth.level * 100))} onChange={(value) => setSynthParam("level", value)} />
        </section>

        <aside className="readme" aria-label="arpeggiator instructions">
          <h2>program</h2>
          <p>Each valid token becomes one bottom-row key, left to right. Press a populated bottom-row key to make it the only active cluster. Press it again to stop.</p>
          <ul>
            <li>Notes: <code>c4</code>, <code>f#3</code>, <code>bb5</code>.</li>
            <li>Compact clusters: <code>c4eg</code> becomes <code>C4 E4 G4</code>.</li>
            <li>Chords: <code>C</code>, <code>Cm</code>, <code>C7</code>, <code>CM7</code>, <code>Cmin7</code>, <code>Csus</code>, <code>C6</code>, <code>Cdim</code>, <code>Caug</code>.</li>
            <li>Separators: spaces, commas, or newlines. Semicolons only set chord octaves, as in <code>C;3</code>.</li>
          </ul>
        </aside>
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
