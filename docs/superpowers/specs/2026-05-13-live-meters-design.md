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

## Frontend Implementation Details

### Design Constraints

This is a VSCode webview extension. All UI must integrate with the host theme:
- **No custom fonts** — use `var(--vscode-font-family)` and `var(--vscode-editor-font-family)` (monospace for numeric readouts)
- **No hardcoded colors for chrome** — all borders, backgrounds, text use VSCode CSS variables
- **Canvas drawing colors** are the exception: signal colors (green/yellow/red for levels, cyan for goniometer points) are hardcoded because they carry semantic meaning independent of theme

### CSS Variables (new, in `liveMeters.css`)

```css
:root {
  /* Layout */
  --live-meter-width: 48px;           /* right column fixed width */
  --live-column-border: 1px solid var(--vscode-foreground);

  /* Canvas signal colors — theme-independent */
  --meter-green:  #4caf50;
  --meter-yellow: #ffeb3b;
  --meter-red:    #f44336;
  --meter-peak-hold: rgba(255, 255, 255, 0.85);
  --meter-clip-active: #f44336;
  --meter-clip-inactive: rgba(244, 67, 54, 0.2);

  --spectrum-fill: rgba(100, 181, 246, 0.35);   /* blue-ish fill under curve */
  --spectrum-stroke: #64b5f6;                    /* curve line */
  --spectrum-grid: rgba(255, 255, 255, 0.08);    /* grid lines */
  --spectrum-label: var(--vscode-foreground);    /* axis labels */

  --gonioMeter-bg: #0d0d0d;
  --gonioMeter-grid: rgba(255, 255, 255, 0.07);
  --gonioMeter-axis: rgba(255, 255, 255, 0.18);
  --gonioMeter-point: #00e5ff;                   /* cyan dots */
  --gonioMeter-corr-positive: #4caf50;
  --gonioMeter-corr-negative: #f44336;
}
```

### Layout & Sizing

**Root layout** (`webview.ts`) uses CSS Grid:
```css
.root {
  display: grid;
  /* base: waveform+spectrogram | [live column] | [meter column] */
  grid-template-columns: 1fr [live-col-width] [meter-col-width];
}
```
- `[live-col-width]` is set via JS as a CSS custom property `--live-col-width` on the root element, recalculated by `ResizeObserver`
- `[meter-col-width]` is `var(--live-meter-width)` (48px), or `0` when hidden
- Both columns use `display: none` when their toggle is off — no layout remnants

**Middle column height split** (between Goniometer and Spectrum Analyzer):
- Default: 50/50
- Drag handle: a 4px tall `div.resize-handle` with `cursor: ns-resize`, updates a CSS custom property `--split-ratio` on the container
- Min height per panel: 120px

**Fullscreen overlay:**
```css
.live-analysis-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: var(--vscode-editor-background);
  display: grid;
  grid-template-rows: 1fr 4px 1fr;  /* top panel, handle, bottom panel */
}
```
Triggered by expand button; dismissed by `keydown:Escape` and `contextmenu` (right-click).

### Level Meter Canvas

**Canvas dimensions:** width = `--live-meter-width / 2 - 1px` per channel (two bars side by side with 1px gap), height = full column height.

**Drawing order per frame:**
1. `clearRect` full canvas
2. Draw RMS bar (bottom-up): color determined by `smoothedRms` value against thresholds
3. Draw Peak bar on top of RMS bar (same color, slightly brighter: `filter: brightness(1.3)` — achieved by using a lighter shade constant)
4. Draw peak hold line: 2px horizontal line, `--meter-peak-hold` color
5. Draw clip LED: 6×6px rect at top, color `--meter-clip-active` or `--meter-clip-inactive`
6. Draw scale ticks and labels on rightmost channel only (to save space): right-aligned, `9px var(--vscode-editor-font-family)`

**dBFS → canvas Y mapping:**
```ts
// dbMin = -60, dbMax = 0
const y = canvasH * (1 - (db - dbMin) / (dbMax - dbMin));
// clamp to [0, canvasH]
```

**Channel labels:** "L" and "R" in `10px var(--vscode-font-family)`, centered above each bar, color `var(--vscode-foreground)` at 60% opacity.

### Spectrum Analyzer Canvas

**Canvas fills its container** (4:3 aspect ratio container, canvas is `width: 100%; height: 100%`).

**Padding inside canvas** (for axis labels): `left: 36px, bottom: 20px, top: 8px, right: 8px`. The drawable area is the remaining rect.

**Grid lines:**
- Vertical: one per frequency tick (20, 50, 100, 200, 500, 1k, 2k, 5k, 10k, 20k Hz) — `--spectrum-grid` color, 1px
- Horizontal: one per dB tick (0, -12, -24, -36, -48, -60, -90) — same

**Curve rendering:**
- After interpolation, build a `Path2D` from the 300 points
- Stroke with `--spectrum-stroke`, lineWidth 1.5px
- Fill from curve down to bottom edge with `--spectrum-fill`

**Axis labels:** `9px var(--vscode-editor-font-family)`, color `--spectrum-label`
- Frequency labels: centered below each vertical grid line, abbreviated (e.g. "1k", "10k")
- dB labels: right-aligned in the left padding area

### Goniometer Canvas

**Canvas is square** — enforced by JS: `canvas.height = canvas.width` on resize.

**Drawing order per frame:**
1. Fill background `--gonioMeter-bg` (do NOT clearRect — background fill is the clear)
2. Draw concentric circles (r = 0.25, 0.5, 0.75, 1.0 × half-canvas): `--gonioMeter-grid`, 1px
3. Draw X-axis and Y-axis lines: `--gonioMeter-grid`, 1px
4. Draw ±45° diagonal reference lines (the "X" shape): `--gonioMeter-axis`, 1px, dashed `[4, 4]`
5. Draw all buffered points: iterate ring buffer, set `ctx.globalAlpha = point.alpha`, fillRect 1.5×1.5px at mapped coords, color `--gonioMeter-point`
6. Reset `globalAlpha = 1`

**Coordinate mapping:**
```ts
const px = cx + x * (canvasW / 2) * 0.9;   // 0.9 = margin factor
const py = cy - y * (canvasH / 2) * 0.9;
```

**Info panel** (below square canvas, within 4:3 container):
- Correlation bar: full-width `<div>` with a centered fill, color interpolated between `--gonioMeter-corr-negative` (red, corr=-1) → white (corr=0) → `--gonioMeter-corr-positive` (green, corr=+1)
- Numeric readout: `"CC: +0.82"` in `11px var(--vscode-editor-font-family)`, right-aligned
- Both use HTML elements (not canvas), styled with VSCode variables

### Expand Button

Positioned `absolute; top: 6px; right: 6px` within the live analysis container.

```css
.expand-btn {
  width: 20px; height: 20px;
  background: var(--vscode-button-secondaryBackground);
  border: 1px solid var(--vscode-foreground);
  color: var(--vscode-foreground);
  font-size: 11px;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.15s;
}
.expand-btn:hover { opacity: 1; }
```

Icon: `⤢` (U+2922) or a simple SVG arrow-out-of-box (4 lines, no library).

### Settings UI Additions (`analyzeSettingsComponent.ts`)

New controls follow the exact same pattern as existing settings rows:
- Toggle rows: `<label><input type="checkbox"> Show Level Meter</label>`
- Select row: `<label>Live FFT Size <select><option>512...4096</option></select></label>`
- Styled with existing `analyzeSetting__*` CSS classes — no new CSS needed for the settings panel itself

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
