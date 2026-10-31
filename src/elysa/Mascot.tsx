import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

/**
 * Ely, ElysaPay's mascot: a little cloud spirit of the Elysian fields, drawn only in dots like everything else. Its
 * body is a halftone (full dots inside, smaller toward the edge), its hem ripples like a cloud, an antenna carries the
 * Elysium star, its eyes follow the pointer and blink, and it reacts to what happens: it thinks while a payment is
 * prepared, gasps when the wallet opens, celebrates when Elysium confirms, and looks sad when something fails.
 *
 * Anything on the page can set its mood with `cheer(mood, line)`; it is decoration (hidden from assistive
 * technology), and its words are always also said by the page's own text.
 */
export type Mood = "idle" | "happy" | "wow" | "think" | "sad" | "wave" | "sleep";

const COLS = 17;
const ROWS = 15;
const PITCH = 10;

type Dot = { x: number; y: number; r: number; hem: boolean; i: number; col: number; row: number };

/** The body's dots: a soft superellipse with a scalloped cloud hem. */
function bodyDots(): Dot[] {
  const dots: Dot[] = [];
  const cx = (COLS - 1) / 2;
  const cy = 6.2;
  let index = 0;
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const dx = (col - cx) / 7.6;
      const dy = (row - cy) / (row < cy ? 6 : 7.2);
      const inside = Math.pow(Math.abs(dx), 2.3) + Math.pow(Math.abs(dy), 2.3);
      // The hem: three scallops across the bottom rows.
      const hemRow = row >= 12;
      if (hemRow) {
        const scallop = Math.abs(Math.sin(((col + 0.5) / COLS) * Math.PI * 3));
        if (row - 12 > scallop * 2.4) continue;
      }
      if (inside > 1) continue;
      const depth = 1 - inside;
      dots.push({ x: col * PITCH + PITCH / 2, y: row * PITCH + PITCH / 2, r: 1.5 + 2.6 * Math.pow(depth, 0.45), hem: hemRow, i: index++, col, row });
    }
  }
  return dots;
}

const BODY = bodyDots();
const WIDTH = COLS * PITCH;
const HEIGHT = ROWS * PITCH;
const EYE_ROW = 6;
const EYE_COLS = [5, 11];

/** Sets every mascot's mood (and an optional line) for a moment; "idle" returns it to rest. */
export function cheer(mood: Mood, line?: string, ms = 2600) {
  window.dispatchEvent(new CustomEvent("elysa:mascot", { detail: { mood, line, ms } }));
}

export function Mascot({ size = 170, mood: fixed, line: fixedLine, className = "", interactive = true }: { size?: number; mood?: Mood; line?: string; className?: string; interactive?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [mood, setMood] = useState<Mood>(fixed ?? "idle");
  const [line, setLine] = useState<string | undefined>(fixedLine);
  const [look, setLook] = useState({ x: 0, y: 0 });
  const [blink, setBlink] = useState(false);
  const timer = useRef(0);

  useEffect(() => { setMood(fixed ?? "idle"); }, [fixed]);
  useEffect(() => { setLine(fixedLine); }, [fixedLine]);

  // Moods sent from anywhere on the page.
  useEffect(() => {
    const listen = (event: Event) => {
      const { mood: next, line: said, ms } = (event as CustomEvent<{ mood: Mood; line?: string; ms: number }>).detail;
      window.clearTimeout(timer.current);
      setMood(next);
      if (said !== undefined) setLine(said);
      if (next !== "idle" && ms > 0) timer.current = window.setTimeout(() => { setMood(fixed ?? "idle"); setLine(fixedLine); }, ms);
    };
    window.addEventListener("elysa:mascot", listen);
    return () => { window.removeEventListener("elysa:mascot", listen); window.clearTimeout(timer.current); };
  }, [fixed, fixedLine]);

  // Eyes follow the pointer; it blinks every few seconds.
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const move = (event: PointerEvent) => {
      const box = host.current?.getBoundingClientRect();
      if (!box) return;
      const dx = event.clientX - (box.left + box.width / 2);
      const dy = event.clientY - (box.top + box.height * 0.42);
      const distance = Math.max(1, Math.hypot(dx, dy));
      const reach = Math.min(1, distance / 260);
      setLook({ x: (dx / distance) * reach * 3.2, y: (dy / distance) * reach * 2.4 });
    };
    window.addEventListener("pointermove", move, { passive: true });
    let blinkTimer = 0;
    const scheduleBlink = () => {
      blinkTimer = window.setTimeout(() => {
        setBlink(true);
        window.setTimeout(() => setBlink(false), 140);
        scheduleBlink();
      }, 2400 + Math.random() * 3200);
    };
    if (!reduced) scheduleBlink();
    return () => { window.removeEventListener("pointermove", move); window.clearTimeout(blinkTimer); };
  }, []);

  // The face is made by the lattice itself: eyes and mouth are dots left out (holes in the halftone), cheeks are
  // lilac dots, and a white glint sits in each open eye. The eyes' holes move a cell toward the pointer.
  const face = useMemo(() => {
    const holes = new Set<string>();
    const cheeks = new Set<string>();
    const glints: Array<[number, number]> = [];
    const key = (col: number, row: number) => `${Math.round(col)}:${Math.round(row)}`;
    const ox = Math.round(look.x / 3.2);
    const oy = Math.round(look.y / 2.4);
    for (const ex of EYE_COLS) {
      const cx = ex + ox;
      const cy = EYE_ROW + oy;
      if (mood === "happy" || mood === "wave") {
        // ^ ^ : an arch of holes.
        holes.add(key(cx - 1, cy)); holes.add(key(cx, cy - 1)); holes.add(key(cx + 1, cy));
      } else if (mood === "sleep" || blink) {
        holes.add(key(cx - 1, cy)); holes.add(key(cx, cy)); holes.add(key(cx + 1, cy));
      } else {
        const radius = mood === "wow" ? 1.6 : 1.15;
        const drop = mood === "sad" ? 0.6 : 0;
        for (let row = Math.floor(cy - 2); row <= cy + 2; row++) {
          for (let col = Math.floor(cx - 2); col <= cx + 2; col++) {
            if (Math.hypot(col - cx, (row - cy - drop) * 1.1) <= radius) holes.add(key(col, row));
          }
        }
        glints.push([cx * PITCH + PITCH / 2 + 2, (cy + drop) * PITCH + PITCH / 2 - 2]);
        if (mood === "sad") { holes.add(key(cx - 1, cy - 1.4)); }
      }
    }
    const mid = (COLS - 1) / 2;
    const mouth: Array<[number, number]> = mood === "happy" || mood === "wave" ? [[-2, 9], [-1, 10], [0, 10], [1, 10], [2, 9], [-1, 9], [0, 9], [1, 9]]
      : mood === "wow" ? [[0, 9], [0, 10], [-1, 9.5], [1, 9.5]]
      : mood === "sad" ? [[-1, 10], [0, 9], [1, 10]]
      : mood === "think" ? [[0, 10], [1, 10], [2, 9.6]]
      : mood === "sleep" ? [[0, 10]]
      : [[-1, 9], [0, 10], [1, 9]];
    for (const [dx, row] of mouth) holes.add(key(mid + dx, row));
    for (const [col, row] of [[2, 8], [3, 8], [13, 8], [14, 8]]) cheeks.add(key(col, row));
    return { holes, cheeks, glints, key };
  }, [look, mood, blink]);

  return <div ref={host} className={`ely ely-${mood} ${className}`} style={{ "--size": `${size}px` } as CSSProperties} aria-hidden="true">
    {line && <p className="ely-bubble" key={line}>{line}</p>}
    <svg viewBox={`-10 -34 ${WIDTH + 20} ${HEIGHT + 44}`} width={size} height={(size * (HEIGHT + 44)) / (WIDTH + 20)} className={interactive ? "ely-svg is-interactive" : "ely-svg"} onPointerDown={interactive ? () => cheer(mood === "happy" ? "wow" : "happy", undefined, 1400) : undefined}>
      {/* The antenna and its Elysium star. */}
      <g className="ely-antenna">
        {[0, 1, 2].map((step) => <circle key={step} cx={WIDTH / 2 + step * 2} cy={-4 - step * 8} r={2.2 - step * 0.3} />)}
        <path className="ely-star" d={`M${WIDTH / 2 + 6} -34c1 5 2.6 6.6 7.6 7.6-5 1-6.6 2.6-7.6 7.6-1-5-2.6-6.6-7.6-7.6 5-1 6.6-2.6 7.6-7.6Z`} />
      </g>
      <g className="ely-body">
        {BODY.map((dot) => {
          const at = face.key(dot.col, dot.row);
          if (face.holes.has(at)) return null;
          return <circle key={dot.i} className={face.cheeks.has(at) ? "ely-cheek" : dot.hem ? "ely-hem" : undefined} cx={dot.x} cy={dot.y} r={dot.r} style={{ "--i": dot.i % 17 } as CSSProperties} />;
        })}
      </g>
      <g className="ely-face">{face.glints.map(([x, y], index) => <circle key={index} className="ely-glint" cx={x} cy={y} r={2.6} />)}</g>
      {/* Sparks around it when it is happy. */}
      <g className="ely-sparks">{[[-6, 20], [WIDTH + 4, 34], [6, HEIGHT - 20], [WIDTH - 2, HEIGHT - 6], [WIDTH / 2 - 40, -20]].map(([x, y], index) => <circle key={index} cx={x} cy={y} r={2.6} style={{ "--i": index } as CSSProperties} />)}</g>
    </svg>
  </div>;
}
