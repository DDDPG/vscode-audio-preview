import "../../styles/figure.css";
import Component from "../../component";
import { EventType } from "../../events";
import AnalyzeService from "../../services/analyzeService";
import AnalyzeSettingsService from "../../services/analyzeSettingsService";
import PlayerService from "../../services/playerService";
import WaveFormComponent from "../waveform/waveFormComponent";
import FigureInteractionComponent from "../figureInteraction/figureInteractionComponent";

function clampWaveformScale(v: number): number {
  return Math.min(
    AnalyzeSettingsService.WAVEFORM_CANVAS_VERTICAL_SCALE_MAX,
    Math.max(AnalyzeSettingsService.WAVEFORM_CANVAS_VERTICAL_SCALE_MIN, v),
  );
}

/** Full-width waveform row; always mounted after decode (no STFT / analyze). */
export default class WaveBandComponent extends Component {
  private _channelsRoot: HTMLElement;
  private _analyzeSettingsService: AnalyzeSettingsService;
  private _audioBuffer: AudioBuffer;
  private _playerService: PlayerService;
  private _analyzeService: AnalyzeService;
  private _rootSelector: string;
  private _figures: FigureInteractionComponent[] = [];

  constructor(
    rootSelector: string,
    audioBuffer: AudioBuffer,
    analyzeSettingsService: AnalyzeSettingsService,
    playerService: PlayerService,
    analyzeService: AnalyzeService,
  ) {
    super();
    this._rootSelector = rootSelector;
    this._audioBuffer = audioBuffer;
    this._analyzeSettingsService = analyzeSettingsService;
    this._playerService = playerService;
    this._analyzeService = analyzeService;

    const root = document.querySelector(rootSelector) as HTMLElement;
    this._channelsRoot = root;

    const onWaveSetting = () => {
      this._rebuildChannels();
    };
    this._addEventlistener(
      analyzeSettingsService,
      EventType.AS_UPDATE_MIN_TIME,
      onWaveSetting,
    );
    this._addEventlistener(
      analyzeSettingsService,
      EventType.AS_UPDATE_MAX_TIME,
      onWaveSetting,
    );
    this._addEventlistener(
      analyzeSettingsService,
      EventType.AS_UPDATE_MIN_AMPLITUDE,
      onWaveSetting,
    );
    this._addEventlistener(
      analyzeSettingsService,
      EventType.AS_UPDATE_MAX_AMPLITUDE,
      onWaveSetting,
    );
    this._addEventlistener(
      analyzeSettingsService,
      EventType.AS_UPDATE_WAVEFORM_VERTICAL_SCALE,
      onWaveSetting,
    );

    this._rebuildChannels();
    this._wireResizeHandle();
  }

  private _rebuildChannels() {
    for (const f of this._figures) {
      f.dispose();
    }
    this._figures = [];
    this._channelsRoot.innerHTML = "";

    const settings = this._analyzeSettingsService.toProps();
    for (let ch = 0; ch < this._audioBuffer.numberOfChannels; ch++) {
      const boxClass = `js-waveBandCh${ch}`;
      const box = document.createElement("div");
      box.className = `canvasBox waveBand__channel ${boxClass}`;
      this._channelsRoot.appendChild(box);

      new WaveFormComponent(
        `${this._rootSelector} .${boxClass}`,
        AnalyzeSettingsService.WAVEFORM_CANVAS_WIDTH,
        AnalyzeSettingsService.WAVEFORM_CANVAS_HEIGHT *
          this._analyzeSettingsService.waveformVerticalScale,
        settings,
        this._audioBuffer.sampleRate,
        this._audioBuffer.getChannelData(ch),
        ch,
        this._audioBuffer.numberOfChannels,
      );

      const fig = new FigureInteractionComponent(
        `${this._rootSelector} .${boxClass}`,
        true,
        this._playerService,
        this._analyzeService,
        this._analyzeSettingsService,
        this._audioBuffer,
        settings,
        ch,
      );
      this._figures.push(fig);
    }
  }

  private _wireResizeHandle() {
    const band = this._channelsRoot.closest("#waveBand") as HTMLElement | null;
    const handle = band?.querySelector(
      ".waveBand__resizeHandle",
    ) as HTMLElement | null;
    if (!band || !handle) {
      return;
    }

    this._addEventlistener(handle, EventType.MOUSE_DOWN, (e: MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startScale = this._analyzeSettingsService.waveformVerticalScale;
      const move = (ev: MouseEvent) => {
        const dy = ev.clientY - startY;
        this._analyzeSettingsService.waveformVerticalScale = clampWaveformScale(
          startScale + dy * 0.006,
        );
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  public dispose() {
    for (const f of this._figures) {
      f.dispose();
    }
    this._figures = [];
    super.dispose();
  }
}
