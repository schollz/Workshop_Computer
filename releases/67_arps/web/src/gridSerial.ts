export const GRID_MSG = Object.freeze({
  SIZE_REQUEST: 0x05,
  SIZE_REPORT: 0x03,
  LED_ALL_OFF: 0x12,
  LED_LEVEL_MAP: 0x1a,
  KEY_UP: 0x20,
  KEY_DOWN: 0x21,
  LEGACY_KEY_UP: 0x00,
  LEGACY_KEY_DOWN: 0x01
});

export type GridLevels = number[][];

export interface MonomeGridSerialOptions {
  baudRate?: number;
  cols?: number;
  rows?: number;
  onKey?: (x: number, y: number, down: boolean) => void;
  onSize?: (cols: number, rows: number) => void;
  onStatus?: (message: string) => void;
  mapLevel?: (level: number) => number;
}

type SerialPortLike = {
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array>;
};

type SerialOptions = {
  baudRate: number;
  dataBits: 8;
  stopBits: 1;
  parity: "none";
  flowControl: "none";
};

declare global {
  interface Navigator {
    serial?: {
      requestPort(): Promise<SerialPortLike>;
    };
  }
}

export function makeGridLevels(cols = 16, rows = 8, fill = 0): GridLevels {
  return Array.from({ length: rows }, () => Array(cols).fill(fill));
}

export class MonomeGridSerial {
  baudRate: number;
  cols: number;
  rows: number;
  onKey: (x: number, y: number, down: boolean) => void;
  onSize: (cols: number, rows: number) => void;
  onStatus: (message: string) => void;
  mapLevel: (level: number) => number;

  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private keepReading = false;
  private pending: number[] = [];
  private pendingLedFrame: GridLevels | null = null;
  private ledWriteInProgress = false;

  constructor(options: MonomeGridSerialOptions = {}) {
    this.baudRate = options.baudRate ?? 115200;
    this.cols = options.cols ?? 16;
    this.rows = options.rows ?? 8;
    this.onKey = options.onKey ?? (() => undefined);
    this.onSize = options.onSize ?? (() => undefined);
    this.onStatus = options.onStatus ?? (() => undefined);
    this.mapLevel = options.mapLevel ?? ((level) => level);
  }

  get connected(): boolean {
    return Boolean(this.port && this.writer);
  }

  async connect(): Promise<this> {
    if (!navigator.serial) {
      throw new Error("Web Serial is unavailable. Use Chrome or Edge.");
    }

    this.port = await navigator.serial.requestPort();
    await this.port.open({
      baudRate: this.baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none"
    });

    this.writer = this.port.writable.getWriter();
    this.keepReading = true;
    void this.readLoop();
    await this.clear();
    await this.write([GRID_MSG.SIZE_REQUEST]);
    this.onStatus("connected");
    return this;
  }

  async disconnect(): Promise<void> {
    this.keepReading = false;
    this.pendingLedFrame = null;

    try {
      await this.clear();
      this.writer?.releaseLock();
      this.writer = null;
    } catch (error) {
      console.warn(error);
    }

    try {
      await this.reader?.cancel();
    } catch (error) {
      console.warn(error);
    }

    try {
      await this.port?.close();
    } catch (error) {
      console.warn(error);
    }

    this.port = null;
    this.reader = null;
    this.writer = null;
    this.pending = [];
    this.onStatus("disconnected");
  }

  async clear(): Promise<void> {
    this.pendingLedFrame = null;
    while (this.ledWriteInProgress) {
      await sleep(4);
    }
    await this.write([GRID_MSG.LED_ALL_OFF]);
  }

  async draw(levels: GridLevels): Promise<void> {
    for (let y = 0; y < this.rows; y += 8) {
      for (let x = 0; x < this.cols; x += 8) {
        await this.write([GRID_MSG.LED_LEVEL_MAP, x, y, ...this.pack8x8(levels, x, y)]);
      }
    }
  }

  drawQueued(levels: GridLevels): void {
    if (!this.writer) return;
    this.pendingLedFrame = cloneLevels(levels);
    void this.flushQueuedDraws();
  }

  private async flushQueuedDraws(): Promise<void> {
    if (this.ledWriteInProgress) return;
    this.ledWriteInProgress = true;

    try {
      while (this.pendingLedFrame && this.writer) {
        const frame = this.pendingLedFrame;
        this.pendingLedFrame = null;
        await this.draw(frame);
      }
    } finally {
      this.ledWriteInProgress = false;
    }
  }

  private async write(bytes: number[]): Promise<void> {
    if (!this.writer) return;
    await this.writer.write(new Uint8Array(bytes));
  }

  private async readLoop(): Promise<void> {
    while (this.keepReading && this.port?.readable) {
      this.reader = this.port.readable.getReader();
      try {
        while (this.keepReading) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) await this.consume(value);
        }
      } catch (error) {
        this.onStatus(`read error: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.reader.releaseLock();
        this.reader = null;
      }
    }
  }

  private async consume(bytes: Uint8Array): Promise<void> {
    this.pending.push(...bytes);
    while (this.pending.length) {
      const len = this.packetLength(this.pending[0]);
      if (this.pending.length < len) return;
      this.handlePacket(this.pending.splice(0, len));
    }
  }

  private packetLength(first: number): number {
    if (
      first === GRID_MSG.SIZE_REPORT ||
      first === GRID_MSG.KEY_UP ||
      first === GRID_MSG.KEY_DOWN ||
      first === GRID_MSG.LEGACY_KEY_UP ||
      first === GRID_MSG.LEGACY_KEY_DOWN
    ) {
      return 3;
    }
    return 1;
  }

  private handlePacket(packet: number[]): void {
    const [type, x, y] = packet;

    if (type === GRID_MSG.SIZE_REPORT) {
      this.cols = x || this.cols;
      this.rows = y || this.rows;
      this.onSize(this.cols, this.rows);
      return;
    }

    const down = type === GRID_MSG.KEY_DOWN || type === GRID_MSG.LEGACY_KEY_DOWN;
    const isKey = down || type === GRID_MSG.KEY_UP || type === GRID_MSG.LEGACY_KEY_UP;
    if (!isKey || x >= this.cols || y >= this.rows) return;
    this.onKey(x, y, down);
  }

  private pack8x8(levels: GridLevels, x0: number, y0: number): number[] {
    const packed: number[] = [];
    for (let i = 0; i < 32; i += 1) {
      const aIndex = i * 2;
      const bIndex = aIndex + 1;
      const ax = x0 + (aIndex % 8);
      const ay = y0 + Math.floor(aIndex / 8);
      const bx = x0 + (bIndex % 8);
      const by = y0 + Math.floor(bIndex / 8);
      const a = clampLevel(this.mapLevel(levels[ay]?.[ax] ?? 0));
      const b = clampLevel(this.mapLevel(levels[by]?.[bx] ?? 0));
      packed.push((a << 4) | b);
    }
    return packed;
  }
}

function cloneLevels(levels: GridLevels): GridLevels {
  return levels.map((row) => row.slice());
}

function clampLevel(value: number): number {
  return Math.max(0, Math.min(15, Math.round(value)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
