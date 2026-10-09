import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createMorphCore, type MorphLayout, type Sprite, type Sprites, type Target } from "../src/components/dot-morph-engine";

/** A canvas that only counts what is drawn, and frames that run when the test says so. */
function fakeSurface() {
  const drawn: number[] = [];
  let frames = new Map<number, (now: number) => void>();
  let handle = 0;
  let clock = 1_000;
  const surface = {
    canvas: { width: 0, height: 0 },
    context: { setTransform() {}, clearRect() { drawn.push(0); }, drawImage() { drawn[drawn.length - 1] = (drawn[drawn.length - 1] ?? 0) + 1; }, globalAlpha: 1 } as never,
    frame(callback: (now: number) => void) { frames.set(++handle, callback); return handle; },
    cancel(id: number) { frames.delete(id); },
    now: () => clock,
  };
  const run = (milliseconds = 16) => {
    clock += milliseconds;
    const due = frames;
    frames = new Map();
    for (const callback of due.values()) callback(clock);
    return due.size;
  };
  return { surface, drawn, run, pending: () => frames.size };
}

const sprite = (size: number): Sprite => ({ image: {} as CanvasImageSource, size, radius: size / 2 });
const sprites: Sprites = { field: sprite(4), fieldHot: sprite(5), dot: sprite(5), dotHot: sprite(5), digits: [sprite(10), sprite(10)], digitsHot: [sprite(10), sprite(10)] };
const layout: MorphLayout = { width: 300, height: 120, dpr: 2, pitch: 6, ox: 0, oy: 0 };
const square = (x: number): Target[] => Array.from({ length: 16 }, (_, index) => ({ x: x + (index % 4) * 6, y: 40 + Math.floor(index / 4) * 6, r: 1.8 }));

/**
 * The hero's engine: the same motion and drawing on the page or in a worker, so the
 * user's "$" keeps every frame while the desk's own thread stays free for presses.
 */
describe("the hero's dot engine", () => {
  it("lays the canvas out at the pixel ratio and draws the shape at once", () => {
    const { surface, drawn } = fakeSurface();
    const core = createMorphCore(surface, ["$", "€"], { still: false, hidden: false });
    core.receive({ kind: "layout", layout, targets: { "$": square(100), "€": square(200) }, sprites });
    assert.deepEqual(surface.canvas, { width: 600, height: 240 });
    assert.ok(drawn.length >= 1 && drawn[drawn.length - 1] > 16, "the field and the first shape's dots are drawn in the same call");
  });

  it("keeps drawing every frame while the dots move, and stops only when they rest out of sight", () => {
    const { surface, drawn, run, pending } = fakeSurface();
    const core = createMorphCore(surface, ["$", "€"], { still: false, hidden: false });
    core.receive({ kind: "layout", layout, targets: { "$": square(100), "€": square(200) }, sprites });
    const before = drawn.length;
    for (let frame = 0; frame < 30; frame++) assert.equal(run(), 1, `frame ${frame} is drawn`);
    assert.equal(drawn.length - before, 30, "one drawing per frame, no frame skipped");
    core.receive({ kind: "visible", on: false });
    for (let frame = 0; frame < 3; frame++) run();
    assert.equal(pending(), 0, "nothing runs while the hero is off screen");
    core.receive({ kind: "visible", on: true });
    assert.equal(pending(), 1, "and it starts again when it comes back");
  });

  it("answers the pointer and a press: the dots wake, a press moves on to the next shape", () => {
    const { surface, run, pending } = fakeSurface();
    const core = createMorphCore(surface, ["$", "€"], { still: true, hidden: false });
    core.receive({ kind: "layout", layout, targets: { "$": square(100), "€": square(200) }, sprites });
    while (pending()) run();
    core.receive({ kind: "pointer", x: 110, y: 50 });
    assert.equal(pending(), 1);
    core.receive({ kind: "press", x: 110, y: 50 });
    assert.ok(pending() >= 1);
    core.receive({ kind: "destroy" });
    assert.equal(pending(), 0, "destroying cancels the next frame");
  });

  it("runs in a worker on the canvas handed to it, with the page's code as the fallback", async () => {
    const [host, worker, engine] = await Promise.all([
      readFile(new URL("../src/components/DotMorph.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/components/dot-morph.worker.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/components/dot-morph-engine.ts", import.meta.url), "utf8"),
    ]);
    assert.match(host, /new Worker\(new URL\("\.\/dot-morph\.worker\.ts", import\.meta\.url\), \{ type: "module" \}\)/);
    assert.match(host, /const offscreen = canvas\.transferControlToOffscreen\(\);/);
    assert.match(host, /receive = createMorphCore\(\{ canvas, context, frame: \(callback\) => requestAnimationFrame\(callback\)/, "the page runs the same engine when it cannot hand the canvas over");
    assert.match(host, /const canvas = document\.createElement\("canvas"\);/, "each engine gets its own canvas");
    assert.match(worker, /receive = createMorphCore\(\{ canvas: message\.canvas, context, frame, cancel, now: \(\) => performance\.now\(\) \}/);
    assert.doesNotMatch(worker, /fetch\(|importScripts|document\./, "the worker only draws");
    // The motion is the hero's own: the same constants and no frame skipped or held back for the page.
    assert.match(engine, /const HOLD = 4600;\nconst SCAN_DELAY = 1900;\nconst SCAN_TIME = 1100;\nconst RIPPLE_LIFE = 1000;\nconst RIPPLE_SPEED = 0\.42;/);
    assert.doesNotMatch(engine + host, /yieldUntil|calm|YIELD_MS/);
  });
});
