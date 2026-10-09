/**
 * SP, HaPaPay's social points, as a coin of dots: a ring of small dots around the letters S and P, each drawn on a dot grid
 * like the rest of the desk's type and icons. The ring takes
 * `--sp-ring` (Robin Neon by default) and the letters the text color, so the coin sits on light and dark surfaces.
 */
const LETTERS = {
  S: [".###", "#...", ".##.", "...#", "###."],
  P: ["###.", "#..#", "###.", "#...", "#..."],
} as const;
const RING_DOTS = 24;

function letterDots() {
  const rows = LETTERS.S.length;
  const columns = LETTERS.S[0].length + 1 + LETTERS.P[0].length;
  const gap = 1.62;
  const left = 12 - ((columns - 1) * gap) / 2;
  const top = 12 - ((rows - 1) * gap) / 2;
  return (["S", "P"] as const).flatMap((letter, index) => LETTERS[letter].flatMap((row, y) => [...row].flatMap((cell, x) => cell === "#"
    ? [{ x: +(left + (x + index * (LETTERS.S[0].length + 1)) * gap).toFixed(2), y: +(top + y * gap).toFixed(2) }]
    : [])));
}

const RING = Array.from({ length: RING_DOTS }, (_, index) => {
  const angle = (index / RING_DOTS) * Math.PI * 2;
  return { x: +(12 + Math.cos(angle) * 10.6).toFixed(2), y: +(12 + Math.sin(angle) * 10.6).toFixed(2) };
});
const GLYPH = letterDots();

export function SpMark({ size = 18, className = "", label }: { size?: number; className?: string; label?: string }) {
  return <svg
    className={`sp-mark ${className}`}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true, focusable: "false" })}
  >
    <g className="sp-mark-ring">{RING.map(({ x, y }) => <circle key={`r${x}-${y}`} cx={x} cy={y} r={0.62} />)}</g>
    <g className="sp-mark-letters">{GLYPH.map(({ x, y }) => <circle key={`l${x}-${y}`} cx={x} cy={y} r={0.66} />)}</g>
  </svg>;
}
