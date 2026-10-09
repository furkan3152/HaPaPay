import type { CSSProperties } from "react";

/**
 * Icons on a dot grid, row by row: "#" is a full dot, "o" a smaller one, "." empty. Every icon in the interface is drawn
 * this way, like the bird and the type, and sits beside a visible or accessible label, so it is hidden from assistive
 * technology.
 */
const ICONS = {
  "arrow-up": ["..#..", ".###.", "#.#.#", "..#..", "..#..", "..#.."],
  "arrow-right": ["...#..", "....#.", "######", "....#.", "...#.."],
  "arrow-up-right": [".####", "...##", "..#.#", ".#..#", "#...."],
  "arrow-down-left": ["....#", "#..#.", "#.#..", "##...", "####."],
  "chevron-down": ["#...#", ".#.#.", "..#.."],
  check: ["....#", "...#.", "#.#..", ".#..."],
  close: ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
  lock: [".###.", "#...#", "#...#", "#####", "##.##", "#####"],
  shield: ["#######", "#.....#", "#....o#", "#o..o.#", "#.oo..#", ".#...#.", "..###.."],
  sun: ["o..#..o", ".......", "..###..", "#.###.#", "..###..", ".......", "o..#..o"],
  moon: ["..###..", ".##....", "##.....", "##.....", "##....o", ".##..#.", "..###.."],
  wallet: ["######.", "#.....#", "#...###", "#...#o#", "#...###", "#######"],
  search: [".###...", "#...#..", "#...#..", "#...#..", ".###...", ".....#.", "......#"],
  trash: ["..###..", "#######", ".#...#.", ".#o.o#.", ".#o.o#.", ".#...#.", "..###.."],
  link: [".##.##.", "#..#..#", "#..#..#", ".##.##."],
  unlink: [".##..##.", "#..o...#", "#...o..#", ".##..##."],
  refresh: ["..###.#", ".#...##", "#...###", "#......", "#.....#", ".#...#.", "..###.."],
  pause: [".#.#.", ".#.#.", ".#.#.", ".#.#.", ".#.#."],
  play: ["#...", "##..", "###.", "####", "###.", "##..", "#..."],
} as const;
export type DotIconName = keyof typeof ICONS;

/** One icon in a 20-unit box; the dots get larger as the grid gets coarser, so small icons stay solid. */
function dots(name: DotIconName) {
  const rows = ICONS[name];
  const columns = Math.max(...rows.map((row) => row.length));
  const gap = Math.min(3.4, 17 / Math.max(columns - 1, rows.length - 1, 1));
  const width = (columns - 1) * gap;
  const height = (rows.length - 1) * gap;
  return rows.flatMap((row, y) => [...row].flatMap((cell, x) => cell === "." ? [] : [{
    x: +(10 - width / 2 + x * gap).toFixed(2),
    y: +(10 - height / 2 + y * gap).toFixed(2),
    r: +(gap * (cell === "#" ? 0.41 : 0.28)).toFixed(2),
    // The order toward the tip, for the arrows' run on hover.
    order: name === "arrow-up" ? rows.length - 1 - y : name === "arrow-right" ? x : x + rows.length - 1 - y,
  }]));
}

export function DotIcon({ name, size = 16, className = "" }: { name: DotIconName; size?: number; className?: string }) {
  return <svg className={`dot-icon dot-icon-${name} ${className}`} width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    {dots(name).map(({ x, y, r, order }) => <circle key={`${x}-${y}`} cx={x} cy={y} r={r} style={{ "--o": order } as CSSProperties} />)}
  </svg>;
}

/**
 * An arrow drawn in dots: up on the send button, right on the home page's way into the desk. Hovering the control runs
 * the dots toward the tip.
 */
export function DotArrow({ direction = "up" }: { direction?: "up" | "right" }) {
  return <DotIcon name={direction === "up" ? "arrow-up" : "arrow-right"} size={18} className="dot-arrow" />;
}
