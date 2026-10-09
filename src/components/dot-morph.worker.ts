import { createMorphCore, type DrawingContext, type MorphMessage } from "./dot-morph-engine";

/**
 * The hero's dots in a worker: the canvas the page handed over, drawn every frame by the same engine the page would
 * run, so the desk's own thread is free for presses and typing. Nothing here touches the page or the network.
 */
type Start = { kind: "start"; canvas: OffscreenCanvas; shapes: string[]; still: boolean; hidden: boolean };
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Start | MorphMessage>) => void) | null;
  requestAnimationFrame?: (callback: (now: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
};

let receive: ((message: MorphMessage) => void) | undefined;

scope.onmessage = (event) => {
  const message = event.data;
  if (message.kind === "start") {
    const context = message.canvas.getContext("2d") as unknown as DrawingContext | null;
    if (!context) return;
    // Workers that draw on a handed-over canvas have animation frames (Baseline since March 2023); a timer at the
    // display's usual rate stands in elsewhere.
    const frame = scope.requestAnimationFrame ? (callback: (now: number) => void) => scope.requestAnimationFrame!(callback) : (callback: (now: number) => void) => setTimeout(() => callback(performance.now()), 1000 / 60) as unknown as number;
    const cancel = scope.cancelAnimationFrame ? (handle: number) => scope.cancelAnimationFrame!(handle) : (handle: number) => clearTimeout(handle);
    receive = createMorphCore({ canvas: message.canvas, context, frame, cancel, now: () => performance.now() }, message.shapes, { still: message.still, hidden: message.hidden }).receive;
    return;
  }
  receive?.(message);
};
