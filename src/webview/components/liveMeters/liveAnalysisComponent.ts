import Component from "../../component";
import PlayerService from "../../services/playerService";
import AnalyzeSettingsService from "../../services/analyzeSettingsService";
import GoniometerComponent from "./goniometerComponent";
import SpectralAnalyzerComponent from "./spectralAnalyzerComponent";

const MIN_PANE_HEIGHT = 120; // px

export default class LiveAnalysisComponent extends Component {
  private _container: HTMLElement;
  private _gonioWrap: HTMLElement;
  private _spectrumWrap: HTMLElement;
  private _handle: HTMLElement;
  private _expandBtn: HTMLButtonElement;
  private _overlay: HTMLElement;
  private _overlayGonioWrap: HTMLElement;
  private _overlaySpectrumWrap: HTMLElement;
  private _overlayHandle: HTMLElement;

  private _goniometer: GoniometerComponent;
  private _spectrum: SpectralAnalyzerComponent;
  private _overlayGoniometer: GoniometerComponent;
  private _overlaySpectrum: SpectralAnalyzerComponent;

  private _splitRatio: number = 0.5;
  private _dragging: boolean = false;

  constructor(
    containerEl: HTMLElement,
    playerService: PlayerService,
    analyzeSettingsService: AnalyzeSettingsService,
  ) {
    super();
    this._container = containerEl;

    containerEl.innerHTML = `
      <div class="liveAnalysisComponent" id="liveAnalysisInner">
        <button type="button" class="liveAnalysis__expandBtn" id="expandBtn" title="Expand">\u2197</button>
        <div class="liveAnalysis__goniometer" id="gonioWrap"></div>
        <div class="liveAnalysis__resizeHandle" id="liveResizeHandle"></div>
        <div class="liveAnalysis__spectrum" id="spectrumWrap"></div>
      </div>
      <div class="liveAnalysis__overlay hidden" id="liveOverlay">
        <div class="liveAnalysisComponent" style="flex:1;position:relative;">
          <div class="liveAnalysis__goniometer" id="overlayGonioWrap" style="flex:1;min-height:${MIN_PANE_HEIGHT}px;"></div>
          <div class="liveAnalysis__resizeHandle" id="overlayHandle"></div>
          <div class="liveAnalysis__spectrum" id="overlaySpectrumWrap" style="flex:1;min-height:${MIN_PANE_HEIGHT}px;"></div>
        </div>
      </div>`;

    this._gonioWrap = containerEl.querySelector("#gonioWrap");
    this._spectrumWrap = containerEl.querySelector("#spectrumWrap");
    this._handle = containerEl.querySelector("#liveResizeHandle");
    this._expandBtn = containerEl.querySelector("#expandBtn");
    this._overlay = containerEl.querySelector("#liveOverlay");
    this._overlayGonioWrap = containerEl.querySelector("#overlayGonioWrap");
    this._overlaySpectrumWrap = containerEl.querySelector("#overlaySpectrumWrap");
    this._overlayHandle = containerEl.querySelector("#overlayHandle");

    // Create sub-components
    this._goniometer = this._register(
      new GoniometerComponent(this._gonioWrap, playerService, analyzeSettingsService),
    );
    this._spectrum = this._register(
      new SpectralAnalyzerComponent(
        this._spectrumWrap,
        playerService,
        analyzeSettingsService,
      ),
    );
    this._overlayGoniometer = this._register(
      new GoniometerComponent(
        this._overlayGonioWrap,
        playerService,
        analyzeSettingsService,
      ),
    );
    this._overlaySpectrum = this._register(
      new SpectralAnalyzerComponent(
        this._overlaySpectrumWrap,
        playerService,
        analyzeSettingsService,
      ),
    );

    this._applyInlineSplit();
    this._initResizeHandle(this._handle, (ratio) => {
      this._splitRatio = ratio;
      this._applyInlineSplit();
    });
    this._initResizeHandle(this._overlayHandle, (ratio) => {
      this._splitRatio = ratio;
      this._applyInlineSplit();
      this._applyOverlaySplit();
    });

    // Expand / collapse
    this._addEventlistener(this._expandBtn, "click", () => this._openOverlay());
    this._addEventlistener(this._overlay, "contextmenu", (e) => {
      (e as Event).preventDefault();
      this._closeOverlay();
    });
    this._addEventlistener(document, "keydown", (e: KeyboardEvent) => {
      if (e.code === "Escape" && !this._overlay.classList.contains("hidden")) {
        this._closeOverlay();
      }
    });

    if (typeof ResizeObserver !== "undefined") {
      const inner = this._container.querySelector("#liveAnalysisInner") as HTMLElement;
      const ro = new ResizeObserver(() => {
        this._applyInlineSplit();
        this._applyOverlaySplit();
      });
      if (inner) ro.observe(inner);
      this._register({ dispose: () => ro.disconnect() });
    }
  }

  private _applyInlineSplit() {
    const total = this._container.querySelector<HTMLElement>("#liveAnalysisInner")?.clientHeight ?? 300;
    const handleH = this._handle.offsetHeight;
    const available = total - handleH;
    const gonioH = Math.max(MIN_PANE_HEIGHT, Math.min(available - MIN_PANE_HEIGHT, this._splitRatio * available));
    this._gonioWrap.style.height = `${gonioH}px`;
    this._gonioWrap.style.flex = "0 0 auto";
  }

  private _applyOverlaySplit() {
    const total = this._overlayGonioWrap.parentElement?.clientHeight ?? 600;
    const handleH = this._overlayHandle.offsetHeight;
    const available = total - handleH;
    const gonioH = Math.max(MIN_PANE_HEIGHT, Math.min(available - MIN_PANE_HEIGHT, this._splitRatio * available));
    this._overlayGonioWrap.style.height = `${gonioH}px`;
    this._overlayGonioWrap.style.flex = "0 0 auto";
  }

  private _initResizeHandle(handle: HTMLElement, onUpdate: (ratio: number) => void) {
    this._addEventlistener(handle, "mousedown", (e: MouseEvent) => {
      e.preventDefault();
      this._dragging = true;
      const parent = handle.parentElement;
      const onMove = (mv: MouseEvent) => {
        if (!this._dragging) return;
        const rect = parent.getBoundingClientRect();
        const y = mv.clientY - rect.top;
        const handleH = handle.offsetHeight;
        const available = rect.height - handleH;
        const ratio = Math.max(
          MIN_PANE_HEIGHT / available,
          Math.min(1 - MIN_PANE_HEIGHT / available, y / available),
        );
        onUpdate(ratio);
      };
      const onUp = () => {
        this._dragging = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  private _openOverlay() {
    this._overlay.classList.remove("hidden");
    this._applyOverlaySplit();
  }

  private _closeOverlay() {
    this._overlay.classList.add("hidden");
  }
}
