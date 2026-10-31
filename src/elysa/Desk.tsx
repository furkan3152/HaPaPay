import { useEffect, useRef } from "react";
import { DotBurst } from "../components/DotBurst";

/**
 * The desk under every page: a quiet grid of dots. Around the pointer its dots light up in mint; a soft band of lit
 * dots drifts across it slowly (only while animations play); and a pressed button comes apart into dots. Everything
 * here is drawn from the same 18 px lattice, so nothing glows that is not a dot.
 */
export function Desk({ motion }: { motion: boolean }) {
  const lens = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = lens.current;
    if (!node || !window.matchMedia("(pointer: fine)").matches) return;
    let frame = 0;
    const move = (event: PointerEvent) => {
      // Buttons light the dots under the pointer: they read their own --px and --py.
      const control = (event.target as Element | null)?.closest?.<HTMLElement>(".btn");
      if (control) {
        const box = control.getBoundingClientRect();
        control.style.setProperty("--px", `${event.clientX - box.left}px`);
        control.style.setProperty("--py", `${event.clientY - box.top}px`);
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        node.style.setProperty("--px", `${event.clientX}px`);
        node.style.setProperty("--py", `${event.clientY}px`);
        node.classList.add("on");
      });
    };
    const leave = () => node.classList.remove("on");
    window.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerleave", leave);
    return () => { window.removeEventListener("pointermove", move); document.removeEventListener("pointerleave", leave); cancelAnimationFrame(frame); };
  }, []);
  // The drifting band: one way and back over about seventy seconds, a few frames a second.
  useEffect(() => {
    const root = document.documentElement;
    if (!motion || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    let last = 0;
    const started = performance.now();
    const step = (now: number) => {
      frame = requestAnimationFrame(step);
      if (document.hidden || now - last < 120) return;
      last = now;
      const phase = ((now - started) / 35_000) % 2;
      root.style.setProperty("--sky", `${((phase < 1 ? phase : 2 - phase) * 100).toFixed(2)}%`);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [motion]);
  return <>
    <div className="desk" aria-hidden="true"><div className="desk-band" /><div ref={lens} className="desk-lens" /></div>
    <DotBurst />
  </>;
}
