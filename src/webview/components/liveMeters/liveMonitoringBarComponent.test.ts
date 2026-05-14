import { MockAudioBuffer } from "../../../__mocks__/helper";
import { EventType } from "../../events";
import AnalyzeService from "../../services/analyzeService";
import AnalyzeSettingsService from "../../services/analyzeSettingsService";
import { AnalyzeDefault } from "../../../config";
import LiveMonitoringBarComponent from "./liveMonitoringBarComponent";

describe("liveMonitoringBarComponent", () => {
  let analyzeService: AnalyzeService;
  let analyzeSettingsService: AnalyzeSettingsService;
  let bar: LiveMonitoringBarComponent;

  beforeAll(() => {
    document.body.innerHTML = '<div id="liveMonitoringBar"></div>';
    const audioBuffer = new MockAudioBuffer(
      44100,
      2,
      44100,
    ) as unknown as AudioBuffer;
    analyzeService = new AnalyzeService(audioBuffer);
    const analyzeDefault = {} as AnalyzeDefault;
    analyzeSettingsService = AnalyzeSettingsService.fromDefaultSetting(
      analyzeDefault,
      audioBuffer,
    );
    bar = new LiveMonitoringBarComponent(
      "#liveMonitoringBar",
      analyzeSettingsService,
    );
  });

  afterAll(() => {
    analyzeService.dispose();
    analyzeSettingsService.dispose();
    bar.dispose();
  });

  test("level meter checkbox reflects and updates showLevelMeter", () => {
    const cb = document.querySelector(
      ".js-lm-showLevelMeter",
    ) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    cb.checked = true;
    cb.dispatchEvent(new Event(EventType.CHANGE));
    expect(analyzeSettingsService.showLevelMeter).toBe(true);
    analyzeSettingsService.dispatchEvent(
      new CustomEvent(EventType.AS_UPDATE_SHOW_LEVEL_METER, {
        detail: { value: false },
      }),
    );
    expect(cb.checked).toBe(false);
  });
});
