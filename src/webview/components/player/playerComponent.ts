import "./playerComponent.css";
import { EventType } from "../../events";
import Component from "../../component";
import PlayerService from "../../services/playerService";
import PlayerSettingsService from "../../services/playerSettingsService";

function parseEditableNumber(raw: string): number {
  const t = raw.replace(",", ".").trim();
  if (t === "" || t === "-" || t === "+" || t === "." || t === "-.") {
    return NaN;
  }
  return Number(t);
}

export default class PlayerComponent extends Component {
  private _componentRoot: HTMLElement;
  private _playButton: HTMLButtonElement;
  private _volumeBar: HTMLInputElement;
  private _volumeNumber: HTMLElement;
  private _positionNumber: HTMLElement;
  private _playerService: PlayerService;
  private _playerSettingsService: PlayerSettingsService;

  constructor(
    componentRootID: string,
    playerService: PlayerService,
    playerSettingsService: PlayerSettingsService,
  ) {
    super();
    this._playerService = playerService;
    this._playerSettingsService = playerSettingsService;

    this._componentRoot = document.querySelector(componentRootID);

    const volumeBar = this._playerSettingsService.volumeUnitDb
      ? `<div class="volumeText">volume <span class="volumeNumber" contenteditable="plaintext-only" spellcheck="false">0.0</span> dB</div>
             <input type="range" class="volumeBar" value="0" min="-80" max="0" step="0.5">`
      : `<div class="volumeText">volume <span class="volumeNumber" contenteditable="plaintext-only" spellcheck="false">100</span></div>
             <input type="range" class="volumeBar" value="100">`;

    this._componentRoot.innerHTML = `
      <div class="playerComponent">
        <button class="playButton">play</button>

        ${volumeBar}
                    
        <div class="seekPosText">position <span class="positionNumber" contenteditable="plaintext-only" spellcheck="false">0.00</span> s</div>
        <div class="seekBarBox">
            <input type="range" class="seekBar" value="0" />
            <input type="range" class="userInputSeekBar inputSeekBar" value="0" />
            <div class="progressTrack">
              <div class="progressFill" style="transform: scaleX(0); transform-origin: left center; width: 100%; height: 100%;"></div>
            </div>
        </div>
      </div>
    `;

    this._volumeNumber = <HTMLElement>(
      this._componentRoot.querySelector(".volumeNumber")
    );
    this._positionNumber = <HTMLElement>(
      this._componentRoot.querySelector(".positionNumber")
    );

    const userinputSeekbar = <HTMLInputElement>(
      this._componentRoot.querySelector(".userInputSeekBar")
    );
    this._addEventlistener(userinputSeekbar, EventType.INPUT, () => {
      if (!this._playerService.isPlaying) {
        this._playerService.previewSeekFromPercent(
          Number(userinputSeekbar.value),
        );
      }
    });
    this._addEventlistener(userinputSeekbar, EventType.CHANGE, () => {
      this._playerService.onSeekbarInput(Number(userinputSeekbar.value));
      userinputSeekbar.value = "100";
    });
    const visibleSeekbar = <HTMLInputElement>(
      this._componentRoot.querySelector(".seekBar")
    );
    const progressFill = <HTMLElement>(
      this._componentRoot.querySelector(".progressFill")
    );
    this._addEventlistener(
      this._playerService,
      EventType.UPDATE_SEEKBAR,
      (e: CustomEventInit) => {
        visibleSeekbar.value = e.detail.value;
        const dur = this._playerService.getAudioDuration();
        const pos =
          typeof e.detail.pos === "number"
            ? e.detail.pos
            : (Number(e.detail.value) * dur) / 100;
        this._positionNumber.textContent = pos.toFixed(2);
        const scale = Math.min(1, Math.max(0, e.detail.value / 100));
        progressFill.style.transform = `scaleX(${scale})`;
      },
    );

    this._volumeBar = <HTMLInputElement>(
      this._componentRoot.querySelector(".volumeBar")
    );
    const updateVolume = () => {
      if (this._playerSettingsService.volumeUnitDb) {
        const voldb = Number(this._volumeBar.value);
        const vollin = voldb === -80 ? 0 : Math.pow(10, voldb / 20);
        this._playerService.volume = vollin;
        this._volumeNumber.textContent =
          voldb === -80 ? "-80.0" : voldb.toFixed(1);
      } else {
        this._playerService.volume = Number(this._volumeBar.value) / 100;
        this._volumeNumber.textContent = String(
          Math.round(Number(this._volumeBar.value)),
        );
      }
    };
    this._addEventlistener(this._volumeBar, EventType.INPUT, updateVolume);
    this._volumeBar.value = String(
      this._playerSettingsService.volumeUnitDb
        ? this._playerSettingsService.initialVolumeDb
        : this._playerSettingsService.initialVolume,
    );
    updateVolume();

    const commitVolumeNumber = () => {
      const v = parseEditableNumber(this._volumeNumber.textContent ?? "");
      if (!Number.isFinite(v)) {
        updateVolume();
        return;
      }
      if (this._playerSettingsService.volumeUnitDb) {
        const db = Math.min(0, Math.max(-80, v));
        this._volumeBar.value = String(db);
      } else {
        const pct = Math.min(100, Math.max(0, Math.round(v)));
        this._volumeBar.value = String(pct);
      }
      updateVolume();
    };

    this._addEventlistener(this._volumeNumber, "blur", commitVolumeNumber);
    this._addEventlistener(this._volumeNumber, EventType.KEY_DOWN, (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter") {
        ke.preventDefault();
        this._volumeNumber.blur();
      }
    });

    const commitPositionNumber = () => {
      const v = parseEditableNumber(this._positionNumber.textContent ?? "");
      if (!Number.isFinite(v)) {
        this._positionNumber.textContent =
          this._playerService.playbackPosition.toFixed(2);
        return;
      }
      const dur = this._playerService.getAudioDuration();
      const clamped = Math.min(Math.max(0, v), dur);
      const pct = dur > 0 ? (100 * clamped) / dur : 0;
      this._playerService.onSeekbarInput(pct);
    };

    this._addEventlistener(this._positionNumber, "blur", commitPositionNumber);
    this._addEventlistener(this._positionNumber, EventType.KEY_DOWN, (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter") {
        ke.preventDefault();
        this._positionNumber.blur();
      }
    });

    this._playButton = <HTMLButtonElement>(
      this._componentRoot.querySelector(".playButton")
    );
    this._addEventlistener(this._playButton, EventType.CLICK, () => {
      if (this._playerService.isPlaying) {
        this._playerService.pause();
      } else {
        this._playerService.play();
      }
    });
    this._playButton.textContent = "play";
    this._playButton.style.display = "block";
    this._addEventlistener(
      this._playerService,
      EventType.UPDATE_IS_PLAYING,
      () => {
        if (this._playerService.isPlaying) {
          this._playButton.textContent = "pause";
        } else {
          this._playButton.textContent = "play";
        }
      },
    );

    if (this._playerSettingsService.enableSpacekeyPlay) {
      this._addEventlistener(window, EventType.KEY_DOWN, (e: KeyboardEvent) => {
        if (e.isComposing || e.code !== "Space") {
          return;
        }
        e.preventDefault();
        this._playButton.click();
      });
    }
  }

  public dispose() {
    if (this._playerService.isPlaying) {
      this._playerService.pause();
    }
    super.dispose();
  }
}
