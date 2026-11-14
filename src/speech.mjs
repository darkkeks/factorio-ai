// Локальные VAD и распознавание речи через sherpa-onnx. Чтобы подключить облачного провайдера,
// достаточно заменить transcribe() — остальной код о моделях не знает.
import path from 'node:path';
import sherpa from 'sherpa-onnx-node';
import { MODELS, VAD_SILENCE_S } from './config.mjs';

export const STT_RATE = 16000;
const VAD_WINDOW = 512;

const asrDir = path.join(MODELS, 'sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16');
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: STT_RATE, featureDim: 64 },
  modelConfig: {
    transducer: {
      encoder: path.join(asrDir, 'encoder.int8.onnx'),
      decoder: path.join(asrDir, 'decoder.onnx'),
      joiner: path.join(asrDir, 'joiner.onnx'),
    },
    tokens: path.join(asrDir, 'tokens.txt'),
    modelType: 'nemo_transducer',
    numThreads: 4,
    debug: 0,
  },
});

// Распознавание идёт строго по одному: процессор слабый.
let chain = Promise.resolve();
const serial = (fn) => {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
};

/** Float32Array 16 кГц моно -> текст. */
export function transcribe(samples) {
  return serial(async () => {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: STT_RATE });
    await recognizer.decodeAsync(stream);
    return recognizer.getResult(stream).text.trim();
  });
}

/** s16le 48 кГц стерео (выход opus-декодера) -> Float32Array 16 кГц моно. */
export function fromDiscordPcm(buf) {
  const n = Math.floor(buf.length / 12);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < 6; k++) sum += buf.readInt16LE(i * 12 + k * 2);
    out[i] = sum / 6 / 32768;
  }
  return out;
}

/** Детектор фраз одного говорящего: кормим звук, получаем законченные отрезки речи. */
export class Utterances {
  constructor() {
    this.vad = new sherpa.Vad({
      sileroVad: {
        model: path.join(MODELS, 'silero_vad.onnx'),
        threshold: 0.5,
        minSpeechDuration: 0.15,
        minSilenceDuration: VAD_SILENCE_S,
        maxSpeechDuration: 25,
        windowSize: VAD_WINDOW,
      },
      sampleRate: STT_RATE,
      numThreads: 1,
      debug: 0,
    }, 60);
    this.pending = new Float32Array(0);
  }

  /** Возвращает { segments: Float32Array[], speaking: boolean }. */
  feed(samples) {
    const all = new Float32Array(this.pending.length + samples.length);
    all.set(this.pending);
    all.set(samples, this.pending.length);
    let off = 0;
    for (; off + VAD_WINDOW <= all.length; off += VAD_WINDOW) {
      this.vad.acceptWaveform(all.subarray(off, off + VAD_WINDOW));
    }
    this.pending = all.slice(off);
    const segments = [];
    while (!this.vad.isEmpty()) {
      segments.push(Float32Array.from(this.vad.front(false).samples));
      this.vad.pop();
    }
    return { segments, speaking: this.vad.isDetected() };
  }
}
