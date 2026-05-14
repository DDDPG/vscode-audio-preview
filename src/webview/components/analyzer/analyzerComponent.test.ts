import { createAudioContext } from "../../../__mocks__/helper";
import AnalyzeService from "../../services/analyzeService";
import AnalyzeSettingsService from "../../services/analyzeSettingsService";
import PlayerService from "../../services/playerService";
import PlayerSettingsService from "../../services/playerSettingsService";
import AnalyzerComponent from "./analyzerComponent";

describe("analyserComponent", () => {
  let audioBuffer: AudioBuffer;
  let analyzeService: AnalyzeService;
  let analyzeSettingsService: AnalyzeSettingsService;
  let analyzerComponent: AnalyzerComponent;
  beforeAll(() => {
    document.body.innerHTML = '<div id="analyzer"></div>';
    const audioContext = createAudioContext(44100);
    audioBuffer = audioContext.createBuffer(2, 44100, 44100);
    const ad = {
      waveformVisible: undefined,
      waveformVerticalScale: undefined,
      spectrogramVisible: undefined,
      spectrogramVerticalScale: undefined,
      windowSizeIndex: undefined,
      minAmplitude: undefined,
      maxAmplitude: undefined,
      minFrequency: undefined,
      maxFrequency: undefined,
      spectrogramAmplitudeRange: undefined,
      frequencyScale: undefined,
      melFilterNum: undefined,
    };
    analyzeService = new AnalyzeService(audioBuffer);
    analyzeSettingsService = AnalyzeSettingsService.fromDefaultSetting(
      ad,
      audioBuffer,
    );
    const pd = {
      volumeUnitDb: true,
      initialVolumeDb: 0.0,
      initialVolume: 1.0,
      enableSpacekeyPlay: true,
      enableSeekToPlay: true,
      enableHpf: false,
      hpfFrequency: PlayerSettingsService.FILTER_FREQUENCY_HPF_DEFAULT,
      enableLpf: false,
      lpfFrequency: PlayerSettingsService.FILTER_FREQUENCY_LPF_DEFAULT,
      matchFilterFrequencyToSpectrogram: false,
    };
    const playerSettingsService = PlayerSettingsService.fromDefaultSetting(
      pd,
      audioBuffer,
    );
    const playerService = new PlayerService(
      audioContext,
      audioBuffer,
      playerSettingsService,
      analyzeSettingsService,
    );
    analyzerComponent = new AnalyzerComponent(
      "#analyzer",
      audioBuffer,
      analyzeService,
      analyzeSettingsService,
      playerService,
    );
  });

  afterAll(() => {
    analyzerComponent.dispose();
  });

  test("figures in analyze-result-box should be created on mount", () => {
    const figures = document
      .querySelector(".analyzeResultBox")
      ?.querySelectorAll("canvas");
    // figures: spectrogram + axis per channel
    expect(figures.length).toBe(audioBuffer.numberOfChannels * 2);
  });

  test("seek-bar on the figures should be created after analyze", () => {
    expect(document.querySelector(".visibleBar")).toBeTruthy();
    expect(document.querySelector(".userInputDiv")).toBeTruthy();
  });
});

describe("analyzer mount", () => {
  test("analyzer runs spectrogram on mount", () => {
    const audioContext = createAudioContext(44100);
    const audioBuffer = audioContext.createBuffer(2, 44100, 44100);
    const ad = {
      waveformVisible: undefined,
      waveformVerticalScale: undefined,
      spectrogramVisible: undefined,
      spectrogramVerticalScale: undefined,
      windowSizeIndex: undefined,
      minAmplitude: undefined,
      maxAmplitude: undefined,
      minFrequency: undefined,
      maxFrequency: undefined,
      spectrogramAmplitudeRange: undefined,
      frequencyScale: undefined,
      melFilterNum: undefined,
    };
    const analyzeService = new AnalyzeService(audioBuffer);
    const analyzeSettingsService = AnalyzeSettingsService.fromDefaultSetting(
      ad,
      audioBuffer,
    );
    const pd = {
      volumeUnitDb: true,
      initialVolumeDb: 0.0,
      initialVolume: 1.0,
      enableSpacekeyPlay: true,
      enableSeekToPlay: true,
      enableHpf: false,
      hpfFrequency: PlayerSettingsService.FILTER_FREQUENCY_HPF_DEFAULT,
      enableLpf: false,
      lpfFrequency: PlayerSettingsService.FILTER_FREQUENCY_LPF_DEFAULT,
      matchFilterFrequencyToSpectrogram: false,
    };
    const playerSettingsService = PlayerSettingsService.fromDefaultSetting(
      pd,
      audioBuffer,
    );
    const playerService = new PlayerService(
      audioContext,
      audioBuffer,
      playerSettingsService,
      analyzeSettingsService,
    );
    const ac = new AnalyzerComponent(
      "#analyzer",
      audioBuffer,
      analyzeService,
      analyzeSettingsService,
      playerService,
    );
    expect(
      document.querySelector(".analyzeResultBox")?.querySelectorAll("canvas")
        .length,
    ).toBe(4);
    ac.dispose();
    playerService.dispose();
  });
});

describe("position of seek-bar should be updated when recieving update-seekbar event", () => {
  let analyzeSettingsService: AnalyzeSettingsService;
  let playerService: PlayerService;
  let analyzerComponent: AnalyzerComponent;

  beforeAll(() => {
    document.body.innerHTML = '<div id="analyzer"></div>';
    const audioContext = createAudioContext(44100);
    const audioBuffer = audioContext.createBuffer(2, 441000, 44100);
    const ad = {
      waveformVisible: undefined,
      waveformVerticalScale: undefined,
      spectrogramVisible: undefined,
      spectrogramVerticalScale: undefined,
      windowSizeIndex: undefined,
      minAmplitude: undefined,
      maxAmplitude: undefined,
      minFrequency: undefined,
      maxFrequency: undefined,
      spectrogramAmplitudeRange: undefined,
      frequencyScale: undefined,
      melFilterNum: undefined,
    };
    const analyzeService = new AnalyzeService(audioBuffer);
    analyzeSettingsService = AnalyzeSettingsService.fromDefaultSetting(
      ad,
      audioBuffer,
    );
    const pd = {
      volumeUnitDb: true,
      initialVolumeDb: 0.0,
      initialVolume: 1.0,
      enableSpacekeyPlay: true,
      enableSeekToPlay: true,
      enableHpf: false,
      hpfFrequency: PlayerSettingsService.FILTER_FREQUENCY_HPF_DEFAULT,
      enableLpf: false,
      lpfFrequency: PlayerSettingsService.FILTER_FREQUENCY_LPF_DEFAULT,
      matchFilterFrequencyToSpectrogram: false,
    };
    const playerSettingsService = PlayerSettingsService.fromDefaultSetting(
      pd,
      audioBuffer,
    );
    playerService = new PlayerService(
      audioContext,
      audioBuffer,
      playerSettingsService,
      analyzeSettingsService,
    );
    analyzeSettingsService.minTime = 2;
    analyzeSettingsService.maxTime = 6;
    // audio: 10s, minTime: 2s, maxTime: 6s
    analyzerComponent = new AnalyzerComponent(
      "#analyzer",
      audioBuffer,
      analyzeService,
      analyzeSettingsService,
      playerService,
    );
    analyzeService.analyze();
  });

  afterAll(() => {
    analyzerComponent.dispose();
    playerService.dispose();
  });

  test("value: 50(5s), position: 75%", () => {
    const visibleSeekbar = <HTMLInputElement>(
      document.querySelector(".visibleBar")
    );
    playerService.dispatchEvent(
      new CustomEvent("update-seekbar", {
        detail: {
          value: 50,
        },
      }),
    );
    expect(visibleSeekbar.style.width).toBe("75%");
  });

  test("value: 5(0.5s), position: 0%", () => {
    const visibleSeekbar = <HTMLInputElement>(
      document.querySelector(".visibleBar")
    );
    playerService.dispatchEvent(
      new CustomEvent("update-seekbar", {
        detail: {
          value: 5,
        },
      }),
    );
    expect(visibleSeekbar.style.width).toBe("0%");
  });

  test("value: 90(9s), position: 100%", () => {
    const visibleSeekbar = <HTMLInputElement>(
      document.querySelector(".visibleBar")
    );
    playerService.dispatchEvent(
      new CustomEvent("update-seekbar", {
        detail: {
          value: 90,
        },
      }),
    );
    expect(visibleSeekbar.style.width).toBe("100%");
  });
});
