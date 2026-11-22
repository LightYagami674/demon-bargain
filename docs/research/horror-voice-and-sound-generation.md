# Horror Voice & Sound Generation Research for Demon Bargain

This document evaluates AI/neural voice generation, Web Audio API demonic DSP & procedural SFX, horror sound sourcing, and a practical static-asset architecture for **Demon Bargain** (mobile-first 2–6 player real-time web horror chat game on Cloudflare Workers + Workers Static Assets).

---

## 1. AI / Neural Voice Generation for Horror Entities

### 1.1 Commercial Cloud TTS & Voice Design APIs

| Provider / Model | Pricing & Free Tier | Commercial License | Horror / Entity Fit & Steerability | Primary Source |
| :--- | :--- | :--- | :--- | :--- |
| **ElevenLabs** (TTS & Voice Design) | **Free:** 10,000 credits/mo (~10 min TTS).<br>**Starter:** ~$5–$6/mo (30,000 credits/mo).<br>**Creator:** $22/mo (121,000 credits/mo). | **Free:** Non-commercial only (requires `elevenlabs.io` / `11.ai` attribution).<br>**Starter+:** Full commercial license. | Very high. **Voice Design API** generates bespoke character voices from text prompts (e.g., ancient, raspy, whispered). | [ElevenLabs Pricing](https://elevenlabs.io/pricing), [Voice Design API](https://elevenlabs.io/docs/api-reference/text-to-voice/design) |
| **OpenAI `gpt-4o-mini-tts`** | Token-based: ~$0.60 / 1M input text tokens; ~$10–$12 / 1M output audio tokens (~$0.015/min avg). | Commercial use permitted under OpenAI API terms. | High steerability via the `instructions` parameter (e.g., *"speak slowly in a cold, gravelly whisper"*). | [OpenAI Pricing](https://openai.com/api/pricing/), [gpt-4o-mini-tts Docs](https://platform.openai.com/docs/models/gpt-4o-mini-tts) |
| **OpenAI `tts-1` / `tts-1-hd`** | Character-based: $15 / 1M chars (`tts-1`), $30 / 1M chars (`tts-1-hd`). | Commercial use permitted. | Low steerability (fixed built-in voices, no `instructions` parameter). | [OpenAI Pricing](https://openai.com/api/pricing/) |
| **Google Gemini TTS** (`gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts`) | Token-based (through Dec 31, 2026): **$0.50 / 1M** input text tokens; **$9.00 / 1M** (`flash-tts`) or **$6.00 / 1M** (`flash-lite-tts`) output audio tokens (doubles Jan 1, 2027). Rate-limited free tier in Google AI Studio. | Commercial use on billed API tier. | Good acting nuance and prompt-driven delivery for pre-baking lines. | [Gemini API Pricing](https://ai.google.dev/gemini-api/docs/pricing) |

### 1.2 Open-Weights / Local / Browser-Runnable TTS

| Model | License | Runtime / Deployment | Horror / Entity Fit & Caveats | Primary Source |
| :--- | :--- | :--- | :--- | :--- |
| **Kokoro-82M** (`hexgrad/Kokoro-82M`) & **`kokoro-js`** | **Apache 2.0** (commercial use permitted). | **Local ($0):** Fast CPU/GPU offline pre-baking.<br>**Browser (`kokoro-js`):** WebGPU (`fp32`, ~326 MB download) or WASM (`q8`, ~80–93 MB download). | 82M-parameter StyleTTS 2 + ISTFTNet model. Great natural prosody for $0 offline pre-baking. **Too heavy for mobile 4G runtime** (~80–326 MB model download). | [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX), [kokoro-js](https://www.npmjs.com/package/kokoro-js) |
| **Piper TTS** (`rhasspy/piper`) | **MIT** (engine/code). *Voice checkpoints vary by training dataset.* | Fast local CPU inference (ONNX). Ideal for offline batch pre-baking. | Must inspect each voice's model card in `rhasspy/piper-voices` to verify commercial dataset permissions. | [rhasspy/piper](https://github.com/rhasspy/piper), [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) |
| **Chatterbox** (`resemble-ai/chatterbox`) | **MIT** (commercial use permitted). | Local GPU inference for offline pre-baking. | Expressive voice cloning/emotion control; repo is now a maintained public archive. | [resemble-ai/chatterbox](https://github.com/resemble-ai/chatterbox) |
| **F5-TTS** (`SWivid/F5-TTS`) | **MIT** (code only). | Local GPU inference. | **Commercial gotcha:** Default pretrained weights (trained on Emilia) carry **`CC-BY-NC-4.0` (non-commercial)** restrictions. | [SWivid/F5-TTS](https://github.com/SWivid/F5-TTS) |
| **Bark** (`suno-ai/bark`) | **MIT** (commercial use permitted). | Local GPU inference (slow for real-time). | Excels at non-speech vocalizations (sighs, laughs, eerie hesitations) useful for offline horror line generation. | [suno-ai/bark](https://github.com/suno-ai/bark) |

---

## 2. Web Audio API Demonic Voice Processing & Procedural Horror SFX

### 2.1 Why `window.speechSynthesis` Cannot Be Processed

The Web Speech API's `SpeechSynthesis` interface delegates directly to OS/browser-internal speech engines and outputs straight to hardware speakers ([MDN: SpeechSynthesis](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis)). It exposes **no `AudioNode`** and **no `MediaStream`**, so it cannot be routed into `AudioContext` or `MediaStreamAudioSourceNode` ([MDN: MediaStreamAudioSourceNode](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamAudioSourceNode)).

To apply real-time DSP effects, audio must enter the `AudioContext` graph via **`AudioBufferSourceNode`** (decoding fetched audio files with `BaseAudioContext.decodeAudioData()`) or **`MediaElementAudioSourceNode`** ([MDN: AudioBufferSourceNode](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode), [MDN: decodeAudioData](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData)).

### 2.2 Demonic Entity FX Chain (Web Audio Nodes)

Routing a clean or pre-baked voice `AudioBufferSourceNode` through this graph turns an ordinary voice into an unsettling, otherworldly Entity:

1. **Pitch-Shifted Doubled Layer (`AudioBufferSourceNode.detune` / `playbackRate`):**
   - Play two synchronized `AudioBufferSourceNode` instances of the same `AudioBuffer`:
     - Primary voice: slightly slowed/lowered (`detune = -200` to `-400` cents, or `playbackRate = 0.88`).
     - Sub-octave shadow layer: `detune = -1200` cents (or `playbackRate = 0.5–0.75`) mixed at ~0.35–0.5 gain.
   - Source: [MDN: AudioBufferSourceNode](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode).
2. **Gravelly Saturation (`WaveShaperNode`):**
   - Apply a non-linear soft-clipping `Float32Array` transfer curve via `WaveShaperNode.curve` to add demonic grit and harmonic roughness.
   - Source: [MDN: WaveShaperNode](https://developer.mozilla.org/en-US/docs/Web/API/WaveShaperNode).
3. **Dark EQ (`BiquadFilterNode`):**
   - Chain a `lowshelf` boost (~140 Hz, +4 to +6 dB) for chesty weight and a `lowpass` (cutoff ~3.5–4.5 kHz) to tame harsh digital sibilance.
   - Source: [MDN: BiquadFilterNode](https://developer.mozilla.org/en-US/docs/Web/API/BiquadFilterNode).
4. **Possessed Vocal Tremor / Ring Modulation (`GainNode` + `OscillatorNode`):**
   - Modulate a `GainNode.gain` `AudioParam` with a low-frequency `OscillatorNode` (`sine` or `triangle` at **30–50 Hz**) to create classic demonic/possessed amplitude tremor.
   - Sources: [MDN: GainNode](https://developer.mozilla.org/en-US/docs/Web/API/GainNode), [MDN: OscillatorNode](https://developer.mozilla.org/en-US/docs/Web/API/OscillatorNode).
5. **Whisper Pre-Echo / Tail (`DelayNode`):**
   - Route a parallel send through a `DelayNode` (40–120 ms) with low feedback (`GainNode` at ~0.2–0.3) for eerie overlapping whispers.
   - Source: [MDN: DelayNode](https://developer.mozilla.org/en-US/docs/Web/API/DelayNode).
6. **Cathedral / Cavern Reverb (`ConvolverNode`):**
   - Convolve the wet send with an impulse response `AudioBuffer` (either a tiny pre-baked IR file or a procedurally generated exponentially decaying filtered noise buffer) for cavernous space.
   - Source: [MDN: ConvolverNode](https://developer.mozilla.org/en-US/docs/Web/API/ConvolverNode).

### 2.3 Procedural Horror SFX in Web Audio (0 KB Asset Cost)

Using `OscillatorNode`, `BiquadFilterNode`, `GainNode`, and `AudioBufferSourceNode` noise buffers ([MDN: Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)):
- **FM Metallic Chimes / Bells:** Connect a modulator `OscillatorNode` at an inharmonic ratio (e.g., `1 : 1.414` or `1 : 2.756`) to a carrier `OscillatorNode.frequency`, shaped by an exponential `GainNode` decay.
- **Sub-Drops / Stingers:** `OscillatorNode` (`sine`/`triangle`) using `frequency.exponentialRampToValueAtTime()` from ~110 Hz down to ~32 Hz over 0.8–1.5 s.
- **Risers / Tension:** Layered `OscillatorNode`s or `BiquadFilterNode` (`bandpass`) sweeping upward over 2–6 s.
- **Filtered Breath / Whisper Noise:** White noise `AudioBuffer` routed through a swept `bandpass` `BiquadFilterNode` with moderate `Q`.

---

## 3. Generating & Sourcing Horror SFX & Ambience

### 3.1 AI Sound Effect Generators

| Tool / Model | Pricing / License | Notes | Primary Source |
| :--- | :--- | :--- | :--- |
| **ElevenLabs Sound Effects API** | **~$0.12 / minute** of generated audio (or monthly credit pool). Commercial use requires Starter+ plan. | Fast text-to-SFX for custom impacts, creaks, chimes, and stingers. | [ElevenLabs Sound Effects API](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert) |
| **Stability AI Stable Audio Open 1.0** | **Stability AI Community License:** Free for commercial use if annual revenue **< $1M USD** (gated Hugging Face repo). | Open-weights model for generating 44.1 kHz stereo sound effects and ambient loops locally. | [stabilityai/stable-audio-open-1.0](https://huggingface.co/stabilityai/stable-audio-open-1.0) |
| **Meta AudioGen** (`facebook/audiogen-medium`) | **`CC-BY-NC-4.0` (Non-Commercial Only).** | Cannot be used in commercial/monetized projects. | [facebook/audiogen-medium](https://huggingface.co/facebook/audiogen-medium), [facebookresearch/audiocraft](https://github.com/facebookresearch/audiocraft) |

### 3.2 Royalty-Free & CC0 Game Audio Sources

- **Sonniss GDC Game Audio Bundles:** Free annual multi-gigabyte bundles of commercial SFX. Custom license allows **unlimited commercial & personal projects with no attribution**, but **forbids** standalone raw redistribution or AI/ML training ([Sonniss GDC Bundle](https://sonniss.com/gameaudiogdc)).
- **Freesound.org:** Collaborative database with per-file licensing. Filter strictly by **CC0** (public domain) to avoid `CC-BY` attribution requirements or `CC-BY-NC` commercial bans ([Freesound](https://freesound.org/)).
- **Kenney.nl:** Clean **CC0** (public domain) UI and impact sound packs ready for commercial games ([Kenney Audio Assets](https://kenney.nl/assets)).
- **PaulXStretch:** Free extreme time-stretching tool (evolution of PaulStretch) that transforms short metallic clangs, whispers, or chimes into massive, eerie horror drones ([PaulXStretch](https://sonosaurus.com/paulxstretch/)).

---

## 4. Practical Architecture for Demon Bargain

### 4.1 Platform Constraints (Cloudflare Workers + Mobile Safari/Chrome)

- **Cloudflare Workers Static Assets (Free Tier):**
  - **$0/mo**, **unlimited static asset bandwidth**, **25 MiB** max per individual file, **20,000 files** max per Worker version ([Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/), [Static Assets Docs](https://developers.cloudflare.com/workers/static-assets/)).
- **Mobile Audio Codec Choice (`.mp3` / `.m4a` vs `.opus`):**
  - While Chrome and Firefox decode `.opus` cleanly, **iOS Safari's `decodeAudioData()` support for Opus containers has historically been fragmented** compared to native CoreAudio/AVFoundation formats ([MDN: Web Audio Codec Guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Audio_codecs)).
  - **Use `.mp3` or `.m4a` (AAC in MP4)** as the primary format for guaranteed cross-platform `decodeAudioData()` reliability on iOS Safari and Android Chrome.
- **iOS Autoplay & Interruption Handling:**
  - `AudioContext` initializes in `"suspended"` state and **must** be resumed via `audioContext.resume()` inside a user gesture (`click`, `touchend`) ([MDN: Autoplay Guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)).
  - On iOS Safari, backgrounding the tab or locking the screen moves `AudioContext.state` to `"interrupted"`; listen for `statechange` and call `.resume()` on the next user interaction ([MDN: BaseAudioContext.state](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state)).

### 4.2 Pre-Baked Static Clips vs. Runtime TTS

| Approach | Pros | Cons | Verdict for Demon Bargain |
| :--- | :--- | :--- | :--- |
| **Runtime Cloud TTS API** | Handles arbitrary `{player}` names dynamically. | Per-turn API cost, 300–1000ms+ network latency, requires API keys/rate-limiting on Worker. | Avoid for core game loop. |
| **In-Browser Neural TTS (`kokoro-js`)** | $0 API cost, dynamic text. | **80–326 MB** model download kills mobile 4G UX and strains mobile RAM. | Not viable for mobile-first party game. |
| **Pre-Baked Static `.mp3`/`.m4a` + Web Audio FX** | **$0/mo** on Cloudflare Static Assets, instant playback once cached, works offline/weak 4G, full `AudioContext` demonic DSP. | Needs a strategy for `{player}` / `{target}` / `{word}` placeholders. | **Recommended.** |

### 4.3 Handling Placeholders & Bandwidth Math

- **~60 Mood Hints + Non-Parameterized Beats:** Pre-bake 100% as static `.mp3` (or `.m4a`) files.
- **Parameterized Beats (`{player}`, `{target}`, `{word}`):**
  1. **Genericize where possible** (*"one of you"*, *"the marked soul"*, *"that forbidden word"*) so the full line can be pre-baked without splicing.
  2. **Stinger / Pause Substitution:** For lines that must reference a live player or word displayed in chat, play a pre-baked Entity carrier phrase + a procedural Web Audio chime/sub-drop while highlighting the player's name visually in the chat UI.
- **Size & Bandwidth Math:**
  - ~145 short Entity voice clips (~3.5 s average) encoded at **64 kbps mono MP3** (`8 KB/s`) ≈ **28 KB per clip** → **~4.1 MB total** for the entire voice library.
  - Add 10–15 SFX/ambient loops (e.g., 30 s ambient drone at 96 kbps ≈ 360 KB + short impacts) → **~5–6 MB total** (well below Cloudflare's **25 MiB** per-file cap).
  - **Lazy-load by game phase** (e.g., preload only UI/ambient + current round clips) so initial mobile 4G load stays under **500 KB**.

---

## 5. Top Recommended Stack for Demon Bargain

1. **Voice Generation (Offline Pre-Bake):** Use **Kokoro-82M** (Apache 2.0, $0 local batch script) or **OpenAI `gpt-4o-mini-tts`** (with ominous/whispered `instructions`) or **ElevenLabs Starter** ($5–$6/mo for 1 month to bake the library with Voice Design + commercial license).
2. **Demonic Post-Processing & Variation:** Run a lightweight **Web Audio API FX chain** (`AudioBufferSourceNode` dual-layer detune + `WaveShaperNode` + `BiquadFilterNode` + 35 Hz `GainNode` ring-mod + `ConvolverNode` reverb) so even repeated clips feel alive and unsettling.
3. **SFX & Ambience:** Combine **procedural Web Audio SFX** (0 KB chimes, sub-drops, risers, breath noise) with a handful of **CC0 / Sonniss / PaulXStretch** `.mp3`/`.m4a` ambient drones served from **Cloudflare Workers Static Assets**.
