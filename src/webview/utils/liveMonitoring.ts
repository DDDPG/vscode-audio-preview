/** Stereo monitoring path for live meters / headphone matrix (linear). */
export type LiveMonitoringMode = "lr" | "l" | "r" | "m" | "s";

/** Gains from (L,R) analyser outputs to (outL, outR) merger inputs: out = M * in. */
export interface MonitoringGains {
  ll: number;
  lr: number;
  rl: number;
  rr: number;
}

export function monitoringGainsForMode(mode: LiveMonitoringMode): MonitoringGains {
  switch (mode) {
    case "l":
      return { ll: 1, lr: 1, rl: 0, rr: 0 };
    case "r":
      return { ll: 0, lr: 0, rl: 1, rr: 1 };
    case "m":
      return { ll: 0.5, lr: 0.5, rl: 0.5, rr: 0.5 };
    case "s":
      return { ll: 0.5, lr: -0.5, rl: -0.5, rr: 0.5 };
    case "lr":
    default:
      return { ll: 1, lr: 0, rl: 0, rr: 1 };
  }
}

/**
 * Mix L/R samples into outL/outR using the same linear matrix as the audio graph.
 * Buffers may alias (e.g. outL === lBuf after in-place); use temporaries if needed.
 */
export function applyMonitoringToTimeDomain(
  mode: LiveMonitoringMode,
  lBuf: Float32Array,
  rBuf: Float32Array,
  outL: Float32Array,
  outR: Float32Array,
): void {
  const { ll, lr, rl, rr } = monitoringGainsForMode(mode);
  const n = lBuf.length;
  for (let i = 0; i < n; i++) {
    const L = lBuf[i];
    const R = rBuf[i];
    outL[i] = ll * L + rl * R;
    outR[i] = lr * L + rr * R;
  }
}

/**
 * Spectrum tilt / slope (e.g. SPAN-style): add `slope * log2(f / fRef)` dB to the trace.
 * Positive slope boosts higher frequencies so pink noise (~−3 dB/oct physical) can read flat at 3 dB/oct.
 */
export function spectrumTiltDb(
  fHz: number,
  slopeDbPerOct: number,
  fRefHz: number = 1000,
): number {
  if (slopeDbPerOct === 0 || !Number.isFinite(fHz) || fHz <= 0) return 0;
  return slopeDbPerOct * (Math.log(fHz / fRefHz) / Math.LN2);
}

/**
 * Same tilt as {@link spectrumTiltDb}, scaled to zero at the noise floor so a
 * constant silent spectrum (e.g. −90 dBFS in every bin) does not become a sloped line.
 *
 * @param rawDb  Measured band level in dB **before** tilt (typically ≤ 0).
 * @param floorDb  Analyzer floor used as “no signal” (same as plot floor, e.g. −90).
 * @param blendDb  How many dB above `floorDb` until tilt reaches full strength.
 */
export function spectrumTiltDbAboveFloor(
  fHz: number,
  slopeDbPerOct: number,
  rawDb: number,
  floorDb: number = -90,
  blendDb: number = 18,
  fRefHz: number = 1000,
): number {
  const t = spectrumTiltDb(fHz, slopeDbPerOct, fRefHz);
  if (t === 0) return 0;
  const w = Math.max(0, Math.min(1, (rawDb - floorDb) / Math.max(1e-6, blendDb)));
  return t * w;
}

/** Mid / Side from interleaved stereo time domain (same length buffers). */
export function encodeMidSideTimeDomain(
  lBuf: Float32Array,
  rBuf: Float32Array,
  outM: Float32Array,
  outS: Float32Array,
): void {
  const n = lBuf.length;
  for (let i = 0; i < n; i++) {
    const L = lBuf[i];
    const R = rBuf[i];
    outM[i] = 0.5 * (L + R);
    outS[i] = 0.5 * (L - R);
  }
}

/** Map UI smoothing 0..100 to exponential decay per animation frame (~60fps). */
export function smoothingPctToDecay(pct: number): number {
  const t = Math.max(0, Math.min(100, pct)) / 100;
  return 0.78 + t * 0.21;
}
