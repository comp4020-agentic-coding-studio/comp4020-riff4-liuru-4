import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

// This week's spec (crits/04-instrument) in the parts a test can actually
// check: the built page carries no pre-recorded audio, offers an input
// surface, and doesn't gate play behind a score or fail state. Whether it is
// expressive, discoverable and fun is for the crit, not vitest.

const doc = new JSDOM(readFileSync(resolve("dist/index.html"), "utf8")).window.document;
const scriptSrc = doc.querySelector('script[type="module"]')?.getAttribute("src") ?? "";
const script = readFileSync(resolve("dist", scriptSrc), "utf8");

describe("an instrument, not a playback deck", () => {
  it("ships no <audio> element and no <video> with a playback source — sound is synthesised, not played back", () => {
    // A <video> is allowed as a live camera sink for the optional hand-control
    // input (see hand.ts) as long as it names no src to play back.
    expect(doc.querySelector("audio")).toBeNull();
    for (const video of doc.querySelectorAll("video")) {
      expect(video.hasAttribute("src")).toBe(false);
    }
  });

  it("builds its sound with the Web Audio API", () => {
    expect(script).toMatch(/AudioContext/);
  });

  it("offers a playing surface that accepts pointer input", () => {
    const stage = doc.querySelector('[data-testid="stage"]');
    expect(stage, "a canvas or similar element the player can act on").toBeTruthy();
  });

  it("names no score, level or fail state in the shipped markup", () => {
    const text = doc.body.textContent?.toLowerCase() ?? "";
    for (const word of ["game over", "you win", "you lose", "score:", "level "]) {
      expect(text, `found "${word}" — this instrument should have no fail state`).not.toContain(word);
    }
  });
});
