import { Fragment, useEffect, useRef, type ElementType } from "react";

/** Letters that flicker into binary digits when warm; punctuation and symbols stay as they are. */
const DECODABLE = /[a-z0-9]/i;
/** How long a pointer that has stopped keeps the letters around it warm. */
const REST_MS = 380;

/**
 * Dot-matrix text that answers the pointer like the hero's dots: letters near the pointer warm to the accent, lift a
 * little and flicker into binary digits, then settle once it moves on or rests; a click or tap sends a ripple through the
 * line, and keyboard focus on the surrounding link or button sweeps it once. The real text stays in the element for
 * assistive technology and search, and the animated letters are hidden from it. Reduced motion keeps only the warm
 * color; forced colors show the plain text.
 */
export function DotText({ text, as: Tag = "span", className, id }: { text: string; as?: ElementType; className?: string; id?: string }) {
  const host = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = host.current;
    return root ? attachDotText(root) : undefined;
  }, [text]);
  // The letters are new elements for each text: the effect's cleanup puts back the letters it found, and on elements
  // React had already given the new text it would bring the old text back ("—" would stay on a claim page after its
  // amount loaded).
  return <Tag ref={host} id={id} className={className ? `dot-text ${className}` : "dot-text"}>
    <span className="visually-hidden">{text}</span>
    <span className="dot-text-live" aria-hidden="true" key={text}>
      {text.split(" ").map((word, index) => <Fragment key={index}>{index > 0 && " "}<span className="dot-word">{[...word].map((char, at) => <span key={at} className="dot-char">{char}</span>)}</span></Fragment>)}
    </span>
  </Tag>;
}

/** Runs the pointer response on one piece of dot text. Frames are requested only while a letter is warm. */
function attachDotText(root: HTMLElement) {
  const chars = [...root.querySelectorAll<HTMLSpanElement>(".dot-char")];
  if (!chars.length) return undefined;
  const original = chars.map((node) => node.textContent ?? "");
  const decodable = original.map((char) => DECODABLE.test(char));
  const heat = new Float32Array(chars.length);
  const applied = new Float32Array(chars.length);
  const flipAt = new Float64Array(chars.length);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let centers: Array<[number, number]> = [];
  let pointer: { x: number; y: number; at: number } | undefined;
  let ripple: { x: number; y: number; at: number } | undefined;
  let frame = 0;

  const measure = () => {
    centers = chars.map((node) => {
      const box = node.getBoundingClientRect();
      return [box.left + box.width / 2, box.top + box.height / 2];
    });
  };
  const tick = (now: number) => {
    frame = 0;
    const size = Number.parseFloat(getComputedStyle(root).fontSize) || 16;
    const radius = Math.max(40, size * 2.2);
    const fresh = pointer && now - pointer.at < REST_MS;
    let warm = false;
    for (let index = 0; index < chars.length; index++) {
      const [x, y] = centers[index] ?? [0, 0];
      let target = 0;
      if (fresh && pointer) target = Math.max(0, 1 - Math.hypot(x - pointer.x, y - pointer.y) / radius);
      if (ripple) {
        const band = Math.abs(Math.hypot(x - ripple.x, y - ripple.y) - (now - ripple.at) * 0.8);
        if (band < size * 1.4) target = Math.max(target, 1 - band / (size * 1.4));
      }
      // Warm at once, cool over a few frames.
      const next = target > heat[index] ? target : heat[index] * 0.84;
      heat[index] = next < 0.03 ? 0 : next;
      if (heat[index]) warm = true;
      if (Math.abs(heat[index] - applied[index]) > 0.03 || (!heat[index] && applied[index])) {
        applied[index] = heat[index];
        if (heat[index]) chars[index].style.setProperty("--heat", heat[index].toFixed(2));
        else chars[index].style.removeProperty("--heat");
      }
      if (!reduced.matches && decodable[index] && heat[index] > 0.42) {
        if (now >= flipAt[index]) {
          chars[index].textContent = Math.random() < 0.5 ? "0" : "1";
          flipAt[index] = now + 60 + Math.random() * 110;
        }
      } else if (chars[index].textContent !== original[index]) {
        chars[index].textContent = original[index];
      }
    }
    if (ripple && now - ripple.at > 1600) ripple = undefined;
    if (warm || fresh || ripple) frame = requestAnimationFrame(tick);
  };
  const start = () => {
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const move = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    if (!centers.length) measure();
    pointer = { x: event.clientX, y: event.clientY, at: performance.now() };
    start();
  };
  const enter = (event: PointerEvent) => {
    measure();
    move(event);
  };
  const leave = () => {
    pointer = undefined;
    start();
  };
  const press = (event: PointerEvent) => {
    measure();
    ripple = { x: event.clientX, y: event.clientY, at: performance.now() };
    start();
  };
  // A keyboard focus on the link or button around the text sweeps it from the left.
  const control = root.closest<HTMLElement>("a, button");
  const focus = () => {
    if (!control?.matches(":focus-visible")) return;
    measure();
    const box = root.getBoundingClientRect();
    ripple = { x: box.left, y: box.top + box.height / 2, at: performance.now() };
    start();
  };
  // Positions are taken in the viewport, so scrolling or resizing asks for new ones.
  const forget = () => {
    centers = [];
  };
  root.addEventListener("pointerenter", enter);
  root.addEventListener("pointermove", move);
  root.addEventListener("pointerleave", leave);
  root.addEventListener("pointerdown", press);
  control?.addEventListener("focus", focus);
  window.addEventListener("scroll", forget, { passive: true, capture: true });
  window.addEventListener("resize", forget);
  return () => {
    root.removeEventListener("pointerenter", enter);
    root.removeEventListener("pointermove", move);
    root.removeEventListener("pointerleave", leave);
    root.removeEventListener("pointerdown", press);
    control?.removeEventListener("focus", focus);
    window.removeEventListener("scroll", forget, { capture: true });
    window.removeEventListener("resize", forget);
    if (frame) cancelAnimationFrame(frame);
    chars.forEach((node, index) => {
      node.textContent = original[index];
      node.style.removeProperty("--heat");
    });
  };
}
