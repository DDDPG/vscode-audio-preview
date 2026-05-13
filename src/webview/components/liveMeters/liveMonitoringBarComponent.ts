import { EventType } from "../../events";
import Component from "../../component";
import AnalyzeSettingsService from "../../services/analyzeSettingsService";
import type { LiveMonitoringMode } from "../../utils/liveMonitoring";

export default class LiveMonitoringBarComponent extends Component {
  constructor(
    rootSelector: string,
    analyzeSettingsService: AnalyzeSettingsService,
  ) {
    super();
    const root = document.querySelector(rootSelector) as HTMLElement;
    if (!root) return;

    root.innerHTML = `
      <div class="liveMonitoringBar" role="toolbar" aria-label="Live monitoring">
        <span class="liveMonitoringBar__label">Monitor</span>
        <button type="button" class="liveMonitoringBar__btn js-lm-lr" title="Stereo">LR</button>
        <button type="button" class="liveMonitoringBar__btn js-lm-l" title="Solo L">L</button>
        <button type="button" class="liveMonitoringBar__btn js-lm-r" title="Solo R">R</button>
        <button type="button" class="liveMonitoringBar__btn js-lm-m" title="Mid">M</button>
        <button type="button" class="liveMonitoringBar__btn js-lm-s" title="Side">S</button>
      </div>`;

    const setActive = (mode: LiveMonitoringMode) => {
      for (const b of root.querySelectorAll<HTMLButtonElement>(
        ".liveMonitoringBar__btn",
      )) {
        b.classList.remove("liveMonitoringBar__btn--active");
      }
      const map: Record<LiveMonitoringMode, string> = {
        lr: ".js-lm-lr",
        l: ".js-lm-l",
        r: ".js-lm-r",
        m: ".js-lm-m",
        s: ".js-lm-s",
      };
      root.querySelector(map[mode])?.classList.add("liveMonitoringBar__btn--active");
    };

    setActive(analyzeSettingsService.liveMonitoringMode);

    const wire = (sel: string, mode: LiveMonitoringMode) => {
      const btn = root.querySelector(sel) as HTMLButtonElement;
      this._addEventlistener(btn, EventType.CLICK, () => {
        analyzeSettingsService.liveMonitoringMode = mode;
      });
    };
    wire(".js-lm-lr", "lr");
    wire(".js-lm-l", "l");
    wire(".js-lm-r", "r");
    wire(".js-lm-m", "m");
    wire(".js-lm-s", "s");

    this._addEventlistener(
      analyzeSettingsService,
      EventType.AS_UPDATE_LIVE_MONITORING_MODE,
      (e: CustomEventInit<{ value: LiveMonitoringMode }>) => {
        setActive(e.detail.value);
      },
    );
  }
}
