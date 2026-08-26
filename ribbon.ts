// Neon spring trail: 24 ribbons of 20 nodes each, chasing history.sample()
// at a spread of delays. Drawn straight onto main.ts's #stage 2D context.

import { sample } from "./history";

const RIBBON_COUNT = 24;
const NODE_COUNT = 20;
const MAX_DELAY_SECONDS = 0.25;
const BASE_STIFFNESS = 0.22;
const BASE_DAMPING = 0.72;
const PALETTE = ["#f967fb", "#53bc28", "#6958d5"];

interface RibbonNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Ribbon {
  nodes: RibbonNode[];
  delayScale: number;
  stiffnessScale: number;
  color: [number, number, number];
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

const ribbons: Ribbon[] = Array.from({ length: RIBBON_COUNT }, (_, i) => ({
  nodes: Array.from({ length: NODE_COUNT }, () => ({ x: 0.5, y: 0.42, vx: 0, vy: 0 })),
  delayScale: 0.65 + Math.random() * 0.7,
  stiffnessScale: 0.75 + Math.random() * 0.5,
  color: hexToRgb(PALETTE[i % PALETTE.length]),
}));

function updateRibbon(ribbon: Ribbon, headX: number, headY: number, headPresence: number): void {
  for (let j = 0; j < ribbon.nodes.length; j++) {
    const node = ribbon.nodes[j];
    const frac = j / (ribbon.nodes.length - 1);
    const delay = frac * MAX_DELAY_SECONDS * ribbon.delayScale;
    const sampled = sample(delay);
    if (!sampled) continue;

    // Blend toward the live head as presence fades, so idle ribbons gather
    // back onto the point instead of hanging on stale history.
    const targetX = headX + (sampled.x - headX) * headPresence;
    const targetY = headY + (sampled.y - headY) * headPresence;

    const stiffness = BASE_STIFFNESS * ribbon.stiffnessScale * (1 - frac * 0.65);
    const damping = BASE_DAMPING * (1 - frac * 0.22);
    node.vx = (node.vx + (targetX - node.x) * stiffness) * damping;
    node.vy = (node.vy + (targetY - node.y) * stiffness) * damping;
    node.x += node.vx;
    node.y += node.vy;
  }
}

function paintRibbon(ctx: CanvasRenderingContext2D, ribbon: Ribbon, width: number, height: number): void {
  const [r, g, b] = ribbon.color;
  for (let j = 0; j < ribbon.nodes.length - 1; j++) {
    const a = ribbon.nodes[j];
    const c = ribbon.nodes[j + 1];
    const frac = j / (ribbon.nodes.length - 1);
    const alpha = 0.8 * (1 - frac) + 0.04;
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
    ctx.lineWidth = 3 - frac * 2.5;
    ctx.beginPath();
    ctx.moveTo(a.x * width, a.y * height);
    ctx.lineTo(c.x * width, c.y * height);
    ctx.stroke();
  }
}

export function drawRibbons(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const head = sample(0);
  if (!head) return;

  ctx.globalCompositeOperation = "lighter";
  for (const ribbon of ribbons) {
    updateRibbon(ribbon, head.x, head.y, head.presence);
    paintRibbon(ctx, ribbon, width, height);
  }
  ctx.globalCompositeOperation = "source-over";
}
