export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): void;
  setTargetAtTime(target: number, startTime: number, timeConstant: number): void;
  exponentialRampToValueAtTime(value: number, endTime: number): void;
}

export interface GainNodeLike {
  gain: AudioParamLike;
  connect(destination: unknown): void;
  disconnect?(): void;
}

export interface OscillatorNodeLike {
  type: OscillatorType;
  frequency: AudioParamLike;
  connect(destination: unknown): void;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface BiquadFilterNodeLike {
  type: BiquadFilterType;
  frequency: { value: number };
  Q: { value: number };
  connect(destination: unknown): void;
}

export interface BufferSourceNodeLike {
  buffer: AudioBuffer | null;
  connect(destination: unknown): void;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioContextLike {
  readonly state: AudioContextState;
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: AudioDestinationNode;
  resume(): Promise<void>;
  close(): Promise<void>;
  createGain(): GainNodeLike;
  createOscillator(): OscillatorNodeLike;
  createBiquadFilter(): BiquadFilterNodeLike;
  createBuffer(
    numberOfChannels: number,
    length: number,
    sampleRate: number,
  ): AudioBuffer;
  createBufferSource(): BufferSourceNodeLike;
}

export interface SoundEngineStatus {
  unlocked: boolean;
  muted: boolean;
  contextState: AudioContextState | "uninitialized";
  bpm: number;
  droneGain: number;
}

export interface SoundEngineOptions {
  initialMuted?: boolean;
  createAudioContext?: () => AudioContextLike | null;
  onStateChange?: (status: SoundEngineStatus) => void;
}

function defaultCreateAudioContext(): AudioContextLike | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  return new Ctor() as unknown as AudioContextLike;
}

const MASTER_UNMUTED_GAIN = 0.85;

/**
 * Zero-DOM-coupling Web Audio synthesizer for Demon Bargain:
 * - iOS Safari / Android Chrome first-gesture unlock with 1-sample silent buffer
 * - 65-155 BPM lub-dub heartbeat with 2x harmonic overtone
 * - 45Hz sub-bass drone fading in above 20% Doom
 * - 1850Hz bandpass white-noise static bursts
 */
export class SoundEngine {
  private ctx: AudioContextLike | null = null;
  private masterGain: GainNodeLike | null = null;
  private droneGain: GainNodeLike | null = null;
  private droneOscA: OscillatorNodeLike | null = null;
  private droneOscB: OscillatorNodeLike | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private unlocked = false;
  private muted: boolean;
  private doom = 0;
  private readonly createAudioContext: () => AudioContextLike | null;
  private readonly onStateChange?: (status: SoundEngineStatus) => void;

  constructor(options: SoundEngineOptions = {}) {
    this.muted = options.initialMuted ?? false;
    this.createAudioContext =
      options.createAudioContext ?? defaultCreateAudioContext;
    this.onStateChange = options.onStateChange;
  }

  async unlock(): Promise<boolean> {
    if (!this.ctx) {
      this.ctx = this.createAudioContext();
      if (!this.ctx) return false;
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : MASTER_UNMUTED_GAIN;
      this.masterGain.connect(this.ctx.destination);
    }

    if (this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch {
        return false;
      }
    }

    // Play a 1-sample silent buffer for iOS Safari / Android Chrome hardware unlock
    const silentBuffer = this.ctx.createBuffer(1, 1, 22050);
    const silentSrc = this.ctx.createBufferSource();
    silentSrc.buffer = silentBuffer;
    silentSrc.connect(this.masterGain ?? this.ctx.destination);
    silentSrc.start(0);

    const wasUnlocked = this.unlocked;
    this.unlocked = true;

    if (!wasUnlocked) {
      this.setupDrone();
      this.scheduleHeartbeat();
    }

    this.emitState();
    return true;
  }

  setDoom(doomPct: number): void {
    const clamped = Math.max(0, Math.min(100, doomPct));
    this.doom = clamped;
    if (this.ctx && this.droneGain) {
      this.droneGain.gain.setTargetAtTime(
        this.targetDroneGain(),
        this.ctx.currentTime,
        0.18,
      );
    }
    this.emitState();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(
        this.muted ? 0 : MASTER_UNMUTED_GAIN,
        this.ctx.currentTime,
        0.04,
      );
    }
    if (this.ctx && this.droneGain) {
      this.droneGain.gain.setTargetAtTime(
        this.targetDroneGain(),
        this.ctx.currentTime,
        0.18,
      );
    }
    this.emitState();
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  triggerStaticBurst(durationSec = 0.28): void {
    if (!this.unlocked || this.muted || !this.ctx || !this.masterGain) return;

    const now = this.ctx.currentTime;
    const sampleRate = this.ctx.sampleRate;
    const length = Math.max(1, Math.floor(sampleRate * durationSec));
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;

    const bandpass = this.ctx.createBiquadFilter();
    bandpass.type = "bandpass";
    bandpass.frequency.value = 1850;
    bandpass.Q.value = 1.4;

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.001, now);
    env.gain.exponentialRampToValueAtTime(0.32, now + 0.02);
    env.gain.exponentialRampToValueAtTime(0.001, now + durationSec);

    src.connect(bandpass);
    bandpass.connect(env);
    env.connect(this.masterGain);

    src.start(now);
    src.stop(now + durationSec + 0.02);
  }

  getBpm(): number {
    return Math.round(65 + (this.doom / 100) * 90);
  }

  getStatus(): SoundEngineStatus {
    return {
      unlocked: this.unlocked,
      muted: this.muted,
      contextState: this.ctx ? this.ctx.state : "uninitialized",
      bpm: this.getBpm(),
      droneGain: this.targetDroneGain(),
    };
  }

  destroy(): void {
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try {
      this.droneOscA?.stop();
      this.droneOscB?.stop();
    } catch {
      // Ignore oscillator stop errors if already stopped
    }
    this.droneOscA = null;
    this.droneOscB = null;
    this.droneGain = null;
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
    this.masterGain = null;
    this.unlocked = false;
  }

  private targetDroneGain(): number {
    if (!this.unlocked || this.muted || this.doom <= 20) return 0;
    const t = (this.doom - 20) / 80;
    return 0.03 + t * 0.19;
  }

  private setupDrone(): void {
    if (!this.ctx || !this.masterGain || this.droneGain) return;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 135;

    const gain = this.ctx.createGain();
    gain.gain.value = this.targetDroneGain();
    filter.connect(gain);
    gain.connect(this.masterGain);

    const oscA = this.ctx.createOscillator();
    oscA.type = "sine";
    oscA.frequency.value = 45;
    oscA.connect(filter);
    oscA.start();

    const oscB = this.ctx.createOscillator();
    oscB.type = "triangle";
    oscB.frequency.value = 45.7;
    const subGainB = this.ctx.createGain();
    subGainB.gain.value = 0.35;
    oscB.connect(subGainB);
    subGainB.connect(filter);
    oscB.start();

    this.droneGain = gain;
    this.droneOscA = oscA;
    this.droneOscB = oscB;
  }

  private scheduleHeartbeat(): void {
    if (!this.unlocked || !this.ctx) return;

    if (!this.muted) {
      const now = this.ctx.currentTime;
      const intensity = 0.18 + (this.doom / 100) * 0.42;
      const dubDelay = Math.max(0.11, 0.21 - (this.doom / 100) * 0.08);
      this.playThump(now, 64, 34, intensity);
      this.playThump(now + dubDelay, 52, 28, intensity * 0.72);
    }

    const intervalMs = Math.round(60000 / this.getBpm());
    this.heartbeatTimer = setTimeout(() => {
      this.scheduleHeartbeat();
    }, intervalMs);
  }

  private playThump(
    startTime: number,
    peakFreq: number,
    endFreq: number,
    gainPeak: number,
  ): void {
    if (!this.ctx || !this.masterGain) return;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 180;

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.exponentialRampToValueAtTime(
      Math.max(0.001, gainPeak),
      startTime + 0.015,
    );
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.16);

    filter.connect(env);
    env.connect(this.masterGain);

    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(peakFreq, startTime);
    osc.frequency.exponentialRampToValueAtTime(endFreq, startTime + 0.11);
    osc.connect(filter);
    osc.start(startTime);
    osc.stop(startTime + 0.18);

    // 2x harmonic overtone for mobile speaker audibility
    const harmonic = this.ctx.createOscillator();
    harmonic.type = "triangle";
    harmonic.frequency.setValueAtTime(peakFreq * 2, startTime);
    harmonic.frequency.exponentialRampToValueAtTime(
      endFreq * 2,
      startTime + 0.09,
    );
    const harmonicGain = this.ctx.createGain();
    harmonicGain.gain.value = 0.22;
    harmonic.connect(harmonicGain);
    harmonicGain.connect(filter);
    harmonic.start(startTime);
    harmonic.stop(startTime + 0.18);
  }

  private emitState(): void {
    this.onStateChange?.(this.getStatus());
  }
}
