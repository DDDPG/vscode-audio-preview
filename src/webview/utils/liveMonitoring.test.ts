import {
  encodeMidSideTimeDomain,
  spectrumTiltDb,
  spectrumTiltDbAboveFloor,
} from "./liveMonitoring";

describe("spectrumTiltDb", () => {
  test("adds +slope dB per octave above reference (one octave up doubles frequency)", () => {
    expect(spectrumTiltDb(1000, 3)).toBeCloseTo(0, 5);
    expect(spectrumTiltDb(2000, 3)).toBeCloseTo(3, 5);
    expect(spectrumTiltDb(500, 3)).toBeCloseTo(-3, 5);
  });
});

describe("encodeMidSideTimeDomain", () => {
  test("M/S diagonal on stereo impulse", () => {
    const L = new Float32Array([1, 0, 1]);
    const R = new Float32Array([1, 0, -1]);
    const M = new Float32Array(3);
    const S = new Float32Array(3);
    encodeMidSideTimeDomain(L, R, M, S);
    expect(M[0]).toBeCloseTo(1);
    expect(S[0]).toBeCloseTo(0);
    expect(M[2]).toBeCloseTo(0);
    expect(S[2]).toBeCloseTo(1);
  });
});

describe("spectrumTiltDbAboveFloor", () => {
  test("adds no tilt when level is at the floor (flat silence)", () => {
    expect(spectrumTiltDbAboveFloor(20000, 4.5, -90, -90, 18)).toBeCloseTo(0, 5);
    expect(spectrumTiltDbAboveFloor(40, 4.5, -90, -90, 18)).toBeCloseTo(0, 5);
  });

  test("reaches full tilt when level is blendDb above floor", () => {
    const raw = -90 + 18;
    expect(spectrumTiltDbAboveFloor(2000, 3, raw, -90, 18)).toBeCloseTo(
      spectrumTiltDb(2000, 3),
      5,
    );
  });
});
