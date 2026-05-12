# vscode-audio-preview 性能与功能改造实施计划

> **For agentic workers:** 使用 superpowers:subagent-driven-development 或 superpowers:executing-plans 按任务逐步实施。步骤使用 checkbox (`- [ ]`) 语法追踪。

**Goal:** 对 audio-preview 插件进行全面升级，涵盖引入 essentia.js、窗函数选择、大文件加载优化、频率轴显示修复、缩放高分辨率重绘、幅度双端控制、DAW 风格播放控制共 7 项功能改造，以及音频解码器重构、频谱图 WebGL 渲染、播放进度同步优化共 3 项性能改造，合计 10 项。

**Architecture:** 采用分层架构（扩展层 → Webview 层 → 服务层 → 组件层），音频处理引擎从 Ooura FFT 迁移至 essentia.js WASM，解码层从 Docker/FFmpeg WASM 迁移至 WebCodecs + wasm-audio-decoders 双层 fallback，可视化层增强窗函数和幅度控制，交互层对齐 DAW 播放逻辑。

**Tech Stack:** TypeScript, Webpack, essentia.js (WASM), WebCodecs API, wasm-audio-decoders, Web Audio API, Canvas 2D / WebGL2, VS Code Extension API

---

## 文件结构总览

| 文件 | 职责 | 涉及改造 |
|------|------|----------|
| `src/webview/services/analyzeService.ts` | STFT 计算、颜色映射 | 1, 2, 5, 6 |
| `src/webview/services/analyzeSettingsService.ts` | 分析设置状态管理 | 2, 5, 6 |
| `src/webview/components/spectrogram/spectrogramComponent.ts` | 频谱图绘制（linear/log/mel） | 4, 6 |
| `src/webview/components/figureInteraction/figureInteractionComponent.ts` | 鼠标交互、缩放、点击 | 5, 7 |
| `src/webview/components/analyzeSettings/analyzeSettingsComponent.ts` | 设置 UI | 2, 6 |
| `src/webview/services/playerService.ts` | 播放控制 | 7 |
| `src/webview/components/player/playerComponent.ts` | 播放器 UI | 7 |
| `src/webview/components/webview/webview.ts` | 主初始化流程 | 1, 3 |
| `src/webview/components/infoTable/infoTableComponent.ts` | 信息表格 | 1 |
| `src/webview/events.ts` | 事件类型定义 | 2, 6, 7 |
| `src/audioPreviewEditor.ts` | Webview CSP 配置 | 1, 8 |
| `webpack.config.js` | 打包配置 | 1, 8 |
| `package.json` | 依赖管理 | 1, 8 |
| `src/decoder/` | **删除整个目录**（Docker/FFmpeg WASM） | 8 |
| `src/webview/decoder.ts` | 重写为 WebCodecs + fallback 解码器 | 8 |

---

## 现有代码关键上下文

### 事件系统

```typescript
// src/webview/events.ts:1-46
class EventType {
  static readonly UPDATE_SEEKBAR = "update-seekbar";
  static readonly UPDATE_IS_PLAYING = "update-is-playing";
  static readonly AS_UPDATE_WINDOW_SIZE_INDEX = "as-update-window-size-index";
  static readonly AS_UPDATE_FREQUENCY_SCALE = "as-update-frequency-scale";
  static readonly AS_UPDATE_MEL_FILTER_NUM = "as-update-mel-filter-num";
  static readonly AS_UPDATE_MIN_FREQUENCY = "as-update-min-frequency";
  static readonly AS_UPDATE_MAX_FREQUENCY = "as-update-max-frequency";
  static readonly AS_UPDATE_MIN_TIME = "as-update-min-time";
  static readonly AS_UPDATE_MAX_TIME = "as-update-max-time";
  static readonly AS_UPDATE_MIN_AMPLITUDE = "as-update-min-amplitude";
  static readonly AS_UPDATE_MAX_AMPLITUDE = "as-update-max-amplitude";
  static readonly AS_UPDATE_SPECTROGRAM_AMPLITUDE_RANGE = "as-update-spectrogram-amplitude-range";
  static readonly CLICK = "click";
  static readonly CHANGE = "change";
  // ...
}
```

### STFT 实现（analyzeService.ts）

- `getSpectrogram(ch, settings)` — 第 71-133 行：使用 Ooura FFT，硬编码 Hann 窗（第 76-79 行），返回 `spectrogram[timeFrame][frequencyBin]`（dB 值）
- `getMelSpectrogram(ch, settings)` — 第 135-214 行：同上 + Mel 滤波器组
- `getSpectrogramColor(amp, range)` — 第 40-65 行：6 级颜色渐变，`range` 为负数（dB 下限）
- `applyMelFilterBank()` — 第 216-268 行：三角形 Mel 滤波器组
- `hzToMel()` / `melToHz()` — 第 270-276 行：Mel 尺度转换

### 分析设置（analyzeSettingsService.ts）

- `AnalyzeSettingsProps` — 第 23-37 行：所有设置的快照接口
- `toProps()` — 第 491-507 行：返回当前设置快照
- `fromDefaultSetting()` — 第 370-455 行：工厂方法
- `calcHopSize()` — 第 479-489 行：基于全时长计算 hopSize
- `WindowSizeIndex` 枚举 — 第 6-15 行：W256 到 W32768
- `FrequencyScale` 枚举 — 第 17-21 行：Linear/Log/Mel
- `spectrogramAmplitudeRange` — 第 283-302 行：单值（负数，下限），上限硬编码为 0

### 频谱图绘制（spectrogramComponent.ts）

- `drawLinearSpectrogram()` — 第 95-122 行：`rectHeight = height / spectrogram[0].length`
- `drawLogSpectrogram()` — 第 162-200 行：**bug** — 第 186 行 `const freq = j * df` 未加 `minFreqIndex` 偏移
- `drawMelSpectrogram()` — 第 237-264 行
- `drawLogAxis()` — 第 124-160 行：**bug** — 刻度用等比 log 区间而非倍频程序列
- `drawMelAxis()` — 第 202-235 行
- `drawTimeAxis()` — 第 266-294 行

### 播放控制（playerService.ts）

- `play()` — 第 92-133 行：从 `_currentSec` 开始播放
- `pause()` — 第 135-153 行：更新 `_currentSec`（第 141 行）
- `tick()` — 第 155-182 行：requestAnimationFrame 驱动进度条
- `onSeekbarInput(value)` — 第 185-208 行：设置 `_currentSec` 并可能播放

### 交互组件（figureInteractionComponent.ts）

- 左键拖动 — 选择范围并重新分析（第 96-107, 151-200 行）
- 左键点击 — **当前行为**：调用 `playerService.onSeekbarInput()` 立即播放（第 173-185 行）
- 右键点击 — 重置范围（第 110-126 行）
- Ctrl/Shift 修饰 — 仅选时间/频率（第 203-240 行）
- `visibleBar` — 紫色进度条 div（第 34-36 行）

### 设置 UI（analyzeSettingsComponent.ts）

- HTML 模板硬编码在构造函数（第 24-87 行）
- `spectrogramAmplitudeRange` 输入 — 第 78 行：单个输入框 `~ 0 dB`
- window size 选择器 — 第 48-58 行
- frequency scale 选择器 — 第 61-66 行
- `updateColorBar()` — 第 295-332 行：绘制颜色条

### 主 webview（webview.ts）

- `activateUI()` — 第 123-206 行：**串行**执行 decoder 解码 → AudioBuffer 构建 → 所有 UI 初始化
- 数据接收分块 — 第 79-120 行：每次 3MB

---

## 实施顺序与各改造详情

### 改造 4：修复频率轴尺度显示逻辑（最先，独立）

**问题根因：**

1. `drawLogAxis()`（spectrogramComponent.ts:124-160）：刻度生成使用 `logMin + i*(logMax-logMin)/numAxes` 等分 log 区间，而非倍频程序列（100, 200, 400, 800...）

2. `drawLogSpectrogram()`（spectrogramComponent.ts:162-200）：第 186 行 `const freq = j * df` 中 `j` 从 0 开始，但 `getSpectrogram()` 返回的是 `minFreqIndex` 到 `maxFreqIndex` 的切片，所以 `j * df` 计算的是相对于切片起点的频率。当用户缩放频率范围后（`minFrequency > 0`），坐标系与数据不对齐。

**修改 `spectrogramComponent.ts`：**

- [ ] **Step 1: 修复 `drawLogAxis()` 刻度生成逻辑**

将第 139-155 行的刻度生成替换为倍频程序列：

```typescript
// 替换 drawLogAxis 中第 139-155 行
const logMin = Math.log10(settings.minFrequency + Number.EPSILON);
const logMax = Math.log10(settings.maxFrequency + Number.EPSILON);
const scale = (logMax - logMin) / height;

// 生成倍频程序列：从 minFrequency 向上找第一个 100 * 2^n
let f = 100;
while (f < settings.minFrequency) f *= 2;
while (f <= settings.maxFrequency) {
  axisContext.fillStyle = "rgb(245,130,32)";
  const logF = Math.log10(f);
  const y = height - (logF - logMin) / scale;
  axisContext.fillText(`${Math.trunc(f)}`, 4, y - 4);

  axisContext.fillStyle = "rgb(180,120,20)";
  for (let j = 0; j < width; j++) {
    axisContext.fillRect(j, y, 2, 2);
  }
  f *= 2;
}
```

同时在顶部绘制奈奎斯特频率标签（在循环后添加）：

```typescript
// 顶部绘制奈奎斯特频率
const nyquistFreq = settings.maxFrequency; // maxFrequency 已被限制为 sampleRate/2
axisContext.fillStyle = "rgb(245,130,32)";
axisContext.fillText(`${Math.trunc(nyquistFreq)}`, 4, 14);
```

- [ ] **Step 2: 修复 `drawLogSpectrogram()` 频率索引偏移**

将第 184-189 行的频率计算修正：

```typescript
// 替换第 184-189 行
const minFreqIndex = Math.floor(settings.minFrequency / df);
const freq = (j + minFreqIndex) * df;
const logFreq = Math.log10(freq + Number.EPSILON);
const logPrevFreq = j > 0
  ? Math.log10((j - 1 + minFreqIndex) * df + Number.EPSILON)
  : Math.log10(Math.max(1, (j - 1 + minFreqIndex) * df) + Number.EPSILON);
const y = height - (logFreq - logMin) / scale;
const rectHeight = Math.max(1, (logFreq - logPrevFreq) / scale);
```

- [ ] **Step 3: 同步修复 `drawMelAxis()` 的上下限显示**

确保 Mel 轴的顶部标签显示奈奎斯特频率（`settings.maxFrequency`），底部显示 0 Hz：

```typescript
// 在 drawMelAxis 循环后添加底部和顶部标签
// 底部 0 Hz 标签
axisContext.fillStyle = "rgb(245,130,32)";
axisContext.fillText("0", 4, height - 4);
// 顶部奈奎斯特频率标签已在循环中由 i=0 时的 mel 计算覆盖
```

---

### 改造 6：幅度范围双端控制（第二，独立）

**修改 `events.ts`：**

- [ ] **Step 1: 新增两个事件类型**

在 `EventType` 类中第 34-35 行之后添加：

```typescript
public static readonly AS_UPDATE_SPECTROGRAM_AMPLITUDE_LOW =
  "as-update-spectrogram-amplitude-low";
public static readonly AS_UPDATE_SPECTROGRAM_AMPLITUDE_HIGH =
  "as-update-spectrogram-amplitude-high";
```

**修改 `analyzeSettingsService.ts`：**

- [ ] **Step 2: 扩展 `AnalyzeSettingsProps` 接口**

在接口中第 34 行 `spectrogramAmplitudeRange` 之后添加：

```typescript
spectrogramAmplitudeLow: number;
spectrogramAmplitudeHigh: number;
```

- [ ] **Step 3: 新增 `spectrogramAmplitudeLow` 属性（setter/getter）**

在第 302 行 `_spectrogramAmplitudeRange` setter 之后添加：

```typescript
private _spectrogramAmplitudeLow: number;
public get spectrogramAmplitudeLow() {
  return this._spectrogramAmplitudeLow;
}
public set spectrogramAmplitudeLow(value: number) {
  const [low] = getRangeValues(value, this._spectrogramAmplitudeHigh, -1000, 0, -90, 0);
  this._spectrogramAmplitudeLow = low;
  this.dispatchEvent(
    new CustomEvent(EventType.AS_UPDATE_SPECTROGRAM_AMPLITUDE_LOW, {
      detail: { value: this._spectrogramAmplitudeLow },
    }),
  );
}
```

- [ ] **Step 4: 新增 `spectrogramAmplitudeHigh` 属性（setter/getter）**

```typescript
private _spectrogramAmplitudeHigh: number;
public get spectrogramAmplitudeHigh() {
  return this._spectrogramAmplitudeHigh;
}
public set spectrogramAmplitudeHigh(value: number) {
  const [, high] = getRangeValues(this._spectrogramAmplitudeLow, value, -1000, 0, -90, 0);
  this._spectrogramAmplitudeHigh = high;
  this.dispatchEvent(
    new CustomEvent(EventType.AS_UPDATE_SPECTROGRAM_AMPLITUDE_HIGH, {
      detail: { value: this._spectrogramAmplitudeHigh },
    }),
  );
}
```

- [ ] **Step 5: 更新 `toProps()` 方法**

在第 503 行 `spectrogramAmplitudeRange` 字段后添加：

```typescript
spectrogramAmplitudeLow: this._spectrogramAmplitudeLow,
spectrogramAmplitudeHigh: this._spectrogramAmplitudeHigh,
```

- [ ] **Step 6: 更新构造函数和工厂方法**

构造函数参数添加 `spectrogramAmplitudeLow: number, spectrogramAmplitudeHigh: number`，并在构造函数体中初始化。

`fromDefaultSetting()` 工厂方法传入默认值 `-90` 和 `0`。

**修改 `analyzeService.ts`：**

- [ ] **Step 7: 修改 `getSpectrogramColor` 签名和逻辑**

将第 40-64 行的方法替换为：

```typescript
public getSpectrogramColor(amp: number, low: number, high: number): string {
  if (amp === null) {
    return "rgb(0,0,0)";
  }
  const classNum = 6;
  const classWidth = (high - low) / classNum;
  const ampClass = Math.floor((amp - low) / classWidth);
  const classMinAmp = low + (ampClass + 1) * classWidth;
  const value = (amp - classMinAmp) / -classWidth;
  switch (ampClass) {
    case 0:
      return `rgb(255,255,${125 + Math.floor(value * 130)})`;
    case 1:
      return `rgb(255,${125 + Math.floor(value * 130)},125)`;
    case 2:
      return `rgb(255,${Math.floor(value * 125)},125)`;
    case 3:
      return `rgb(${125 + Math.floor(value * 130)},0,125)`;
    case 4:
      return `rgb(${Math.floor(value * 125)},0,125)`;
    case 5:
      return `rgb(0,0,${Math.floor(value * 125)})`;
    default:
      return `rgb(0,0,0)`;
  }
}
```

**修改 `spectrogramComponent.ts`：**

- [ ] **Step 8: 更新所有 `getSpectrogramColor` 调用**

第 115-118 行（linear）、第 193-196 行（log）、第 257-260 行（mel）的 3 处调用改为：

```typescript
context.fillStyle = this._analyzeService.getSpectrogramColor(
  value,
  settings.spectrogramAmplitudeLow,
  settings.spectrogramAmplitudeHigh,
);
```

**修改 `analyzeSettingsComponent.ts`：**

- [ ] **Step 9: 更新 HTML 模板和事件绑定**

将第 76-79 行的单个幅度输入替换为两个输入：

```html
<div>
    spectrogram amplitude range:
    <input class="analyzeSetting__input js-analyzeSetting-spectrogramAmplitudeLow" type="number" step="1">dB ~
    <input class="analyzeSetting__input js-analyzeSetting-spectrogramAmplitudeHigh" type="number" step="1">dB
</div>
```

在 `initAnalyzerSettingUI()` 中替换第 268-292 行的幅度绑定逻辑，参照 `minAmplitude/maxAmplitude` 的双输入模式添加两个输入的事件绑定。

- [ ] **Step 10: 更新 `updateColorBar()` 方法**

将第 295-332 行中 `settings.spectrogramAmplitudeRange` 引用替换为与 `getSpectrogramColor` 一致的双端范围：

```typescript
private updateColorBar(settings: AnalyzeSettingsProps) {
  const colorCanvas = <HTMLCanvasElement>(
    this._componentRoot.querySelector(".js-analyzeSetting-spectrogramColor")
  );
  const colorAxisCanvas = <HTMLCanvasElement>(
    this._componentRoot.querySelector(".js-analyzeSetting-spectrogramColorAxis")
  );
  const colorContext = colorCanvas.getContext("2d", { alpha: false });
  const colorAxisContext = colorAxisCanvas.getContext("2d", { alpha: false });
  colorAxisContext.clearRect(0, 0, colorAxisCanvas.width, colorAxisCanvas.height);
  colorAxisContext.font = `15px Arial`;
  colorAxisContext.fillStyle = "white";

  const low = settings.spectrogramAmplitudeLow;
  const high = settings.spectrogramAmplitudeHigh;
  const range = high - low;

  for (let i = 0; i < 10; i++) {
    const amp = low + (i * range) / 10;
    const x = (i * colorAxisCanvas.width) / 10;
    colorAxisContext.fillText(`${amp} dB`, x, colorAxisCanvas.height);
  }
  for (let i = 0; i < 100; i++) {
    const amp = low + (i * range) / 100;
    const x = (i * colorCanvas.width) / 100;
    colorContext.fillStyle = this._analyzeService.getSpectrogramColor(amp, low, high);
    colorContext.fillRect(x, 0, colorCanvas.width / 100, colorCanvas.height);
  }
}
```

---

### 改造 2：添加窗函数选择（第三，独立）

**修改 `analyzeSettingsService.ts`：**

- [ ] **Step 1: 新增 `WindowType` 枚举**

在第 21 行 `FrequencyScale` 枚举之后添加：

```typescript
export enum WindowType {
  Hann = 0,
  Hamming = 1,
  BlackmanHarris = 2,
  Triangular = 3,
}
```

- [ ] **Step 2: 扩展 `AnalyzeSettingsProps` 接口**

添加 `windowType: WindowType;` 字段。

- [ ] **Step 3: 新增 `windowType` 属性（setter/getter）**

参照 `frequencyScale` 模式（第 304-320 行）：

```typescript
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
```

- [ ] **Step 4: 更新 `toProps()` 和工厂方法**

`toProps()` 中添加 `windowType: this._windowType`。工厂方法 `fromDefaultSetting()` 中初始化为 `WindowType.Hann`。

**修改 `events.ts`：**

- [ ] **Step 5: 新增事件类型**

```typescript
public static readonly AS_UPDATE_WINDOW_TYPE = "as-update-window-type";
```

**修改 `analyzeService.ts`：**

- [ ] **Step 6: 提取 `buildWindow` 方法**

在 `AnalyzeService` 类中新增：

```typescript
import { WindowType } from "./analyzeSettingsService";

private buildWindow(size: number, type: WindowType): Float32Array {
  const window = new Float32Array(size);
  switch (type) {
    case WindowType.Hann:
      for (let i = 0; i < size; i++) {
        window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
      }
      break;
    case WindowType.Hamming:
      for (let i = 0; i < size; i++) {
        window[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / size);
      }
      break;
    case WindowType.BlackmanHarris:
      for (let i = 0; i < size; i++) {
        window[i] = 0.35875
          - 0.48829 * Math.cos((2 * Math.PI * i) / size)
          + 0.14128 * Math.cos((4 * Math.PI * i) / size)
          - 0.01168 * Math.cos((6 * Math.PI * i) / size);
      }
      break;
    case WindowType.Triangular:
      for (let i = 0; i < size; i++) {
        window[i] = 1 - Math.abs((2 * i) / size - 1);
      }
      break;
  }
  return window;
}
```

- [ ] **Step 7: 替换 `getSpectrogram()` 中硬编码的 Hann 窗**

将第 76-79 行：

```typescript
const window = new Float32Array(windowSize);
for (let i = 0; i < windowSize; i++) {
  window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / windowSize);
}
```

替换为：

```typescript
const window = this.buildWindow(windowSize, settings.windowType);
```

- [ ] **Step 8: 替换 `getMelSpectrogram()` 中硬编码的 Hann 窗**

将第 141-143 行中同样的 Hann 窗替换为 `this.buildWindow(windowSize, settings.windowType)`。

**修改 `analyzeSettingsComponent.ts`：**

- [ ] **Step 9: 添加窗函数选择器 UI**

在 window size 选择器（第 48-58 行）之后添加：

```html
<div>
    window type:
    <select class="analyzeSetting__select js-analyzeSetting-windowType">
        <option value="0">Hann</option>
        <option value="1">Hamming</option>
        <option value="2">Blackman-Harris</option>
        <option value="3">Triangular</option>
    </select>
</div>
```

在 `initAnalyzerSettingUI()` 中添加事件绑定，参照 `frequencyScaleSelect` 模式（第 143-157 行）：

```typescript
// init window type select
const windowTypeSelect = <HTMLSelectElement>(
  this._componentRoot.querySelector(".js-analyzeSetting-windowType")
);
windowTypeSelect.selectedIndex = settings.windowType;
this._addEventlistener(windowTypeSelect, EventType.CHANGE, () => {
  settings.windowType = Number(windowTypeSelect.selectedIndex);
});
this._addEventlistener(
  settings,
  EventType.AS_UPDATE_WINDOW_TYPE,
  (e: CustomEventInit) => {
    windowTypeSelect.selectedIndex = e.detail.value;
  },
);
```

---

### 改造 7：DAW 风格播放控制（第四，独立）

**行为规格：**
- 鼠标点击图像 → 设置 playback position 标记（白色静态竖线），**不播放**
- 空格/播放按钮 → 从 playback position 开始播放
- 暂停后再播放 → 从 playback position 重新开始
- 播放中紫色进度条继续移动

**修改 `events.ts`：**

- [ ] **Step 1: 新增 playback position 事件**

```typescript
public static readonly UPDATE_PLAYBACK_POSITION = "update-playback-position";
```

**修改 `playerService.ts`：**

- [ ] **Step 2: 新增 `_playbackPosition` 属性和 `setPlaybackPosition` 方法**

在 `PlayerService` 类中第 12 行 `_currentSec` 之后添加：

```typescript
private _playbackPosition: number = 0;
public get playbackPosition() {
  return this._playbackPosition;
}

public setPlaybackPosition(sec: number) {
  this._playbackPosition = Math.max(0, Math.min(sec, this._audioBuffer.duration));
  this.dispatchEvent(
    new CustomEvent(EventType.UPDATE_PLAYBACK_POSITION, {
      detail: {
        sec: this._playbackPosition,
        percent: (100 * this._playbackPosition) / this._audioBuffer.duration,
      },
    }),
  );
}
```

- [ ] **Step 3: 修改 `play()` 使用 `_playbackPosition`**

将第 120 行：

```typescript
this._source.start(this._audioContext.currentTime, this._currentSec);
```

改为：

```typescript
this._currentSec = this._playbackPosition;
this._source.start(this._audioContext.currentTime, this._playbackPosition);
```

- [ ] **Step 4: 修改 `pause()` 不再更新 `_currentSec` 用于下次播放**

将第 141-142 行：

```typescript
this._currentSec += this._audioContext.currentTime - this._lastStartAcTime;
```

改为：

```typescript
// 仍更新 _currentSec 用于 tick() 中的 seekbar 位置计算
this._currentSec += this._audioContext.currentTime - this._lastStartAcTime;
// 但不更新 _playbackPosition（保持用户设置的播放起点）
```

**修改 `figureInteractionComponent.ts`：**

- [ ] **Step 5: 添加 playback position 标记线**

在第 34-36 行 `visibleBar` 创建之后添加：

```typescript
// register playback position bar on figures
const positionBar = document.createElement("div");
positionBar.className = "positionBar";
positionBar.style.position = "absolute";
positionBar.style.top = "0";
positionBar.style.width = "2px";
positionBar.style.height = "100%";
positionBar.style.backgroundColor = "white";
positionBar.style.pointerEvents = "none";
positionBar.style.zIndex = "10";
componentRoot.appendChild(positionBar);
```

监听 `UPDATE_PLAYBACK_POSITION` 事件（在第 38-57 行的 `UPDATE_SEEKBAR` 监听之后添加）：

```typescript
this._addEventlistener(
  playerService,
  EventType.UPDATE_PLAYBACK_POSITION,
  (e: CustomEventInit) => {
    const sec = e.detail.sec;
    const percentInFigureRange =
      ((sec - settings.minTime) / (settings.maxTime - settings.minTime)) * 100;
    if (percentInFigureRange < 0 || 100 < percentInFigureRange) {
      positionBar.style.display = "none";
      return;
    }
    positionBar.style.display = "block";
    positionBar.style.left = `${percentInFigureRange}%`;
  },
);
```

- [ ] **Step 6: 修改点击行为为设置 playback position**

将第 172-185 行的点击处理改为：

```typescript
// treat as click if mouse moved less than threshold
if (
  Math.abs(this.mouseDownX - mouseUpX) < 3 &&
  Math.abs(this.mouseDownY - mouseUpY) < 3
) {
  // set playback position (does not start playing)
  const xPercentInFigureRange =
    ((mouseUpX - rect.left) / rect.width) * 100;
  const sec =
    (xPercentInFigureRange / 100) *
      (settings.maxTime - settings.minTime) +
    settings.minTime;
  playerService.setPlaybackPosition(sec);
  return;
}
```

---

### 改造 5：缩放时重新计算 STFT（第五，依赖改造 2）

**问题：** 缩放时 `hopSize` 和 `windowSize` 不变，导致帧数和频率分辨率不变，缩放只是截取已有帧，分辨率不提升。

- [ ] **Step 1: `minTime`/`maxTime` setter 中触发 hopSize 重算**

修改 `analyzeSettingsService.ts` 第 199-218 行 `set minTime()` 和第 220-239 行 `set maxTime()`：在值更新后添加 hopSize 重算逻辑：

```typescript
public set minTime(value: number) {
  const [minTime] = getRangeValues(value, this.maxTime, 0, this._duration, 0, this._duration);
  this._minTime = minTime;
  // 缩放时自动重算 hopSize 以提升时间分辨率
  if (this._autoCalcHopSize) {
    this.hopSize = this.calcHopSize();
  }
  this.dispatchEvent(new CustomEvent(EventType.AS_UPDATE_MIN_TIME, {
    detail: { value: this._minTime },
  }));
}
// maxTime setter 同样添加 if (this._autoCalcHopSize) 逻辑
```

- [ ] **Step 2: 新增 `effectiveWindowSize` 计算属性**

在 `analyzeSettingsService.ts` 中添加：

```typescript
private get effectiveWindowSize(): number {
  const totalDuration = this._duration;
  const currentRange = this._maxTime - this._minTime;
  if (currentRange >= totalDuration || currentRange <= 0) {
    return this._windowSize;
  }
  const zoomRatio = totalDuration / currentRange;
  const maxIndex = WindowSizeIndex.W8192; // 上限 8192 防止计算爆炸
  const effectiveIndex = Math.min(
    this._windowSizeIndex + Math.floor(Math.log2(zoomRatio)),
    maxIndex,
  );
  return Math.pow(2, effectiveIndex + 8);
}
```

- [ ] **Step 3: `toProps()` 中使用 `effectiveWindowSize`**

将第 495 行 `windowSize: this.windowSize` 改为：

```typescript
windowSize: this.effectiveWindowSize,
```

- [ ] **Step 4: 监听设置变更后触发重分析**

在 `figureInteractionComponent.ts` 的 `applySelectedRange()` 末尾已调用 `analyzeService.analyze()`（第 354 行），确保它触发 `spectrogramComponent` 重新创建（带新的 settings props）。

---

### 改造 3：音频大文件加载优化（第六，独立）

- [ ] **Step 1: 修改 `activateUI()` 拆分为两阶段**

修改 `webview.ts` 第 123-206 行的 `activateUI()`：

```typescript
private async activateUI() {
  const decoder = await this._createDecoder(this._fileData);
  decoder.readAudioInfo();

  // 阶段 1：快速显示信息表和波形
  const infoTableComponent = new InfoTableComponent("#infoTable");
  infoTableComponent.showInfo(
    decoder.numChannels, decoder.sampleRate, decoder.fileSize,
    decoder.format, decoder.encoding,
  );
  decoder.decode();
  infoTableComponent.showAdditionalInfo(decoder.duration);

  const audioContext = this._createAudioContext(decoder.sampleRate);
  const audioBuffer = audioContext.createBuffer(
    decoder.numChannels, decoder.length, decoder.sampleRate,
  );
  for (let ch = 0; ch < decoder.numChannels; ch++) {
    audioBuffer.copyToChannel(Float32Array.from(decoder.samples[ch]), ch);
  }

  // 初始化播放器和服务
  const playerSettingsService = PlayerSettingsService.fromDefaultSetting(
    this._config.playerDefault, audioBuffer,
  );
  const playerService = new PlayerService(audioContext, audioBuffer, playerSettingsService);
  const playerComponent = new PlayerComponent("#player", playerService, playerSettingsService);
  this._disposables.push(playerService, playerComponent);

  const analyzeService = new AnalyzeService(audioBuffer);
  const analyzeSettingsService = AnalyzeSettingsService.fromDefaultSetting(
    this._config.analyzeDefault, audioBuffer,
  );
  const settingTabComponent = new SettingTab(
    "#settingTab", playerSettingsService, analyzeService,
    analyzeSettingsService, audioBuffer, this._postMessage,
  );
  this._disposables.push(analyzeService, analyzeSettingsService, settingTabComponent);

  // 阶段 2：异步初始化频谱图（延迟执行避免黑屏）
  const delayFn = typeof requestIdleCallback !== "undefined"
    ? requestIdleCallback
    : (cb: () => void) => setTimeout(cb, 0);

  delayFn(() => {
    const analyzerComponent = new AnalyzerComponent(
      "#analyzer", audioBuffer, analyzeService,
      analyzeSettingsService, playerService, this._config.autoAnalyze,
    );
    this._disposables.push(analyzerComponent);
  });

  decoder.dispose();
}
```

- [ ] **Step 2: 在频谱图 canvas 上显示加载提示**

在 `analyzerComponent.ts` 中，频谱图 canvas 创建后先绘制加载提示文字，直到 `SpectrogramComponent` 初始化完成并覆盖绘制。

---

### 改造 1：引入 essentia.js 完全替换 STFT（最后，最复杂）

- [ ] **Step 1: 安装依赖**

```bash
npm install essentia.js
```

- [ ] **Step 2: 修改 `webpack.config.js`**

在第 138 行 `plugins` 之前添加 WASM 支持和文件处理规则：

```javascript
module: {
  rules: [
    { test: /\.wasm$/, type: 'asset/resource' },
    // 保持现有 TypeScript 规则...
  ],
},
experiments: {
  asyncWebAssembly: true,
},
```

- [ ] **Step 3: 修改 `audioPreviewEditor.ts` 的 CSP**

第 247 行的 CSP 已包含 `'wasm-unsafe-eval'`（确认无需修改）：

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'wasm-unsafe-eval' 'nonce-${nonce}'; connect-src data:;">
```

- [ ] **Step 4: 修改 `analyzeService.ts` — 添加 essentia.js 支持**

```typescript
import EssentiaWASM from 'essentia.js/dist/essentia-wasm.umd.js';
import { Essentia } from 'essentia.js';

export default class AnalyzeService extends Service {
  private _audioBuffer: AudioBuffer;
  private _essentia: Essentia | null = null;

  public async initEssentia(): Promise<void> {
    if (!this._essentia) {
      const wasmModule = await EssentiaWASM();
      this._essentia = new Essentia(wasmModule);
    }
  }

  public get essentiaReady(): boolean {
    return this._essentia !== null;
  }
```

- [ ] **Step 5: 替换 `getSpectrogram()` 中的 FFT 计算**

将 Ooura FFT 部分（第 88-124 行）替换为 essentia.js STFT 流程：

```typescript
// 窗函数类型映射
const windowTypeMap: Record<WindowType, string> = {
  [WindowType.Hann]: 'hann',
  [WindowType.Hamming]: 'hamming',
  [WindowType.BlackmanHarris]: 'blackmanharris92',
  [WindowType.Triangular]: 'triangular',
};

for (let i = startIndex; i < endIndex; i += settings.hopSize) {
  const s = i - windowSize / 2;
  const ss = Math.max(s, 0);
  const frame = new Float32Array(windowSize);
  for (let j = 0; j < windowSize; j++) {
    const idx = s + j;
    if (idx >= 0 && idx < data.length) {
      frame[j] = data[idx];
    }
  }

  const windowed = this._essentia.Windowing(
    frame, true, 0, windowTypeMap[settings.windowType], windowSize, false
  );
  const spectrum = this._essentia.Spectrum(windowed.frame, windowSize);
  // spectrum.spectrum 是 Float32Array 形式的功率谱
  const ps: number[] = [];
  for (let j = minFreqIndex; j < maxFreqIndex; j++) {
    const v = spectrum.spectrum[j];
    ps.push(v);
    if (maxValue < v) maxValue = v;
  }
  spectrogram.push(ps);
}
```

- [ ] **Step 6: 添加 LUFS 计算方法**

```typescript
public getLUFS(ch: number): number {
  if (!this._essentia) return 0;
  const data = this._audioBuffer.getChannelData(ch);
  const audioVector = this._essentia.arrayToVector(data);
  const loudness = this._essentia.LoudnessEBUR128(
    audioVector, this._audioBuffer.sampleRate
  );
  return loudness.integratedLoudness;
}
```

- [ ] **Step 7: 修改 `webview.ts` — 初始化 essentia**

在 `activateUI()` 中，播放器初始化之后、Analyzer 初始化之前添加：

```typescript
await analyzeService.initEssentia();
```

- [ ] **Step 8: 修改 `infoTableComponent.ts` — 显示 LUFS**

在 `showAdditionalInfo()` 方法中添加 LUFS 行：

```typescript
public showLUFS(value: number) {
  this.insertTableData("integrated_loudness", `${value.toFixed(1)} LUFS`);
}
```

---

---

### 改造 8：音频解码器重构（替换 Docker/FFmpeg WASM）

**背景：** 当前 `src/decoder/` 使用 C++ + FFmpeg + libopus 编译为 WASM，需要 Docker + Emscripten 3.1.17 环境才能构建，构建产物 `decoder.js` 以 SINGLE_FILE 形式内嵌 WASM base64，体积庞大。目标是完全删除该目录，改用纯 npm 依赖实现相同格式覆盖。

**格式覆盖策略（三层 fallback）：**

| 层级 | 方案 | 支持格式 | 特点 |
|------|------|---------|------|
| 1 | WebCodecs API | WAV, MP3, AAC, Opus, FLAC | 原生硬件加速，零依赖 |
| 2 | wasm-audio-decoders | MP3, FLAC, Ogg FLAC, Ogg Opus, Raw Opus, Ogg Vorbis | 纯 npm，67-114 KiB/格式，Worker 支持 |
| 3 | Web Audio API `decodeAudioData` | WAV, MP3（浏览器原生） | 最终兜底，同步阻塞 |

**SPH（NIST Sphere）格式：** 三层均不支持，需在 `package.json` 的 `contributes.customEditors` 中移除 `.sph` 扩展名，或保留旧 decoder 仅用于 SPH（不推荐）。

**新 decoder 接口（与现有 `decoder.ts` 保持兼容）：**

```typescript
interface AudioDecoder {
  readAudioInfo(): void;
  decode(): void;
  readonly numChannels: number;
  readonly sampleRate: number;
  readonly duration: number;
  readonly length: number;
  readonly format: string;
  readonly encoding: string;
  readonly fileSize: number;
  readonly samples: Float32Array[];
  dispose(): void;
}
```

**实施步骤：**

- [ ] **Step 1: 安装 wasm-audio-decoders 子包**

```bash
npm install @wasm-audio-decoders/flac @wasm-audio-decoders/ogg-vorbis ogg-opus-decoder mpg123-decoder
```

- [ ] **Step 2: 新建 `src/webview/decoders/webCodecsDecoder.ts`**

使用 `AudioDecoder`（WebCodecs API）解码，通过 `EncodedAudioChunk` 逐帧解码，输出 `Float32Array[]`。

检测可用性：`typeof AudioDecoder !== 'undefined' && AudioDecoder.isConfigSupported`。

支持格式检测：对每种 codec（`mp3`, `aac`, `flac`, `opus`, `pcm-f32le` 等）调用 `AudioDecoder.isConfigSupported({ codec })` 判断当前环境是否支持。

- [ ] **Step 3: 新建 `src/webview/decoders/wasmDecoder.ts`**

根据文件扩展名/MIME 类型选择对应的 wasm-audio-decoders 子包：

```typescript
const decoderMap: Record<string, () => Promise<StreamingDecoder>> = {
  'mp3': () => import('mpg123-decoder').then(m => new m.MPEGDecoder()),
  'flac': () => import('@wasm-audio-decoders/flac').then(m => new m.FLACDecoder()),
  'ogg': () => detectOggCodec(data).then(codec =>
    codec === 'vorbis'
      ? import('@wasm-audio-decoders/ogg-vorbis').then(m => new m.OggVorbisDecoder())
      : import('ogg-opus-decoder').then(m => new m.OggOpusDecoder())
  ),
  'opus': () => import('ogg-opus-decoder').then(m => new m.OggOpusDecoder()),
};
```

所有解码器在 Worker 线程中运行（各包均提供 `*DecoderWorker` 变体）。

- [ ] **Step 4: 新建 `src/webview/decoders/webAudioDecoder.ts`**

使用 `AudioContext.decodeAudioData()` 作为最终 fallback，将结果转换为 `Float32Array[]`。

- [ ] **Step 5: 新建 `src/webview/decoders/decoderFactory.ts`**

```typescript
export async function createDecoder(
  data: Uint8Array,
  ext: string,
): Promise<AudioDecoder> {
  // 1. 尝试 WebCodecs
  if (await webCodecsSupports(ext)) {
    return new WebCodecsDecoder(data, ext);
  }
  // 2. 尝试 wasm-audio-decoders
  if (wasmDecoderSupports(ext)) {
    return new WasmDecoder(data, ext);
  }
  // 3. Web Audio API fallback
  return new WebAudioDecoder(data);
}
```

- [ ] **Step 6: 修改 `src/webview/components/webview/webview.ts`**

将 `this._createDecoder(this._fileData)` 替换为 `createDecoder(this._fileData, this._fileExt)`，移除对旧 WASM 模块的引用。

- [ ] **Step 7: 删除旧 decoder 目录和相关引用**

```bash
rm -rf src/decoder/
```

从 `webpack.config.js` 中移除 WASM SINGLE_FILE 相关配置（如有）。从 `package.json` 中移除 SPH 扩展名（如决定不支持）。

- [ ] **Step 8: 更新 `audioPreviewEditor.ts` CSP**

确认 CSP 中包含 `'wasm-unsafe-eval'`（wasm-audio-decoders 需要）。WebCodecs 不需要额外 CSP。

---

### 改造 9：频谱图 WebGL2 渲染

**背景：** `spectrogramComponent.ts` 用 Canvas 2D `putImageData` 逐像素绘制，颜色映射（dB → RGB）在 JS 中逐像素计算，大文件时绘制慢。WebGL2 将颜色映射和频率坐标变换移到 GPU fragment shader，避免 JS 逐像素循环。

**方案：** 将频谱图数据作为 `R32F` 纹理上传 GPU，在 fragment shader 中完成 dB → RGB 颜色映射和 Log/Mel 频率坐标变换，输出到 WebGL canvas。

**实施步骤：**

- [ ] **Step 1: 安装 twgl.js（减少 WebGL 样板代码）**

```bash
npm install twgl.js
```

- [ ] **Step 2: 新建 `src/webview/components/spectrogram/spectrogramRenderer.ts`**

封装 WebGL2 渲染逻辑：

```typescript
export class SpectrogramRenderer {
  private gl: WebGL2RenderingContext;
  private programInfo: twgl.ProgramInfo;
  private texture: WebGLTexture;

  constructor(canvas: HTMLCanvasElement) {
    this.gl = canvas.getContext('webgl2');
    this.programInfo = twgl.createProgramInfo(this.gl, [VERT_SHADER, FRAG_SHADER]);
  }

  upload(data: Float32Array, timeFrames: number, freqBins: number) {
    // 上传频谱图数据为 R32F 纹理
  }

  render(settings: AnalyzeSettingsProps) {
    // 传入 uniform：frequencyScale, minFreq, maxFreq, ampLow, ampHigh
    // 绘制全屏四边形，fragment shader 完成所有映射
  }
}
```

- [ ] **Step 3: 编写 fragment shader**

```glsl
#version 300 es
precision highp float;

uniform sampler2D u_spectrogram; // R32F 纹理，值为 dB
uniform int u_freqScale;         // 0=linear, 1=log, 2=mel
uniform float u_minFreq;
uniform float u_maxFreq;
uniform float u_ampLow;
uniform float u_ampHigh;

in vec2 v_texCoord;
out vec4 fragColor;

// 6 级颜色映射（与现有 getSpectrogramColor 一致）
vec3 colormap(float t) { /* ... */ }

void main() {
  // 频率坐标变换（log/mel 在 shader 中完成）
  float freqCoord = v_texCoord.y;
  if (u_freqScale == 1) { /* log 变换 */ }
  else if (u_freqScale == 2) { /* mel 变换 */ }

  float dB = texture(u_spectrogram, vec2(v_texCoord.x, freqCoord)).r;
  float t = clamp((dB - u_ampLow) / (u_ampHigh - u_ampLow), 0.0, 1.0);
  fragColor = vec4(colormap(t), 1.0);
}
```

- [ ] **Step 4: 修改 `spectrogramComponent.ts`**

检测 WebGL2 可用性，可用时使用 `SpectrogramRenderer`，不可用时 fallback 到现有 Canvas 2D 路径：

```typescript
const gl = canvas.getContext('webgl2');
if (gl) {
  this._renderer = new SpectrogramRenderer(canvas);
} else {
  // 保留现有 Canvas 2D 逻辑
}
```

频谱图数据计算完成后调用 `renderer.upload(flatData, timeFrames, freqBins)`，设置变更时调用 `renderer.render(settings)`。

- [ ] **Step 5: 更新 `audioPreviewEditor.ts` CSP**

WebGL 不需要额外 CSP，但确认 `img-src` 包含 `blob:`（WebGL canvas toBlob 可能用到）。

---

### 改造 10：播放进度同步优化

**背景：** `playerService.ts` 的 `tick()` 用 `requestAnimationFrame` 每帧更新进度条，存在两个问题：(1) `AudioContext.currentTime` 在某些情况下会冻结 ~230ms 导致进度跳跃；(2) 每帧触发 DOM 属性修改，与频谱图绘制竞争主线程。

**实施步骤：**

- [ ] **Step 1: 替换 `tick()` 中的时间源**

将 `playerService.ts` 第 155-182 行的 `tick()` 中：

```typescript
// 旧：可能冻结 230ms
const currentSec = this._currentSec + (this._audioContext.currentTime - this._lastStartAcTime);
```

改为：

```typescript
// 新：使用 getOutputTimestamp() 获取精确输出时间
const ts = this._audioContext.getOutputTimestamp();
const currentSec = this._currentSec + (ts.contextTime - this._lastStartAcTime);
```

加入 `getOutputTimestamp` 不可用时的 fallback：

```typescript
const contextTime = this._audioContext.getOutputTimestamp?.().contextTime
  ?? this._audioContext.currentTime;
```

- [ ] **Step 2: 进度条用 CSS transform 替代 width**

在 `playerComponent.ts` 中，将进度条更新从修改 `width` 改为 `transform: scaleX()`：

```typescript
// 旧：触发重排
seekbar.style.width = `${percent}%`;

// 新：仅触发合成，不重排
seekbarFill.style.transform = `scaleX(${percent / 100})`;
seekbarFill.style.transformOrigin = 'left';
```

需在 CSS 中将进度条填充元素设为 `width: 100%`，通过 scaleX 控制视觉宽度。

---

## 验证方案

| 改造 | 验证方法 |
|------|---------|
| 4 | 用 440Hz 正弦波，log 尺度下验证频率轴标签与峰值位置对齐；底部显示 0Hz，顶部显示奈奎斯特频率 |
| 6 | 设置 low=-80dB, high=-10dB，验证颜色条范围正确，超出范围的值显示为黑色 |
| 2 | 用白噪声对比 Hann/Hamming 窗的旁瓣抑制差异；切换窗函数后频谱图有明显变化 |
| 7 | 点击中间位置 → 确认白色静态标记线出现，不播放 → 空格播放 → 确认从标记位置开始 → 暂停 → 空格 → 确认从标记位置重新开始 |
| 5 | 对比全局视图和缩放 10 倍后的频谱图，缩放后应能看到更细的频率细节 |
| 3 | 用 >50MB FLAC 文件，确认信息表和波形在频谱图计算前已可见 |
| 1 | 运行 `npm run compile` 确认编译通过；用 EBU R128 测试音频验证 LUFS 值准确性；用已知频率音频验证 STFT 峰值位置 |
| 8 | 分别用 wav/mp3/aac/ogg/opus/flac/m4a 文件打开，确认每种格式均能正常解码显示；确认 `src/decoder/` 目录已删除；确认 `npm run compile` 不再依赖 Docker |
| 9 | 用 >5 分钟音频文件对比 Canvas 2D 和 WebGL2 渲染时间（DevTools Performance 面板）；切换 Linear/Log/Mel 尺度确认渲染正确；在不支持 WebGL2 的环境确认 fallback 到 Canvas 2D |
| 10 | 播放时用 DevTools Performance 面板确认无 Layout/Reflow；进度条在快速 seek 后无跳跃；`getOutputTimestamp` 不可用时 fallback 正常工作 |
