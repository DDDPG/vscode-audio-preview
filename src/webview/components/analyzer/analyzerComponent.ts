import "./analyzerComponent.css";
import { EventType } from "../../events";
import Component from "../../component";
import PlayerService from "../../services/playerService";
import AnalyzeService from "../../services/analyzeService";
import AnalyzeSettingsService from "../../services/analyzeSettingsService";
import SpectrogramComponent from "../spectrogram/spectrogramComponent";
import FigureInteractionComponent from "../figureInteraction/figureInteractionComponent";

export default class AnalyzerComponent extends Component {
  private _componentRootSelector: string;
  private _componentRoot: HTMLElement;

  private _audioBuffer: AudioBuffer;
  private _analyzeService: AnalyzeService;
  private _analyzeSettingsService: AnalyzeSettingsService;
  private _playerService: PlayerService;

  private _analyzeResultBox: HTMLElement;

  constructor(
    componentRootSelector: string,
    audioBuffer: AudioBuffer,
    analyzeService: AnalyzeService,
    analyzeSettingsService: AnalyzeSettingsService,
    playerService: PlayerService,
  ) {
    super();
    this._audioBuffer = audioBuffer;
    this._analyzeService = analyzeService;
    this._analyzeSettingsService = analyzeSettingsService;
    this._playerService = playerService;

    this._componentRootSelector = componentRootSelector;
    this._componentRoot = document.querySelector(this._componentRootSelector);
    this._componentRoot.innerHTML = `
      <div class="analyzerComponent">
        <div class="analyzeResultBox"></div>
      </div>
    `;

    this._analyzeResultBox =
      this._componentRoot.querySelector(".analyzeResultBox");
    this._analyzeResultBox.style.display = "block";

    this._addEventlistener(this._analyzeService, EventType.ANALYZE, () => {
      this.renderAnalyzeResult();
    });

    this._analyzeService.analyze();
  }

  private clearAnalyzeResult() {
    for (const c of Array.from(this._analyzeResultBox.children)) {
      this._analyzeResultBox.removeChild(c);
    }
  }

  private renderAnalyzeResult() {
    this.clearAnalyzeResult();

    const settings = this._analyzeSettingsService.toProps();

    for (let ch = 0; ch < this._audioBuffer.numberOfChannels; ch++) {
      if (this._analyzeSettingsService.spectrogramVisible) {
        const canvasBox = document.createElement("div");
        const canvasBoxClass = `js-canvasBoxSpectrogram${ch}`;
        canvasBox.classList.add("canvasBox", canvasBoxClass);
        this._analyzeResultBox.appendChild(canvasBox);

        new SpectrogramComponent(
          `${this._componentRootSelector} .analyzeResultBox .${canvasBoxClass}`,
          AnalyzeSettingsService.spectrogramRenderWidth(
            this._analyzeSettingsService.highResolutionSpectrogram,
          ),
          AnalyzeSettingsService.spectrogramRenderHeightBase(
            this._analyzeSettingsService.highResolutionSpectrogram,
          ) * this._analyzeSettingsService.spectrogramVerticalScale,
          this._analyzeService,
          settings,
          this._audioBuffer.sampleRate,
          ch,
          this._audioBuffer.numberOfChannels,
        );

        new FigureInteractionComponent(
          `${this._componentRootSelector} .analyzeResultBox .${canvasBoxClass}`,
          false,
          this._playerService,
          this._analyzeService,
          this._analyzeSettingsService,
          this._audioBuffer,
          settings,
          ch,
        );
      }
    }
  }
}
