// An instrument: one mechanic — a point in space, wherever it comes from
// (pointer, touch, the arrow keys, or a tracked hand) — drives everything
// else. Moving it sings; letting it sit still lets the tone fade like dew; a
// tap or the space bar bursts a bubble; moving it fast cracks like lightning.
// The six-as-ifs of the Diamond Sūtra's closing line supply the vocabulary
// for what one continuous gesture sounds and looks like, not six separate
// toys.

import { HandController, type HandPoll } from "./hand.ts";

import { recordEvent, recordFrame } from "./history";
import { drawFlash } from "./lightning";
import { drawRibbons } from "./ribbon";
import { drawShadows } from "./shadows";

const canvas = document.querySelector<HTMLCanvasElement>("#stage");
if (!canvas) throw new Error("missing #stage canvas");
const stage = canvas;
const ink = stage.getContext("2d");
if (!ink) throw new Error("2d context unavailable");
const draw = ink;

interface Point {
  x: number;
  y: number;
}

// The one shape every input device speaks, so pointer/touch, keyboard and a
// tracked hand all drive the same audio+visual logic below instead of each
// getting their own copy of it. `active` means "this tick carries an
// intentional position update" (not merely "the device is present") — that
// distinction is what lets a still tracked hand fall through to Dew instead
// of holding presence up forever; see hand.ts's noise-tolerance gating.
export type InputSource = "pointer" | "keyboard" | "hand";
export interface InstrumentInput {
  x: number;
  y: number;
  active: boolean;
  pinch: boolean;
  source: InputSource;
}

interface AudioGraph {
  ctx: AudioContext;
  master: GainNode;
  osc: OscillatorNode;
  filter: BiquadFilterNode;
  voiceGain: GainNode;
  noiseBuffer: AudioBuffer;
}

interface BubbleRing {
  delay: number;
  gapAngle: number;
  gapWidth: number;
  maxRadius: number;
}

interface BubbleFragment {
  angle: number;
  dist: number;
  size: number;
  delay: number;
}

interface Bubble {
  x: number;
  y: number;
  bornAt: number;
  hue: number;
  rings: BubbleRing[];
  fragments: BubbleFragment[];
}

interface TrailPoint {
  x: number;
  y: number;
  bornAt: number;
  speed: number;
  life: number;
  zig: number;
  branch: number;
}

interface Flash {
  x: number;
  y: number;
  bornAt: number;
  angle: number;
  speed: number;
}

const MIN_FREQ = 90;
const MAX_FREQ = 720;
const MIN_CUTOFF = 250;
const MAX_CUTOFF = 5200;
const BASE_VOICE_LEVEL = 0.22;
const PRESENCE_TAU_UP = 0.06;
const PRESENCE_TAU_DOWN = 2.4;
const MOVE_WINDOW_MS = 150;
const LIGHTNING_SPEED = 2.2; // normalised units per second
const LIGHTNING_COOLDOWN_MS = 260;
const BUBBLE_LIFE_MS = 420; // total burst duration, within the 350-500ms window
const FLASH_LIFE_MS = 220;
const CLICK_PULSE_MS = 220;
const ORB_BASE_RADIUS = 8;
const ORB_PRESENCE_RADIUS = 23;
const TRAIL_SPEED_REF = 2.4; // normalised units per second, for trail scaling
const TRAIL_LIFE_BASE_MS = 320;
const TRAIL_LIFE_BONUS_MS = 350; // faster points live longer, within the 0.3-0.8s window
const TRAIL_PRUNE_MS = TRAIL_LIFE_BASE_MS + TRAIL_LIFE_BONUS_MS;
const TRAIL_JITTER_BASE = 4; // px of zigzag at rest
const TRAIL_JITTER_SPEED = 24; // extra px of zigzag at full speed
// Ambient mist: the motion trail demoted to a background layer under ribbon/shadows/orb.
// Flip these back to 1 to see it at full strength.
const AMBIENT_TRAIL_WIDTH = 0.4;
const AMBIENT_TRAIL_ALPHA = 0.35;
const AMBIENT_TRAIL_LIFE = 0.6;
const KEY_SPEED = 0.7; // normalised units per second

const pointer: Point = { x: 0.5, y: 0.42 };
let lastMoveAt = -Infinity;
let lastLightningAt = 0;
let lastClickAt = -Infinity;
let presence = 0;
let lastFrameAt = 0;

const bubbles: Bubble[] = [];
const trail: TrailPoint[] = [];
const flashes: Flash[] = [];
const heldKeys = new Set<string>();
const pinchState: Record<InputSource, boolean> = { pointer: false, keyboard: false, hand: false };

let audio: AudioGraph | null = null;
let handController: HandController | null = null;
let handEnabled = false;
let handDetected = false;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function buildNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const length = ctx.sampleRate; // one second
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function ensureAudio(): AudioGraph {
  if (audio) {
    void audio.ctx.resume();
    return audio;
  }
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(ctx.destination);

  const osc = ctx.createOscillator();
  osc.type = "triangle";
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.8;
  const voiceGain = ctx.createGain();
  voiceGain.gain.value = 0;

  osc.connect(filter);
  filter.connect(voiceGain);
  voiceGain.connect(master);

  const delay = ctx.createDelay(1);
  delay.delayTime.value = 0.22;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.28;
  voiceGain.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(master);

  osc.start();

  audio = { ctx, master, osc, filter, voiceGain, noiseBuffer: buildNoiseBuffer(ctx) };
  return audio;
}

export function getAudio(): AudioGraph | null {
  return audio;
}

function currentFrequency(): number {
  return MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, 1 - pointer.y);
}

function pluckBubble(): void {
  const graph = ensureAudio();
  const { ctx, master } = graph;
  const now = ctx.currentTime;
  const freq = currentFrequency() * (0.94 + Math.random() * 0.28);

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq * 1.5, now);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.85), now + 0.32);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.32, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);

  osc.connect(gain);
  gain.connect(master);
  osc.start(now);
  osc.stop(now + 0.55);

  const clickedAt = performance.now();
  lastClickAt = clickedAt;
  const hue = Math.min(268, Math.max(205, hueFor(pointer.y)));

  // 2-3 rings, each with its own gap that widens as it expands, so the
  // membrane reads as breaking apart rather than a clean pop.
  const ringCount = 2 + Math.round(Math.random());
  const rings: BubbleRing[] = Array.from({ length: ringCount }, (_, i) => ({
    delay: i * 30,
    gapAngle: Math.random() * Math.PI * 2,
    gapWidth: 0.3 + Math.random() * 0.35,
    maxRadius: 16 + i * 6,
  }));

  const fragments: BubbleFragment[] = Array.from({ length: 5 }, () => ({
    angle: Math.random() * Math.PI * 2,
    dist: 14 + Math.random() * 12,
    size: 0.8 + Math.random() * 1.2,
    delay: Math.random() * 40,
  }));

  bubbles.push({ x: pointer.x, y: pointer.y, bornAt: clickedAt, hue, rings, fragments });
  recordEvent(clickedAt, "bubble", pointer.x, pointer.y);
}

function lightningCrack(speed: number): void {
  const graph = ensureAudio();
  const { ctx, master, noiseBuffer } = graph;
  const now = ctx.currentTime;
  const intensity = Math.min(1.6, speed / LIGHTNING_SPEED - 1);

  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer;
  const bandpass = ctx.createBiquadFilter();
  bandpass.type = "bandpass";
  bandpass.frequency.value = 1800 + Math.random() * 3200;
  bandpass.Q.value = 5.5;

  const gain = ctx.createGain();
  const peak = 0.45 + intensity * 0.3;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peak, now + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

  source.connect(bandpass);
  bandpass.connect(gain);
  gain.connect(master);
  source.start(now);
  source.stop(now + 0.15);

  const rumble = ctx.createOscillator();
  rumble.type = "sine";
  rumble.frequency.setValueAtTime(90, now);
  rumble.frequency.exponentialRampToValueAtTime(40, now + 0.18);
  const rumbleGain = ctx.createGain();
  rumbleGain.gain.setValueAtTime(0.18 + intensity * 0.1, now);
  rumbleGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
  rumble.connect(rumbleGain);
  rumbleGain.connect(master);
  rumble.start(now);
  rumble.stop(now + 0.2);

  flashes.push({
    x: pointer.x,
    y: pointer.y,
    bornAt: performance.now(),
    angle: Math.random() * Math.PI * 2,
    speed,
  });
  recordEvent(performance.now(), "lightning", pointer.x, pointer.y);
}

function setPointer(x: number, y: number, now: number): void {
  const elapsedMs = Math.max(4, now - (lastMoveAt || now));
  const dx = x - pointer.x;
  const dy = y - pointer.y;
  const speed = Math.hypot(dx, dy) / (elapsedMs / 1000);

  pointer.x = clamp01(x);
  pointer.y = clamp01(y);
  lastMoveAt = now;

  const life = TRAIL_LIFE_BASE_MS + clamp01(speed / TRAIL_SPEED_REF) * TRAIL_LIFE_BONUS_MS;
  trail.push({
    x: pointer.x,
    y: pointer.y,
    bornAt: now,
    speed,
    life,
    zig: (Math.random() - 0.5) * 2,
    branch: Math.random(),
  });
  while (trail.length && now - trail[0]!.bornAt > TRAIL_PRUNE_MS) trail.shift();

  // Every input source funnels through here (see applyInput below), so a
  // fast hand swipe cracks the same lightning a fast mouse swipe does.
  if (audio && speed > LIGHTNING_SPEED && now - lastLightningAt > LIGHTNING_COOLDOWN_MS) {
    lastLightningAt = now;
    lightningCrack(speed);
  }
}

function applyInput(input: InstrumentInput, now: number): void {
  if (input.active) setPointer(input.x, input.y, now);
  if (input.pinch && !pinchState[input.source]) {
    ensureAudio();
    pluckBubble();
  }
  pinchState[input.source] = input.pinch;
}

function normalisePointer(event: PointerEvent): Point {
  const rect = stage.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
  };
}

function updateKeyboardInput(dt: number, now: number): void {
  let dx = 0;
  let dy = 0;
  if (heldKeys.has("ArrowLeft")) dx -= 1;
  if (heldKeys.has("ArrowRight")) dx += 1;
  if (heldKeys.has("ArrowUp")) dy -= 1;
  if (heldKeys.has("ArrowDown")) dy += 1;
  const moving = dx !== 0 || dy !== 0;
  let x = pointer.x;
  let y = pointer.y;
  if (moving) {
    const length = Math.hypot(dx, dy) || 1;
    x = pointer.x + (dx / length) * KEY_SPEED * dt;
    y = pointer.y + (dy / length) * KEY_SPEED * dt;
  }
  applyInput({ x, y, active: moving, pinch: heldKeys.has(" "), source: "keyboard" }, now);
}

function updatePresence(dt: number, now: number): void {
  const target = now - lastMoveAt < MOVE_WINDOW_MS ? 1 : 0;
  const tau = target > presence ? PRESENCE_TAU_UP : PRESENCE_TAU_DOWN;
  presence += (target - presence) * (1 - Math.exp(-dt / tau));
}

function updateAudioParams(): void {
  if (!audio) return;
  const { ctx, osc, filter, voiceGain } = audio;
  const now = ctx.currentTime;
  osc.frequency.setTargetAtTime(currentFrequency(), now, 0.03);
  filter.frequency.setTargetAtTime(MIN_CUTOFF * Math.pow(MAX_CUTOFF / MIN_CUTOFF, pointer.x), now, 0.05);
  voiceGain.gain.setTargetAtTime(presence * BASE_VOICE_LEVEL, now, 0.09);
}

function hueFor(y: number): number {
  return 260 - y * 140; // low notes toward violet, high notes toward gold
}

function resizeStage(): void {
  const dpr = window.devicePixelRatio || 1;
  stage.width = Math.round(stage.clientWidth * dpr);
  stage.height = Math.round(stage.clientHeight * dpr);
  draw.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function render(now: number): void {
  recordFrame(now, pointer.x, pointer.y, presence);
  const width = stage.clientWidth;
  const height = stage.clientHeight;

  draw.fillStyle = "rgba(5, 4, 10, 0.16)";
  draw.fillRect(0, 0, width, height);

  // Dream: slow drifting glow, always present, inviting the first touch.
  const t = now / 1000;
  for (let i = 0; i < 3; i++) {
    const phase = t * 0.08 + i * 2.1;
    const bx = width * (0.5 + 0.32 * Math.sin(phase));
    const by = height * (0.5 + 0.28 * Math.cos(phase * 0.8));
    const gradient = draw.createRadialGradient(bx, by, 0, bx, by, Math.min(width, height) * 0.35);
    gradient.addColorStop(0, `hsla(${250 + i * 40}, 70%, 55%, 0.05)`);
    gradient.addColorStop(1, "hsla(250, 70%, 55%, 0)");
    draw.fillStyle = gradient;
    draw.fillRect(0, 0, width, height);
  }

  // Ambient mist: the motion trail, demoted to a dim background layer (see
  // AMBIENT_TRAIL_* above) so it sits under the ribbon/shadow/orb stack
  // instead of competing with it. Each segment kinks at a fixed random
  // midpoint (set once, at capture, so it doesn't strobe) and occasionally
  // throws a short branch; faster points get wider kinks and live longer.
  if (trail.length > 1) {
    draw.save();
    draw.globalCompositeOperation = "lighter";
    draw.lineCap = "round";
    draw.lineJoin = "round";
    for (let i = 1; i < trail.length; i++) {
      const prev = trail[i - 1]!;
      const cur = trail[i]!;
      const age = now - cur.bornAt;
      const life = cur.life * AMBIENT_TRAIL_LIFE;
      if (age > life) continue;
      const fade = Math.pow(clamp01(1 - age / life), 1.7);
      if (fade <= 0) continue;
      const speedFactor = clamp01(cur.speed / TRAIL_SPEED_REF);
      const hue = Math.min(268, Math.max(205, hueFor(cur.y)));

      const x0 = prev.x * width;
      const y0 = prev.y * height;
      const x1 = cur.x * width;
      const y1 = cur.y * height;
      const segDx = x1 - x0;
      const segDy = y1 - y0;
      const segLen = Math.hypot(segDx, segDy) || 1;
      const nx = -segDy / segLen;
      const ny = segDx / segLen;
      const jitter = (TRAIL_JITTER_BASE + speedFactor * TRAIL_JITTER_SPEED) * cur.zig;
      const kink1x = x0 + segDx * 0.35 + nx * jitter;
      const kink1y = y0 + segDy * 0.35 + ny * jitter;
      const kink2x = x0 + segDx * 0.68 - nx * jitter * 0.6;
      const kink2y = y0 + segDy * 0.68 - ny * jitter * 0.6;

      // Soft outer glow.
      draw.strokeStyle = `hsla(${hue}, 90%, 68%, ${fade * (0.14 + speedFactor * 0.22) * AMBIENT_TRAIL_ALPHA})`;
      draw.lineWidth = (2 + fade * (3 + speedFactor * 6)) * AMBIENT_TRAIL_WIDTH;
      draw.shadowColor = `hsla(${hue}, 95%, 72%, ${fade * 0.6 * AMBIENT_TRAIL_ALPHA})`;
      draw.shadowBlur = 5 + fade * 9;
      draw.beginPath();
      draw.moveTo(x0, y0);
      draw.lineTo(kink1x, kink1y);
      draw.lineTo(kink2x, kink2y);
      draw.lineTo(x1, y1);
      draw.stroke();

      // Bright electric core.
      draw.shadowBlur = 2 + fade * 4;
      draw.strokeStyle = `hsla(${hue + 8}, 100%, 90%, ${fade * (0.26 + speedFactor * 0.4) * AMBIENT_TRAIL_ALPHA})`;
      draw.lineWidth = (0.7 + fade * 1.6) * AMBIENT_TRAIL_WIDTH;
      draw.stroke();

      // Occasional side branch, only on quicker gestures.
      if (cur.branch > 0.72 && speedFactor > 0.25) {
        const branchLen = (8 + speedFactor * 20) * fade;
        const side = cur.zig >= 0 ? 1 : -1;
        const bx = kink1x + nx * side * branchLen + segDx * 0.2;
        const by = kink1y + ny * side * branchLen + segDy * 0.2;
        draw.shadowBlur = 5;
        draw.strokeStyle = `hsla(${hue}, 90%, 80%, ${fade * 0.32 * AMBIENT_TRAIL_ALPHA})`;
        draw.lineWidth = 0.9 * AMBIENT_TRAIL_WIDTH;
        draw.beginPath();
        draw.moveTo(kink1x, kink1y);
        draw.lineTo(bx, by);
        draw.stroke();
      }
    }
    draw.restore();
  }

  drawRibbons(draw, width, height);
  drawShadows(draw, width, height, getAudio);

  // The point itself: brighter and larger the more it is singing, with a
  // brief compress-and-rebound pulse on click for tactile feedback.
  const px = pointer.x * width;
  const py = pointer.y * height;
  const pulseAge = now - lastClickAt;
  const pulse =
    pulseAge >= 0 && pulseAge < CLICK_PULSE_MS
      ? 1 - 0.2 * Math.exp(-4 * (pulseAge / CLICK_PULSE_MS)) * Math.cos((pulseAge / CLICK_PULSE_MS) * Math.PI * 3)
      : 1;
  const glowRadius = (ORB_BASE_RADIUS + presence * ORB_PRESENCE_RADIUS) * pulse;
  const glow = draw.createRadialGradient(px, py, 0, px, py, glowRadius);
  const hue = hueFor(pointer.y);
  glow.addColorStop(0, `hsla(${hue}, 90%, 75%, ${0.15 + presence * 0.55})`);
  glow.addColorStop(1, `hsla(${hue}, 90%, 65%, 0)`);
  draw.fillStyle = glow;
  draw.beginPath();
  draw.arc(px, py, glowRadius, 0, Math.PI * 2);
  draw.fill();

  // A tracked hand gets a faint ring instead of any on-screen text — the
  // subtlest way to say "you're seen" without competing with the artwork.
  // Sized relative to the current orb glow radius, so it still tracks
  // correctly now that the orb has its own click-pulse animation.
  if (handDetected) {
    draw.beginPath();
    draw.arc(px, py, glowRadius + 6, 0, Math.PI * 2);
    draw.strokeStyle = `hsla(${hue}, 90%, 85%, 0.35)`;
    draw.lineWidth = 1;
    draw.stroke();
  }

  // Bubble burst: orb -> pressure -> membrane breaks -> fragments/rings
  // disappear. A few thin rings expand from the centre, each gap widening
  // as it grows so the ring reads as breaking apart rather than a clean
  // pop, plus a handful of small glowing fragments scattering from the edge.
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const bubble = bubbles[i];
    if (!bubble) continue;
    const age = now - bubble.bornAt;
    if (age > BUBBLE_LIFE_MS + 40) {
      bubbles.splice(i, 1);
      continue;
    }
    const bx = bubble.x * width;
    const by = bubble.y * height;

    for (const ring of bubble.rings) {
      const ringAge = age - ring.delay;
      if (ringAge < 0) continue;
      const progress = clamp01(ringAge / BUBBLE_LIFE_MS);
      const eased = 1 - Math.pow(1 - progress, 3);
      const radius = 3 + eased * ring.maxRadius;
      const alpha = (1 - progress) * 0.45;
      if (alpha <= 0) continue;
      const gap = Math.min(2.6, ring.gapWidth * (0.4 + progress * 1.6));
      const start = ring.gapAngle + gap / 2;
      const end = ring.gapAngle + Math.PI * 2 - gap / 2;
      draw.beginPath();
      draw.arc(bx, by, radius, start, end);
      draw.strokeStyle = `hsla(${bubble.hue}, 90%, 80%, ${alpha})`;
      draw.lineWidth = 1.3;
      draw.shadowColor = `hsla(${bubble.hue}, 90%, 75%, ${alpha})`;
      draw.shadowBlur = 5 * (1 - progress);
      draw.stroke();
    }

    for (const frag of bubble.fragments) {
      const fragAge = age - frag.delay;
      if (fragAge < 0) continue;
      const progress = clamp01(fragAge / BUBBLE_LIFE_MS);
      const eased = 1 - Math.pow(1 - progress, 2);
      const dist = eased * frag.dist;
      const alpha = (1 - progress) * 0.6;
      if (alpha <= 0) continue;
      const fx = bx + Math.cos(frag.angle) * dist;
      const fy = by + Math.sin(frag.angle) * dist;
      draw.beginPath();
      draw.arc(fx, fy, frag.size * (1 - progress * 0.5), 0, Math.PI * 2);
      draw.fillStyle = `hsla(${bubble.hue}, 95%, 85%, ${alpha})`;
      draw.shadowColor = `hsla(${bubble.hue}, 95%, 80%, ${alpha})`;
      draw.shadowBlur = 4;
      draw.fill();
    }
  }

  // Lightning: a fast gesture, cracking bright then gone.
  for (let i = flashes.length - 1; i >= 0; i--) {
    const flash = flashes[i];
    if (!flash) continue;
    const age = now - flash.bornAt;
    if (age > FLASH_LIFE_MS) {
      flashes.splice(i, 1);
      continue;
    }
    drawFlash(draw, flash, age, width, height);
  }
}

// Hand tracking as a third input source — see hand.ts. It only produces
// InstrumentInput values; everything downstream is the same audio/visual
// code pointer and keyboard already drive via applyInput.
const handVideo = document.querySelector<HTMLVideoElement>("#hand-video");
const handToggle = document.querySelector<HTMLButtonElement>("#hand-toggle");

async function startHandControl(): Promise<void> {
  if (!handVideo || !handToggle) return;
  handToggle.textContent = "STARTING CAMERA…";
  try {
    const controller = new HandController(handVideo);
    await controller.start();
    handController = controller;
    handEnabled = true;
    handToggle.setAttribute("aria-pressed", "true");
    handToggle.textContent = "HAND CONTROL · ON";
  } catch {
    handController = null;
    handEnabled = false;
    handToggle.setAttribute("aria-pressed", "false");
    handToggle.textContent = "CAMERA UNAVAILABLE";
    setTimeout(() => {
      if (!handEnabled) handToggle.textContent = "HAND CONTROL";
    }, 2600);
  }
}

function stopHandControl(): void {
  handController?.stop();
  handController = null;
  handEnabled = false;
  handDetected = false;
  pinchState.hand = false;
  if (handToggle) {
    handToggle.setAttribute("aria-pressed", "false");
    handToggle.textContent = "HAND CONTROL";
  }
}

handToggle?.addEventListener("click", () => {
  if (handEnabled) stopHandControl();
  else void startHandControl();
});

function updateHandInput(now: number, dt: number): void {
  if (!handEnabled || !handController) {
    handDetected = false;
    return;
  }
  const poll: HandPoll = handController.poll(now, dt);
  handDetected = poll.handPresent;
  if (handToggle) {
    handToggle.textContent = poll.handPresent ? "HAND CONTROL · ON" : "NO HAND DETECTED";
  }
  applyInput(poll.input, now);
}

function frame(now: number): void {
  const dt = lastFrameAt ? Math.min(0.05, (now - lastFrameAt) / 1000) : 0;
  lastFrameAt = now;
  updateKeyboardInput(dt, now);
  updateHandInput(now, dt);
  updatePresence(dt, now);
  updateAudioParams();
  render(now);
  requestAnimationFrame(frame);
}

stage.addEventListener("pointerdown", (event) => {
  stage.setPointerCapture(event.pointerId);
  const { x, y } = normalisePointer(event);
  applyInput({ x, y, active: true, pinch: true, source: "pointer" }, performance.now());
});

stage.addEventListener("pointermove", (event) => {
  const { x, y } = normalisePointer(event);
  applyInput({ x, y, active: true, pinch: (event.buttons & 1) === 1, source: "pointer" }, performance.now());
});

stage.addEventListener("pointerup", (event) => {
  if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
  applyInput({ x: pointer.x, y: pointer.y, active: false, pinch: false, source: "pointer" }, performance.now());
});

window.addEventListener("keydown", (event) => {
  if (event.key.startsWith("Arrow")) {
    heldKeys.add(event.key);
    event.preventDefault();
  } else if (event.key === " ") {
    heldKeys.add(" ");
    event.preventDefault();
  }
});

window.addEventListener("keyup", (event) => {
  heldKeys.delete(event.key);
});

window.addEventListener("resize", resizeStage);

resizeStage();
requestAnimationFrame(frame);
