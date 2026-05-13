import { EventType } from "../events";
import { AnalyzeDefault } from "../../config";
import { getRangeValues, getValueInEnum, getValueInRange } from "../../util";
import Service from "../service";
import type { LiveMonitoringMode } from "../utils/liveMonitoring";

export enum WindowSizeIndex {
  W256 = 0,
  W512 = 1,
  W1024 = 2,
  W2048 = 3,
  W4096 = 4,
  W8192 = 5,
  W16384 = 6,
  W32768 = 7,
}

/** Allowed STFT window lengths (samples), ascending. */
export const FFT_WINDOW_SAMPLES = [
  256, 512, 1024, 2048, 4096, 8192, 16384, 32768,
] as const;

/**
 * Map an ideal FFT length to the nearest allowed window size (linear distance in samples).
 */
export function snapFftWindowSamples(ideal: number): number {
  const clamped = Math.max(256, Math.min(32768, ideal));
  let best: number = FFT_WINDOW_SAMPLES[0];
  let bestScore = Infinity;
  for (const n of FFT_WINDOW_SAMPLES) {
    const score = Math.abs(n - clamped);
    if (score < bestScore) {
      bestScore = score;
      best = n;
    }
  }
  return best;
}

/**
 * Infer FFT window (samples) for **music / speech**-like content from the visible
 * time range `T` (s), sample rate `fs` (Hz), and spectrogram canvas width `W` (px).
 *
 * **Quasi-stationarity (literature):** speech is often taken as quasi-stationary on
 * ~20–30 ms; tonal / musical structure evolves more slowly, and common STFT
 * references cite ~40–60 ms as a useful analysis-window scale. We model a target
 * physical window τ(T) = τ_lo + (τ_hi−τ_lo)(1−e^(−T/T_s)) so longer spans allow a
 * slightly longer window for frequency detail without jumping immediately to large N.
 *
 * **Hop / overlap / canvas:** with this extension’s hop heuristic, time columns are
 * roughly K ≈ W·1024 / (2N) when the “min rect width” branch dominates. We require
 * K ≥ K_screen(T) with K_screen relaxed as T grows (longer views tolerate fewer columns
 * and can use a larger n_fft). We then take min(N_stationary, N_canvas) so the
 * stricter of “physical window” vs “keep enough time columns” wins—matching the
 * observation that ~50 s views still favor 512 over 1024. Constants below were tuned
 * so music/speech-style zoom levels land on sensible defaults at 44.1 kHz and W≈1800.
 */
export function inferFftWindowSamplesForTimeRange(
  timeRangeSec: number,
  sampleRate: number,
  spectrogramCanvasWidth: number,
): number {
  const T = Math.max(1e-6, timeRangeSec);
  const fs = Math.max(8000, sampleRate);
  const W = Math.max(512, spectrogramCanvasWidth);

  const tauLo = 0.009;
  const tauHi = 0.051;
  const tauS = 138;
  const tauStat =
    tauLo + (tauHi - tauLo) * (1 - Math.exp(-T / tauS));
  const nStationary = tauStat * fs;

  const kFloor = 410;
  const kScreen = Math.max(
    kFloor,
    735 +
      1520 * Math.exp(-T / 7.1) +
      785 * Math.exp(-T / 98) +
      1.1 * T,
  );
  const nCanvas = (W * 1024) / (2 * kScreen);

  let nIdeal = Math.min(nStationary, nCanvas);
  const longViewSec = 275;
  const longViewWindowMs = 39.2;
  if (T > longViewSec) {
    nIdeal = Math.max(
      nIdeal,
      Math.min(nStationary, (longViewWindowMs / 1000) * fs),
    );
  }

  return snapFftWindowSamples(Math.min(8192, Math.max(256, nIdeal)));
}

export enum FrequencyScale {
  Linear = 0,
  Log = 1,
  Mel = 2,
}

export enum WindowType {
  Hann = 0,
  Hamming = 1,
  BlackmanHarris = 2,
  Triangular = 3,
}

export enum FftBackend {
  Ooura = 0,
  Essentia = 1,
}

export interface AnalyzeSettingsProps {
  waveformVerticalScale: number;
  spectrogramVerticalScale: number;
  windowSize: number;
  hopSize: number;
  minFrequency: number;
  maxFrequency: number;
  minTime: number;
  maxTime: number;
  minAmplitude: number;
  maxAmplitude: number;
  spectrogramAmplitudeRange: number;
  spectrogramAmplitudeLow: number;
  spectrogramAmplitudeHigh: number;
  frequencyScale: number;
  melFilterNum: number;
  windowType: WindowType;
  fftBackend: FftBackend;
}

export default class AnalyzeSettingsService extends Service {
  public static readonly WAVEFORM_CANVAS_WIDTH = 1000;
  public static readonly WAVEFORM_CANVAS_HEIGHT = 200;
  public static readonly WAVEFORM_CANVAS_VERTICAL_SCALE_MAX = 2.0;
  public static readonly WAVEFORM_CANVAS_VERTICAL_SCALE_MIN = 0.2;
  public static readonly SPECTROGRAM_CANVAS_WIDTH = 1800;
  public static readonly SPECTROGRAM_CANVAS_HEIGHT = 600;
  public static readonly SPECTROGRAM_CANVAS_VERTICAL_SCALE_MAX = 2.0;
  public static readonly SPECTROGRAM_CANVAS_VERTICAL_SCALE_MIN = 0.2;

  /** Spectrogram canvas width used when high-resolution mode is off. */
  public static spectrogramRenderWidth(highRes: boolean): number {
    return highRes ? 3600 : AnalyzeSettingsService.SPECTROGRAM_CANVAS_WIDTH;
  }

  /** Base spectrogram canvas height (before vertical scale) when high-resolution is off. */
  public static spectrogramRenderHeightBase(highRes: boolean): number {
    return highRes ? 900 : AnalyzeSettingsService.SPECTROGRAM_CANVAS_HEIGHT;
  }

  private _sampleRate: number;
  private _duration: number;

  private _minAmplitudeOfAudioBuffer: number;
  public get minAmplitudeOfAudioBuffer() {
    return this._minAmplitudeOfAudioBuffer;
  }

  private _maxAmplitudeOfAudioBuffer: number;
  public get maxAmplitudeOfAudioBuffer() {
    return this._maxAmplitudeOfAudioBuffer;
  }

  private _autoCalcHopSize: boolean = true;
  public set autoCalsHopSize(value: boolean) {
    this._autoCalcHopSize = value;
  }

  private _highResolutionSpectrogram: boolean = false;
  public get highResolutionSpectrogram(): boolean {
    return this._highResolutionSpectrogram;
  }
  public set highResolutionSpectrogram(value: boolean) {
    this._highResolutionSpectrogram = value === true;
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_HIGH_RESOLUTION_SPECTROGRAM, {
        detail: { value: this._highResolutionSpectrogram },
      }),
    );
    if (this._autoCalcHopSize) {
      this.hopSize = this.calcHopSize();
    }
  }

  private _fftWindowAuto: boolean = false;
  public get fftWindowAuto(): boolean {
    return this._fftWindowAuto;
  }
  public set fftWindowAuto(value: boolean) {
    this._fftWindowAuto = value === true;
    if (this._fftWindowAuto) {
      this.applyInferredBaseWindowAndHop();
    } else {
      this._windowSize = 2 ** (this._windowSizeIndex + 8);
      if (this._autoCalcHopSize) {
        this._hopSize = this.calcHopSize();
      }
    }
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_FFT_WINDOW_AUTO, {
        detail: { value: this._fftWindowAuto },
      }),
    );
  }

  /** Inferred FFT length for the current time range (for UI label when auto). */
  public get inferredAutoWindowSamples(): number {
    const T = Math.max(1e-9, this._maxTime - this._minTime);
    return inferFftWindowSamplesForTimeRange(
      T,
      this._sampleRate,
      AnalyzeSettingsService.spectrogramRenderWidth(this._highResolutionSpectrogram),
    );
  }

  private _persistHook?: () => void;

  private _waveformVisible: boolean;
  public get waveformVisible() {
    return this._waveformVisible;
  }
  public set waveformVisible(value: boolean) {
    this._waveformVisible = value === undefined ? true : value; // true by default
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_WAVEFORM_VISIBLE, {
        detail: { value: this._waveformVisible },
      }),
    );
  }

  private _waveformVerticalScale: number;
  public get waveformVerticalScale() {
    return this._waveformVerticalScale;
  }
  public set waveformVerticalScale(value: number) {
    this._waveformVerticalScale = getValueInRange(
      value,
      AnalyzeSettingsService.WAVEFORM_CANVAS_VERTICAL_SCALE_MIN,
      AnalyzeSettingsService.WAVEFORM_CANVAS_VERTICAL_SCALE_MAX,
      1.0,
    );
  }

  private _spectrogramVisible: boolean;
  public get spectrogramVisible() {
    return this._spectrogramVisible;
  }
  public set spectrogramVisible(value: boolean) {
    this._spectrogramVisible = value === undefined ? true : value; // true by default
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_SPECTROGRAM_VISIBLE, {
        detail: { value: this._spectrogramVisible },
      }),
    );
  }

  private _spectrogramVerticalScale: number;
  public get spectrogramVerticalScale() {
    return this._spectrogramVerticalScale;
  }
  public set spectrogramVerticalScale(value: number) {
    this._spectrogramVerticalScale = getValueInRange(
      value,
      AnalyzeSettingsService.SPECTROGRAM_CANVAS_VERTICAL_SCALE_MIN,
      AnalyzeSettingsService.SPECTROGRAM_CANVAS_VERTICAL_SCALE_MAX,
      1.0,
    );
  }

  private _windowSizeIndex: number;
  public get windowSizeIndex() {
    return this._windowSizeIndex;
  }
  public set windowSizeIndex(value: number) {
    const windowSizeIndex = getValueInEnum(
      value,
      WindowSizeIndex,
      WindowSizeIndex.W1024,
    );
    this._windowSizeIndex = windowSizeIndex;
    if (!this._fftWindowAuto) {
      this.windowSize = 2 ** (windowSizeIndex + 8);
    }
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_WINDOW_SIZE_INDEX, {
        detail: { value: this._windowSizeIndex },
      }),
    );
  }

  private _windowSize: number;
  public get windowSize() {
    return this._windowSize;
  }
  public set windowSize(value: number) {
    this._windowSize = value;
    if (this._autoCalcHopSize) {
      this.hopSize = this.calcHopSize();
    }
  }

  private _hopSize: number;
  public get hopSize() {
    return this._hopSize;
  }
  public set hopSize(value: number) {
    this._hopSize = value;
  }

  private _minFrequency: number;
  public get minFrequency() {
    return this._minFrequency;
  }
  public set minFrequency(value: number) {
    const [minFrequency] = getRangeValues(
      value,
      this.maxFrequency,
      0,
      this._sampleRate / 2,
      0,
      this._sampleRate / 2,
    );
    this._minFrequency = minFrequency;
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_MIN_FREQUENCY, {
        detail: { value: this._minFrequency },
      }),
    );
  }

  private _maxFrequency: number;
  public get maxFrequency() {
    return this._maxFrequency;
  }
  public set maxFrequency(value: number) {
    const [, maxFrequency] = getRangeValues(
      this.minFrequency,
      value,
      0,
      this._sampleRate / 2,
      0,
      this._sampleRate / 2,
    );
    this._maxFrequency = maxFrequency;
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_MAX_FREQUENCY, {
        detail: { value: this._maxFrequency },
      }),
    );
  }

  private _minTime: number;
  public get minTime() {
    return this._minTime;
  }
  public set minTime(value: number) {
    const [minTime] = getRangeValues(
      value,
      this.maxTime,
      0,
      this._duration,
      0,
      this._duration,
    );
    this._minTime = minTime;
    if (this._fftWindowAuto) {
      this.applyInferredBaseWindowAndHop();
    } else if (this._autoCalcHopSize) {
      this._hopSize = this.calcHopSize();
    }
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_MIN_TIME, {
        detail: { value: this._minTime },
      }),
    );
    if (this._fftWindowAuto) {
      this.dispatchEvent(
        new CustomEvent(EventType.AS_UPDATE_FFT_WINDOW_AUTO, {
          detail: { value: true },
        }),
      );
    }
  }

  private _maxTime: number;
  public get maxTime() {
    return this._maxTime;
  }
  public set maxTime(value: number) {
    const [, maxTime] = getRangeValues(
      this.minTime,
      value,
      0,
      this._duration,
      0,
      this._duration,
    );
    this._maxTime = maxTime;
    if (this._fftWindowAuto) {
      this.applyInferredBaseWindowAndHop();
    } else if (this._autoCalcHopSize) {
      this._hopSize = this.calcHopSize();
    }
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_MAX_TIME, {
        detail: { value: this._maxTime },
      }),
    );
    if (this._fftWindowAuto) {
      this.dispatchEvent(
        new CustomEvent(EventType.AS_UPDATE_FFT_WINDOW_AUTO, {
          detail: { value: true },
        }),
      );
    }
  }

  private _minAmplitude: number;
  public get minAmplitude() {
    return this._minAmplitude;
  }
  public set minAmplitude(value: number) {
    const [minAmplitude] = getRangeValues(
      value,
      this.maxAmplitude,
      -100,
      100,
      this._minAmplitudeOfAudioBuffer,
      this._maxAmplitudeOfAudioBuffer,
    );
    this._minAmplitude = minAmplitude;
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_MIN_AMPLITUDE, {
        detail: { value: this._minAmplitude },
      }),
    );
  }

  private _maxAmplitude: number;
  public get maxAmplitude() {
    return this._maxAmplitude;
  }
  public set maxAmplitude(value: number) {
    const [, maxAmplitude] = getRangeValues(
      this.minAmplitude,
      value,
      -100,
      100,
      this._minAmplitudeOfAudioBuffer,
      this._maxAmplitudeOfAudioBuffer,
    );
    this._maxAmplitude = maxAmplitude;
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_MAX_AMPLITUDE, {
        detail: { value: this._maxAmplitude },
      }),
    );
  }

  private _spectrogramAmplitudeRange: number;
  public get spectrogramAmplitudeRange() {
    return this._spectrogramAmplitudeRange;
  }
  public set spectrogramAmplitudeRange(value: number) {
    const [spectrogramAmplitudeRange] = getRangeValues(
      value,
      0,
      -1000,
      0,
      -90,
      0,
    );
    this._spectrogramAmplitudeRange = spectrogramAmplitudeRange;
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_SPECTROGRAM_AMPLITUDE_RANGE, {
        detail: { value: this._spectrogramAmplitudeRange },
      }),
    );
  }

  private _spectrogramAmplitudeLow: number;
  public get spectrogramAmplitudeLow() {
    return this._spectrogramAmplitudeLow;
  }
  public set spectrogramAmplitudeLow(value: number) {
    const [low] = getRangeValues(
      value,
      this._spectrogramAmplitudeHigh,
      -1000,
      0,
      -90,
      0,
    );
    this._spectrogramAmplitudeLow = low;
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_SPECTROGRAM_AMPLITUDE_LOW, {
        detail: { value: this._spectrogramAmplitudeLow },
      }),
    );
  }

  private _spectrogramAmplitudeHigh: number;
  public get spectrogramAmplitudeHigh() {
    return this._spectrogramAmplitudeHigh;
  }
  public set spectrogramAmplitudeHigh(value: number) {
    const [, high] = getRangeValues(
      this._spectrogramAmplitudeLow,
      value,
      -1000,
      0,
      -90,
      0,
    );
    this._spectrogramAmplitudeHigh = high;
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_SPECTROGRAM_AMPLITUDE_HIGH, {
        detail: { value: this._spectrogramAmplitudeHigh },
      }),
    );
  }

  private _frequencyScale: FrequencyScale;
  public get frequencyScale() {
    return this._frequencyScale;
  }
  public set frequencyScale(value: FrequencyScale) {
    const frequencyScale = getValueInEnum(
      value,
      FrequencyScale,
      FrequencyScale.Linear,
    );
    this._frequencyScale = frequencyScale;
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_FREQUENCY_SCALE, {
        detail: { value: this._frequencyScale },
      }),
    );
  }

  private _windowType: WindowType;
  public get windowType() {
    return this._windowType;
  }
  public set windowType(value: WindowType) {
    const windowType = getValueInEnum(value, WindowType, WindowType.Hann);
    this._windowType = windowType;
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_WINDOW_TYPE, {
        detail: { value: this._windowType },
      }),
    );
  }

  private _fftBackend: FftBackend = FftBackend.Ooura;
  public get fftBackend() {
    return this._fftBackend;
  }
  public set fftBackend(value: FftBackend) {
    this._fftBackend = getValueInEnum(value, FftBackend, FftBackend.Ooura);
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_FFT_BACKEND, {
        detail: { value: this._fftBackend },
      }),
    );
  }

  private _showLevelMeter: boolean = false;
  public get showLevelMeter(): boolean {
    return this._showLevelMeter;
  }
  public set showLevelMeter(value: boolean) {
    this._showLevelMeter = value === true;
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_SHOW_LEVEL_METER, {
        detail: { value: this._showLevelMeter },
      }),
    );
  }

  private _showLiveAnalysis: boolean = false;
  public get showLiveAnalysis(): boolean {
    return this._showLiveAnalysis;
  }
  public set showLiveAnalysis(value: boolean) {
    this._showLiveAnalysis = value === true;
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_SHOW_LIVE_ANALYSIS, {
        detail: { value: this._showLiveAnalysis },
      }),
    );
  }

  private static readonly LIVE_FFT_SIZES = [512, 1024, 2048, 4096] as const;
  private _liveAnalysisFftSize: 512 | 1024 | 2048 | 4096 = 2048;
  public get liveAnalysisFftSize(): 512 | 1024 | 2048 | 4096 {
    return this._liveAnalysisFftSize;
  }
  public set liveAnalysisFftSize(value: number) {
    const valid = AnalyzeSettingsService.LIVE_FFT_SIZES.includes(
      value as 512 | 1024 | 2048 | 4096,
    );
    this._liveAnalysisFftSize = valid
      ? (value as 512 | 1024 | 2048 | 4096)
      : 2048;
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_LIVE_ANALYSIS_FFT_SIZE, {
        detail: { value: this._liveAnalysisFftSize },
      }),
    );
  }

  private static readonly LIVE_TILT_VALUES = [0, 1.5, 3, 4.5, 6] as const;

  private _liveVisualSmoothingPct: number = 35;
  public get liveVisualSmoothingPct(): number {
    return this._liveVisualSmoothingPct;
  }
  public set liveVisualSmoothingPct(value: number) {
    this._liveVisualSmoothingPct = getValueInRange(
      Math.round(Number(value)),
      0,
      100,
      35,
    );
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_LIVE_VISUAL_SMOOTHING, {
        detail: { value: this._liveVisualSmoothingPct },
      }),
    );
  }

  private _liveSpectrumTiltDbPerOct: 0 | 1.5 | 3 | 4.5 | 6 = 0;
  public get liveSpectrumTiltDbPerOct(): 0 | 1.5 | 3 | 4.5 | 6 {
    return this._liveSpectrumTiltDbPerOct;
  }
  public set liveSpectrumTiltDbPerOct(value: number) {
    const v = Number(value);
    const ok = (AnalyzeSettingsService.LIVE_TILT_VALUES as readonly number[]).includes(
      v,
    );
    this._liveSpectrumTiltDbPerOct = ok
      ? (v as 0 | 1.5 | 3 | 4.5 | 6)
      : 0;
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_LIVE_SPECTRUM_TILT, {
        detail: { value: this._liveSpectrumTiltDbPerOct },
      }),
    );
  }

  private _liveMonitoringMode: LiveMonitoringMode = "lr";
  public get liveMonitoringMode(): LiveMonitoringMode {
    return this._liveMonitoringMode;
  }
  public set liveMonitoringMode(value: LiveMonitoringMode) {
    const v = String(value).toLowerCase();
    const allowed = ["lr", "l", "r", "m", "s"];
    this._liveMonitoringMode = (allowed.includes(v) ? v : "lr") as LiveMonitoringMode;
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_LIVE_MONITORING_MODE, {
        detail: { value: this._liveMonitoringMode },
      }),
    );
  }

  private _melFilterNum: number;
  public get melFilterNum() {
    return this._melFilterNum;
  }
  public set melFilterNum(value: number) {
    this._melFilterNum = getValueInRange(Math.trunc(value), 20, 200, 40);
    this.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_MEL_FILTER_NUM, {
        detail: { value: this._melFilterNum },
      }),
    );
  }

  private _defaultSetting: AnalyzeDefault;

  private constructor(
    defaultSetting: AnalyzeDefault,
    waveformVisible: boolean,
    waveformVerticalScale: number,
    spectrogramVisible: boolean,
    spectrogramVerticalScale: number,
    windowSize: number,
    hopSize: number,
    minFrequency: number,
    maxFrequency: number,
    minTime: number,
    maxTime: number,
    minAmplitude: number,
    maxAmplitude: number,
    spectrogramAmplitudeRange: number,
    spectrogramAmplitudeLow: number,
    spectrogramAmplitudeHigh: number,
    windowType: WindowType,
  ) {
    super();
    this._defaultSetting = defaultSetting;
    this._waveformVisible = waveformVisible;
    this._waveformVerticalScale = waveformVerticalScale;
    this._spectrogramVisible = spectrogramVisible;
    this._spectrogramVerticalScale = spectrogramVerticalScale;
    this._windowSize = windowSize;
    this._hopSize = hopSize;
    this._minFrequency = minFrequency;
    this._maxFrequency = maxFrequency;
    this._minTime = minTime;
    this._maxTime = maxTime;
    this._minAmplitude = minAmplitude;
    this._maxAmplitude = maxAmplitude;
    this._spectrogramAmplitudeRange = spectrogramAmplitudeRange;
    this._spectrogramAmplitudeLow = spectrogramAmplitudeLow;
    this._spectrogramAmplitudeHigh = spectrogramAmplitudeHigh;
    this._windowType = windowType;
  }

  public static fromDefaultSetting(
    defaultSetting: AnalyzeDefault,
    audioBuffer: AudioBuffer,
  ) {
    // calc min & max amplitude
    let min = Number.POSITIVE_INFINITY,
      max = Number.NEGATIVE_INFINITY;
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      const chData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < chData.length; i++) {
        const v = chData[i];
        if (v < min) {
          min = v;
        }
        if (max < v) {
          max = v;
        }
      }
    }

    // create instance
    const setting = new AnalyzeSettingsService(
      defaultSetting,
      true,
      1.0,
      true,
      1.0,
      1024,
      256,
      0,
      audioBuffer.sampleRate / 2,
      0,
      audioBuffer.duration,
      min,
      max,
      -90,
      -90,
      0,
      WindowType.Hann,
    );

    // set min & max amplitude of audio buffer to instance
    setting._minAmplitudeOfAudioBuffer = min;
    setting._maxAmplitudeOfAudioBuffer = max;
    // set sample rate & duration of audio buffer to instance
    setting._sampleRate = audioBuffer.sampleRate;
    setting._duration = audioBuffer.duration;

    // update the instance props using the values from the default settings

    // init waveform visible
    setting.waveformVisible = defaultSetting.waveformVisible;

    // init waveform vertical scale
    setting.waveformVerticalScale = defaultSetting.waveformVerticalScale;

    // init spectrogram visible
    setting.spectrogramVisible = defaultSetting.spectrogramVisible;

    // init spectrogram vertical scale
    setting.spectrogramVerticalScale = defaultSetting.spectrogramVerticalScale;

    // init fft window size
    setting.windowSizeIndex = defaultSetting.windowSizeIndex;

    // init frequency scale
    setting.frequencyScale = defaultSetting.frequencyScale;

    // init mel filter num
    setting.melFilterNum = defaultSetting.melFilterNum;

    // init default frequency
    setting.minFrequency = defaultSetting.minFrequency;
    setting.maxFrequency = defaultSetting.maxFrequency;

    // init default time range
    setting.minTime = 0;
    setting.maxTime = audioBuffer.duration;

    // init default amplitude
    setting.minAmplitude = defaultSetting.minAmplitude;
    setting.maxAmplitude = defaultSetting.maxAmplitude;

    // init spectrogram amplitude range
    setting.spectrogramAmplitudeRange =
      defaultSetting.spectrogramAmplitudeRange;

    // init spectrogram amplitude from defaults (cached / workspace)
    setting.spectrogramAmplitudeLow =
      defaultSetting.spectrogramAmplitudeLow ?? -90;
    setting.spectrogramAmplitudeHigh =
      defaultSetting.spectrogramAmplitudeHigh ?? 0;

    // init window type from defaults
    if (defaultSetting.windowType !== undefined) {
      setting.windowType = defaultSetting.windowType as WindowType;
    } else {
      setting.windowType = WindowType.Hann;
    }

    if (defaultSetting.fftBackend !== undefined) {
      setting.fftBackend = defaultSetting.fftBackend as FftBackend;
    }

    setting.highResolutionSpectrogram =
      defaultSetting.highResolutionSpectrogram === true;

    setting.fftWindowAuto = defaultSetting.fftWindowAuto === true;

    setting.showLevelMeter = defaultSetting.showLevelMeter === true;
    setting.showLiveAnalysis = defaultSetting.showLiveAnalysis === true;
    if (defaultSetting.liveAnalysisFftSize !== undefined) {
      setting.liveAnalysisFftSize = defaultSetting.liveAnalysisFftSize;
    }

    if (defaultSetting.liveAnalysisVisualSmoothingPct !== undefined) {
      setting.liveVisualSmoothingPct =
        defaultSetting.liveAnalysisVisualSmoothingPct;
    }
    if (defaultSetting.liveSpectrumTiltDbPerOct !== undefined) {
      setting.liveSpectrumTiltDbPerOct =
        defaultSetting.liveSpectrumTiltDbPerOct;
    }
    if (defaultSetting.liveMonitoringMode !== undefined) {
      setting.liveMonitoringMode = defaultSetting.liveMonitoringMode;
    }

    return setting;
  }

  public resetToDefaultTimeRange() {
    this.minTime = 0;
    this.maxTime = this._duration;
  }

  public resetToDefaultAmplitudeRange() {
    this.minAmplitude = this._defaultSetting.minAmplitude;
    this.maxAmplitude = this._defaultSetting.maxAmplitude;
  }

  public resetToDefaultFrequencyRange() {
    this.minFrequency = this._defaultSetting.minFrequency;
    this.maxFrequency = this._defaultSetting.maxFrequency;
  }

  private applyInferredBaseWindowAndHop(): void {
    if (!this._fftWindowAuto) {
      return;
    }
    const T = Math.max(1e-9, this._maxTime - this._minTime);
    this._windowSize = inferFftWindowSamplesForTimeRange(
      T,
      this._sampleRate,
      AnalyzeSettingsService.spectrogramRenderWidth(this._highResolutionSpectrogram),
    );
    if (this._autoCalcHopSize) {
      this._hopSize = this.calcHopSize();
    }
  }

  private get effectiveBaseWindowIndex(): number {
    if (this._fftWindowAuto) {
      const T = Math.max(1e-9, this._maxTime - this._minTime);
      const n = inferFftWindowSamplesForTimeRange(
        T,
        this._sampleRate,
        AnalyzeSettingsService.spectrogramRenderWidth(this._highResolutionSpectrogram),
      );
      return Math.round(Math.log2(n)) - 8;
    }
    return this._windowSizeIndex;
  }

  /*
  Calc hopsize
  This hopSize make rectWidth greater than minRectWidth for every duration of input.
  Thus, spectrogram of long duration input can be drawn as faster as short duration one.

  Use a minimum hopSize to prevent from becoming too small for short periods of data.
  */
  private calcHopSize() {
    const n = this.effectiveWindowSize;
    const minRectWidth = (2 * n) / 1024;
    const fullSampleNum = (this.maxTime - this.minTime) * this._sampleRate;
    const enoughHopSize = Math.trunc(
      (minRectWidth * fullSampleNum) /
        AnalyzeSettingsService.spectrogramRenderWidth(
          this._highResolutionSpectrogram,
        ),
    );
    const minHopSize = n / 32;
    const hopSize = Math.max(enoughHopSize, minHopSize);
    return hopSize;
  }

  /*
  Returns a window size boosted by zoom level so that zoomed-in views have
  higher frequency resolution. Capped at W8192 (index 5) to avoid OOM on
  very narrow ranges.
  */
  private get effectiveWindowSize(): number {
    const totalDuration = this._duration;
    const currentRange = this._maxTime - this._minTime;
    if (
      !totalDuration ||
      !currentRange ||
      currentRange >= totalDuration
    ) {
      return this._windowSize;
    }
    const zoomRatio = totalDuration / currentRange;
    const maxEffectiveIndex = 5; // W8192
    const effectiveIndex = Math.min(
      this.effectiveBaseWindowIndex + Math.floor(Math.log2(zoomRatio)),
      maxEffectiveIndex,
    );
    return Math.pow(2, effectiveIndex + 8);
  }

  public setPersistHook(hook: (() => void) | undefined): void {
    this._persistHook = hook;
  }

  public dispatchEvent(event: Event): boolean {
    const ok = super.dispatchEvent(event);
    this._persistHook?.();
    return ok;
  }

  public toCachedDefaults(): Record<string, unknown> {
    return {
      waveformVisible: this.waveformVisible,
      waveformVerticalScale: this.waveformVerticalScale,
      spectrogramVisible: this.spectrogramVisible,
      spectrogramVerticalScale: this.spectrogramVerticalScale,
      windowSizeIndex: this._windowSizeIndex,
      fftWindowAuto: this._fftWindowAuto,
      frequencyScale: this.frequencyScale,
      melFilterNum: this.melFilterNum,
      minFrequency: this.minFrequency,
      maxFrequency: this.maxFrequency,
      minAmplitude: this.minAmplitude,
      maxAmplitude: this.maxAmplitude,
      spectrogramAmplitudeRange: this.spectrogramAmplitudeRange,
      spectrogramAmplitudeLow: this.spectrogramAmplitudeLow,
      spectrogramAmplitudeHigh: this.spectrogramAmplitudeHigh,
      windowType: this.windowType,
      highResolutionSpectrogram: this.highResolutionSpectrogram,
      fftBackend: this.fftBackend,
      showLevelMeter: this.showLevelMeter,
      showLiveAnalysis: this.showLiveAnalysis,
      liveAnalysisFftSize: this.liveAnalysisFftSize,
      liveAnalysisVisualSmoothingPct: this.liveVisualSmoothingPct,
      liveSpectrumTiltDbPerOct: this.liveSpectrumTiltDbPerOct,
      liveMonitoringMode: this.liveMonitoringMode,
    };
  }

  public toProps(): AnalyzeSettingsProps {
    return {
      waveformVerticalScale: this.waveformVerticalScale,
      spectrogramVerticalScale: this.spectrogramVerticalScale,
      windowSize: this.effectiveWindowSize,
      hopSize: this.hopSize,
      minFrequency: this.minFrequency,
      maxFrequency: this.maxFrequency,
      minTime: this.minTime,
      maxTime: this.maxTime,
      minAmplitude: this.minAmplitude,
      maxAmplitude: this.maxAmplitude,
      spectrogramAmplitudeRange: this.spectrogramAmplitudeRange,
      spectrogramAmplitudeLow: this.spectrogramAmplitudeLow,
      spectrogramAmplitudeHigh: this.spectrogramAmplitudeHigh,
      frequencyScale: this.frequencyScale,
      melFilterNum: this.melFilterNum,
      windowType: this.windowType,
      fftBackend: this.fftBackend,
    };
  }
}
