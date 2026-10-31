import { useEffect, useRef } from "react";

/**
 * The Elysian sky behind every page: night overhead fading to a dawn on the horizon, stars that twinkle, layers of
 * soft clouds that drift at different speeds and follow the pointer a little, and now and then a payment crossing the
 * sky as a mint comet. Decorative only (hidden from assistive technology). It draws at most 30 frames a second, stops
 * while the tab is hidden, and holds a still frame under reduced motion or when animations are paused.
 */
export function Sky({ motion = true, variant = "app" }: { motion?: boolean; variant?: "hero" | "app" }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const surface = canvas.current;
    if (!surface) return;
    const g = surface.getContext("2d");
    if (!g) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    let width = 0;
    let height = 0;
    let stars: Array<{ x: number; y: number; r: number; phase: number; speed: number }> = [];
    let clouds: Array<{ sprite: HTMLCanvasElement; x: number; y: number; speed: number; depth: number; alpha: number }> = [];
    const comets: Array<{ x: number; y: number; vx: number; vy: number; life: number }> = [];
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

    // A cloud is drawn once, as soft overlapping puffs, and then moved as a sprite.
    const cloudSprite = (w: number, h: number, tint: string) => {
      const sprite = document.createElement("canvas");
      sprite.width = w;
      sprite.height = h;
      const c = sprite.getContext("2d")!;
      for (let index = 0; index < 14; index++) {
        const px = w * (0.15 + Math.random() * 0.7);
        const py = h * (0.45 + Math.random() * 0.25);
        const pr = h * (0.18 + Math.random() * 0.3);
        const puff = c.createRadialGradient(px, py, 0, px, py, pr);
        puff.addColorStop(0, tint);
        puff.addColorStop(1, "rgba(255,255,255,0)");
        c.fillStyle = puff;
        c.beginPath();
        c.arc(px, py, pr, 0, Math.PI * 2);
        c.fill();
      }
      return sprite;
    };

    const layout = () => {
      const box = surface.getBoundingClientRect();
      width = box.width;
      height = box.height;
      surface.width = Math.round(width * dpr);
      surface.height = Math.round(height * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round((width * height) / 5200);
      stars = Array.from({ length: count }, () => ({ x: Math.random() * width, y: Math.random() * height * 0.75, r: Math.random() * 1.2 + 0.2, phase: Math.random() * Math.PI * 2, speed: 0.4 + Math.random() * 1.4 }));
      const tints = ["rgba(170,190,255,0.10)", "rgba(200,180,255,0.09)", "rgba(255,200,180,0.08)"];
      clouds = Array.from({ length: variant === "hero" ? 9 : 6 }, (_, index) => {
        const depth = (index % 3) + 1;
        const w = 360 + depth * 160;
        return { sprite: cloudSprite(w, w * 0.42, tints[index % 3]), x: Math.random() * (width + w) - w, y: height * (0.25 + (depth / 3) * 0.55) + (Math.random() - 0.5) * 80, speed: 0.06 * depth, depth, alpha: 0.65 + depth * 0.12 };
      });
    };

    const draw = (time: number, animate: boolean) => {
      // Sky: night overhead to a dawn on the horizon.
      const sky = g.createLinearGradient(0, 0, 0, height);
      sky.addColorStop(0, "#04060E");
      sky.addColorStop(0.45, "#0A1030");
      sky.addColorStop(0.78, "#1B1A4A");
      sky.addColorStop(1, variant === "hero" ? "#3A2550" : "#141436");
      g.fillStyle = sky;
      g.fillRect(0, 0, width, height);
      // Aurora veils.
      const veil = (x: number, y: number, r: number, color: string) => {
        const glow = g.createRadialGradient(x, y, 0, x, y, r);
        glow.addColorStop(0, color);
        glow.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = glow;
        g.fillRect(x - r, y - r, r * 2, r * 2);
      };
      const drift = animate ? Math.sin(time / 9000) * 40 : 0;
      veil(width * 0.22 + drift, height * 0.18, Math.max(width, height) * 0.45, "rgba(124,242,212,0.10)");
      veil(width * 0.78 - drift, height * 0.12, Math.max(width, height) * 0.4, "rgba(167,139,255,0.12)");
      if (variant === "hero") veil(width * 0.5, height * 1.05, width * 0.55, "rgba(255,170,130,0.16)");
      // Stars.
      for (const star of stars) {
        const twinkle = animate ? 0.55 + 0.45 * Math.sin(star.phase + (time / 1000) * star.speed) : 0.8;
        g.globalAlpha = twinkle * (1 - star.y / (height * 0.9));
        g.fillStyle = "#F4F6FF";
        g.beginPath();
        g.arc(star.x + pointer.x * 4, star.y + pointer.y * 3, star.r, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      // Comets: payments crossing the sky.
      for (let index = comets.length - 1; index >= 0; index--) {
        const comet = comets[index];
        comet.x += comet.vx;
        comet.y += comet.vy;
        comet.life -= 1;
        const tail = g.createLinearGradient(comet.x, comet.y, comet.x - comet.vx * 22, comet.y - comet.vy * 22);
        tail.addColorStop(0, `rgba(160,255,230,${0.6 * Math.min(1, comet.life / 30)})`);
        tail.addColorStop(1, "rgba(160,255,230,0)");
        g.strokeStyle = tail;
        g.lineWidth = 1.6;
        g.beginPath();
        g.moveTo(comet.x, comet.y);
        g.lineTo(comet.x - comet.vx * 22, comet.y - comet.vy * 22);
        g.stroke();
        if (comet.life <= 0) comets.splice(index, 1);
      }
      // Clouds, far to near.
      for (const cloud of clouds) {
        if (animate) {
          cloud.x += cloud.speed;
          if (cloud.x > width + 20) cloud.x = -cloud.sprite.width;
        }
        g.globalAlpha = cloud.alpha;
        g.drawImage(cloud.sprite, cloud.x + pointer.x * cloud.depth * 10, cloud.y + pointer.y * cloud.depth * 6);
      }
      g.globalAlpha = 1;
    };

    layout();
    const still = () => reduced.matches || !motion;
    draw(0, false);
    let frame = 0;
    let last = 0;
    let nextComet = performance.now() + 2500;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (document.hidden || now - last < 33) return;
      last = now;
      pointer.x += (pointer.tx - pointer.x) * 0.05;
      pointer.y += (pointer.ty - pointer.y) * 0.05;
      if (variant === "hero" && now > nextComet) {
        nextComet = now + 4000 + Math.random() * 7000;
        const fromLeft = Math.random() < 0.6;
        comets.push({ x: fromLeft ? -20 : width * (0.3 + Math.random() * 0.5), y: height * (0.05 + Math.random() * 0.3), vx: fromLeft ? 7 + Math.random() * 4 : 6 + Math.random() * 3, vy: 1.8 + Math.random() * 1.6, life: 80 });
      }
      draw(now, true);
    };
    if (!still()) frame = requestAnimationFrame(tick);
    const move = (event: PointerEvent) => {
      pointer.tx = event.clientX / window.innerWidth - 0.5;
      pointer.ty = event.clientY / window.innerHeight - 0.5;
    };
    const resize = () => {
      layout();
      draw(performance.now(), false);
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("resize", resize);
    };
  }, [motion, variant]);
  return <canvas ref={canvas} className={`elysa-sky elysa-sky-${variant}`} aria-hidden="true" />;
}
