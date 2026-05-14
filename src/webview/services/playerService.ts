import { EventType } from "../events";
import Service from "../service";
import PlayerSettingsService from "./playerSettingsService";
import AnalyzeSettingsService from "./analyzeSettingsService";
import { monitoringGainsForMode } from "../utils/liveMonitoring";

export default class PlayerService extends Service {
  private _audioContext: AudioContext;
  private _audioBuffer: AudioBuffer;
  private _playerSettingsService: PlayerSettingsService;
  private _analyzeSettingsService: AnalyzeSettingsService;

  private _isPlaying: boolean = false;
  private _lastStartAcTime: number = 0;
  private _currentSec: number = 0;
  /** Fixed playback start / cue time (white line). Not advanced by pause or tick. */
  private _playbackPosition: number = 0;
  private _source: AudioBufferSourceNode;

  public get playbackPosition() {
    return this._playbackPosition;
  }

  /**
   * Sets the fixed playback cue (absolute seconds). Play always starts from here;
   * pausing does not move this value.
   */
  public setPlaybackPosition(sec: number) {
    this._playbackPosition = Math.max(
      0,
      Math.min(sec, this._audioBuffer.duration),
    );
    this.dispatchEvent(
      new CustomEvent(EventType.UPDATE_PLAYBACK_POSITION, {
        detail: {
          sec: this._playbackPosition,
          percent:
            (100 * this._playbackPosition) / this._audioBuffer.duration,
        },
      }),
    );
  }

  public get isPlaying() {
    return this._isPlaying;
  }

  public getAudioDuration(): number {
    return this._audioBuffer.duration;
  }
  public get currentSec() {
    return this._currentSec;
  }

  private _gainNode: GainNode;
  // volume is 0~1
  public get volume() {
    if (!this._gainNode) {
      return 1;
    }
    return this._gainNode.gain.value;
  }
  public set volume(value: number) {
    if (!this._gainNode) {
      return;
    }
    this._gainNode.gain.value = value;
  }

  private _hpfNode: BiquadFilterNode;
  private _lpfNode: BiquadFilterNode;

  // Live analyser graph nodes (created/destroyed on demand)
  private _liveGraphActive: boolean = false;
  private _splitter: ChannelSplitterNode | null = null;
  private _merger: ChannelMergerNode | null = null;
  private _analyserL: AnalyserNode | null = null;
  private _analyserR: AnalyserNode | null = null;
  private _gLL: GainNode | null = null;
  private _gLR: GainNode | null = null;
  private _gRL: GainNode | null = null;
  private _gRR: GainNode | null = null;

  private _seekbarValue: number = 0;
  private _animationFrameID: number = 0;

  constructor(
    audioContext: AudioContext,
    audioBuffer: AudioBuffer,
    playerSettingsService: PlayerSettingsService,
    analyzeSettingsService: AnalyzeSettingsService,
  ) {
    super();
    this._audioContext = audioContext;
    this._audioBuffer = audioBuffer;
    this._playerSettingsService = playerSettingsService;
    this._analyzeSettingsService = analyzeSettingsService;

    // init volume — do NOT connect to destination here; routing is decided in play()
    this._gainNode = this._audioContext.createGain();

    // init high-pass filter
    this._hpfNode = this._audioContext.createBiquadFilter();
    this._hpfNode.type = "highpass";
    this._hpfNode.Q.value = Math.SQRT1_2; // butterworth

    // init low-pass filter
    this._lpfNode = this._audioContext.createBiquadFilter();
    this._lpfNode.type = "lowpass";
    this._lpfNode.Q.value = Math.SQRT1_2; // butterworth

    // play again if filter related setting is changed
    const applyFilters = () => {
      if (this._isPlaying) {
        this.pause();
        this.play();
      }
    };
    this._playerSettingsService.addEventListener(
      EventType.PS_UPDATE_ENABLE_HPF,
      applyFilters,
    );
    this._playerSettingsService.addEventListener(
      EventType.PS_UPDATE_HPF_FREQUENCY,
      applyFilters,
    );
    this._playerSettingsService.addEventListener(
      EventType.PS_UPDATE_ENABLE_LPF,
      applyFilters,
    );
    this._playerSettingsService.addEventListener(
      EventType.PS_UPDATE_LPF_FREQUENCY,
      applyFilters,
    );

    // rebuild live graph when toggles change
    const onLiveToggle = () => {
      this._updateLiveGraph();
      if (this._isPlaying) {
        this.pause();
        this.play();
      }
    };
    this._analyzeSettingsService.addEventListener(
      EventType.AS_UPDATE_SHOW_LEVEL_METER,
      onLiveToggle,
    );
    this._analyzeSettingsService.addEventListener(
      EventType.AS_UPDATE_SHOW_LIVE_ANALYSIS,
      onLiveToggle,
    );

    // fftSize change — only update fftSize if analysers exist; no glitch since
    // analysers are not in the signal path (they tap, not block)
    this._analyzeSettingsService.addEventListener(
      EventType.AS_UPDATE_LIVE_ANALYSIS_FFT_SIZE,
      () => {
        const fftSize = this._analyzeSettingsService.liveAnalysisFftSize;
        if (this._analyserL) this._analyserL.fftSize = fftSize;
        if (this._analyserR) this._analyserR.fftSize = fftSize;
      },
    );

    this._analyzeSettingsService.addEventListener(
      EventType.AS_UPDATE_LIVE_MONITORING_MODE,
      () => this._applyMonitoringGains(),
    );
  }

  /** Returns the live analyser pair, or null when the live graph is not active. */
  public getAnalysers(): { left: AnalyserNode; right: AnalyserNode } | null {
    if (!this._liveGraphActive || !this._analyserL || !this._analyserR) {
      return null;
    }
    return { left: this._analyserL, right: this._analyserR };
  }

  // ─── Private graph helpers ─────────────────────────────────────────────────

  private _needsLiveGraph(): boolean {
    return (
      this._analyzeSettingsService.showLevelMeter ||
      this._analyzeSettingsService.showLiveAnalysis
    );
  }

  /** Create or destroy the splitter→analyser→merger sub-graph as needed. */
  private _updateLiveGraph(): void {
    const needed = this._needsLiveGraph();
    if (needed === this._liveGraphActive) {
      return;
    }
    if (needed) {
      this._createLiveGraph();
    } else {
      this._destroyLiveGraph();
    }
  }

  private _applyMonitoringGains(): void {
    if (!this._gLL || !this._gLR || !this._gRL || !this._gRR) return;
    const g = monitoringGainsForMode(
      this._analyzeSettingsService.liveMonitoringMode,
    );
    this._gLL.gain.value = g.ll;
    this._gLR.gain.value = g.lr;
    this._gRL.gain.value = g.rl;
    this._gRR.gain.value = g.rr;
  }

  private _createLiveGraph(): void {
    const ctx = this._audioContext;
    const fftSize = this._analyzeSettingsService.liveAnalysisFftSize;
    const numChannels = Math.min(2, this._audioBuffer.numberOfChannels);

    this._splitter = ctx.createChannelSplitter(numChannels);
    this._merger = ctx.createChannelMerger(2);

    this._analyserL = ctx.createAnalyser();
    this._analyserL.fftSize = fftSize;
    this._analyserL.smoothingTimeConstant = 0;

    this._analyserR = ctx.createAnalyser();
    this._analyserR.fftSize = fftSize;
    this._analyserR.smoothingTimeConstant = 0;

    this._gLL = ctx.createGain();
    this._gLR = ctx.createGain();
    this._gRL = ctx.createGain();
    this._gRR = ctx.createGain();

    this._splitter.connect(this._analyserL, 0);
    if (numChannels >= 2) {
      this._splitter.connect(this._analyserR, 1);
    } else {
      this._splitter.connect(this._analyserR, 0);
    }

    this._analyserL.connect(this._gLL);
    this._analyserL.connect(this._gLR);
    this._analyserR.connect(this._gRL);
    this._analyserR.connect(this._gRR);

    this._gLL.connect(this._merger, 0, 0);
    this._gLR.connect(this._merger, 0, 1);
    this._gRL.connect(this._merger, 0, 0);
    this._gRR.connect(this._merger, 0, 1);

    this._merger.connect(ctx.destination);
    this._liveGraphActive = true;
    this._applyMonitoringGains();
  }

  private _destroyLiveGraph(): void {
    try { this._merger?.disconnect(); } catch (_) { /* already disconnected */ }
    try { this._gLL?.disconnect(); } catch (_) { /* already disconnected */ }
    try { this._gLR?.disconnect(); } catch (_) { /* already disconnected */ }
    try { this._gRL?.disconnect(); } catch (_) { /* already disconnected */ }
    try { this._gRR?.disconnect(); } catch (_) { /* already disconnected */ }
    try { this._analyserL?.disconnect(); } catch (_) { /* already disconnected */ }
    try { this._analyserR?.disconnect(); } catch (_) { /* already disconnected */ }
    try { this._splitter?.disconnect(); } catch (_) { /* already disconnected */ }

    this._splitter = null;
    this._merger = null;
    this._analyserL = null;
    this._analyserR = null;
    this._gLL = null;
    this._gLR = null;
    this._gRL = null;
    this._gRR = null;
    this._liveGraphActive = false;
  }

  /**
   * Connect _gainNode to the correct output endpoint.
   * Must be called each time play() rebuilds the source chain.
   */
  private _connectGainOutput(): void {
    // gainNode always disconnects before reconnecting to avoid double-connections
    try { this._gainNode.disconnect(); } catch (_) { /* ok */ }

    this._updateLiveGraph();

    if (this._liveGraphActive && this._splitter) {
      this._gainNode.connect(this._splitter);
    } else {
      this._gainNode.connect(this._audioContext.destination);
    }
  }

  // ─── Public playback API ───────────────────────────────────────────────────

  public play() {
    // connect nodes: source → [hpf →] [lpf →] gain → [splitter → analysers → merger →] destination
    let lastNode: AudioNode = this._gainNode;

    this._lpfNode.disconnect();
    if (this._playerSettingsService.enableLpf) {
      this._lpfNode.frequency.value = this._playerSettingsService.lpfFrequency;
      this._lpfNode.connect(lastNode);
      lastNode = this._lpfNode;
    }

    this._hpfNode.disconnect();
    if (this._playerSettingsService.enableHpf) {
      this._hpfNode.frequency.value = this._playerSettingsService.hpfFrequency;
      this._hpfNode.connect(lastNode);
      lastNode = this._hpfNode;
    }

    this._connectGainOutput();

    // create audioBufferSourceNode every time,
    // because audioBufferSourceNode.start() can't be called more than once.
    // https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode
    this._source = this._audioContext.createBufferSource();
    this._source.buffer = this._audioBuffer;
    this._source.connect(lastNode);

    // Always start from the fixed cue (white line), not from where we last paused.
    this._isPlaying = true;
    this._currentSec = this._playbackPosition;
    this._lastStartAcTime = this._audioContext.currentTime;
    this._source.start(this._audioContext.currentTime, this._playbackPosition);

    // update playing status
    this.dispatchEvent(
      new CustomEvent(EventType.UPDATE_IS_PLAYING, {
        detail: {
          value: this._isPlaying,
        },
      }),
    );

    // move seek bar
    this._animationFrameID = requestAnimationFrame(() => this.tick());
  }

  public pause() {
    cancelAnimationFrame(this._animationFrameID);

    this._source.stop();
    this._currentSec += this._audioContext.currentTime - this._lastStartAcTime;
    const stopped = Math.max(
      0,
      Math.min(this._currentSec, this._audioBuffer.duration),
    );
    this._currentSec = stopped;
    this._seekbarValue =
      this._audioBuffer.duration > 0
        ? (100 * stopped) / this._audioBuffer.duration
        : 0;
    this._isPlaying = false;
    this._source = undefined;

    this.dispatchEvent(
      new CustomEvent(EventType.UPDATE_SEEKBAR, {
        detail: {
          value: this._seekbarValue,
          pos: stopped,
        },
      }),
    );

    this.dispatchEvent(
      new CustomEvent(EventType.UPDATE_IS_PLAYING, {
        detail: {
          value: this._isPlaying,
        },
      }),
    );
  }

  public tick() {
    // Prefer getOutputTimestamp for sub-buffer-size latency compensation
    const ts =
      typeof this._audioContext.getOutputTimestamp === "function"
        ? this._audioContext.getOutputTimestamp()
        : null;
    const acTime =
      ts && ts.contextTime > 0
        ? ts.contextTime
        : this._audioContext.currentTime;

    const current = this._currentSec + acTime - this._lastStartAcTime;
    this._seekbarValue = (100 * current) / this._audioBuffer.duration;

    // update seek bar value
    this.dispatchEvent(
      new CustomEvent(EventType.UPDATE_SEEKBAR, {
        detail: {
          value: this._seekbarValue,
          pos: current,
        },
      }),
    );

    if (current > this._audioBuffer.duration) {
      cancelAnimationFrame(this._animationFrameID);
      this._source.stop();
      const dur = this._audioBuffer.duration;
      this._currentSec = dur;
      this._seekbarValue = dur > 0 ? 100 : 0;
      this._isPlaying = false;
      this._source = undefined;

      this.dispatchEvent(
        new CustomEvent(EventType.UPDATE_SEEKBAR, {
          detail: {
            value: this._seekbarValue,
            pos: dur,
          },
        }),
      );
      this.dispatchEvent(
        new CustomEvent(EventType.UPDATE_IS_PLAYING, {
          detail: {
            value: this._isPlaying,
          },
        }),
      );
      return;
    }

    if (this._isPlaying) {
      this._animationFrameID = requestAnimationFrame(() => this.tick());
    }
  }

  /**
   * Live update UI while dragging the position slider (does not restart playback).
   * seek value is 0~100.
   */
  public previewSeekFromPercent(value: number) {
    const sec = (value * this._audioBuffer.duration) / 100;
    this.setPlaybackPosition(sec);
    this._currentSec = this._playbackPosition;
    this._seekbarValue = value;
    this.dispatchEvent(
      new CustomEvent(EventType.UPDATE_SEEKBAR, {
        detail: {
          value: this._seekbarValue,
          pos: this._currentSec,
        },
      }),
    );
  }

  // seekbar value is 0~100
  public onSeekbarInput(value: number) {
    const resumeRequired = this._isPlaying;

    if (this._isPlaying) {
      this.pause();
    }

    const sec = (value * this._audioBuffer.duration) / 100;
    this.setPlaybackPosition(sec);
    this._currentSec = this._playbackPosition;
    this._seekbarValue = value;
    this.dispatchEvent(
      new CustomEvent(EventType.UPDATE_SEEKBAR, {
        detail: {
          value: this._seekbarValue,
          pos: this._currentSec,
        },
      }),
    );

    // restart from selected place
    if (resumeRequired || this._playerSettingsService.enableSeekToPlay) {
      this.play();
    }
  }
}
