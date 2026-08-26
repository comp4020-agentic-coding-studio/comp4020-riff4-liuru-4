// Shadows: a delay line, not a looper. Each shadow is you, T seconds ago,
// replaying continuously off the shared history ring buffer — never its
// own copy of the path.

import { eventsBetween, sample } from "./history";

interface AudioAccess {
  ctx: AudioContext;
}

interface ShadowConfig {
  delaySeconds: number;
  volumeScale: number;
  cutoffScale: number;
  alphaScale: number;
  saturationPercent: number;
}

const SHADOWS: ShadowConfig[] = [
  { delaySeconds: 3.5, volumeScale: 0.45, cutoffScale: 0.5, alphaScale: 0.45, saturationPercent: 55 },
  { delaySeconds: 7, volumeScale: 0.25, cutoffScale: 0.3, alphaScale: 0.25, saturationPercent: 40 },
];

// Mirrors main.ts's pitch/filter mapping and constants exactly — same
// formula, applied to a shadow's own delayed position instead of the live
// pointer.
const MIN_FREQ = 90;
const MAX_FREQ = 720;
const MIN_CUTOFF = 250;
const MAX_CUTOFF = 5200;
const BASE_VOICE_LEVEL = 0.22;
const BUBBLE_LIFE_MS = 750;
const FLASH_LIFE_MS = 220;

function frequencyForY(y: number): number {
  return MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, 1 - y);
}

function hueFor(y: number): number {
  return 260 - y * 140;
}

interface Voice {
  osc: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  delay: DelayNode;
}

const voices: (Voice | null)[] = SHADOWS.map(() => null);
const playheads: number[] = SHADOWS.map(() => -Infinity);

interface Echo {
  x: number;
  y: number;
  bornAt: number;
  hue: number;
  kind: "bubble" | "lightning";
  angle: number;
}

const echoes: Echo[][] = SHADOWS.map(() => []);

function ensureVoice(index: number, graph: AudioAccess): Voice {
  const existing = voices[index];
  if (existing) return existing;

  const osc = graph.ctx.createOscillator();
  osc.type = "triangle";
  const filter = graph.ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.8;
  const gain = graph.ctx.createGain();
  gain.gain.value = 0;
  const delay = graph.ctx.createDelay(1);
  delay.delayTime.value = 0.12 + index * 0.08;

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(delay);
  delay.connect(graph.ctx.destination);
  osc.start();

  const voice: Voice = { osc, filter, gain, delay };
  voices[index] = voice;
  return voice;
}

function updateVoice(
  index: number,
  graph: AudioAccess,
  config: ShadowConfig,
  frame: { x: number; y: number; presence: number },
): void {
  const voice = ensureVoice(index, graph);
  const now = graph.ctx.currentTime;
  voice.osc.frequency.setTargetAtTime(frequencyForY(frame.y), now, 0.03);
  const cutoff = MIN_CUTOFF * Math.pow(MAX_CUTOFF / MIN_CUTOFF, frame.x) * config.cutoffScale;
  voice.filter.frequency.setTargetAtTime(cutoff, now, 0.05);
  voice.gain.gain.setTargetAtTime(frame.presence * BASE_VOICE_LEVEL * config.volumeScale, now, 0.09);
}

function collectEchoes(index: number, config: ShadowConfig, now: number): void {
  const playedTo = playheads[index];
  const playhead = now - config.delaySeconds * 1000;
  playheads[index] = playhead;
  if (playedTo === -Infinity) return;

  const due = eventsBetween(playedTo, playhead);
  const bucket = echoes[index];
  for (const event of due) {
    bucket.push({
      x: event.x,
      y: event.y,
      bornAt: now,
      hue: hueFor(event.y),
      kind: event.type,
      angle: Math.random() * Math.PI * 2,
    });
  }
}

function drawGlow(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: { x: number; y: number; presence: number },
  config: ShadowConfig,
): void {
  const px = frame.x * width;
  const py = frame.y * height;
  const radius = (18 + frame.presence * 40) * (0.5 + config.alphaScale);
  const hue = hueFor(frame.y);
  const glow = ctx.createRadialGradient(px, py, 0, px, py, radius);
  glow.addColorStop(
    0,
    `hsla(${hue}, ${config.saturationPercent}%, 65%, ${(0.15 + frame.presence * 0.5) * config.alphaScale})`,
  );
  glow.addColorStop(1, `hsla(${hue}, ${config.saturationPercent}%, 55%, 0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(px, py, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawEchoes(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  index: number,
  config: ShadowConfig,
  now: number,
): void {
  const bucket = echoes[index];
  for (let i = bucket.length - 1; i >= 0; i--) {
    const echo = bucket[i];
    const lifeMs = echo.kind === "bubble" ? BUBBLE_LIFE_MS : FLASH_LIFE_MS;
    const age = now - echo.bornAt;
    if (age > lifeMs) {
      bucket.splice(i, 1);
      continue;
    }
    const progress = age / lifeMs;
    if (echo.kind === "bubble") {
      const radius = 5 + progress * 34;
      const rise = progress * 38;
      const alpha = (1 - progress) * 0.4 * config.alphaScale;
      ctx.beginPath();
      ctx.arc(echo.x * width, echo.y * height - rise, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${echo.hue}, ${config.saturationPercent}%, 70%, ${alpha})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      const alpha = (1 - progress) * 0.5 * config.alphaScale;
      let x = echo.x * width;
      let y = echo.y * height;
      let angle = echo.angle;
      ctx.strokeStyle = `hsla(200, 60%, 80%, ${alpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let seg = 0; seg < 4; seg++) {
        angle += (Math.random() - 0.5) * 1.4;
        x += Math.cos(angle) * 14;
        y += Math.sin(angle) * 14;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
}

export function drawShadows(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  getAudio: () => AudioAccess | null,
): void {
  const now = performance.now();
  const graph = getAudio();

  SHADOWS.forEach((config, index) => {
    collectEchoes(index, config, now);
    const frame = sample(config.delaySeconds);
    if (!frame) return;
    if (graph) updateVoice(index, graph, config, frame);
    drawGlow(ctx, width, height, frame, config);
    drawEchoes(ctx, width, height, index, config, now);
  });
}
