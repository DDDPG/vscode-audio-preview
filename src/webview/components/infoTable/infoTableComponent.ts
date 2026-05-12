import "./infoTableComponent.css";
import Component from "../../component";
import { CursorReadoutPayload, EventType } from "../../events";

export default class InfoTableComponent extends Component {
  private static readonly CURSOR_RMS_LABEL = "Cursor RMS";
  private static readonly CURSOR_PEAK_LABEL = "Cursor Peak";
  private static readonly CURSOR_FREQ_LABEL = "Cursor frequency";

  private _infoTable: HTMLTableElement;

  constructor(componentRootSelector: string) {
    super();
    const parent = document.querySelector(componentRootSelector);
    this._infoTable = document.createElement("table");
    this._infoTable.classList.add("infoTable");
    parent.appendChild(this._infoTable);

    this._addEventlistener(window, EventType.CURSOR_READOUT, (ev: Event) => {
      const e = ev as CustomEvent<CursorReadoutPayload>;
      const d = e.detail;
      const rmsLabelEl = this._infoTable.querySelector<HTMLElement>(
        "[data-hover-meter-label='rms']",
      );
      const peakLabelEl = this._infoTable.querySelector<HTMLElement>(
        "[data-hover-meter-label='peak']",
      );
      const freqLabelEl = this._infoTable.querySelector<HTMLElement>(
        "[data-hover-meter-label='freq']",
      );
      const rmsEl = this._infoTable.querySelector<HTMLElement>(
        "[data-hover-meter='rms']",
      );
      const peakEl = this._infoTable.querySelector<HTMLElement>(
        "[data-hover-meter='peak']",
      );
      const freqEl = this._infoTable.querySelector<HTMLElement>(
        "[data-hover-meter='freq']",
      );
      if (
        !rmsLabelEl ||
        !peakLabelEl ||
        !freqLabelEl ||
        !rmsEl ||
        !peakEl ||
        !freqEl
      ) {
        return;
      }
      if (d.kind === "clear") {
        rmsLabelEl.textContent = InfoTableComponent.CURSOR_RMS_LABEL;
        rmsLabelEl.removeAttribute("title");
        peakLabelEl.textContent = InfoTableComponent.CURSOR_PEAK_LABEL;
        peakLabelEl.removeAttribute("title");
        freqLabelEl.textContent = InfoTableComponent.CURSOR_FREQ_LABEL;
        freqLabelEl.removeAttribute("title");
        rmsEl.textContent = "-";
        rmsEl.removeAttribute("title");
        peakEl.textContent = "-";
        peakEl.removeAttribute("title");
        freqEl.textContent = "-";
        freqEl.removeAttribute("title");
        return;
      }
      const fmtLin = (v: number) =>
        Number.isFinite(v) ? v.toFixed(5) : "-";
      const fmtRmsWindow = (sec: number) => {
        if (!Number.isFinite(sec) || sec <= 0) {
          return "";
        }
        return sec >= 1
          ? `${sec.toFixed(3)} s`
          : `${(sec * 1000).toFixed(2)} ms`;
      };
      const fmtHz = (hz: number) => {
        if (!Number.isFinite(hz)) {
          return "-";
        }
        if (Math.abs(hz) >= 1000) {
          return `${(hz / 1000).toFixed(3)} kHz`;
        }
        return `${hz.toFixed(1)} Hz`;
      };
      const w = fmtRmsWindow(d.rmsWindowDurationSec);
      const rmsLabelText = w
        ? `${InfoTableComponent.CURSOR_RMS_LABEL} (window: ${w})`
        : InfoTableComponent.CURSOR_RMS_LABEL;
      rmsLabelEl.textContent = rmsLabelText;
      rmsLabelEl.title = rmsLabelText;
      const rmsVal = fmtLin(d.rms);
      rmsEl.textContent = rmsVal;
      rmsEl.title = rmsVal;
      const peakVal = fmtLin(d.peak);
      peakEl.textContent = peakVal;
      peakEl.title = peakVal;
      if (d.kind === "waveform") {
        freqEl.textContent = "-";
        freqEl.removeAttribute("title");
        return;
      }
      const f = fmtHz(d.frequencyHz);
      freqEl.textContent = f;
      freqEl.title = f;
    });
  }

  public showInfo(
    numChannels: number,
    sampleRate: number,
    fileSize: number,
    format: string,
    encoding: string,
  ) {
    const channels =
      numChannels === 1 ? "mono" : numChannels === 2 ? "stereo" : "unsupported";

    const info = [
      { name: "encoding", value: `${encoding}` },
      { name: "format", value: `${format}` },
      { name: "number_of_channel", value: `${numChannels} ch (${channels})` },
      { name: "sample_rate", value: `${sampleRate.toLocaleString()} Hz` },
      { name: "file_size", value: `${fileSize.toLocaleString()} bytes` },
    ];

    const trList = this._infoTable.querySelectorAll("tr");
    trList.forEach((tr) => {
      this._infoTable.removeChild(tr);
    });
    for (const i of info) {
      this.insertTableData(i.name, i.value);
    }
  }

  public showAdditionalInfo(duration: number) {
    this.insertTableData(
      "duration",
      duration.toLocaleString(undefined, { maximumFractionDigits: 1 }) + " s",
    );
  }

  /** Call after {@link showInfo} / {@link showAdditionalInfo} so rows are not cleared. */
  public appendCursorProbeRows(): void {
    const rows: [string, string][] = [
      [InfoTableComponent.CURSOR_RMS_LABEL, "rms"],
      [InfoTableComponent.CURSOR_PEAK_LABEL, "peak"],
      [InfoTableComponent.CURSOR_FREQ_LABEL, "freq"],
    ];
    for (const [label, field] of rows) {
      const tr = document.createElement("tr");
      tr.classList.add("infoTableRow");

      const nameTd = document.createElement("td");
      nameTd.classList.add("infoTableData");
      nameTd.textContent = label;
      nameTd.dataset.hoverMeterLabel = field;
      tr.appendChild(nameTd);

      const valueTd = document.createElement("td");
      valueTd.classList.add("infoTableData");
      valueTd.textContent = "-";
      valueTd.dataset.hoverMeter = field;
      tr.appendChild(valueTd);

      this._infoTable.appendChild(tr);
    }
  }

  private insertTableData(name: string, value: string) {
    const tr = document.createElement("tr");
    tr.classList.add("infoTableRow");

    const nameTd = document.createElement("td");
    nameTd.classList.add("infoTableData");
    nameTd.textContent = name;
    tr.appendChild(nameTd);

    const valueTd = document.createElement("td");
    valueTd.textContent = value;
    valueTd.classList.add("infoTableData");
    valueTd.classList.add(`js-infoTableData-${name}`);

    tr.appendChild(valueTd);

    this._infoTable.appendChild(tr);
  }
}
