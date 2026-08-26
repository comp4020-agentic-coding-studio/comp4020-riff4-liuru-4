// Hand tracking as a third input source for the instrument. This module
// knows about webcams and MediaPipe; it produces InstrumentInput values and
// nothing else — no audio, no drawing, no bubble/lightning logic of its own.
import {
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import type { InstrumentInput } from "./main";

// Pinned version, not @latest — a CDN pointing at a moving target would
// change behaviour under us without a commit. Only these static asset files
// come from the network; camera frames never leave the browser.
const VISION_WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const DETECT_INTERVAL_MS = 80; // ~12Hz inference; rendering stays at rAF speed
const HAND_LOST_TIMEOUT_MS = 400;
const SMOOTH_TAU = 0.08; // seconds; same exponential-smoothing shape as `presence`
const MOVE_EPSILON = 0.004; // normalised units below which movement counts as noise, not intent
const PINCH_ENTER = 0.055;
const PINCH_EXIT = 0.08;

// Landmark indices from the MediaPipe hand model.
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const RING_MCP = 13;
const PINKY_MCP = 17;
const PALM_LANDMARKS = [WRIST, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP];

export interface HandPoll {
  input: InstrumentInput;
  handPresent: boolean;
}

function palmCenter(landmarks: NormalizedLandmark[]): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const index of PALM_LANDMARKS) {
    const landmark = landmarks[index];
    if (!landmark) continue;
    x += landmark.x;
    y += landmark.y;
  }
  return { x: x / PALM_LANDMARKS.length, y: y / PALM_LANDMARKS.length };
}

function pinchDistance(landmarks: NormalizedLandmark[]): number {
  const thumb = landmarks[THUMB_TIP];
  const index = landmarks[INDEX_TIP];
  if (!thumb || !index) return Infinity;
  return Math.hypot(thumb.x - index.x, thumb.y - index.y);
}

export class HandController {
  private video: HTMLVideoElement;
  private landmarker: HandLandmarker | null = null;
  private stream: MediaStream | null = null;

  private lastDetectAt = 0;
  private lastLandmarks: NormalizedLandmark[] | null = null;
  private lastSeenAt = -Infinity;

  private smoothed: { x: number; y: number } | null = null;
  private committed: { x: number; y: number } | null = null;
  private pinching = false;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, facingMode: "user" },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    const vision = await FilesetResolver.forVisionTasks(VISION_WASM_URL);
    try {
      this.landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 1,
      });
    } catch {
      this.landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: "CPU" },
        runningMode: "VIDEO",
        numHands: 1,
      });
    }
  }

  stop(): void {
    this.landmarker?.close();
    this.landmarker = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.video.srcObject = null;
    this.lastLandmarks = null;
    this.smoothed = null;
    this.committed = null;
    this.pinching = false;
  }

  poll(now: number, dt: number): HandPoll {
    if (this.landmarker && this.video.readyState >= 2 && now - this.lastDetectAt >= DETECT_INTERVAL_MS) {
      this.lastDetectAt = now;
      const result = this.landmarker.detectForVideo(this.video, now);
      const hand = result.landmarks[0];
      if (hand) {
        this.lastLandmarks = hand;
        this.lastSeenAt = now;
      }
    }

    const handPresent = now - this.lastSeenAt < HAND_LOST_TIMEOUT_MS;
    const landmarks = handPresent ? this.lastLandmarks : null;

    if (!landmarks) {
      this.smoothed = null;
      this.committed = null;
      this.pinching = false;
      return { input: { x: 0, y: 0, active: false, pinch: false, source: "hand" }, handPresent };
    }

    const raw = palmCenter(landmarks);
    const mirroredX = 1 - raw.x; // undo the selfie-camera mirror: hand-left moves the cursor left
    if (!this.smoothed) this.smoothed = { x: mirroredX, y: raw.y };
    const factor = 1 - Math.exp(-dt / SMOOTH_TAU);
    this.smoothed.x += (mirroredX - this.smoothed.x) * factor;
    this.smoothed.y += (raw.y - this.smoothed.y) * factor;

    let active = false;
    if (!this.committed) {
      this.committed = { x: this.smoothed.x, y: this.smoothed.y };
      active = true;
    } else {
      const moved = Math.hypot(this.smoothed.x - this.committed.x, this.smoothed.y - this.committed.y);
      if (moved > MOVE_EPSILON) {
        this.committed.x = this.smoothed.x;
        this.committed.y = this.smoothed.y;
        active = true;
      }
    }

    const distance = pinchDistance(landmarks);
    if (this.pinching) {
      if (distance > PINCH_EXIT) this.pinching = false;
    } else if (distance < PINCH_ENTER) {
      this.pinching = true;
    }

    return {
      input: {
        x: this.committed?.x ?? this.smoothed.x,
        y: this.committed?.y ?? this.smoothed.y,
        active,
        pinch: this.pinching,
        source: "hand",
      },
      handPresent,
    };
  }
}
