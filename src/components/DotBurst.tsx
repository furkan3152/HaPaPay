import { useEffect, useRef } from "react";

/**
 * A pressed button comes apart into dots and binary digits: its own 6 px dot grid lifts off in a wave from the press
 * point, scatters outward and fades within a second, while the button dims and forms again under it. A key press
 * bursts from the button's center. One canvas draws every burst, sized to the pressed buttons and the room their dots
 * fly in; it runs frames only while dots are in the air and gives its memory back afterwards. It answers a press, so it is not ambient motion: the pause control
 * leaves it on, and reduced motion and high-contrast mode keep plain buttons. It is decorative and hidden from
 * assistive technology.
 */

/**
 * Buttons, and links drawn as buttons. Disabled buttons stay still, and the theme switch is left out: its own reveal
 * runs through a view transition, which would freeze the dots mid-flight.
 */
const CONTROLS = "button:not(:disabled):not(.theme-toggle), a:is(.home-open, .home-docs, .docs-back), .farcaster-signin a, .stock-links a";
/** The buttons' own dot pitch, so the burst starts as the button's surface. */
const PITCH = 6;
const MAX_PER_PRESS = 96;
const MAX_PARTICLES = 320;
/** How long the button takes to form again under its dots. */
const REFORM_MS = 560;
/** Velocity lost per second, and the slow fall of the dots once they are out. */
const DRAG = 3.4;
const FALL = 90;
/**
 * How far past the button a dot can get (the fastest one coasts about 140 px and falls about 40). The canvas covers
 * only the pressed buttons and this margin, not the whole window: a window-sized canvas made every press's first
 * frame slower on phones.
 */
const REACH = 220;

type Particle = {
  /** Page position, so the dots stay where they left when the page scrolls. */
  x: number; y: number; vx: number; vy: number;
  /** When it leaves the button and how long it flies, in ms. Until it leaves it rests as a dot of the button. */
  leaves: number; life: number;
  radius: number; size: number; color: string;
  /** A digit shows 0 or 1 and flips while it flies; otherwise it is a dot. */
  digit: boolean; bit: number; flipAt: number;
};

export function DotBurst() {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const forced = window.matchMedia("(forced-colors: active)");
    let particles: Particle[] = [];
    let frame = 0;
    let last = 0;
    let scale = 1;
    let mono = "";
    /** The page area the canvas covers while dots are in the air, in page pixels. */
    let area = { left: 0, top: 0, right: 0, bottom: 0 };

    /** Sizes the canvas to `next` (page pixels); a canvas that changes size starts blank, which each frame is anyway. */
    const cover = (next: typeof area) => {
      area = next;
      const width = Math.max(1, Math.ceil(area.right - area.left));
      const height = Math.max(1, Math.ceil(area.bottom - area.top));
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
      element.width = Math.round(width * scale);
      element.height = Math.round(height * scale);
      context.textAlign = "center";
      context.textBaseline = "middle";
    };

    const tick = (now: number) => {
      frame = 0;
      const step = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      particles = particles.filter((particle) => now - particle.leaves < particle.life);
      // The canvas sits over its page area wherever the page has scrolled; dots are drawn in page pixels.
      element.style.transform = `translate(${area.left - window.scrollX}px, ${area.top - window.scrollY}px)`;
      context.setTransform(scale, 0, 0, scale, -area.left * scale, -area.top * scale);
      context.clearRect(area.left, area.top, area.right - area.left, area.bottom - area.top);
      let font = 0;
      for (const particle of particles) {
        const age = now - particle.leaves;
        if (age < 0) {
          // Still part of the button: a resting dot of its grid.
          context.globalAlpha = 0.9;
          context.fillStyle = particle.color;
          context.beginPath();
          context.arc(particle.x, particle.y, 1.1, 0, Math.PI * 2);
          context.fill();
          continue;
        }
        const damping = Math.exp(-DRAG * step);
        particle.vx *= damping;
        particle.vy = particle.vy * damping + FALL * step;
        particle.x += particle.vx * step;
        particle.y += particle.vy * step;
        const progress = age / particle.life;
        context.globalAlpha = (1 - progress) ** 1.6;
        context.fillStyle = particle.color;
        if (particle.digit) {
          if (now >= particle.flipAt) {
            particle.bit ^= 1;
            particle.flipAt = now + 70 + Math.random() * 90;
          }
          if (font !== particle.size) {
            font = particle.size;
            context.font = `600 ${font}px ${mono}`;
          }
          context.fillText(String(particle.bit), particle.x, particle.y);
        } else {
          context.beginPath();
          context.arc(particle.x, particle.y, particle.radius * (1 - 0.45 * progress), 0, Math.PI * 2);
          context.fill();
        }
      }
      context.globalAlpha = 1;
      if (particles.length) frame = requestAnimationFrame(tick);
      else {
        // Nothing in the air: give the canvas memory back and take it off the page until the next press.
        element.width = 0;
        element.height = 0;
        element.hidden = true;
      }
    };

    const press = (event: MouseEvent) => {
      if (reduced.matches || forced.matches) return;
      const control = event.target instanceof Element ? event.target.closest<HTMLElement>(CONTROLS) : null;
      if (!control) return;
      const box = control.getBoundingClientRect();
      if (box.width < PITCH || box.height < PITCH) return;
      const style = getComputedStyle(control);
      const dots = style.getPropertyValue("--accent").trim() || style.color;
      const digits = style.getPropertyValue("--accent-text").trim() || dots;
      const corner = Math.min(Number.parseFloat(style.borderTopLeftRadius) || 0, box.width / 2, box.height / 2);
      // A key press (or a form sent with Enter) has no pointer position, so it bursts from the center.
      const pointer = event.detail > 0 && (event.clientX !== 0 || event.clientY !== 0);
      const originX = pointer ? Math.min(box.right, Math.max(box.left, event.clientX)) : box.left + box.width / 2;
      const originY = pointer ? Math.min(box.bottom, Math.max(box.top, event.clientY)) : box.top + box.height / 2;

      const cells: Array<[number, number]> = [];
      for (let y = box.top + PITCH / 2; y < box.bottom; y += PITCH) {
        for (let x = box.left + PITCH / 2; x < box.right; x += PITCH) {
          // Skip the cells outside the button's rounded corners.
          const dx = Math.max(box.left + corner - x, 0, x - (box.right - corner));
          const dy = Math.max(box.top + corner - y, 0, y - (box.bottom - corner));
          if (dx * dx + dy * dy <= corner * corner) cells.push([x, y]);
        }
      }
      const keep = Math.min(1, MAX_PER_PRESS / cells.length);
      const now = performance.now();
      const left = window.scrollX;
      const top = window.scrollY;
      for (const [x, y] of cells) {
        if (Math.random() > keep) continue;
        const distance = Math.hypot(x - originX, y - originY);
        const angle = (distance > 1 ? Math.atan2(y - originY, x - originX) : Math.random() * Math.PI * 2) + (Math.random() - 0.5) * 0.9;
        // Dots near the press point leave first and fastest, so the burst runs across the button like a ripple; the
        // spread in speed keeps a small button's burst from flying out as a ring.
        const speed = (70 + 250 * Math.exp(-distance / 70)) * (0.45 + Math.random());
        const digit = Math.random() < 0.38;
        particles.push({
          x: x + left,
          y: y + top,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 40,
          leaves: now + Math.min(140, distance * 0.9),
          life: 480 + Math.random() * 420,
          radius: 0.9 + Math.random() * 1.3,
          size: Math.random() < 0.5 ? 9 : 11,
          color: digit ? digits : dots,
          digit,
          bit: Math.random() < 0.5 ? 0 : 1,
          flipAt: 0,
        });
      }
      if (particles.length > MAX_PARTICLES) particles = particles.slice(-MAX_PARTICLES);

      // The button dims as its dots leave and forms again under them; a quick second press starts it over. A script
      // animation leaves the button's own CSS animations alone.
      for (const animation of control.getAnimations()) if (animation.id === "dot-burst") animation.cancel();
      control.animate([{ opacity: 1 }, { opacity: 0.16, offset: 0.12 }, { opacity: 1 }], { id: "dot-burst", duration: REFORM_MS, easing: "cubic-bezier(.2, .8, .2, 1)" });

      // This press's area: the button and as far as its dots can fly, in page pixels.
      const reach = { left: box.left + left - REACH, top: box.top + top - REACH, right: box.right + left + REACH, bottom: box.bottom + top + REACH };
      if (!frame) {
        scale = Math.min(2, window.devicePixelRatio || 1);
        element.hidden = false;
        mono = getComputedStyle(element).getPropertyValue("--font-mono").trim() || "monospace";
        cover(reach);
        last = now;
        frame = requestAnimationFrame(tick);
      } else if (reach.left < area.left || reach.top < area.top || reach.right > area.right || reach.bottom > area.bottom) {
        // Another press while dots are still in the air: the canvas grows to cover both.
        cover({ left: Math.min(area.left, reach.left), top: Math.min(area.top, reach.top), right: Math.max(area.right, reach.right), bottom: Math.max(area.bottom, reach.bottom) });
      }
    };

    // Capture, so every press is seen before the button's own handler changes the page under it.
    document.addEventListener("click", press, true);
    return () => {
      document.removeEventListener("click", press, true);
      cancelAnimationFrame(frame);
    };
  }, []);

  return <canvas className="dot-burst" ref={canvas} aria-hidden="true" hidden />;
}
