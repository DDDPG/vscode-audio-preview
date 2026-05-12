# Live Meters Design

## Context

This adds three real-time audio visualization modules to the vscode-audio-preview extension: a stereo level meter, a real-time spectrum analyzer, and a phase correlation goniometer. These are optional overlays on top of the existing waveform + spectrogram layout, activated via settings toggles.

The core layout remains unchanged (waveform + spectrogram). The new modules attach as optional columns to the right.

---

## Layout

```
┌─────────────────────┬──────────────────┬────────┐
│   Waveform          │  Goniometer      │        │
│   (flex-grow)       │  (1:1 canvas +   │  L  R  │
│                     │   info panel)    │        │
├─────────────────────┼──────────────────│ Level  │
│   Spectrogram       │  Spectrum        │ Meter  │
│   (flex-grow)       │  Analyzer (4:3)  │        │
└─────────────────────┴──────────────────┴────────┘
```

**Middle column width** is derived from the container height:
- Both components are 4:3 aspect ratio (Goniometer: 1:1 canvas inside a 4:3 container)
- Stacked height = 2 × (3/4 × width) → width = total_height × 2/3
- Recalculated on `ResizeObserver` of the root container

**Middle column** (Goniometer + Spectrum Analyzer):
- Single toggle `showLiveAnalysis` in settings
- Disappears entirely when off (waveform/spectrogram expand to fill)
- Vertical resize handle between the two components (drag to adjust split)
- Expand button (↗) in top-right corner → full-screen overlay; dismiss with ESC or right-click

**Right column** (Level Meter):
- Separate toggle `showLevelMeter`
- Fixed width ~48px, spans full height
- Disappears entirely when off

---

## Web Audio Chain Changes

**File:** `src/webview/services/playerService.ts`

Current chain:
```
AudioBufferSourceNode → [HPF] → [LPF] → GainNode → destination
```

New chain:
```
AudioBufferSourceNode → [HPF] → [LPF] → GainNode → ChannelSplitterNode
                                                          ↓           ↓
                                                      AnalyserL   AnalyserR
                                                          ↓           ↓
                                                      ChannelMergerNode → destination
```

- `AnalyserL` and `AnalyserR` are created when either live module is enabled
- `fftSize` for both is controlled by `liveAnalysisFftSize` setting (default 2048)
- Expose `getAnalysers(): { left: AnalyserNode, right: AnalyserNode } | null`
- Tear down splitter/merger/analysers when both modules are disabled

---

## Module 1: Level Meter

**File:** `src/webview/components/liveMeters/levelMeterComponent.ts`

**Data source:** `AnalyserL/R.getFloatTimeDomainData()` each animation frame

**Per-channel computation:**
```
rms = sqrt(mean(samples²))
peak = max(abs(samples))
rmsDb = 20 * log10(max(rms, 1e-9))
peakDb = 20 * log10(max(peak, 1e-9))
```

**Smoothing (your formula):**
```ts
smoothedRms[ch] = currentRmsDb < smoothedRms[ch]
  ? smoothedRms[ch] * decay + currentRmsDb * (1 - decay)
  : currentRmsDb;
// decay ≈ 0.85 per frame at 60fps ≈ ~150ms fall time
```

**Peak hold:**
- `peakHold[ch]`: updated to `peakDb` whenever `peakDb > peakHold[ch]`
- Held for 2s (frame counter), then falls with same decay formula
- Clip indicator: set when `peakDb > 0`, cleared on click

**Canvas layout (per channel, vertical bar):**
```
[clip LED]
[peak hold line]
[peak bar    ]  ← bright color
[rms bar     ]  ← darker color, drawn on top of peak bar
[dBFS scale  ]  ← right-aligned tick labels
```

**Color zones:**
- < -6 dBFS: green `#4caf50`
- -6 to -3 dBFS: yellow `#ffeb3b`
- > -3 dBFS: red `#f44336`

**Scale ticks:** 0, -3, -6, -12, -18, -24, -36, -48, -60 dBFS

---

## Module 2: Spectrum Analyzer

**File:** `src/webview/components/liveMeters/spectralAnalyzerComponent.ts`

**Data source:** Average of `AnalyserL` and `AnalyserR` `getFloatFrequencyData()` (already in dBFS)

**Interpolation pipeline:**

```
getFloatFrequencyData() → N linear FFT bins (dBFS)
    ↓ Step 1: Log-frequency resampling
    Generate 300 log-spaced frequency points from 20Hz to 20kHz.
    For each target freq, find surrounding FFT bins and linear-interpolate dBFS.
    ↓ Step 2: Cardinal Quintic B-spline smoothing
    Apply 5th-order B-spline over the 300 points.
    Basis matrix is fixed; compute once. O(300) per frame.
    ↓ Step 3: Modified Akima interpolation
    Apply modified Akima over B-spline output (same 300 points).
    Handles peaks conservatively, suppresses B-spline ringing.
    ↓ Canvas: fill path from bottom (-90 dBFS) to curve
```

**B-spline implementation:** Self-contained ~60 lines in `src/webview/utils/quinticBSpline.ts`. No external library. Uses the standard quintic uniform B-spline basis matrix.

**Akima implementation:** Self-contained ~80 lines in `src/webview/utils/modifiedAkima.ts`. Based on Akima (1991) modified algorithm (uses median slopes to reduce overshoot).

**Axes:**
- X: 20Hz–20kHz, log scale. Ticks: 20, 50, 100, 200, 500, 1k, 2k, 5k, 10k, 20k Hz
- Y: -90 to 0 dBFS. Ticks: 0, -12, -24, -36, -48, -60, -90

**Settings control:** `liveAnalysisFftSize` — 512 / 1024 / 2048 / 4096 (independent from spectrogram windowSize)

---

## Module 3: Goniometer

**File:** `src/webview/components/liveMeters/goniometerComponent.ts`

**Data source:** `AnalyserL/R.getFloatTimeDomainData()` — raw L/R PCM samples

**Coordinate transform (Mid-Side rotation, 45°):**
```ts
const x = (L[i] + R[i]) / Math.SQRT2;  // Mid → horizontal
const y = (L[i] - R[i]) / Math.SQRT2;  // Side → vertical
// Canvas: cx + x * scale, cy - y * scale  (y-axis flipped)
```

This maps pure-L to -45° and pure-R to +45°, forming the X pattern.

**Point buffer:**
```ts
type Point = { x: number; y: number; alpha: number };
// Ring buffer, capacity = fftSize * bufferFrames (e.g. 2048 * 30)
// Each frame: push new points with alpha=1.0, then decay all:
point.alpha *= decayPerFrame;  // decayPerFrame ≈ 0.92 at 60fps
// Discard points where alpha < 0.02
```

**Canvas layout:**
- Square canvas (1:1), dark background `#111`
- Reference lines: X-cross at ±45°, concentric circles at 0.25, 0.5, 0.75, 1.0 amplitude
- Points drawn with `globalAlpha = point.alpha`, color `#00e5ff` (cyan)
- Info panel below canvas (within 4:3 container): correlation value, stereo width indicator

**Correlation value (displayed in info panel):**
```ts
const corr = dot(L, R) / (rms(L) * rms(R) * N);
// Range [-1, 1]; display as numeric + color bar
```

No essentia.js dependency. Pure Web Audio API + Canvas 2D.

---

## New Files

| File | Purpose |
|------|---------|
| `src/webview/components/liveMeters/levelMeterComponent.ts` | Level meter (L+R bars) |
| `src/webview/components/liveMeters/spectralAnalyzerComponent.ts` | Real-time spectrum analyzer |
| `src/webview/components/liveMeters/goniometerComponent.ts` | Phase correlation goniometer |
| `src/webview/components/liveMeters/liveAnalysisComponent.ts` | Container: goniometer + spectrum, resize handle, fullscreen |
| `src/webview/components/liveMeters/liveMeters.css` | Styles for all live meter components |
| `src/webview/utils/quinticBSpline.ts` | Cardinal Quintic B-spline (self-contained) |
| `src/webview/utils/modifiedAkima.ts` | Modified Akima interpolation (self-contained) |

## Modified Files

| File | Change |
|------|--------|
| `src/webview/services/playerService.ts` | Add ChannelSplitter + dual AnalyserNode; expose `getAnalysers()` |
| `src/webview/components/webview/webview.ts` | Layout: add middle column + right column; wire ResizeObserver for width calc |
| `src/config.ts` | Add `showLevelMeter`, `showLiveAnalysis`, `liveAnalysisFftSize` |
| `src/webview/components/analyzeSettings/analyzeSettingsComponent.ts` | Add toggles + fftSize selector for live modules |

---

## Settings

```ts
// New fields in config
showLevelMeter: boolean        // default: false
showLiveAnalysis: boolean      // default: false
liveAnalysisFftSize: 512 | 1024 | 2048 | 4096  // default: 2048
```

---

## Verification

1. **Level meter:** Open a stereo audio file, enable level meter, play — both L/R bars animate, peak hold line appears and falls after 2s, clip LED lights on loud material
2. **Spectrum analyzer:** Enable live analysis, play — spectrum curve updates in real time, log frequency axis correct, curve is smooth (no jagged FFT bins visible)
3. **Goniometer:** Play stereo content — point cloud forms X pattern, points fade over time; mono content → vertical line; out-of-phase → horizontal line
4. **Layout:** Resize VSCode panel — middle column width recalculates correctly; disable each module — layout collapses cleanly
5. **Fullscreen:** Click expand button — overlay covers full webview; ESC and right-click both dismiss
6. **Resize handle:** Drag vertical divider between goniometer and spectrum — both resize proportionally
7. **Build:** `npm run compile` passes with no TypeScript errors
