import { useEffect, useRef, type CSSProperties } from "react";
import { playCue } from "../sound";
import "./elysian-hero.css";

/**
 * The home page's scene: the Elysian Fields at dawn. A temple draws itself in gold lines, the sun rises behind its
 * pediment and turns its rays, constellations join star by star, clouds drift across, laurel frames the scene and gold
 * motes rise from the steps. Layers follow the pointer at different depths; a click strikes a bronze bell and sends a
 * ring of light from the sun.
 *
 * It is decoration (hidden from assistive technology). Ambient motion follows the page's pause control (`motion`) and
 * stops under reduced motion and off screen; the drawing-in plays once either way, instantly under reduced motion.
 */
const COLUMNS = [92, 140, 188, 236, 284];
const STARS: Array<[number, number, number]> = [
  [48, 52, 1.6], [86, 34, 1.1], [124, 60, 1.4], [168, 28, 1.2], [214, 46, 1.8], [262, 30, 1.1], [306, 58, 1.5], [350, 38, 1.2],
  [30, 118, 1], [372, 112, 1.3], [62, 160, .9], [340, 166, 1], [196, 92, 1], [118, 104, .8], [290, 98, .9],
];
// Two constellations: the Lyre (Lyra) on the left and the Crown (Corona) on the right, joined star by star.
const LYRA = "M48 52 L86 34 L124 60 L118 104 L62 160";
const CORONA = "M262 30 L306 58 L350 38 L372 112 L340 166 L290 98";

export function ElysianHero({ motion }: { motion: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  // Pointer parallax: each layer moves by its depth.
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const move = (event: PointerEvent) => {
      const box = node.getBoundingClientRect();
      node.style.setProperty("--mx", ((event.clientX - box.left) / box.width - 0.5).toFixed(3));
      node.style.setProperty("--my", ((event.clientY - box.top) / box.height - 0.5).toFixed(3));
    };
    const leave = () => {
      node.style.setProperty("--mx", "0");
      node.style.setProperty("--my", "0");
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerleave", leave);
    return () => {
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerleave", leave);
    };
  }, []);

  // Gold motes rising from the temple steps; the pointer pushes them aside. Runs only with motion, on screen.
  useEffect(() => {
    const surface = canvas.current;
    const node = host.current;
    if (!surface || !node) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!motion || reduced.matches) return;
    const g = surface.getContext("2d");
    if (!g) return;
    let width = 0;
    let height = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      const box = node.getBoundingClientRect();
      width = box.width;
      height = box.height;
      surface.width = Math.round(width * dpr);
      surface.height = Math.round(height * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    type Mote = { x: number; y: number; vx: number; vy: number; r: number; life: number; max: number; hue: number };
    const motes: Mote[] = [];
    const spawn = (): Mote => ({
      x: width * (0.2 + Math.random() * 0.6), y: height * (0.78 + Math.random() * 0.12),
      vx: (Math.random() - 0.5) * 0.15, vy: -(0.15 + Math.random() * 0.35), r: 0.6 + Math.random() * 1.6,
      life: 0, max: 260 + Math.random() * 320, hue: 38 + Math.random() * 14,
    });
    for (let index = 0; index < 46; index++) {
      const mote = spawn();
      mote.life = Math.random() * mote.max;
      mote.y -= mote.life * Math.abs(mote.vy);
      motes.push(mote);
    }
    let pointer: { x: number; y: number } | undefined;
    const move = (event: PointerEvent) => {
      const box = node.getBoundingClientRect();
      pointer = { x: event.clientX - box.left, y: event.clientY - box.top };
    };
    const leave = () => { pointer = undefined; };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerleave", leave);
    let visible = true;
    const seen = new IntersectionObserver(([entry]) => { visible = Boolean(entry?.isIntersecting); });
    seen.observe(node);
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (!visible || document.hidden) return;
      g.clearRect(0, 0, width, height);
      for (let index = 0; index < motes.length; index++) {
        const mote = motes[index];
        mote.life++;
        if (pointer) {
          const dx = mote.x - pointer.x;
          const dy = mote.y - pointer.y;
          const distance = Math.hypot(dx, dy);
          if (distance < 70 && distance > 0.1) {
            mote.vx += (dx / distance) * 0.06;
            mote.vy += (dy / distance) * 0.03;
          }
        }
        mote.vx *= 0.985;
        mote.x += mote.vx + Math.sin((mote.life + index * 40) / 50) * 0.12;
        mote.y += mote.vy;
        const fade = Math.min(1, mote.life / 40) * Math.max(0, 1 - mote.life / mote.max);
        if (mote.life > mote.max || mote.y < -10) motes[index] = spawn();
        g.beginPath();
        g.fillStyle = `hsla(${mote.hue}, 85%, 70%, ${0.75 * fade})`;
        g.shadowColor = `hsla(${mote.hue}, 90%, 65%, ${fade})`;
        g.shadowBlur = 8;
        g.arc(mote.x, mote.y, mote.r, 0, Math.PI * 2);
        g.fill();
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      seen.disconnect();
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerleave", leave);
      g.clearRect(0, 0, width, height);
    };
  }, [motion]);

  const strike = () => {
    const node = host.current;
    if (!node) return;
    playCue("bell");
    node.classList.remove("struck");
    void node.offsetWidth;
    node.classList.add("struck");
  };

  return <div ref={host} className="elysian-hero" data-motion={motion ? "on" : "off"} aria-hidden="true" onPointerDown={strike}>
    <svg viewBox="0 0 400 420" className="eh-scene" focusable="false">
      <defs>
        <radialGradient id="eh-sun" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#FFF4CF" />
          <stop offset="45%" stopColor="#F3D88E" />
          <stop offset="100%" stopColor="#D8A54A" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="eh-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FBE7AE" />
          <stop offset="50%" stopColor="#D8B15A" />
          <stop offset="100%" stopColor="#9C7A2E" />
        </linearGradient>
        <linearGradient id="eh-marble" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F5EFE2" stopOpacity=".16" />
          <stop offset="100%" stopColor="#F5EFE2" stopOpacity=".03" />
        </linearGradient>
        <linearGradient id="eh-river" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#5CF2C9" stopOpacity="0" />
          <stop offset="50%" stopColor="#5CF2C9" stopOpacity=".55" />
          <stop offset="100%" stopColor="#5CF2C9" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Far layer: the sky. */}
      <g className="eh-layer eh-far" style={{ "--depth": 6 } as CSSProperties}>
        <path className="eh-constellation" d={LYRA} pathLength={1} />
        <path className="eh-constellation eh-late" d={CORONA} pathLength={1} />
        {STARS.map(([x, y, r], index) => <circle key={index} className="eh-star" cx={x} cy={y} r={r} style={{ "--i": index } as CSSProperties} />)}
      </g>

      {/* The sun rising behind the pediment, its rays turning. */}
      <g className="eh-layer eh-sunlayer" style={{ "--depth": 10 } as CSSProperties}>
        <g className="eh-rise">
          <g className="eh-rays">{Array.from({ length: 18 }, (_, index) => <path key={index} d="M200 170 L196 40 L204 40 Z" transform={`rotate(${index * 20} 200 170)`} />)}</g>
          <circle className="eh-sun" cx="200" cy="170" r="74" fill="url(#eh-sun)" />
          <circle className="eh-ring" cx="200" cy="170" r="60" />
        </g>
      </g>

      {/* Clouds of the Elysian sky. */}
      <g className="eh-layer eh-clouds" style={{ "--depth": 14 } as CSSProperties}>
        <path className="eh-cloud eh-cloud-a" d="M20 206c10-14 30-16 42-6 6-16 30-20 42-6 14-6 30 2 30 14H20Z" />
        <path className="eh-cloud eh-cloud-b" d="M262 150c8-12 26-14 36-4 6-14 26-16 36-4 12-4 26 2 26 12H262Z" />
      </g>

      {/* Near layer: the temple, drawn in gold. */}
      <g className="eh-layer eh-temple" style={{ "--depth": 20 } as CSSProperties}>
        <path className="eh-fill" d="M70 214 L200 152 L330 214 Z" fill="url(#eh-marble)" />
        <path className="eh-line" d="M64 216 L200 150 L336 216 Z" pathLength={1} />
        <path className="eh-line" d="M88 210 L200 158 L312 210" pathLength={1} />
        {/* The coin in the pediment: Ε for Elysium. */}
        <circle className="eh-line eh-coin" cx="200" cy="191" r="13" pathLength={1} />
        <text className="eh-epsilon" x="200" y="197.5" textAnchor="middle">Ε</text>
        <rect className="eh-line" x="62" y="216" width="276" height="14" pathLength={1} />
        <path className="eh-meander" d="M70 223 h8 v-4 h-4 v2 M84 223 h8 v-4 h-4 v2 M98 223 h8 v-4 h-4 v2 M112 223 h8 v-4 h-4 v2 M126 223 h8 v-4 h-4 v2 M140 223 h8 v-4 h-4 v2 M154 223 h8 v-4 h-4 v2 M168 223 h8 v-4 h-4 v2 M182 223 h8 v-4 h-4 v2 M196 223 h8 v-4 h-4 v2 M210 223 h8 v-4 h-4 v2 M224 223 h8 v-4 h-4 v2 M238 223 h8 v-4 h-4 v2 M252 223 h8 v-4 h-4 v2 M266 223 h8 v-4 h-4 v2 M280 223 h8 v-4 h-4 v2 M294 223 h8 v-4 h-4 v2 M308 223 h8 v-4 h-4 v2 M322 223 h8 v-4 h-4 v2" pathLength={1} />
        {COLUMNS.map((x, index) => <g key={x} className="eh-column" style={{ "--i": index } as CSSProperties}>
          <rect x={x - 3} y="230" width={30} height="6" className="eh-line" pathLength={1} />
          <rect x={x} y="236" width={24} height="104" fill="url(#eh-marble)" className="eh-line" pathLength={1} />
          <path className="eh-flute" d={`M${x + 6} 240 V336 M${x + 12} 240 V336 M${x + 18} 240 V336`} pathLength={1} />
          <rect x={x - 3} y="340" width={30} height="6" className="eh-line" pathLength={1} />
        </g>)}
        <path className="eh-line" d="M56 346 H344 M48 356 H352 M40 366 H360" pathLength={1} />
      </g>

      {/* Laurel branches framing the scene. */}
      <g className="eh-layer eh-laurel" style={{ "--depth": 28 } as CSSProperties}>
        {[-1, 1].map((side) => <g key={side} transform={side < 0 ? undefined : "translate(400 0) scale(-1 1)"}>
          <path className="eh-line eh-stem" d="M34 400 C14 330 18 262 52 206" pathLength={1} />
          {Array.from({ length: 8 }, (_, index) => {
            const t = index / 7;
            const x = 34 - 20 * Math.sin(t * 2.4) + 18 * t;
            const y = 400 - 194 * t;
            return <path key={index} className="eh-leaf" style={{ "--i": index } as CSSProperties} d={`M${x} ${y} q 14 -10 22 -4 q -10 12 -22 4 Z`} transform={`rotate(${-38 + index * 4} ${x} ${y})`} />;
          })}
        </g>)}
      </g>

      {/* The river Lethe at the foot of the steps. */}
      <g className="eh-layer eh-water" style={{ "--depth": 32 } as CSSProperties}>
        <path className="eh-wave" d="M40 384 q 20 -6 40 0 t 40 0 t 40 0 t 40 0 t 40 0 t 40 0 t 40 0 t 40 0" stroke="url(#eh-river)" />
        <path className="eh-wave eh-wave-2" d="M60 398 q 20 -6 40 0 t 40 0 t 40 0 t 40 0 t 40 0 t 40 0 t 40 0" stroke="url(#eh-river)" />
      </g>
    </svg>
    <canvas ref={canvas} className="eh-motes" />
  </div>;
}

/** The ElysaPay mark: a laurel wreath around a gold coin struck with Ε. */
export function LaurelMark({ className = "", size = 34 }: { className?: string; size?: number }) {
  const leaves = Array.from({ length: 7 }, (_, index) => index);
  return <svg className={`laurel-mark ${className}`} width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="lm-gold" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#FBE7AE" />
        <stop offset="55%" stopColor="#D8B15A" />
        <stop offset="100%" stopColor="#9C7A2E" />
      </linearGradient>
    </defs>
    <circle cx="24" cy="23" r="11.5" fill="url(#lm-gold)" />
    <circle cx="24" cy="23" r="9.4" fill="none" stroke="#7A5C1E" strokeOpacity=".55" strokeWidth=".8" />
    <text x="24" y="27.6" textAnchor="middle" className="laurel-epsilon">Ε</text>
    {[-1, 1].map((side) => <g key={side} transform={side < 0 ? undefined : "translate(48 0) scale(-1 1)"}>
      <path d="M17 43 C8 38 4 28 7 16" fill="none" stroke="url(#lm-gold)" strokeWidth="1.3" strokeLinecap="round" />
      {leaves.map((index) => {
        const t = index / 6;
        const x = 17 - 10.5 * Math.sin(t * 1.9) - 2 * t;
        const y = 43 - 27 * t;
        return <path key={index} className="laurel-leaf" style={{ "--i": index } as CSSProperties} d={`M${x} ${y} q -5 -1.5 -7 -5 q 4.5 .5 7 5 Z`} fill="url(#lm-gold)" />;
      })}
    </g>)}
  </svg>;
}
