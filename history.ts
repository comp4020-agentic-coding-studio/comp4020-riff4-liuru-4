// Ring-buffer history of the pointer's recent path — the one source of
// truth for anything that needs to look back in time (trailing ribbons,
// delayed shadows). Fixed-size arrays, mutated in place, no push/shift.

export type HistoryEventType = "bubble" | "lightning";

export interface Frame {
  t: number;
  x: number;
  y: number;
  presence: number;
}

export interface HistoryEvent {
  t: number;
  type: HistoryEventType;
  x: number;
  y: number;
}

const FRAME_CAPACITY = 1440; // 12s of history at up to ~120fps
const EVENT_CAPACITY = 64;

const frames: Frame[] = Array.from({ length: FRAME_CAPACITY }, () => ({
  t: -Infinity,
  x: 0.5,
  y: 0.42,
  presence: 0,
}));
let frameHead = 0;
let frameCount = 0;

const events: HistoryEvent[] = Array.from({ length: EVENT_CAPACITY }, () => ({
  t: -Infinity,
  type: "bubble" as HistoryEventType,
  x: 0.5,
  y: 0.42,
}));
let eventHead = 0;
let eventCount = 0;

export function recordFrame(t: number, x: number, y: number, presence: number): void {
  const slot = frames[frameHead];
  slot.t = t;
  slot.x = x;
  slot.y = y;
  slot.presence = presence;
  frameHead = (frameHead + 1) % FRAME_CAPACITY;
  frameCount = Math.min(frameCount + 1, FRAME_CAPACITY);
}

export function recordEvent(t: number, type: HistoryEventType, x: number, y: number): void {
  const slot = events[eventHead];
  slot.t = t;
  slot.type = type;
  slot.x = x;
  slot.y = y;
  eventHead = (eventHead + 1) % EVENT_CAPACITY;
  eventCount = Math.min(eventCount + 1, EVENT_CAPACITY);
}

function frameAt(stepsBack: number): Frame {
  const idx = (frameHead - 1 - stepsBack + FRAME_CAPACITY * 2) % FRAME_CAPACITY;
  return frames[idx];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// The interpolated frame `delaySeconds` behind the most recently recorded
// one, or null once no frame has ever been recorded.
export function sample(delaySeconds: number): Frame | null {
  if (frameCount === 0) return null;
  const latest = frameAt(0);
  const targetT = latest.t - delaySeconds * 1000;

  let after = latest;
  for (let back = 1; back < frameCount; back++) {
    const before = frameAt(back);
    if (before.t <= targetT) {
      const span = after.t - before.t;
      const ratio = span > 0 ? clamp01((targetT - before.t) / span) : 0;
      return {
        t: targetT,
        x: before.x + (after.x - before.x) * ratio,
        y: before.y + (after.y - before.y) * ratio,
        presence: before.presence + (after.presence - before.presence) * ratio,
      };
    }
    after = before;
  }

  const oldest = frameAt(frameCount - 1);
  return { t: oldest.t, x: oldest.x, y: oldest.y, presence: oldest.presence };
}

// Recorded events with t in [t0, t1], newest first.
export function eventsBetween(t0: number, t1: number): HistoryEvent[] {
  const found: HistoryEvent[] = [];
  for (let back = 0; back < eventCount; back++) {
    const idx = (eventHead - 1 - back + EVENT_CAPACITY * 2) % EVENT_CAPACITY;
    const event = events[idx];
    if (event.t < t0) break;
    if (event.t <= t1) found.push(event);
  }
  return found;
}
