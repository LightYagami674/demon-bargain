import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SoundEngine, type AudioContextLike } from "./audio/soundEngine.js";

function createFakeGainNode() {
  return {
    gain: {
      value: 1,
      setValueAtTime: vi.fn(),
      setTargetAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

function createFakeOscillatorNode() {
  return {
    type: "sine" as OscillatorType,
    frequency: {
      value: 440,
      setValueAtTime: vi.fn(),
      setTargetAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function createFakeFilterNode() {
  return {
    type: "lowpass" as BiquadFilterType,
    frequency: { value: 350 },
    Q: { value: 1 },
    connect: vi.fn(),
  };
}

function createFakeBufferSource() {
  return {
    buffer: null as AudioBuffer | null,
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

export function createFakeAudioContext(initialState: AudioContextState = "suspended") {
  const gainNodes: ReturnType<typeof createFakeGainNode>[] = [];
  const oscillators: ReturnType<typeof createFakeOscillatorNode>[] = [];
  const filters: ReturnType<typeof createFakeFilterNode>[] = [];
  const bufferSources: ReturnType<typeof createFakeBufferSource>[] = [];

  const ctx: Omit<AudioContextLike, "state"> & {
    state: AudioContextState;
    _gainNodes: typeof gainNodes;
    _oscillators: typeof oscillators;
    _filters: typeof filters;
    _bufferSources: typeof bufferSources;
    resume: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    createBuffer: ReturnType<typeof vi.fn>;
  } = {
    state: initialState,
    currentTime: 10,
    sampleRate: 44100,
    destination: {} as AudioDestinationNode,
    _gainNodes: gainNodes,
    _oscillators: oscillators,
    _filters: filters,
    _bufferSources: bufferSources,
    resume: vi.fn(async () => {
      ctx.state = "running";
    }),
    close: vi.fn(async () => {
      ctx.state = "closed";
    }),
    createGain: vi.fn(() => {
      const node = createFakeGainNode();
      gainNodes.push(node);
      return node;
    }),
    createOscillator: vi.fn(() => {
      const node = createFakeOscillatorNode();
      oscillators.push(node);
      return node;
    }),
    createBiquadFilter: vi.fn(() => {
      const node = createFakeFilterNode();
      filters.push(node);
      return node;
    }),
    createBuffer: vi.fn((channels: number, length: number, sampleRate: number) => {
      const channelData = new Float32Array(length);
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        getChannelData: () => channelData,
      } as unknown as AudioBuffer;
    }),
    createBufferSource: vi.fn(() => {
      const node = createFakeBufferSource();
      bufferSources.push(node);
      return node;
    }),
  };

  return ctx;
}

describe("SoundEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("unlocks AudioContext, calls resume(), plays a 1-sample silent buffer, and supports mute toggling", async () => {
    const fakeCtx = createFakeAudioContext("suspended");
    const engine = new SoundEngine({ createAudioContext: () => fakeCtx });

    expect(engine.getStatus().unlocked).toBe(false);

    const unlocked = await engine.unlock();
    expect(unlocked).toBe(true);
    expect(fakeCtx.resume).toHaveBeenCalledTimes(1);
    expect(fakeCtx.createBuffer).toHaveBeenCalledWith(1, 1, 22050);
    expect(fakeCtx._bufferSources.length).toBeGreaterThanOrEqual(1);
    expect(fakeCtx._bufferSources[0]!.start).toHaveBeenCalledWith(0);

    const status = engine.getStatus();
    expect(status.unlocked).toBe(true);
    expect(status.muted).toBe(false);
    expect(status.contextState).toBe("running");

    // Toggle mute on -> off
    expect(engine.toggleMute()).toBe(true);
    expect(engine.getStatus().muted).toBe(true);
    // masterGain is index 0
    expect(fakeCtx._gainNodes[0]!.gain.setTargetAtTime).toHaveBeenCalledWith(
      0,
      fakeCtx.currentTime,
      0.04,
    );

    expect(engine.toggleMute()).toBe(false);
    expect(engine.getStatus().muted).toBe(false);
    expect(fakeCtx._gainNodes[0]!.gain.setTargetAtTime).toHaveBeenCalledWith(
      0.85,
      fakeCtx.currentTime,
      0.04,
    );

    engine.destroy();
    expect(fakeCtx.close).toHaveBeenCalledTimes(1);
  });

  it("scales BPM from 65 to 155, fades in 45Hz sub-bass drone above 20% Doom, and schedules lub-dub heartbeat with 2x harmonic overtone", async () => {
    const fakeCtx = createFakeAudioContext("running");
    const engine = new SoundEngine({ createAudioContext: () => fakeCtx });
    await engine.unlock();

    // At 0% Doom: 65 BPM, droneGain 0
    engine.setDoom(0);
    expect(engine.getBpm()).toBe(65);
    expect(engine.getStatus().droneGain).toBe(0);

    // At 20% Doom: still 0 drone gain (fades in above 20%)
    engine.setDoom(20);
    expect(engine.getBpm()).toBe(83);
    expect(engine.getStatus().droneGain).toBe(0);

    // At 100% Doom: 155 BPM, droneGain peaks at 0.22
    engine.setDoom(100);
    expect(engine.getBpm()).toBe(155);
    expect(engine.getStatus().droneGain).toBeCloseTo(0.22, 5);

    // Clamping out-of-range Doom
    engine.setDoom(140);
    expect(engine.getBpm()).toBe(155);
    engine.setDoom(-10);
    expect(engine.getBpm()).toBe(65);

    // Verify 45Hz sine + 45.7Hz triangle drone oscillators and 135Hz lowpass filter
    const drone45 = fakeCtx._oscillators.find(
      (o) => o.type === "sine" && o.frequency.value === 45,
    );
    const drone457 = fakeCtx._oscillators.find(
      (o) => o.type === "triangle" && o.frequency.value === 45.7,
    );
    const droneFilter = fakeCtx._filters.find(
      (f) => f.type === "lowpass" && f.frequency.value === 135,
    );
    expect(drone45).toBeDefined();
    expect(drone457).toBeDefined();
    expect(droneFilter).toBeDefined();

    // Verify lub-dub heartbeat played on unlock with 2x harmonic overtones
    // First beat spawns 2 thumps (lub + dub), each with 2 oscillators (sine + 2x triangle)
    const thumpOscs = fakeCtx._oscillators.filter(
      (o) => o !== drone45 && o !== drone457,
    );
    expect(thumpOscs.length).toBeGreaterThanOrEqual(4);
    expect(thumpOscs.some((o) => o.type === "triangle")).toBe(true);

    engine.destroy();
  });

  it("triggers an 1850Hz bandpass-filtered white-noise static burst when unlocked and unmuted", async () => {
    const fakeCtx = createFakeAudioContext("running");
    const engine = new SoundEngine({ createAudioContext: () => fakeCtx });

    // No-op before unlock
    engine.triggerStaticBurst(0.28);
    expect(fakeCtx.createBufferSource).not.toHaveBeenCalled();

    await engine.unlock();
    const sourcesBefore = fakeCtx._bufferSources.length;

    engine.triggerStaticBurst(0.28);
    expect(fakeCtx._bufferSources.length).toBe(sourcesBefore + 1);

    const bandpass = fakeCtx._filters.find(
      (f) => f.type === "bandpass" && f.frequency.value === 1850 && f.Q.value === 1.4,
    );
    expect(bandpass).toBeDefined();

    // No-op when muted
    engine.setMuted(true);
    engine.triggerStaticBurst(0.28);
    expect(fakeCtx._bufferSources.length).toBe(sourcesBefore + 1);

    engine.destroy();
  });
});
