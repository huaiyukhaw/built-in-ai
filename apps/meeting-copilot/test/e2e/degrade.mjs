// Makes a clean TTS recording sound more like a laptop mic in a meeting room: quieter, with
// reverb and background noise. Clean TTS transcribes almost perfectly, which hides real problems.
//
//   node test/e2e/degrade.mjs realistic-en.wav room-en.wav --gain -18 --snr 12 --reverb 0.5
//
// Writes the output next to the input and copies the reference .txt alongside it.
// Only 16-bit mono PCM WAV (what make-*.ps1 produce) is supported.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [input, output, ...rest] = process.argv.slice(2);
if (!input || !output) { console.error('usage: degrade.mjs <in.wav> <out.wav> [--gain dB] [--snr dB] [--reverb seconds] [--seed n]'); process.exit(1); }
const opt = { gain: -12, snr: 15, reverb: 0.4, seed: 1 };
for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = Number(rest[i + 1]);

let seed = opt.seed;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;

function readWav(path) {
  const b = readFileSync(path);
  let p = 12;
  let rate = 16000;
  while (p < b.length) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') rate = b.readUInt32LE(p + 12);
    if (id === 'data') {
      const n = size / 2;
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = b.readInt16LE(p + 8 + i * 2) / 32768;
      return { rate, x };
    }
    p += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

function writeWav(path, rate, x) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  writeFileSync(path, b);
}

const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);

const inPath = join(here, input);
const { rate, x } = readWav(inPath);

// Reverb: convolve with exponentially decaying noise (a crude room impulse response), 35% wet.
let y = x;
if (opt.reverb > 0) {
  const len = Math.round(rate * opt.reverb);
  const ir = Float32Array.from({ length: len }, (_, i) => rand() * Math.exp((-6.9 * i) / len)); // -60 dB at the end
  const irNorm = Math.sqrt(ir.reduce((a, v) => a + v * v, 0));
  const wet = new Float32Array(x.length);
  const step = 4; // sparse taps keep this fast enough in plain JS
  for (let k = 0; k < len; k += step) {
    const g = (ir[k] / irNorm) * Math.sqrt(step);
    for (let i = k; i < x.length; i++) wet[i] += g * x[i - k];
  }
  y = Float32Array.from(x, (v, i) => 0.65 * v + 0.35 * wet[i]);
}

// Gain: a speaker across the table is much quieter than TTS at full scale.
const gain = 10 ** (opt.gain / 20);
y = y.map((v) => v * gain);

// Background noise (brownish: air conditioning, laptop fan) at the requested SNR against speech level.
const speechRms = rms(y.filter((v) => Math.abs(v) > 1e-4));
const noise = new Float32Array(y.length);
let last = 0;
for (let i = 0; i < noise.length; i++) { last = 0.97 * last + 0.03 * rand(); noise[i] = last + 0.15 * rand(); }
const noiseGain = speechRms / 10 ** (opt.snr / 20) / rms(noise);
y = y.map((v, i) => v + noise[i] * noiseGain);

const outPath = join(here, output);
writeWav(outPath, rate, y);
const ref = inPath.replace(/\.wav$/, '.txt');
if (existsSync(ref)) copyFileSync(ref, outPath.replace(/\.wav$/, '.txt'));
console.log(`${output}: speech rms ${speechRms.toFixed(4)}, noise rms ${(rms(noise) * noiseGain).toFixed(4)}, ${(y.length / rate).toFixed(1)} s`);
