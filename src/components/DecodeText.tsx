import { useEffect, useRef, useState } from "react";

/**
 * A label that decodes from binary digits, like the dots of the hero: when the pointer enters its button (or `replay`
 * changes), the letters run through 0 and 1 and settle from left to right in about a third of a second. The real label
 * stays in the accessibility tree and reserves the width, so the button never changes size. Reduced motion shows the
 * label as is.
 */
export function DecodeText({ text, replay }: { text: string; replay?: unknown }) {
  const [shown, setShown] = useState(text);
  const host = useRef<HTMLSpanElement>(null);
  const run = useRef<() => void>(() => undefined);

  useEffect(() => {
    let frame = 0;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    setShown(text);
    run.current = () => {
      if (reduced.matches) return;
      const start = performance.now();
      const step = () => {
        const progress = (performance.now() - start) / 340;
        if (progress >= 1) {
          frame = 0;
          setShown(text);
          return;
        }
        const settled = Math.floor(text.length * progress);
        setShown([...text].map((character, index) => index < settled || /\s|[.…·]/.test(character) ? character : Math.random() < 0.5 ? "0" : "1").join(""));
        frame = requestAnimationFrame(step);
      };
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(step);
    };
    const control = host.current?.closest("button, a");
    const start = () => run.current();
    control?.addEventListener("pointerenter", start);
    return () => {
      control?.removeEventListener("pointerenter", start);
      cancelAnimationFrame(frame);
    };
  }, [text]);

  // A truthy `replay` that changes (a tab becoming the selected one) plays the decode once more.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (replay) run.current();
  }, [replay]);

  // Assistive technology reads the label once, from the hidden copy; the sizing copy keeps the width unseen, and the
  // live copy is the one people see, so a label's visible words and its name are the same (audit, 2026-10-06).
  return <span className="decode" ref={host}>
    <span className="visually-hidden">{text}</span>
    <span className="decode-size" aria-hidden="true">{text}</span>
    <span className="decode-live" aria-hidden="true">{shown}</span>
  </span>;
}
