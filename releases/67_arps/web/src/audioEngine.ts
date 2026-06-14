export type SynthWave = OscillatorType;

export interface SynthSettings {
  wave: SynthWave;
  attack: number;
  decay: number;
  filter: number;
  q: number;
  drive: number;
  level: number;
}

type AudioContextConstructor = typeof AudioContext;

declare global {
  interface Window {
    webkitAudioContext?: AudioContextConstructor;
  }
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  synth: SynthSettings = {
    wave: "square",
    attack: 0.012,
    decay: 0.2,
    filter: 2600,
    q: 0.8,
    drive: 1.4,
    level: 0.55
  };

  private master: GainNode | null = null;
  private delay: DelayNode | null = null;
  private delayFeedback: GainNode | null = null;

  async setup(resume = true): Promise<void> {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.synth.level;
      this.delay = this.ctx.createDelay(1.2);
      this.delay.delayTime.value = 0.22;
      this.delayFeedback = this.ctx.createGain();
      this.delayFeedback.gain.value = 0.24;
      this.delay.connect(this.delayFeedback);
      this.delayFeedback.connect(this.delay);
      this.delay.connect(this.master);
      this.master.connect(this.ctx.destination);
    }

    if (resume && this.ctx.state !== "running") {
      await this.ctx.resume();
    }
  }

  async ensure(): Promise<void> {
    await this.setup(true);
  }

  setSynthParam<K extends keyof SynthSettings>(key: K, value: SynthSettings[K] | string): SynthSettings {
    if (key === "wave") {
      this.synth.wave = value as SynthWave;
    } else {
      this.synth[key] = Number(value) as SynthSettings[K];
    }

    if (key === "level" && this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.synth.level, this.ctx.currentTime, 0.02);
    }

    return { ...this.synth };
  }

  playMidi(note: number, duration = 0.2, amp = 0.16, pan = 0): void {
    this.tone(this.midiToFrequency(note), duration, amp, pan, 0.04);
  }

  private midiToFrequency(note: number): number {
    return 440 * Math.pow(2, (note - 69) / 12);
  }

  private driveCurve(drive: number): Float32Array<ArrayBuffer> {
    const curve = new Float32Array(new ArrayBuffer(512 * Float32Array.BYTES_PER_ELEMENT));
    const fold = clamp((drive - 1) / 7, 0, 1);
    for (let i = 0; i < curve.length; i += 1) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      const folded = x + Math.sin(x * Math.PI * 2) * fold * 0.22;
      const clipped = Math.tanh(folded * (1.2 + drive * 0.85));
      const asym = folded * folded * Math.sign(folded) * fold * 0.18;
      curve[i] = clamp((clipped + asym) * (0.82 + fold * 0.22), -1, 1);
    }
    return curve;
  }

  private tone(freq: number, dur = 0.16, amp = 0.18, pan = 0, send = 0): void {
    if (!this.ctx || !this.master || !this.delay) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const shaper = this.ctx.createWaveShaper();
    const preDrive = this.ctx.createGain();
    const postDrive = this.ctx.createGain();
    const gain = this.ctx.createGain();
    const panner = this.ctx.createStereoPanner();
    const attack = Math.max(0.003, this.synth.attack);
    const decay = Math.max(0.025, dur, this.synth.decay);
    const drive = Math.max(1, this.synth.drive);
    const drivePush = 1 + (drive - 1) * 0.28;
    const filterHz = clamp(this.synth.filter * drivePush, 80, 18000);

    osc.type = this.synth.wave;
    osc.frequency.setValueAtTime(freq, now);
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(filterHz, now);
    filter.Q.value = this.synth.q * (1 + (drive - 1) * 0.06);
    preDrive.gain.value = 0.75 + drive * 0.35;
    shaper.curve = this.driveCurve(drive);
    shaper.oversample = "2x";
    postDrive.gain.value = 0.78 + Math.min(0.75, (drive - 1) * 0.13);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp * (1 + (drive - 1) * 0.06)), now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    panner.pan.value = pan;

    osc.connect(preDrive);
    preDrive.connect(shaper);
    shaper.connect(postDrive);
    postDrive.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(this.master);
    if (send > 0) {
      const wet = this.ctx.createGain();
      wet.gain.value = send;
      panner.connect(wet);
      wet.connect(this.delay);
    }
    osc.start(now);
    osc.stop(now + decay + 0.03);
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
