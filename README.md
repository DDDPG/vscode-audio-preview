# audio-preview

Play audio, inspect metadata, and view **waveform** and **spectrogram** inside VS Code. Optimized for music analysis by @DDDPG.

**Formats:** `wav`, `mp3`, `aac`, `ogg`, `flac`, `opus`, `m4a`, `sph`, and more.

## Upstream

## This project is based on **[vscode-audio-preview](https://github.com/sukumo28/vscode-audio-preview)** by sukumo28 (published as **wav-preview** on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=sukumo28.wav-preview)).

## What we changed

### 1. Decoding stack

- Replaced the monolithic FFmpeg WASM decoder (required Docker build) with a layered decoder stack under `src/webview/decoders/`.
- Format-specific WASM decoders: MP3 (`mpg123-decoder`), FLAC (`@wasm-audio-decoders/flac`), Ogg Vorbis / Opus (`ogg-vorbis`, `ogg-opus-decoder`).
- **Web Audio `decodeAudioData`** as fallback for WAV, AAC, and browser-native formats.
- No Docker required; `npm install` is sufficient for development.

### 2. Build

- Webpack webview config enables **async WebAssembly** and emits `.wasm` files as assets.
- CSP updated to allow `worker-src` and `connect-src` so WASM decoders load correctly inside the webview sandbox.

### 3. STFT / spectrogram analysis

- Added **multiple FFT window types**: Hann, Hamming, Blackman–Harris, Triangular.
- Integrated **Essentia.js** (async WASM) as an optional FFT backend for windowing and spectrum; also used for **LUFS / EBU R128** loudness measurement.
- FFT backend is **user-selectable** via the *FFT backend* setting in the Analyze panel: Ooura (default, faster) or Essentia WASM (multi-window + LUFS).
- Optional **high-resolution STFT** mode (`WavPreview.highResolutionSpectrogram`) doubles canvas pixel density for sharper plots.
- **Auto FFT window size** (`fftWindowAuto`) infers an appropriate window from the visible time range and sample rate.

### 4. Spectrogram rendering

- **WebGL2 rendering path** (`spectrogramRenderer.ts`, `twgl.js`): packs all STFT frames into a single GPU texture and draws with one call, replacing per-pixel `fillRect` on Canvas2D. Measured **5–7× faster** CPU-side (e.g. 40.9 ms → 6.0 ms for 300 s audio).
- **Independent low / high dB** range controls replace the single amplitude-range slider.
- **Log-frequency axis** layout rewritten in `spectrogramFrequencyLayout.ts` with correct piecewise-log mapping.

### 5. Interaction & readouts

- Drag on any plot to select a time/frequency/amplitude range and re-analyze that region; hold **Ctrl** or **Shift** to constrain the axis.
- Right-click to reset the visible range (with Ctrl / Shift variants).
- Waveform / spectrogram hover emits `CURSOR_READOUT` events that drive **RMS, peak, and frequency** readouts in the info table.

### 6. Extension UX

- **Analyze UI cache** (`WavPreview.cacheAnalyzeUi`, default on): persists window type, dB range, FFT backend, and other panel settings across files via `globalState`.
- Phased UI initialization: player and info table appear immediately; analyzer initializes in an idle callback after the audio buffer is ready.

---

## Compared to upstream (architecture & everyday flows)

The upstream webview shipped a **single FFmpeg-based WASM decoder** that had to be **compiled via Docker** before development or packaging. This fork replaces that core with **small format-specific WASM decoders** and **browser `decodeAudioData`** where possible, and upgrades analysis/rendering around the same host → webview file transfer.

> **Benchmark methodology:** Numbers below come from `tmp_files/benchmark.js` (Node.js, Apple Silicon). Rendering figures measure CPU-side work only (texture pack vs. per-pixel color string); actual GPU draw is 1 call vs. millions of `fillRect` calls. Decoder figures measure WASM module init time. STFT figures are excluded here — see the FFT backend setting note below.


| Area                         | Original (upstream-style)                               | This fork                                                                                                                                       | Measured delta                                                                                              |
| ---------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Developer setup**          | Docker image + `make` to build decoder WASM before `F5` | `npm install` + webpack only; **no Docker** on the decode path                                                                                  | —                                                                                                           |
| **Decoder footprint**        | One large general-purpose FFmpeg WASM blob              | **Targeted** codec packages (MP3/FLAC/Ogg/Opus) + native decode fallback                                                                        | —                                                                                                           |
| **Decoder WASM init**        | FFmpeg WASM: requires Docker build + ~8 MB blob load    | Format-specific WASM (e.g. `mpg123-decoder`): **cold ~4 ms, warm ~0.15 ms**                                                                     | Cold start measured at **3.94 ms**; warm (cached) **0.15 ms**                                               |
| **Spectrogram redraw (CPU)** | Canvas2D `fillRect` + color string per pixel            | **WebGL2** texture pack + 1 draw call (`spectrogramRenderer.ts`)                                                                                | **5–7× faster** CPU-side across 10 s / 60 s / 300 s audio (e.g. 40.9 ms → 6.0 ms for 300 s)                 |
| **STFT / spectrogram math**  | Ooura FFT (JS), single Hann window                      | Ooura (default, faster) **or** Essentia.js WASM (multi-window types) — user-selectable via *FFT backend* setting                                | Ooura is the faster path; Essentia adds Hamming / Blackman–Harris / Triangular windows and LUFS calculation |
| **Host ↔ webview file I/O**  | Chunked `postMessage` transfer                          | Same chunked transfer; perceived readiness improves from faster decode + phased UI init                                                         | —                                                                                                           |
| **Analysis UX**              | Good baseline                                           | **dB range**, **log axis fixes**, optional **high-res STFT**, **cursor RMS/peak/freq** readouts, **analyze UI cache**, **FFT backend selector** | —                                                                                                           |


**Common operations in plain terms**

- **Clone and hack:** No decoder container — you get to a running extension faster and CI is simpler.
- **Open a file:** Same data copy into the webview; advantage is **faster decode** and richer analysis options once bytes arrive.
- **Tweak window / range / scale and re-analyze:** More control (windows, dB limits, high-res mode); STFT path is **engineered for throughput** (WASM + optional GPU draw).
- **Scrub or resize the spectrogram:** WebGL path targets **smoother** interaction on large canvases than pure CPU Canvas fills.

---

## Usage

how-to-use

- **Drag** on a plot to select a range and re-run analysis on that range. Hold **Ctrl** for time-focused selection, **Shift** for value-focused selection.
- **Right-click** to reset the visible range (with Ctrl / Shift variants for time-only or value-only reset).
- Use the in-editor **Analyze** tab for precise numeric settings.
- The **info table** can show cursor RMS / peak / frequency while you move over the waveform or spectrogram.

To open audio with this editor by default, set `workbench.editorAssociations` for your extensions (e.g. `*.wav`, `*.mp3`) to `wavPreview.audioPreview`.

---

## Settings

All optional. See `src/config.ts` and `package.json` → `contributes.configuration` for the full list.

```jsonc
"WavPreview.autoAnalyze": true
```

```jsonc
"WavPreview.playerDefault": {
  "initialVolume": 50
}
```

```jsonc
"WavPreview.analyzeDefault": {
  "spectrogramVisible": false
}
```

Fork-specific examples:

```jsonc
"WavPreview.highResolutionSpectrogram": false,
"WavPreview.cacheAnalyzeUi": true
```

---

## Development

1. Clone the repo
2. `npm install`
3. Press **F5** in VS Code to launch the Extension Development Host

Web assets are bundled to `dist/audioPreview.js`. Run `npm run test`, `npm run lint`, and `npm run format` as needed.

### References

- [Custom Editor API](https://code.visualstudio.com/api/extension-guides/custom-editors)  
- [custom-editor-sample](https://github.com/microsoft/vscode-extension-samples/tree/main/custom-editor-sample)

---

## TODO

### Live meters (next major feature)

1. **Playback tap** — branch the Web Audio graph so stereo output can feed analyser nodes during playback without affecting normal listening.
2. **Stereo level meter** — classic L/R RMS / peak / hold / clip display in a slim column beside the existing waveform/spectrogram area.
3. **Live spectrum** — real-time log-frequency spectrum updated each animation frame during playback, sharing the live-analysis column.
4. **Goniometer** — phase / stereo goniometer (mid–side “X” display) with correlation readout, co-located with the live spectrum.
5. **Layout & chrome** — extend the webview shell to host the above modules in resizable extra columns; support vertical split and fullscreen overlay; expose FFT size and toggle controls in the existing settings style.

### Live feature extractor

1. **F0 / pitch tracking** — frame-by-frame fundamental frequency estimate (e.g. YIN or autocorrelation), displayed as a pitch curve overlay on the spectrogram or as a dedicated readout. Useful for monophonic melody, voice, and instrument tuning checks.
2. **Time-aware loudness** — rolling EBU R128 metrics updated each hop:
  - **LUFS-M** (momentary, 400 ms window) and **LUFS-S** (short-term, 3 s window) as live bar graphs.
  - **LUFS-I** (integrated, gated) accumulated from playback start.
  - **PLR** (peak-to-loudness ratio) and **LRA** (loudness range) derived from the same measurement window.
  - Reuses the Essentia `LoudnessEBUR128` path already wired in `analyzeService.ts`.
3. **Chroma** — 12-bin pitch-class energy vector per frame, computed via:
  - **CQT-based chroma** for harmonic content (better octave invariance).
  - **STFT-based chroma** as a lighter fallback when Essentia is unavailable.
  - Displayed as a scrolling chromagram strip (time × 12 pitch classes, color-coded by energy).
4. **Auto-tagging / event detection** — lightweight onset and structure markers overlaid on the timeline:
  - **Onset detection** (spectral flux or HFC) marks transient events (beats, note attacks, percussive hits).
  - **Structural segmentation** groups the timeline into coarse regions (intro, verse, chorus, etc.) using self-similarity or novelty-curve analysis.
  - Markers rendered as vertical lines / region shading on the waveform canvas; clicking a marker seeks playback to that position.

