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

export default class WebView extends Component {
  private _fileData: Uint8Array;

  private _postMessage: PostMessage;
  private _createAudioContext: CreateAudioContext;
  private _createDecoder: CreateDecoder;
  private _fileExt: string = "";

  private _config: Config;

  constructor(
    postMessage: PostMessage,
    createAudioContext: CreateAudioContext,
    createDecoder: CreateDecoder,
  ) {
    super();
    this._postMessage = postMessage;
    this._createAudioContext = createAudioContext;
    this._createDecoder = createDecoder;
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
      <div id="infoTable"></div>
      <div id="player"></div>
      <div id="settingTab"></div>
      <div id="liveMonitoringBar"></div>
      <div id="mainVisualizer">
        <div id="analyzer"></div>
        <div id="liveMetersMiddle"></div>
        <div id="liveMetersRight"></div>
      </div>
    `;

    this._postMessage({ type: WebviewMessageType.CONFIG });
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
          }

          // set fileData
          console.log(
            `received data: ${msg.data.start} ~ ${msg.data.end} / ${msg.data.wholeLength}`,
          );
          const samples = new Uint8Array(msg.data.samples);
          this._fileData.set(samples, msg.data.start);

          // request next data
          if (msg.data.end < msg.data.wholeLength) {
            this._postMessage({
              type: WebviewMessageType.DATA,
              data: { start: msg.data.end, end: msg.data.end + 3000000 },
            });
            break;
          }

          console.log("finish receiving data");
          try {
            await this.activateUI();
          } catch (err) {
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
