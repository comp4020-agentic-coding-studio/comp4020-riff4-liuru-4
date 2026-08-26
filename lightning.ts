// Lightning, upgraded: a branching bolt drawn in two passes (a wide soft
// glow, then a thin bright core), with speed above the trigger threshold
// stretching its reach and fork count.

export interface FlashLike {
  x: number;
  y: number;
  bornAt: number;
  angle: number;
  speed: number;
}

interface BoltPoint {
  x: number;
  y: number;
}

function buildBolt(
  x0: number,
  y0: number,
  angle0: number,
  segments: number,
  stepLength: number,
  wobble: number,
): BoltPoint[] {
  const points: BoltPoint[] = [{ x: x0, y: y0 }];
  let x = x0;
  let y = y0;
  let angle = angle0;
  for (let i = 0; i < segments; i++) {
    angle += (Math.random() - 0.5) * wobble;
    x += Math.cos(angle) * stepLength;
    y += Math.sin(angle) * stepLength;
    points.push({ x, y });
  }
  return points;
}

function strokeBolt(ctx: CanvasRenderingContext2D, points: BoltPoint[]): void {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
}

function envelope(age: number): number {
  const holdMs = 60;
  if (age <= holdMs) return 1;
  const decay = (age - holdMs) / (220 - holdMs);
  return Math.max(0, 1 - Math.pow(decay, 0.6));
}

export function drawFlash(
  ctx: CanvasRenderingContext2D,
  flash: FlashLike,
  age: number,
  width: number,
  height: number,
): void {
  const alpha = envelope(age);
  if (alpha <= 0) return;

  const intensity = Math.min(1.6, flash.speed / 5);
  const segments = 6 + Math.round(Math.random() * 2); // 6-8
  const stepLength = 15 + intensity * 9;
  const extraForks = Math.round(Math.min(2, Math.max(0, intensity - 0.9)));
  const forkCount = 2 + extraForks;
  const fx = flash.x * width;
  const fy = flash.y * height;

  const trunk = buildBolt(fx, fy, flash.angle, segments, stepLength, 1.1);
  const forks: BoltPoint[][] = [];
  for (let f = 0; f < forkCount; f++) {
    const forkStart = Math.min(1 + Math.floor(Math.random() * Math.max(1, segments - 2)), trunk.length - 1);
    const anchor = trunk[forkStart];
    const forkAngle = flash.angle + (Math.random() - 0.5) * 1.6;
    forks.push(buildBolt(anchor.x, anchor.y, forkAngle, 3 + Math.round(Math.random()), stepLength * 0.6, 1.5));
  }

  if (age < 24) {
    ctx.fillStyle = `rgba(255, 255, 255, ${0.12 * alpha})`;
    ctx.fillRect(0, 0, width, height);
  }

  const previousComposite = ctx.globalCompositeOperation;

  ctx.globalCompositeOperation = "lighter";
  ctx.lineWidth = Math.min(10, 8 + intensity * 1.25);
  ctx.strokeStyle = `hsla(195, 100%, 88%, ${alpha * 0.3})`;
  strokeBolt(ctx, trunk);
  for (const fork of forks) strokeBolt(ctx, fork);

  ctx.globalCompositeOperation = "source-over";
  ctx.lineWidth = 2;
  ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
  strokeBolt(ctx, trunk);
  for (const fork of forks) strokeBolt(ctx, fork);

  ctx.globalCompositeOperation = previousComposite;
}
