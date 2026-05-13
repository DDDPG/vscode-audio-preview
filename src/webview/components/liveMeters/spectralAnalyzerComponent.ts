import { EventType } from "../../events";
import Component from "../../component";
import PlayerService from "../../services/playerService";
import AnalyzeSettingsService from "../../services/analyzeSettingsService";
import { quinticBSplineSmooth } from "../../utils/quinticBSpline";
import { akimaResample } from "../../utils/modifiedAkima";
import {
  monitoringGainsForMode,
  smoothingPctToDecay,
  spectrumTiltDbAboveFloor,
} from "../../utils/liveMonitoring";

const DB_FLOOR = -90;
const DB_CEIL = 0;
const LOG_POINTS = 300;
const FREQ_MIN = 20;
const FREQ_MAX = 20000;

const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const DB_TICKS = [0, -12, -24, -36, -48, -60, -90];
const MAX_CANVAS_PX = 4096;

function logFreqPoints(): Float64Array {
  const pts = new Float64Array(LOG_POINTS);
  const lo = Math.log10(FREQ_MIN);
  const hi = Math.log10(FREQ_MAX);
  for (let i = 0; i < LOG_POINTS; i++) {
    pts[i] = Math.pow(10, lo + (i / (LOG_POINTS - 1)) * (hi - lo));
  }
  return pts;
}

const LOG_FREQS = logFreqPoints();

function lerpF32(arr: Float32Array, idx: number): number {
  const n = arr.length;
  if (n < 2) return DB_FLOOR;
  const i = Math.max(0, Math.min(n - 2, Math.floor(idx)));
  const f = idx - i;
  return arr[i] * (1 - f) + arr[i + 1] * f;
}

function hzFromCanvasX(x: number, padL: number, drawW: number): number {
  const t = (x - padL) / drawW;
  const tl = Math.max(0, Math.min(1, t));
  const lo = Math.log10(FREQ_MIN);
  const hi = Math.log10(FREQ_MAX);
  return Math.pow(10, lo + tl * (hi - lo));
}

function dbFromCanvasY(y: number, padT: number, drawH: number): number {
  const t = (y - padT) / drawH;
  const tl = Math.max(0, Math.min(1, t));
  return DB_FLOOR + (1 - tl) * (DB_CEIL - DB_FLOOR);
}

function logIndexFromHz(hz: number): number {
  const lo = Math.log10(FREQ_MIN);
  const hi = Math.log10(FREQ_MAX);
  return (
    ((Math.log10(Math.max(hz, FREQ_MIN)) - lo) / (hi - lo)) * (LOG_POINTS - 1)
  );
}

function fmtHzLive(hz: number): string {
  if (!Number.isFinite(hz)) return "—";
  if (hz >= 10000) return `${(hz / 1000).toFixed(2)} kHz`;
  if (hz >= 1000) return `${(hz / 1000).toFixed(3)} kHz`;
  return `${hz.toFixed(1)} Hz`;
}

export default class SpectralAnalyzerComponent extends Component {
  private _container: HTMLElement;
  private _canvas: HTMLCanvasElement;
  private _readoutEl: HTMLElement;
  private _playerService: PlayerService;
  private _analyzeSettingsService: AnalyzeSettingsService;
  private _rafId: number = 0;
  private _bufL: Float32Array = new Float32Array(1024);
  private _bufR: Float32Array = new Float32Array(1024);
  private _emaPeak: Float32Array = new Float32Array(LOG_POINTS);
  private _emaRms: Float32Array = new Float32Array(LOG_POINTS);
  private _hoverCx = 0;
  private _hoverCy = 0;
  private _hoverActive = false;

  /** Keep animating while playing or while the pointer is over the plot (crosshair / readout when paused). */
  private _shouldRunRaf(): boolean {
    return this._playerService.isPlaying || this._hoverActive;
  }

  private _syncRafToState() {
    if (this._shouldRunRaf()) {
      this._startRaf();
    } else {
      this._stopRaf();
    }
  }

  constructor(
    containerEl: HTMLElement,
    playerService: PlayerService,
    analyzeSettingsService: AnalyzeSettingsService,
  ) {
    super();
    this._playerService = playerService;
    this._analyzeSettingsService = analyzeSettingsService;
    this._container = containerEl;

    containerEl.innerHTML = `<div class="spectralAnalyzerComponent">
      <canvas class="spectralAnalyzer__canvas"></canvas>
      <div class="spectralAnalyzer__hoverReadout" style="visibility:hidden" aria-live="polite"></div>
    </div>`;
    this._canvas = containerEl.querySelector(".spectralAnalyzer__canvas");
    this._readoutEl = containerEl.querySelector(
      ".spectralAnalyzer__hoverReadout",
    ) as HTMLElement;

    this._emaPeak.fill(DB_FLOOR);
    this._emaRms.fill(DB_FLOOR);

    this._addEventlistener(containerEl, EventType.MOUSE_MOVE, (e: MouseEvent) => {
      const r = this._canvas.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      this._hoverActive = true;
      this._hoverCx = (e.clientX - r.left) * (this._canvas.width / r.width);
      this._hoverCy = (e.clientY - r.top) * (this._canvas.height / r.height);
      this._syncRafToState();
    });
    this._addEventlistener(containerEl, "mouseleave", () => {
      this._hoverActive = false;
      this._readoutEl.style.visibility = "hidden";
      // Redraw once: stopping RAF cancels the next frame, which would otherwise
      // leave the last crosshair painted on the canvas.
      this._draw();
      this._syncRafToState();
    });

    this._addEventlistener(playerService, EventType.UPDATE_IS_PLAYING, () => {
      this._syncRafToState();
    });

    this._syncRafToState();
  }

  private _startRaf() {
    if (!this._shouldRunRaf() || this._rafId) return;
    const loop = () => {
      this._draw();
      if (this._shouldRunRaf()) {
        this._rafId = requestAnimationFrame(loop);
      } else {
        this._rafId = 0;
      }
    };
    this._rafId = requestAnimationFrame(loop);
  }

  private _stopRaf() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
  }

  private _draw() {
    const analysers = this._playerService.getAnalysers();
    const playing = this._playerService.isPlaying;

    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, Math.floor(this._container.clientWidth));
    const cssH = Math.max(1, Math.floor(this._container.clientHeight));
    const w = Math.min(MAX_CANVAS_PX, Math.max(1, Math.round(cssW * dpr)));
    const h = Math.min(MAX_CANVAS_PX, Math.max(1, Math.round(cssH * dpr)));
    if (this._canvas.width !== w || this._canvas.height !== h) {
      this._canvas.width = w;
      this._canvas.height = h;
    }
    const ctx = this._canvas.getContext("2d");
    if (!ctx || w <= 0 || h <= 0) return;

    const padL = 28 * dpr;
    const padB = 16 * dpr;
    const padT = 6 * dpr;
    const padR = 4 * dpr;
    const drawW = w - padL - padR;
    const drawH = h - padB - padT;

    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = "#0f0f0f";
    ctx.fillRect(0, 0, w, h);

    if (drawW <= 0 || drawH <= 0) return;

    const freqToX = (f: number) =>
      padL +
      ((Math.log10(f) - Math.log10(FREQ_MIN)) /
        (Math.log10(FREQ_MAX) - Math.log10(FREQ_MIN))) *
        drawW;
    const dbToY = (db: number) =>
      padT + (1 - (db - DB_FLOOR) / (DB_CEIL - DB_FLOOR)) * drawH;

    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    for (const db of DB_TICKS) {
      const y = dbToY(db);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + drawW, y);
      ctx.stroke();
    }

    for (const f of FREQ_TICKS) {
      const x = freqToX(f);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + drawH);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = `${8 * dpr}px monospace`;

    ctx.textAlign = "right";
    for (const db of DB_TICKS) {
      ctx.fillText(db === 0 ? "0" : String(db), padL - 3 * dpr, dbToY(db) + 3 * dpr);
    }

    ctx.textAlign = "center";
    for (const f of FREQ_TICKS) {
      const label = f >= 1000 ? `${f / 1000}k` : String(f);
      ctx.fillText(label, freqToX(f), padT + drawH + 11 * dpr);
    }

    const clampDb = (v: number): number => {
      if (!Number.isFinite(v)) return DB_FLOOR;
      return Math.min(DB_CEIL + 6, Math.max(DB_FLOOR, v));
    };

    const drawSpectrumCurves = () => {
      const bottomY = padT + drawH;

      const rmsGradient = ctx.createLinearGradient(0, padT, 0, padT + drawH);
      rmsGradient.addColorStop(0, "rgba(0,180,216,0.55)");
      rmsGradient.addColorStop(1, "rgba(0,100,160,0.12)");
      ctx.fillStyle = rmsGradient;
      ctx.beginPath();
      ctx.moveTo(freqToX(LOG_FREQS[0]), bottomY);
      for (let i = 0; i < LOG_POINTS; i++) {
        const x = freqToX(LOG_FREQS[i]);
        const y = dbToY(clampDb(this._emaRms[i]));
        ctx.lineTo(x, y);
      }
      ctx.lineTo(freqToX(LOG_FREQS[LOG_POINTS - 1]), bottomY);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = "rgba(120, 230, 255, 0.95)";
      ctx.lineWidth = 1.25 * dpr;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i < LOG_POINTS; i++) {
        const x = freqToX(LOG_FREQS[i]);
        const y = dbToY(clampDb(this._emaPeak[i]));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    if (analysers) {
      const fftSize = analysers.left.fftSize;
      if (this._bufL.length !== fftSize / 2) {
        this._bufL = new Float32Array(fftSize / 2);
        this._bufR = new Float32Array(fftSize / 2);
        this._emaPeak = new Float32Array(LOG_POINTS);
        this._emaRms = new Float32Array(LOG_POINTS);
        this._emaPeak.fill(DB_FLOOR);
        this._emaRms.fill(DB_FLOOR);
      }

      if (playing) {
        analysers.left.getFloatFrequencyData(this._bufL);
        analysers.right.getFloatFrequencyData(this._bufR);

        const sampleRate = analysers.left.context.sampleRate;
        const binCount = this._bufL.length;
        const binHz = sampleRate / fftSize;
        const g = monitoringGainsForMode(
          this._analyzeSettingsService.liveMonitoringMode,
        );
        const tilt = this._analyzeSettingsService.liveSpectrumTiltDbPerOct;

        const srcXs = new Float64Array(binCount);
        const srcYs = new Float64Array(binCount);
        for (let k = 0; k < binCount; k++) {
          const f = (k + 0.5) * binHz;
          srcXs[k] = f;
          const dBL = isFinite(this._bufL[k])
            ? Math.max(this._bufL[k], DB_FLOOR)
            : DB_FLOOR;
          const dBR = isFinite(this._bufR[k])
            ? Math.max(this._bufR[k], DB_FLOOR)
            : DB_FLOOR;
          const lLin = Math.pow(10, dBL / 20);
          const rLin = Math.pow(10, dBR / 20);
          const oL = g.ll * lLin + g.rl * rLin;
          const oR = g.lr * lLin + g.rr * rLin;
          const pLin = Math.sqrt(oL * oL + oR * oR) / Math.SQRT2 + 1e-15;
          let db = 20 * Math.log10(pLin);
          db = Math.max(DB_FLOOR, Math.min(DB_CEIL + 12, db));
          db += spectrumTiltDbAboveFloor(f, tilt, db, DB_FLOOR, 18);
          srcYs[k] = Math.max(DB_FLOOR, Math.min(DB_CEIL + 12, db));
        }

        const resampled = akimaResample(srcXs, srcYs, LOG_FREQS);
        const inst = quinticBSplineSmooth(resampled);

        const decay = smoothingPctToDecay(
          this._analyzeSettingsService.liveVisualSmoothingPct,
        );
        const smoothT =
          this._analyzeSettingsService.liveVisualSmoothingPct / 100;
        const peakFallDbPerFrame = (10 + smoothT * 48) / 60;

        for (let i = 0; i < LOG_POINTS; i++) {
          const v = clampDb(inst[i]);

          const pk = this._emaPeak[i];
          if (v >= pk) {
            this._emaPeak[i] = v;
          } else {
            this._emaPeak[i] = Math.max(v, pk - peakFallDbPerFrame);
          }

          this._emaRms[i] = decay * this._emaRms[i] + (1 - decay) * v;
        }
      }

      drawSpectrumCurves();
    }

    if (this._hoverActive && drawW > 0 && drawH > 0) {
      const mx = this._hoverCx;
      const my = this._hoverCy;
      const hx = Math.min(padL + drawW, Math.max(padL, mx));
      const hy = Math.min(padT + drawH, Math.max(padT, my));
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.82)";
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, padT + drawH);
      ctx.moveTo(padL, hy);
      ctx.lineTo(padL + drawW, hy);
      ctx.stroke();
      ctx.restore();

      const hz = hzFromCanvasX(mx, padL, drawW);
      const dbY = dbFromCanvasY(my, padT, drawH);
      let pkStr = "—";
      let rmStr = "—";
      if (analysers && this._emaPeak.length >= 2) {
        const li = logIndexFromHz(hz);
        pkStr = lerpF32(this._emaPeak, li).toFixed(1);
        rmStr = lerpF32(this._emaRms, li).toFixed(1);
      }
      this._readoutEl.style.visibility = "visible";
      this._readoutEl.innerHTML = `${fmtHzLive(hz)}<br>Y ${dbY.toFixed(1)} dBFS<br>Peak ${pkStr} dBFS<br>RMS ${rmStr} dBFS`;
    } else {
      this._readoutEl.style.visibility = "hidden";
    }
  }

  override dispose() {
    this._stopRaf();
    super.dispose();
  }
}
