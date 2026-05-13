import { EventType } from "../../events";
import Component from "../../component";
import PlayerService from "../../services/playerService";
import AnalyzeSettingsService from "../../services/analyzeSettingsService";
import {
  applyMonitoringToTimeDomain,
  smoothingPctToDecay,
} from "../../utils/liveMonitoring";

const ALPHA_MIN = 0.02;
const MAX_BUFFER_POINTS = 2048 * 30;
const MAX_CANVAS_PX = 4096;

interface GonioPoint {
  x: number;
  y: number;
  alpha: number;
}

export default class GoniometerComponent extends Component {
  private _container: HTMLElement;
  private _canvasWrap: HTMLElement;
  private _canvas: HTMLCanvasElement;
  private _corrFill: HTMLElement;
  private _corrText: HTMLElement;

  private _playerService: PlayerService;
  private _analyzeSettingsService: AnalyzeSettingsService;
  private _rafId: number = 0;
  private _bufL: Float32Array = new Float32Array(2048);
  private _bufR: Float32Array = new Float32Array(2048);
  private _mixL: Float32Array = new Float32Array(2048);
  private _mixR: Float32Array = new Float32Array(2048);
  private _points: GonioPoint[] = [];

  constructor(
    containerEl: HTMLElement,
    playerService: PlayerService,
    analyzeSettingsService: AnalyzeSettingsService,
  ) {
    super();
    this._playerService = playerService;
    this._analyzeSettingsService = analyzeSettingsService;
    this._container = containerEl;

    containerEl.innerHTML = `
      <div class="goniometerComponent">
        <div class="gonioCanvasWrap">
          <canvas class="goniometer__canvas"></canvas>
        </div>
        <div class="goniometer__info">
          <div class="goniometer__corrBar">
            <div class="goniometer__corrFill"></div>
          </div>
          <div class="goniometer__corrText">CC: 0.00</div>
        </div>
      </div>`;

    this._canvasWrap = containerEl.querySelector(".gonioCanvasWrap");
    this._canvas = containerEl.querySelector(".goniometer__canvas");
    this._corrFill = containerEl.querySelector(".goniometer__corrFill");
    this._corrText = containerEl.querySelector(".goniometer__corrText");

    this._addEventlistener(playerService, EventType.UPDATE_IS_PLAYING, () => {
      if (playerService.isPlaying) {
        this._startRaf();
      } else {
        this._stopRaf();
      }
    });

    if (playerService.isPlaying) this._startRaf();
  }

  private _pointDecayPerFrame(): number {
    return smoothingPctToDecay(
      this._analyzeSettingsService.liveVisualSmoothingPct,
    );
  }

  private _startRaf() {
    if (this._rafId) return;
    const loop = () => {
      this._tick();
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  private _stopRaf() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
  }

  private _tick() {
    const analysers = this._playerService.getAnalysers();
    if (!analysers) return;

    const fftSize = analysers.left.fftSize;
    if (this._bufL.length !== fftSize) {
      this._bufL = new Float32Array(fftSize);
      this._bufR = new Float32Array(fftSize);
      this._mixL = new Float32Array(fftSize);
      this._mixR = new Float32Array(fftSize);
    }

    analysers.left.getFloatTimeDomainData(this._bufL);
    analysers.right.getFloatTimeDomainData(this._bufR);
    applyMonitoringToTimeDomain(
      this._analyzeSettingsService.liveMonitoringMode,
      this._bufL,
      this._bufR,
      this._mixL,
      this._mixR,
    );

    const decay = this._pointDecayPerFrame();

    for (let i = 0; i < fftSize; i++) {
      const L = this._mixL[i];
      const R = this._mixR[i];
      this._points.push({
        x: (L + R) / Math.SQRT2,
        y: (L - R) / Math.SQRT2,
        alpha: 1.0,
      });
    }

    let writeIdx = 0;
    for (let i = 0; i < this._points.length; i++) {
      this._points[i].alpha *= decay;
      if (this._points[i].alpha >= ALPHA_MIN) {
        this._points[writeIdx++] = this._points[i];
      }
    }
    this._points.length = writeIdx;

    if (this._points.length > MAX_BUFFER_POINTS) {
      this._points.splice(0, this._points.length - MAX_BUFFER_POINTS);
    }

    this._draw();
    this._updateCorrelation();
  }

  private _draw() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, Math.floor(this._canvasWrap.clientWidth));
    const cssH = Math.max(1, Math.floor(this._canvasWrap.clientHeight));
    const w = Math.min(MAX_CANVAS_PX, Math.max(1, Math.round(cssW * dpr)));
    const h = Math.min(MAX_CANVAS_PX, Math.max(1, Math.round(cssH * dpr)));
    if (this._canvas.width !== w || this._canvas.height !== h) {
      this._canvas.width = w;
      this._canvas.height = h;
    }
    const ctx = this._canvas.getContext("2d");
    if (!ctx) return;

    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(cx, cy) * 0.9;

    ctx.fillStyle = "#111111";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    for (const r of [0.25, 0.5, 0.75, 1.0]) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius * r, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy + radius);
    ctx.lineTo(cx + radius, cy - radius);
    ctx.moveTo(cx - radius, cy - radius);
    ctx.lineTo(cx + radius, cy + radius);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const pt of this._points) {
      const px = cx + pt.x * radius;
      const py = cy - pt.y * radius;
      ctx.globalAlpha = pt.alpha;
      ctx.fillStyle = "#00e5ff";
      ctx.fillRect(px - 0.75, py - 0.75, 1.5, 1.5);
    }
    ctx.globalAlpha = 1;
  }

  private _updateCorrelation() {
    const n = this._mixL.length;
    let sumLR = 0;
    let sumL2 = 0;
    let sumR2 = 0;
    for (let i = 0; i < n; i++) {
      sumLR += this._mixL[i] * this._mixR[i];
      sumL2 += this._mixL[i] * this._mixL[i];
      sumR2 += this._mixR[i] * this._mixR[i];
    }
    const denom = Math.sqrt(sumL2 * sumR2);
    const corr = denom < 1e-12 ? 0 : Math.max(-1, Math.min(1, sumLR / denom));

    if (corr >= 0) {
      this._corrFill.style.left = "50%";
      this._corrFill.style.width = `${corr * 50}%`;
      this._corrFill.style.background = `rgb(${Math.round(255 * (1 - corr))}, ${Math.round(255 * corr)}, ${Math.round(255 * (1 - corr) * 0.3)})`;
    } else {
      this._corrFill.style.left = `${(1 + corr) * 50}%`;
      this._corrFill.style.width = `${-corr * 50}%`;
      this._corrFill.style.background = `rgb(${Math.round(255)}, ${Math.round(255 * (1 + corr))}, ${Math.round(255 * (1 + corr) * 0.3)})`;
    }

    const sign = corr >= 0 ? "+" : "";
    this._corrText.textContent = `CC: ${sign}${corr.toFixed(2)}`;
  }

  override dispose() {
    this._stopRaf();
    super.dispose();
  }
}
