/**
 * The hero's dots: their motion and their drawing, the same code wherever it runs. The page measures the hero, reads
 * its colors, draws its sprites and samples its shapes (all need the page's styles and fonts), and hands them here.
 * Where the browser can, this runs in a worker on a canvas handed to it, so the dots keep every frame while the page
 * answers presses on its own thread; elsewhere it runs on the page as it always did. See `DotMorph.tsx`.
 */

export type Point = { x: number; y: number };
/** A lattice cell of a shape, with the radius of its dot. */
export type Target = Point & { r: number };
export type Sprite = { image: CanvasImageSource; size: number; radius: number };
export type Sprites = { field: Sprite; fieldHot: Sprite; dot: Sprite; dotHot: Sprite; digits: Sprite[]; digitsHot: Sprite[] };
/** The hero's size and the lattice its shapes are sampled on, measured by the page. */
export type MorphLayout = { width: number; height: number; dpr: number; pitch: number; ox: number; oy: number };

type Particle = {
  x: number; y: number; vx: number; vy: number;
  /** Current target and the next one, taken at `switchAt` so a change ripples across the shape. */
  tx: number; ty: number; nx: number; ny: number; switchAt: number;
  /** Its radius, the radius it is growing or shrinking to, and the next one. */
  r: number; goalR: number; nextR: number;
  alpha: number; goal: number; nextGoal: number;
  /** 0 is a resting dot; above about a third the dot shows a binary digit. */
  heat: number; bit: number; phase: number;
};

/** What the engine draws with: a canvas on the page or one handed to a worker. */
export type DrawingContext = Pick<CanvasRenderingContext2D, "setTransform" | "clearRect" | "drawImage" | "globalAlpha">;
export type MorphSurface = {
  canvas: { width: number; height: number };
  context: DrawingContext;
  frame(callback: (now: number) => void): number;
  cancel(handle: number): void;
  now(): number;
};

/** Everything the page tells the engine. In a worker these arrive as messages, on the page as calls. */
export type MorphMessage =
  | { kind: "layout"; layout: MorphLayout; targets: Record<string, Target[]>; sprites: Sprites }
  | { kind: "refresh"; targets: Record<string, Target[]>; sprites: Sprites }
  | { kind: "sprites"; sprites: Sprites }
  | { kind: "targets"; shape: string; points: Target[] }
  | { kind: "focus"; shape?: string }
  | { kind: "motion"; on: boolean }
  | { kind: "visible"; on: boolean }
  | { kind: "hidden"; on: boolean }
  | { kind: "reduced"; on: boolean }
  | { kind: "followColors" }
  | { kind: "pointer"; x: number; y: number }
  | { kind: "leave" }
  | { kind: "press"; x: number; y: number }
  | { kind: "destroy" };

const HOLD = 4600;
const SCAN_DELAY = 1900;
const SCAN_TIME = 1100;
const RIPPLE_LIFE = 1000;
const RIPPLE_SPEED = 0.42;

export function createMorphCore(surface: MorphSurface, shapes: readonly string[], initial: { still: boolean; hidden: boolean }) {
  const ctx = surface.context;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let pitch = 6;
  let particles: Particle[] = [];
  let field: Array<Point & { edge: number }> = [];
  const cache = new Map<string, Target[]>();
  let cycle = 0;
  let shown = shapes[0] ?? "$";
  let focus: string | undefined;
  let motion = true;
  let visible = true;
  let hidden = initial.hidden;
  let still = initial.still;
  let destroyed = false;
  let raf = 0;
  let last = 0;
  let nextMorphAt = surface.now() + HOLD;
  let scanAt = surface.now() + SCAN_DELAY;
  let followColorsUntil = 0;
  const pointer = { x: 0, y: 0, sx: 0, sy: 0, strength: 0, inside: false };
  const ripples: Array<Point & { born: number }> = [];
  let sprites: Sprites | undefined;

  const dotRadius = () => pitch * 0.31;
  const targets = (shape: string) => cache.get(shape) ?? [];

  /** Pairs the dots and the new shape's cells in angular order, so the dots swirl into place one after another. */
  function morph(shape: string, now: number, instant: boolean) {
    shown = shape;
    const goals = targets(shape);
    if (!goals.length) return;
    const scatter = particles.length === 0;
    while (particles.length < goals.length) {
      const source = scatter ? undefined : particles[Math.floor(Math.random() * particles.length)];
      const x = source?.x ?? width / 2 + (Math.random() - 0.5) * width * 0.95;
      const y = source?.y ?? height / 2 + (Math.random() - 0.5) * height * 0.95;
      const r = source?.r ?? dotRadius();
      particles.push({ x, y, vx: 0, vy: 0, tx: x, ty: y, nx: x, ny: y, switchAt: 0, r, goalR: r, nextR: r, alpha: 0, goal: 0, nextGoal: 0, heat: scatter ? 0.9 : 0, bit: Math.random() < 0.5 ? 0 : 1, phase: Math.random() * Math.PI * 2 });
    }
    const center = (list: Point[]) => {
      let x = 0;
      let y = 0;
      for (const point of list) {
        x += point.x;
        y += point.y;
      }
      return { x: x / list.length, y: y / list.length };
    };
    const from = center(particles);
    const to = center(goals);
    const order = particles.map((particle, index) => ({ index, angle: Math.atan2(particle.y - from.y, particle.x - from.x) })).sort((a, b) => a.angle - b.angle);
    const slots = goals.map((goal) => ({ goal, angle: Math.atan2(goal.y - to.y, goal.x - to.x) })).sort((a, b) => a.angle - b.angle);
    let previous = -1;
    order.forEach(({ index }, rank) => {
      const slot = Math.min(slots.length - 1, Math.floor((rank * slots.length) / order.length));
      const particle = particles[index];
      const goal = slots[slot].goal;
      particle.nx = goal.x;
      particle.ny = goal.y;
      particle.nextR = goal.r;
      // Spare dots share a cell with another dot and fade out; they come back when a larger shape needs them.
      particle.nextGoal = slot === previous ? 0 : 1;
      previous = slot;
      if (instant) {
        particle.x = particle.tx = goal.x;
        particle.y = particle.ty = goal.y;
        particle.vx = particle.vy = 0;
        particle.r = particle.goalR = goal.r;
        particle.alpha = particle.goal = particle.nextGoal;
        particle.heat = 0;
        particle.switchAt = 0;
      } else {
        particle.switchAt = now + (rank / order.length) * 300 + Math.random() * 110;
      }
    });
    scanAt = now + SCAN_DELAY;
    wake();
  }

  /** A new size: the canvas, the field and the shapes are laid out again, then the current shape is drawn at once. */
  function layout(next: MorphLayout, shapeTargets: Record<string, Target[]>, nextSprites: Sprites) {
    const first = width === 0;
    ({ width, height, dpr, pitch } = next);
    surface.canvas.width = Math.round(width * dpr);
    surface.canvas.height = Math.round(height * dpr);
    cache.clear();
    for (const [shape, points] of Object.entries(shapeTargets)) cache.set(shape, points);
    sprites = nextSprites;
    field = [];
    const gap = pitch * 2;
    for (let y = next.oy + pitch; y < height; y += gap) {
      for (let x = next.ox + pitch; x < width; x += gap) {
        const ex = (x - width / 2) / (width / 2);
        const ey = (y - height / 2) / (height / 2);
        const edge = Math.max(0, Math.min(1, (1 - Math.sqrt(ex * ex + ey * ey)) * 1.7));
        if (edge > 0.02) field.push({ x, y, edge });
      }
    }
    particles = [];
    // The first build assembles from scattered dots; later resizes place the shape at once.
    morph(focus ?? shown, surface.now(), !first || still);
    draw(surface.now(), still);
  }

  function tick(now: number) {
    raf = 0;
    if (destroyed) return;
    const step = last ? Math.min(2.5, (now - last) / (1000 / 60)) : 1;
    last = now;
    const ambient = motion && !still;
    if (ambient && !focus && shapes.length > 1 && now >= nextMorphAt && pointer.strength < 0.05) {
      cycle = (cycle + 1) % shapes.length;
      morph(shapes[cycle], now, false);
      nextMorphAt = now + HOLD;
    }
    const follow = Math.min(1, 0.35 * step);
    pointer.sx += (pointer.x - pointer.sx) * follow;
    pointer.sy += (pointer.y - pointer.sy) * follow;
    pointer.strength += ((pointer.inside ? 1 : 0) - pointer.strength) * Math.min(1, 0.14 * step);
    if (pointer.strength < 0.005) pointer.strength = 0;
    for (let index = ripples.length - 1; index >= 0; index--) if (now - ripples[index].born > RIPPLE_LIFE) ripples.splice(index, 1);
    const scanX = ambient && now >= scanAt && now <= scanAt + SCAN_TIME ? -80 + ((now - scanAt) / SCAN_TIME) * (width + 160) : undefined;
    const reach = Math.max(54, Math.min(92, width * 0.11));
    const cool = Math.pow(0.93, step);
    const damping = Math.pow(0.84, step);
    let moving = false;
    for (const particle of particles) {
      if (particle.switchAt && now >= particle.switchAt) {
        particle.tx = particle.nx;
        particle.ty = particle.ny;
        particle.goal = particle.nextGoal;
        particle.goalR = particle.nextR;
        particle.switchAt = 0;
      }
      if (particle.switchAt) moving = true;
      if (still) {
        particle.x = particle.tx;
        particle.y = particle.ty;
        particle.vx = particle.vy = 0;
        particle.alpha = particle.goal;
        particle.r = particle.goalR;
        particle.heat = 0;
        continue;
      }
      let ax = (particle.tx + (ambient ? Math.sin(now * 0.0012 + particle.phase) * 0.6 : 0) - particle.x) * 0.06;
      let ay = (particle.ty + (ambient ? Math.cos(now * 0.001 + particle.phase * 1.7) * 0.6 : 0) - particle.y) * 0.06;
      let heat = particle.heat * cool;
      if (pointer.strength > 0) {
        const dx = particle.x - pointer.sx;
        const dy = particle.y - pointer.sy;
        const d2 = dx * dx + dy * dy;
        if (d2 < reach * reach) {
          const d = Math.sqrt(d2) || 1;
          const f = 1 - d / reach;
          const push = f * f * 3.2 * pointer.strength;
          ax += (dx / d) * push;
          ay += (dy / d) * push;
          heat = Math.max(heat, Math.min(1, f * 1.15 * pointer.strength));
        }
      }
      for (const ripple of ripples) {
        const age = now - ripple.born;
        const dx = particle.x - ripple.x;
        const dy = particle.y - ripple.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const band = Math.abs(d - age * RIPPLE_SPEED);
        if (band < 18) {
          const f = (1 - band / 18) * (1 - age / RIPPLE_LIFE);
          ax += (dx / d) * f * 1.7;
          ay += (dy / d) * f * 1.7;
          heat = Math.max(heat, f);
        }
      }
      if (scanX !== undefined) {
        const band = Math.abs(particle.x + (particle.y - height / 2) * 0.4 - scanX);
        if (band < 16) heat = Math.max(heat, (1 - band / 16) * 0.85);
      }
      particle.vx = (particle.vx + ax * step) * damping;
      particle.vy = (particle.vy + ay * step) * damping;
      particle.x += particle.vx * step;
      particle.y += particle.vy * step;
      const speed = Math.abs(particle.vx) + Math.abs(particle.vy);
      particle.heat = Math.min(1, Math.max(heat, speed / 9));
      if (particle.heat > 0.34 && Math.random() < 0.06 * step) particle.bit ^= 1;
      particle.alpha += (particle.goal - particle.alpha) * Math.min(1, 0.08 * step);
      particle.r += (particle.goalR - particle.r) * Math.min(1, 0.1 * step);
      if (speed > 0.04 || particle.heat > 0.02 || Math.abs(particle.goal - particle.alpha) > 0.01 || Math.abs(particle.goalR - particle.r) > 0.02) moving = true;
    }
    draw(now, still);
    // A resting pointer stops the loop once the dots have settled around it; the next move wakes it again.
    const pointerSettling = Math.abs(pointer.x - pointer.sx) + Math.abs(pointer.y - pointer.sy) > 0.5 || Math.abs((pointer.inside ? 1 : 0) - pointer.strength) > 0.005;
    const keepGoing = moving || ambient || pointerSettling || ripples.length > 0 || now < followColorsUntil;
    // A morph started inside this frame may already have asked for the next one.
    if (keepGoing && visible && !hidden) raf ||= surface.frame(tick);
    else if (!raf) last = 0;
  }

  function draw(now: number, still: boolean) {
    if (!sprites || !width) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const reach = Math.max(70, Math.min(130, width * 0.16));
    for (const dot of field) {
      let x = dot.x;
      let y = dot.y;
      let lift = 0;
      if (pointer.strength > 0) {
        const dx = x - pointer.sx;
        const dy = y - pointer.sy;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        if (d < reach) {
          const k = 1 - d / reach;
          lift = k * k * pointer.strength;
          if (!still) {
            x += (dx / d) * lift * 6;
            y += (dy / d) * lift * 6;
          }
        }
      }
      for (const ripple of ripples) {
        const age = now - ripple.born;
        const band = Math.abs(Math.hypot(dot.x - ripple.x, dot.y - ripple.y) - age * RIPPLE_SPEED);
        if (band < 22) lift = Math.max(lift, (1 - band / 22) * (1 - age / RIPPLE_LIFE));
      }
      const sprite = lift > 0.18 ? sprites.fieldHot : sprites.field;
      ctx.globalAlpha = lift > 0.18 ? Math.min(1, dot.edge * (0.35 + lift)) : dot.edge * 0.55;
      ctx.drawImage(sprite.image, x - sprite.size / 2, y - sprite.size / 2, sprite.size, sprite.size);
    }
    const glow = Math.max(40, Math.min(80, width * 0.09));
    for (const particle of particles) {
      if (particle.alpha < 0.02) continue;
      let sprite = sprites.dot;
      // A dot is drawn at its own radius; a digit at the digits' size.
      let scale = particle.r / sprites.dot.radius;
      let alpha = particle.alpha * 0.95;
      if (!still && particle.heat > 0.34) {
        sprite = particle.heat > 0.72 ? sprites.digitsHot[particle.bit] : sprites.digits[particle.bit];
        scale = 1;
        alpha = particle.alpha * (0.5 + particle.heat * 0.5);
      } else if (still && pointer.strength > 0 && Math.hypot(particle.x - pointer.sx, particle.y - pointer.sy) < glow) {
        sprite = sprites.dotHot;
      }
      const size = sprite.size * scale;
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprite.image, particle.x - size / 2, particle.y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  function wake() {
    if (!raf && !destroyed && visible && !hidden && width) raf = surface.frame(tick);
  }

  function place(x: number, y: number) {
    pointer.x = x;
    pointer.y = y;
    if (!pointer.inside && pointer.strength === 0) {
      pointer.sx = pointer.x;
      pointer.sy = pointer.y;
    }
    pointer.inside = true;
    // The shape holds while someone is playing with it.
    nextMorphAt = Math.max(nextMorphAt, surface.now() + 1600);
    wake();
  }

  /** One message from the page. */
  function receive(message: MorphMessage) {
    switch (message.kind) {
      case "layout":
        return layout(message.layout, message.targets, message.sprites);
      case "refresh":
        // The interface and digit fonts arrived: the shapes are measured again and the current one redrawn.
        cache.clear();
        for (const [shape, points] of Object.entries(message.targets)) cache.set(shape, points);
        sprites = message.sprites;
        return morph(focus ?? shown, surface.now(), still);
      case "sprites":
        sprites = message.sprites;
        return wake();
      case "targets":
        cache.set(message.shape, message.points);
        return;
      case "focus": {
        if (message.shape === focus) return;
        focus = message.shape;
        if (!width) return;
        const now = surface.now();
        morph(message.shape ?? shapes[cycle], now, still);
        nextMorphAt = now + HOLD;
        return;
      }
      case "motion":
        motion = message.on;
        if (message.on) nextMorphAt = Math.max(nextMorphAt, surface.now() + HOLD / 2);
        return wake();
      case "visible":
        visible = message.on;
        if (visible) wake();
        return;
      case "hidden":
        hidden = message.on;
        if (!hidden) wake();
        return;
      case "reduced":
        still = message.on;
        morph(focus ?? shown, surface.now(), true);
        return draw(surface.now(), still);
      case "followColors":
        followColorsUntil = surface.now() + 700;
        return wake();
      case "pointer":
        return place(message.x, message.y);
      case "leave":
        pointer.inside = false;
        return wake();
      case "press": {
        place(message.x, message.y);
        const now = surface.now();
        if (!still) ripples.push({ x: pointer.x, y: pointer.y, born: now });
        if (!focus && shapes.length > 1) {
          cycle = (cycle + 1) % shapes.length;
          morph(shapes[cycle], now, still);
          nextMorphAt = now + HOLD;
        }
        return wake();
      }
      case "destroy":
        destroyed = true;
        if (raf) surface.cancel(raf);
        return;
    }
  }

  return { receive };
}

export type MorphCore = ReturnType<typeof createMorphCore>;
