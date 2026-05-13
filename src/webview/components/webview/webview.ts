import "./webview.css";
import "../liveMeters/liveMeters.css";
import { EventType } from "../../events";
import {
  ExtMessage,
  ExtMessageType,
  PostMessage,
  WebviewMessageType,
} from "../../../message";
import Component from "../../component";
import { Config } from "../../../config";
import { IAudioDecoder } from "../../decoders/audioDecoderInterface";
import PlayerService from "../../services/playerService";
import PlayerSettingsService from "../../services/playerSettingsService";
import AnalyzeService from "../../services/analyzeService";
import AnalyzeSettingsService from "../../services/analyzeSettingsService";
import InfoTableComponent from "../infoTable/infoTableComponent";
import PlayerComponent from "../player/playerComponent";
import SettingTab from "../settingTab/settingTabComponent";
import AnalyzerComponent from "../analyzer/analyzerComponent";
import LevelMeterComponent from "../liveMeters/levelMeterComponent";
import LiveAnalysisComponent from "../liveMeters/liveAnalysisComponent";
import LiveMonitoringBarComponent from "../liveMeters/liveMonitoringBarComponent";

type CreateAudioContext = (sampleRate: number) => AudioContext;
type CreateDecoder = (fileData: Uint8Array, ext: string) => Promise<IAudioDecoder>;

/** Ring geometry matches viewBox / circle `r` in webview template (px). */
const FAB_LOAD_RING_RADIUS_PX = 23;
const FAB_LOAD_RING_CIRCUMFERENCE = 2 * Math.PI * FAB_LOAD_RING_RADIUS_PX;
/** Portion of the ring reserved for file transfer into the webview (rest = decode + UI). */
const LOAD_PROGRESS_RECEIVE_SHARE = 0.38;

export default class WebView extends Component {
  private _fileData: Uint8Array;

  private _postMessage: PostMessage;
  private _createAudioContext: CreateAudioContext;
  private _createDecoder: CreateDecoder;
  private _fileExt: string = "";

  private _config: Config;

  private _settingsFab: HTMLButtonElement | null = null;
  private _fabPercentEl: HTMLSpanElement | null = null;
  private _loadRingSvg: SVGSVGElement | null = null;
  private _loadRingBar: SVGCircleElement | null = null;
  private _decodeProgressRaf = 0;
  private _decodeProgressStartedAt = 0;
  private _visualLoadProgress = 0;
  private _reduceMotion = false;

  constructor(
    postMessage: PostMessage,
    createAudioContext: CreateAudioContext,
    createDecoder: CreateDecoder,
  ) {
    super();
    this._postMessage = postMessage;
    this._createAudioContext = createAudioContext;
    this._createDecoder = createDecoder;
    this._register({
      dispose: () => this._cancelDecodeProgressRaf(),
    });
    this.initWebview();
  }

  private initWebview() {
    this._isDisposed = false;
    this._fileData = undefined;

    this._addEventlistener(
      window,
      EventType.VSCODE_MESSAGE,
      (e: MessageEvent<ExtMessage>) => this.onReceiveMessage(e.data),
    );

    const root = document.getElementById("root");
    root.innerHTML = `
      <div id="topChrome" class="topChrome">
        <div id="infoTable"></div>
        <div id="player"></div>
      </div>
      <div id="liveMonitoringBar"></div>
      <div id="mainVisualizer">
        <div id="analyzer"></div>
        <div id="liveMetersMiddle"></div>
        <div id="liveMetersRight"></div>
      </div>
      <div id="settingsDock" class="settingsDock">
        <button
          type="button"
          class="settingsDock__fab js-settingsFab"
          id="settingsFab"
          aria-expanded="false"
          aria-controls="settingsSheet"
          aria-haspopup="dialog"
          aria-busy="false"
          disabled
          title="Loading audio…"
        >
          <svg
            class="settingsDock__fabRingSvg settingsDock__fabRingSvg--hidden"
            viewBox="0 0 52 52"
            width="52"
            height="52"
            aria-hidden="true"
            focusable="false"
          >
            <circle
              class="settingsDock__fabRingTrack"
              cx="26"
              cy="26"
              r="${FAB_LOAD_RING_RADIUS_PX}"
              fill="none"
              stroke-width="2"
            />
            <circle
              class="settingsDock__fabRingBar"
              cx="26"
              cy="26"
              r="${FAB_LOAD_RING_RADIUS_PX}"
              fill="none"
              stroke-width="2.75"
              stroke-linecap="round"
              transform="rotate(-90 26 26)"
            />
          </svg>
          <span
            class="settingsDock__fabPercent js-settingsFabPercent"
            aria-hidden="true"
          >0%</span>
          <span class="settingsDock__fabIcon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" stroke="currentColor" stroke-width="1.5"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c0 .66.39 1.26 1 1.51H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
            </svg>
          </span>
        </button>
        <div class="settingsDock__backdrop js-settingsBackdrop" id="settingsBackdrop" hidden></div>
        <div
          class="settingsDock__sheet js-settingsSheet"
          id="settingsSheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="settingsSheetTitle"
          hidden
        >
          <div id="settingsSheetTitle" class="settingsDock__sheetTitle">Settings</div>
          <div id="settingTab"></div>
        </div>
      </div>
    `;

    this._postMessage({ type: WebviewMessageType.CONFIG });

    this._reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this._settingsFab = document.getElementById(
      "settingsFab",
    ) as HTMLButtonElement | null;
    this._fabPercentEl = this._settingsFab?.querySelector(
      ".js-settingsFabPercent",
    ) as HTMLSpanElement | null;
    this._loadRingSvg = this._settingsFab?.querySelector(
      ".settingsDock__fabRingSvg",
    ) as SVGSVGElement | null;
    this._loadRingBar = this._loadRingSvg?.querySelector(
      ".settingsDock__fabRingBar",
    ) as SVGCircleElement | null;
    this._primeLoadRingGeometry();
  }

  private _primeLoadRingGeometry() {
    if (!this._loadRingBar) {
      return;
    }
    this._loadRingBar.style.strokeDasharray = `${FAB_LOAD_RING_CIRCUMFERENCE}`;
    this._paintLoadRingProgress(0);
  }

  private _paintLoadRingProgress(unit: number) {
    if (!this._loadRingBar) {
      return;
    }
    const u = Math.max(0, Math.min(1, unit));
    this._loadRingBar.style.strokeDashoffset = `${FAB_LOAD_RING_CIRCUMFERENCE * (1 - u)}`;
    if (
      this._settingsFab?.classList.contains("settingsDock__fab--loading") &&
      this._fabPercentEl
    ) {
      const pct = Math.min(100, Math.max(0, Math.round(u * 100)));
      this._fabPercentEl.textContent = `${pct}%`;
    }
  }

  private _showLoadRing() {
    this._settingsFab?.classList.add("settingsDock__fab--loading");
    this._loadRingSvg?.classList.remove("settingsDock__fabRingSvg--hidden");
    this._settingsFab?.setAttribute("aria-busy", "true");
    this._settingsFab?.setAttribute("title", "Loading audio…");
    this._paintLoadRingProgress(this._visualLoadProgress);
  }

  private _setReceiveLoadProgress(end: number, whole: number) {
    if (whole <= 0) {
      return;
    }
    const ratio = Math.min(1, end / whole);
    this._visualLoadProgress = LOAD_PROGRESS_RECEIVE_SHARE * ratio;
    this._paintLoadRingProgress(this._visualLoadProgress);
    this._showLoadRing();
  }

  private _cancelDecodeProgressRaf() {
    if (this._decodeProgressRaf !== 0) {
      cancelAnimationFrame(this._decodeProgressRaf);
      this._decodeProgressRaf = 0;
    }
  }

  private _beginDecodePhaseProgress() {
    this._cancelDecodeProgressRaf();
    this._visualLoadProgress = Math.max(
      this._visualLoadProgress,
      LOAD_PROGRESS_RECEIVE_SHARE,
    );
    this._paintLoadRingProgress(this._visualLoadProgress);
    if (this._reduceMotion) {
      return;
    }
    this._decodeProgressStartedAt = performance.now();
    const tick = () => {
      const elapsed = performance.now() - this._decodeProgressStartedAt;
      const headroom = 1 - LOAD_PROGRESS_RECEIVE_SHARE - 0.03;
      const asymptote =
        LOAD_PROGRESS_RECEIVE_SHARE +
        headroom * (1 - Math.exp(-elapsed / 3200));
      const target = Math.min(asymptote, 0.97);
      this._visualLoadProgress += (target - this._visualLoadProgress) * 0.06;
      this._paintLoadRingProgress(this._visualLoadProgress);
      this._decodeProgressRaf = requestAnimationFrame(tick);
    };
    this._decodeProgressRaf = requestAnimationFrame(tick);
  }

  private _finishAndHideLoadRing(success: boolean) {
    this._cancelDecodeProgressRaf();
    this._paintLoadRingProgress(1);
    if (!this._settingsFab) {
      return;
    }
    this._settingsFab.setAttribute("aria-busy", "false");
    if (success) {
      this._settingsFab.disabled = false;
      this._settingsFab.setAttribute("title", "Settings");
    } else {
      this._settingsFab.disabled = true;
      this._settingsFab.setAttribute("title", "Could not load audio");
    }
    requestAnimationFrame(() => {
      this._settingsFab?.classList.remove("settingsDock__fab--loading");
    });
    window.setTimeout(() => {
      this._loadRingSvg?.classList.add("settingsDock__fabRingSvg--hidden");
      this._visualLoadProgress = 0;
      this._paintLoadRingProgress(0);
      if (this._fabPercentEl) {
        this._fabPercentEl.textContent = "0%";
      }
    }, 220);
  }

  private async onReceiveMessage(msg: ExtMessage) {
    switch (msg.type) {
      case ExtMessageType.CONFIG:
        if (ExtMessageType.isCONFIG(msg)) {
          this._config = msg.data;
          this._fileExt = msg.data.fileExt ?? "";
          console.log(msg.data);
          this._postMessage({
            type: WebviewMessageType.DATA,
            data: { start: 0, end: 500000 },
          });
        }
        break;

      case ExtMessageType.DATA:
        if (ExtMessageType.isDATA(msg)) {
          // init fileData after receiving first data
          if (!this._fileData) {
            console.log("start receiving data");
            this._fileData = new Uint8Array(msg.data.wholeLength);
            this._visualLoadProgress = 0;
            this._primeLoadRingGeometry();
            this._showLoadRing();
          }

          // set fileData
          console.log(
            `received data: ${msg.data.start} ~ ${msg.data.end} / ${msg.data.wholeLength}`,
          );
          const samples = new Uint8Array(msg.data.samples);
          this._fileData.set(samples, msg.data.start);

          this._setReceiveLoadProgress(
            msg.data.end,
            msg.data.wholeLength,
          );

          // request next data
          if (msg.data.end < msg.data.wholeLength) {
            this._postMessage({
              type: WebviewMessageType.DATA,
              data: { start: msg.data.end, end: msg.data.end + 3000000 },
            });
            break;
          }

          console.log("finish receiving data");
          this._setReceiveLoadProgress(
            msg.data.wholeLength,
            msg.data.wholeLength,
          );
          this._beginDecodePhaseProgress();
          try {
            await this.activateUI();
            this._finishAndHideLoadRing(true);
          } catch (err) {
            this._finishAndHideLoadRing(false);
            this._postMessage({
              type: WebviewMessageType.ERROR,
              data: { message: err.message },
            });
          }
        }
        break;

      case ExtMessageType.RELOAD: {
        this.dispose();
        this.initWebview();
        break;
      }
    }
  }

  private async activateUI() {
    const decoder = await this._createDecoder(this._fileData, this._fileExt);

    // Phase 1: show header info immediately (fast path)
    console.log("read header info");
    decoder.readAudioInfo();
    const infoTableComponent = new InfoTableComponent("#infoTable");
    infoTableComponent.showInfo(
      decoder.numChannels,
      decoder.sampleRate,
      decoder.fileSize,
      decoder.format,
      decoder.encoding,
      decoder.bitDepth,
    );

    // decode audio data
    console.log("decode");
    decoder.decode();

    console.log("show other ui");
    infoTableComponent.showAdditionalInfo(decoder.duration);
    this._disposables.push(infoTableComponent);

    const audioContext = this._createAudioContext(decoder.sampleRate);
    const audioBuffer = audioContext.createBuffer(
      decoder.numChannels,
      decoder.length,
      decoder.sampleRate,
    );
    for (let ch = 0; ch < decoder.numChannels; ch++) {
      const d = Float32Array.from(decoder.samples[ch]);
      audioBuffer.copyToChannel(d, ch);
    }

    const playerSettingsService = PlayerSettingsService.fromDefaultSetting(
      this._config.playerDefault,
      audioBuffer,
    );

    const analyzeService = new AnalyzeService(audioBuffer);
    const analyzeSettingsService = AnalyzeSettingsService.fromDefaultSetting(
      this._config.analyzeDefault,
      audioBuffer,
    );

    const playerService = new PlayerService(
      audioContext,
      audioBuffer,
      playerSettingsService,
      analyzeSettingsService,
    );
    const playerComponent = new PlayerComponent(
      "#player",
      playerService,
      playerSettingsService,
    );
    this._disposables.push(playerService, playerComponent);

    let persistTimer: ReturnType<typeof setTimeout> | undefined;
    const debouncedPersist = () => {
      clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        this._postMessage({
          type: WebviewMessageType.SAVE_ANALYZE_UI,
          data: analyzeSettingsService.toCachedDefaults(),
        });
      }, 500);
    };
    analyzeSettingsService.setPersistHook(debouncedPersist);
    this._register({
      dispose: () => {
        analyzeSettingsService.setPersistHook(undefined);
        clearTimeout(persistTimer);
      },
    });

    const settingTabComponent = new SettingTab(
      "#settingTab",
      playerSettingsService,
      analyzeService,
      analyzeSettingsService,
      audioBuffer,
      this._postMessage,
    );
    this._disposables.push(
      analyzeService,
      analyzeSettingsService,
      settingTabComponent,
    );

    // Wire live meter components and connect column visibility to settings.
    const mainVisualizer = document.getElementById("mainVisualizer") as HTMLElement;
    const liveMetersRight = document.getElementById("liveMetersRight") as HTMLElement;
    const liveMetersMiddle = document.getElementById("liveMetersMiddle") as HTMLElement;

    const levelMeterComponent = new LevelMeterComponent(
      liveMetersRight,
      playerService,
      analyzeSettingsService,
    );
    const liveAnalysisComponent = new LiveAnalysisComponent(
      liveMetersMiddle,
      playerService,
      analyzeSettingsService,
    );
    const liveMonitoringBarComponent = new LiveMonitoringBarComponent(
      "#liveMonitoringBar",
      analyzeSettingsService,
    );
    this._disposables.push(
      levelMeterComponent,
      liveAnalysisComponent,
      liveMonitoringBarComponent,
    );

    const updateLiveColumns = () => {
      const showMeter = analyzeSettingsService.showLevelMeter;
      const showLive = analyzeSettingsService.showLiveAnalysis;
      mainVisualizer.style.setProperty(
        "--meter-col-width",
        showMeter ? "112px" : "0px",
      );
      if (!showLive) {
        mainVisualizer.style.setProperty("--live-col-width", "0px");
        return;
      }
      const rect = mainVisualizer.getBoundingClientRect();
      const rowH = rect.height > 1 ? rect.height : 400;
      const rowW = rect.width > 1 ? rect.width : 800;
      const meterPx = showMeter ? 112 : 0;
      const minAnalyzerPx = 200;
      const fromHeight = Math.round((rowH * 2) / 3);
      const maxFromWidth = Math.max(
        0,
        Math.floor(rowW - meterPx - minAnalyzerPx),
      );
      const livePx = Math.max(0, Math.min(fromHeight, maxFromWidth));
      mainVisualizer.style.setProperty("--live-col-width", `${livePx}px`);
    };

    // Recalculate live-col-width whenever the container resizes (guard for
    // environments such as jsdom in unit tests where ResizeObserver is absent).
    if (typeof ResizeObserver !== "undefined") {
      const resizeObserver = new ResizeObserver(() => updateLiveColumns());
      resizeObserver.observe(mainVisualizer);
      this._register({ dispose: () => resizeObserver.disconnect() });
    }

    // Re-evaluate column widths on settings changes.
    this._addEventlistener(analyzeSettingsService, EventType.AS_UPDATE_SHOW_LEVEL_METER, updateLiveColumns);
    this._addEventlistener(analyzeSettingsService, EventType.AS_UPDATE_SHOW_LIVE_ANALYSIS, updateLiveColumns);
    updateLiveColumns();

    decoder.dispose();

    // Phase 2: defer spectrogram/analyzer init so the player and info table
    // are visible before the potentially-long analysis begins.
    const scheduleIdle: (cb: () => void) => void =
      typeof requestIdleCallback !== "undefined"
        ? (cb) => requestIdleCallback(cb)
        : (cb) => setTimeout(cb, 0);

    scheduleIdle(async () => {
      // Try to initialize essentia.js WASM for higher-quality STFT
      await analyzeService.initEssentia();

      const analyzerComponent = new AnalyzerComponent(
        "#analyzer",
        audioBuffer,
        analyzeService,
        analyzeSettingsService,
        playerService,
        this._config.autoAnalyze,
      );
      this._disposables.push(analyzerComponent);
    });
  }
}
