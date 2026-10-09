import { useEffect, useRef } from "react";
import { DotIcon } from "./DotIcon";
import { createMorphCore, type MorphLayout, type MorphMessage, type Sprite, type Sprites, type Target } from "./dot-morph-engine";
import "./dot-morph.css";

/**
 * The hero: a field of dots that gathers into a shape and changes from one shape into the next ($ and € on the home page
 * and the desk, the asset being typed, a lock on the vault pages). Dots at the edge of a shape are smaller than the dots
 * inside it. Dots that are disturbed show the binary digits behind them: the cursor pushes them aside and decodes them, a
 * click or tap sends a ripple and moves on to the next shape, and a light scan passes through each shape once. It is
 * decorative and hidden from assistive technology; the heading under it says what the page is for.
 *
 * Ambient motion (the shape cycle, the drift and the scan) stops when animations are paused and runs only while the
 * hero is on screen. Reduced motion keeps the dots still: shapes change in place and the cursor only lights them up.
 *
 * The dots move and are drawn by `dot-morph-engine.ts`. Where the browser can hand a canvas to a worker, they run in
 * one, every frame as before, so the desk's presses never wait behind them; elsewhere they run here on the page. This
 * page measures the hero, reads its colors, draws its sprites and samples its shapes, since those need its styles and
 * fonts, and passes on the pointer, the theme and the motion switches.
 */

/** Shapes that are drawn rather than typed, in a 24-unit box. */
const ICONS: Record<string, (g: CanvasRenderingContext2D) => void> = {
  lock(g) {
    g.lineWidth = 2.6;
    g.lineCap = "round";
    g.stroke(new Path2D("M7.5 11V7.6a4.5 4.5 0 0 1 9 0V11"));
    g.fill(new Path2D("M5.2 10.4h13.6a2.2 2.2 0 0 1 2.2 2.2v7.6a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 20.2v-7.6a2.2 2.2 0 0 1 2.2-2.2Z"));
    g.globalCompositeOperation = "destination-out";
    g.beginPath();
    g.arc(12, 15.3, 1.9, 0, Math.PI * 2);
    g.fill();
    g.fillRect(11.15, 15.8, 1.7, 3.4);
    g.globalCompositeOperation = "source-over";
  },
};

/**
 * The lattice cells a shape covers, with how much of each cell is ink: drawn four times larger, then each cell is kept
 * when it is mostly ink.
 */
function sampleShape(shape: string, cols: number, rows: number, font: string): Array<[number, number, number]> {
  const scale = 4;
  const sheet = document.createElement("canvas");
  sheet.width = cols * scale;
  sheet.height = rows * scale;
  const g = sheet.getContext("2d", { willReadFrequently: true });
  if (!g) return [];
  g.fillStyle = "#000";
  g.strokeStyle = "#000";
  const icon = ICONS[shape];
  if (icon) {
    const size = sheet.height * 0.9;
    const unit = size / 24;
    g.setTransform(unit, 0, 0, unit, (sheet.width - size) / 2, (sheet.height - size) / 2);
    icon(g);
    g.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    let size = sheet.height * 0.86;
    g.font = `700 ${size}px ${font}`;
    const width = g.measureText(shape).width;
    if (width > sheet.width * 0.9) size *= (sheet.width * 0.9) / width;
    g.font = `700 ${size}px ${font}`;
    const metrics = g.measureText(shape);
    let ascent = metrics.actualBoundingBoxAscent;
    let descent = metrics.actualBoundingBoxDescent;
    const height = ascent + descent;
    // Tall glyphs ($ has strokes above and below the letter) are scaled down to fit the box.
    if (height > sheet.height * 0.9) {
      size *= (sheet.height * 0.9) / height;
      g.font = `700 ${size}px ${font}`;
      const fitted = g.measureText(shape);
      ascent = fitted.actualBoundingBoxAscent;
      descent = fitted.actualBoundingBoxDescent;
    }
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    g.fillText(shape, sheet.width / 2, sheet.height / 2 + (ascent - descent) / 2);
  }
  const data = g.getImageData(0, 0, sheet.width, sheet.height).data;
  const cells: Array<[number, number, number]> = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let ink = 0;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) ink += data[((row * scale + y) * sheet.width + col * scale + x) * 4 + 3];
      }
      const covered = ink / (scale * scale * 255);
      if (covered > 0.42) cells.push([col, row, covered]);
    }
  }
  return cells;
}

/** Starts the hero's engine in a worker that draws on this canvas, when the browser can; undefined otherwise. */
function startWorker(canvas: HTMLCanvasElement, shapes: string[], initial: { still: boolean; hidden: boolean }) {
  if (typeof Worker !== "function" || typeof OffscreenCanvas !== "function" || !("transferControlToOffscreen" in canvas)) return undefined;
  let worker: Worker | undefined;
  try {
    worker = new Worker(new URL("./dot-morph.worker.ts", import.meta.url), { type: "module" });
    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage({ kind: "start", canvas: offscreen, shapes, ...initial }, [offscreen]);
    return worker;
  } catch {
    worker?.terminate();
    return undefined;
  }
}

/** The bitmaps a message hands to the worker, so they move instead of being copied. */
function bitmapsOf(message: MorphMessage): Transferable[] {
  if (!("sprites" in message)) return [];
  const { field, fieldHot, dot, dotHot, digits, digitsHot } = message.sprites;
  return [field, fieldHot, dot, dotHot, ...digits, ...digitsHot].map((sprite) => sprite.image).filter((image): image is ImageBitmap => typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap);
}

function createEngine(wrap: HTMLDivElement, canvas: HTMLCanvasElement, shapes: string[]) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const shell = wrap.closest(".shell");
  const worker = startWorker(canvas, shapes, { still: reduced.matches, hidden: document.hidden });
  let receive: ((message: MorphMessage) => void) | undefined;
  if (!worker) {
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    receive = createMorphCore({ canvas, context, frame: (callback) => requestAnimationFrame(callback), cancel: (handle) => cancelAnimationFrame(handle), now: () => performance.now() }, shapes, { still: reduced.matches, hidden: document.hidden }).receive;
  }
  const send = (message: MorphMessage) => (worker ? worker.postMessage(message, bitmapsOf(message)) : receive?.(message));

  let layout: (MorphLayout & { cols: number; rows: number }) | undefined;
  let focus: string | undefined;
  let destroyed = false;
  let palette = "";
  let followUntil = 0;
  let followFrame = 0;
  const cache = new Map<string, Target[]>();

  const dotRadius = () => (layout?.pitch ?? 6) * 0.31;

  /** A sprite at the hero's pixel ratio: a canvas on the page, a bitmap for the worker. */
  function sprite(size: number, radius: number, draw: (g: CanvasRenderingContext2D) => void): Sprite {
    const dpr = layout?.dpr ?? 1;
    const side = Math.max(1, Math.ceil(size * dpr));
    if (worker) {
      const sheet = new OffscreenCanvas(side, side);
      const g = sheet.getContext("2d") as unknown as CanvasRenderingContext2D | null;
      if (g) {
        g.scale(dpr, dpr);
        draw(g);
      }
      return { image: sheet.transferToImageBitmap(), size, radius };
    }
    const sheet = document.createElement("canvas");
    sheet.width = sheet.height = side;
    const g = sheet.getContext("2d");
    if (g) {
      g.scale(dpr, dpr);
      draw(g);
    }
    return { image: sheet, size, radius };
  }

  /** Colors come from the theme and the network, and cross-fade with them; undefined while they are unchanged. */
  function readPalette(force = false): Sprites | undefined {
    const style = getComputedStyle(canvas);
    const glyph = style.getPropertyValue("--dot-glyph").trim() || "#8E9BFF";
    const hot = style.getPropertyValue("--dot-hot").trim() || "#EDEFF2";
    const base = style.getPropertyValue("--dot-base").trim() || "#353A42";
    const mono = style.getPropertyValue("--font-mono").trim() || "monospace";
    const pitch = layout?.pitch ?? 6;
    const key = [glyph, hot, base, mono, layout?.dpr ?? 1, pitch].join("|");
    if (key === palette && !force) return undefined;
    palette = key;
    const dot = (color: string, radius: number) => sprite(radius * 2 + 2, radius, (g) => {
      g.fillStyle = color;
      g.beginPath();
      g.arc(radius + 1, radius + 1, radius, 0, Math.PI * 2);
      g.fill();
    });
    const digitBox = Math.round(pitch * 1.75);
    const digit = (color: string, value: string) => sprite(digitBox, digitBox / 2, (g) => {
      g.fillStyle = color;
      g.font = `600 ${Math.round(digitBox * 0.84)}px ${mono}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(value, digitBox / 2, digitBox / 2 + 0.5);
    });
    return {
      field: dot(base, 0.95),
      fieldHot: dot(glyph, 1.25),
      dot: dot(glyph, dotRadius()),
      dotHot: dot(hot, dotRadius()),
      digits: ["0", "1"].map((value) => digit(glyph, value)),
      digitsHot: ["0", "1"].map((value) => digit(hot, value)),
    };
  }

  function targets(shape: string) {
    let points = cache.get(shape);
    if (!points && layout) {
      const { cols, rows, ox, oy, pitch } = layout;
      const font = getComputedStyle(canvas).fontFamily || "sans-serif";
      // A cell the shape only partly covers gets a smaller dot, so the outline reads smooth.
      points = sampleShape(shape, cols, rows, font).map(([col, row, covered]) => ({
        x: ox + col * pitch + pitch / 2,
        y: oy + row * pitch + pitch / 2,
        r: dotRadius() * (0.62 + 0.38 * Math.min(1, (covered - 0.42) / 0.5)),
      }));
      cache.set(shape, points);
    }
    return points ?? [];
  }

  /** Every shape the engine may turn into next: the cycle and the shape the page asks for. */
  const shapeTargets = () => Object.fromEntries([...new Set([...shapes, ...(focus ? [focus] : [])])].map((shape) => [shape, targets(shape)]));

  function resize() {
    const rect = wrap.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 24) return;
    const width = rect.width;
    const height = rect.height;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pitch = width < 560 ? 5 : 6;
    const cols = Math.floor(width / pitch);
    const rows = Math.floor(height / pitch);
    layout = { width, height, dpr, pitch, cols, rows, ox: (width - cols * pitch) / 2, oy: (height - rows * pitch) / 2 };
    cache.clear();
    const sprites = readPalette(true)!;
    send({ kind: "layout", layout, targets: shapeTargets(), sprites });
  }

  /** While the theme cross-fades, its colors are read every frame and the sprites follow them. */
  function followColors() {
    followFrame = 0;
    if (destroyed) return;
    const sprites = layout ? readPalette() : undefined;
    if (sprites) send({ kind: "sprites", sprites });
    if (performance.now() < followUntil) followFrame = requestAnimationFrame(followColors);
  }

  function place(event: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    send({ kind: "pointer", x: event.clientX - rect.left, y: event.clientY - rect.top });
  }
  function leave() {
    send({ kind: "leave" });
  }
  function press(event: PointerEvent) {
    if (event.target instanceof Element && event.target.closest("button")) return;
    const rect = canvas.getBoundingClientRect();
    send({ kind: "press", x: event.clientX - rect.left, y: event.clientY - rect.top });
  }
  function release(event: PointerEvent) {
    if (event.pointerType !== "mouse") leave();
  }

  wrap.addEventListener("pointermove", place);
  wrap.addEventListener("pointerdown", press);
  wrap.addEventListener("pointerup", release);
  wrap.addEventListener("pointerleave", leave);
  wrap.addEventListener("pointercancel", leave);
  const resizer = new ResizeObserver(() => resize());
  resizer.observe(wrap);
  const watcher = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(([entry]) => {
    send({ kind: "visible", on: Boolean(entry?.isIntersecting) });
  }, { threshold: 0.05 });
  watcher?.observe(wrap);
  const colors = new MutationObserver(() => {
    followUntil = performance.now() + 700;
    send({ kind: "followColors" });
    if (!followFrame) followFrame = requestAnimationFrame(followColors);
  });
  colors.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  if (shell) colors.observe(shell, { attributes: true, attributeFilter: ["data-network-theme"] });
  const onVisibility = () => send({ kind: "hidden", on: document.hidden });
  document.addEventListener("visibilitychange", onVisibility);
  const onReducedChange = () => send({ kind: "reduced", on: reduced.matches });
  reduced.addEventListener("change", onReducedChange);

  // Shapes are measured in the interface face and digits drawn in the mono face; measure again once they load.
  const loadFonts = async () => {
    const style = getComputedStyle(canvas);
    await Promise.all([
      document.fonts.load(`700 64px ${style.fontFamily}`, shapes.join("")),
      document.fonts.load(`600 12px ${style.getPropertyValue("--font-mono").trim() || "monospace"}`, "01"),
    ]);
  };
  void loadFonts().catch(() => undefined).then(() => document.fonts.ready).then(() => {
    if (destroyed || !layout) return;
    cache.clear();
    send({ kind: "refresh", targets: shapeTargets(), sprites: readPalette(true)! });
  });

  return {
    setMotion(next: boolean) {
      send({ kind: "motion", on: next });
    },
    setFocus(next: string | undefined) {
      if (next === focus) return;
      focus = next;
      if (next && layout) send({ kind: "targets", shape: next, points: targets(next) });
      send({ kind: "focus", shape: next });
    },
    destroy() {
      destroyed = true;
      send({ kind: "destroy" });
      worker?.terminate();
      if (followFrame) cancelAnimationFrame(followFrame);
      wrap.removeEventListener("pointermove", place);
      wrap.removeEventListener("pointerdown", press);
      wrap.removeEventListener("pointerup", release);
      wrap.removeEventListener("pointerleave", leave);
      wrap.removeEventListener("pointercancel", leave);
      resizer.disconnect();
      watcher?.disconnect();
      colors.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      reduced.removeEventListener("change", onReducedChange);
    },
  };
}

export function DotMorph({ shapes, focus, motion, onToggleMotion, className = "" }: {
  /** Shapes the idle cycle moves through: text in the interface face, or a drawn icon ("lock"). */
  shapes: string[];
  /** A shape the page asks for, such as the asset being typed; it holds until it clears. */
  focus?: string;
  motion: boolean;
  onToggleMotion: () => void;
  className?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const engine = useRef<ReturnType<typeof createEngine>>();
  const key = shapes.join("\n");
  useEffect(() => {
    const host = wrap.current;
    if (!host) return;
    // Each engine gets a canvas of its own: one handed to a worker can never be drawn on from the page again, and
    // React may start an engine twice on the same element.
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    host.prepend(canvas);
    const created = createEngine(host, canvas, key.split("\n"));
    engine.current = created;
    return () => {
      created?.destroy();
      engine.current = undefined;
      canvas.remove();
    };
  }, [key]);
  useEffect(() => engine.current?.setMotion(motion), [motion, key]);
  // Partial tickers match while someone types ("AA" on the way to "AAPL"), so the shape follows a short pause.
  useEffect(() => {
    const timer = window.setTimeout(() => engine.current?.setFocus(focus), 220);
    return () => window.clearTimeout(timer);
  }, [focus, key]);
  return <div className={`dot-morph ${className}`} ref={wrap}>
    <button type="button" className="dot-morph-pause" onClick={onToggleMotion} aria-pressed={!motion} aria-label={motion ? "Pause animations" : "Play animations"} title={motion ? "Pause animations" : "Play animations"}>
      <DotIcon name={motion ? "pause" : "play"} size={14} />
    </button>
  </div>;
}
