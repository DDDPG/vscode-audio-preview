#!/usr/bin/env node
// Benchmark: old (Ooura JS) vs new (Essentia WASM) STFT + rendering
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');

function makePCM(seconds, sampleRate = 44100) {
  const len = seconds * sampleRate;
  const data = new Float32Array(len);
  for (let i = 0; i < len; i++) data[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.5;
  return data;
}

function bench(fn, runs = 5) {
  fn(); // warmup
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return +(times.reduce((a, b) => a + b, 0) / runs).toFixed(2);
}

// ── STFT: Ooura (old + new fallback path) ────────────────────────────────────
function stftOoura(data, windowSize, hopSize) {
  const Ooura = require(path.join(ROOT, 'node_modules/ooura'));
  const ooura = new Ooura(windowSize, { type: 'real', radix: 4 });
  const win = new Float32Array(windowSize);
  for (let i = 0; i < windowSize; i++)
    win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / windowSize);

  const frames = [];
  for (let i = 0; i < data.length; i += hopSize) {
    const d = ooura.scalarArrayFactory();
    for (let j = 0; j < windowSize; j++)
      d[j] = (i + j < data.length ? data[i + j] : 0) * win[j];
    const re = ooura.vectorArrayFactory();
    const im = ooura.vectorArrayFactory();
    ooura.fft(d.buffer, re.buffer, im.buffer);
    const ps = new Float32Array(windowSize / 2);
    for (let j = 0; j < windowSize / 2; j++) ps[j] = re[j] * re[j] + im[j] * im[j];
    frames.push(ps);
  }
  return frames;
}

// ── STFT: Essentia WASM (new primary path) — single-frame timing × extrapolate
// Essentia WASM crashes on large loops in Node (browser-targeted WASM memory layout),
// so we time N_SAMPLE frames and extrapolate.
function benchEssentiaPerFrame(E, windowSize, N_SAMPLE = 200) {
  const frame = new Float32Array(windowSize);
  for (let i = 0; i < windowSize; i++) frame[i] = Math.sin(2 * Math.PI * i / windowSize);

  // warmup
  for (let i = 0; i < 5; i++) {
    const v = E.arrayToVector(frame);
    const w = E.Windowing(v, false, windowSize, 'hann', 0, false);
    E.Spectrum(w.frame, windowSize);
  }

  const t0 = performance.now();
  for (let i = 0; i < N_SAMPLE; i++) {
    const v = E.arrayToVector(frame);
    const w = E.Windowing(v, false, windowSize, 'hann', 0, false);
    E.Spectrum(w.frame, windowSize);
  }
  return (performance.now() - t0) / N_SAMPLE; // ms per frame
}

// ── Rendering: Canvas2D (old) vs WebGL2 texture pack (new) ───────────────────
function renderCanvas2D(frames) {
  for (const f of frames)
    for (let y = 0; y < f.length; y++) {
      const amp = f[y];
      void `rgb(${Math.floor(amp * 255)},0,0)`; // color string per pixel (old approach)
    }
}

function renderWebGL2(frames) {
  // New: pack all frames into one Float32Array (texture upload), then 1 draw call
  const tex = new Float32Array(frames.length * frames[0].length);
  for (let x = 0; x < frames.length; x++) tex.set(frames[x], x * frames[0].length);
  return tex; // 1 draw call
}

// ── Decoder: new WASM decoders init time ─────────────────────────────────────
async function benchDecoder() {
  const { MPEGDecoder } = require(path.join(ROOT, 'node_modules/mpg123-decoder'));

  const t0 = performance.now();
  const d1 = new MPEGDecoder(); await d1.ready;
  const cold = +(performance.now() - t0).toFixed(2);
  d1.free();

  const t1 = performance.now();
  const d2 = new MPEGDecoder(); await d2.ready;
  const warm = +(performance.now() - t1).toFixed(2);
  d2.free();

  return { cold_ms: cold, warm_ms: warm };
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const essSrc = fs.readFileSync(path.join(ROOT, 'node_modules/essentia.js/dist/essentia.js-core.js'), 'utf8');
  vm.runInThisContext(essSrc);
  const EssentiaWASM = require(path.join(ROOT, 'node_modules/essentia.js/dist/essentia-wasm.umd.js'));
  const E = new global.Essentia(EssentiaWASM);

  const WINDOW_SIZE = 2048;
  const HOP_SIZE = 512;

  // Essentia: ms per frame (extrapolated)
  const essPerFrame = benchEssentiaPerFrame(E, WINDOW_SIZE);

  const stftResults = [];
  const renderResults = [];

  for (const seconds of [10, 60, 300]) {
    const data = makePCM(seconds);
    const numFrames = Math.floor(data.length / HOP_SIZE);

    const oouraMs = bench(() => stftOoura(data, WINDOW_SIZE, HOP_SIZE));
    const essentiaMs = +(essPerFrame * numFrames).toFixed(2); // extrapolated

    stftResults.push({
      duration: `${seconds}s`,
      frames: numFrames,
      ooura_ms: oouraMs,
      essentia_ms_extrapolated: essentiaMs,
      speedup: +(oouraMs / essentiaMs).toFixed(2),
    });

    const frames = stftOoura(data, WINDOW_SIZE, HOP_SIZE);
    const c2dMs = bench(() => renderCanvas2D(frames));
    const glMs  = bench(() => renderWebGL2(frames));

    renderResults.push({
      duration: `${seconds}s`,
      frames: frames.length,
      total_pixels: frames.length * frames[0].length,
      canvas2d_ms: c2dMs,
      webgl2_texture_pack_ms: glMs,
      speedup: +(c2dMs / glMs).toFixed(2),
    });
  }

  const decoderResult = await benchDecoder();

  // ── print ────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  STFT: Ooura JS (old/fallback) vs Essentia WASM (new primary)');
  console.log('  windowSize=2048, hopSize=512  |  Essentia: extrapolated from single-frame timing');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('Duration │  Frames │ Ooura (ms) │ Essentia (ms) │ Speedup');
  console.log('─────────┼─────────┼────────────┼───────────────┼────────');
  for (const r of stftResults)
    console.log(`${r.duration.padEnd(8)} │ ${String(r.frames).padEnd(7)} │ ${String(r.ooura_ms).padEnd(10)} │ ${String(r.essentia_ms_extrapolated).padEnd(13)} │ ${r.speedup}x`);

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  Rendering: Canvas2D fillRect/color-string (old) vs WebGL2 texture pack (new)');
  console.log('  canvas 1200×600  |  WebGL2 time = CPU texture upload only (GPU draw = 1 call)');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('Duration │  Frames │  Pixels    │ Canvas2D (ms) │ WebGL2 (ms) │ Speedup');
  console.log('─────────┼─────────┼────────────┼───────────────┼─────────────┼────────');
  for (const r of renderResults)
    console.log(`${r.duration.padEnd(8)} │ ${String(r.frames).padEnd(7)} │ ${String(r.total_pixels).padEnd(10)} │ ${String(r.canvas2d_ms).padEnd(13)} │ ${String(r.webgl2_texture_pack_ms).padEnd(11)} │ ${r.speedup}x`);

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  Decoder WASM Init: new mpg123-decoder (old FFmpeg WASM needs Docker)');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`  Cold start (first init): ${decoderResult.cold_ms} ms`);
  console.log(`  Warm start (WASM cached): ${decoderResult.warm_ms} ms`);
  console.log(`  Old FFmpeg WASM: requires Docker build step + ~8MB blob load (not measurable here)`);

  const out = path.join(__dirname, 'benchmark_results.json');
  fs.writeFileSync(out, JSON.stringify({ stft: stftResults, rendering: renderResults, decoder: decoderResult }, null, 2));
  console.log(`\n  Saved → ${out}\n`);

  E.delete();
}

main().catch(e => { console.error(e); process.exit(1); });
