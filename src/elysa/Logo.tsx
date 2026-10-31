import type { CSSProperties } from "react";

/**
 * The ElysaPay mark: an E drawn in dots whose top stroke lets its last dot go. That dot leaves up and to the right
 * with a short trail, as a payment leaves for its name. The spine's dots are the fullest, like a halftone. On the page
 * the dots gather into the E once, and under the pointer the free dot hops.
 */
const E: Array<[number, number, number]> = [
  // spine
  [0, 0, 1], [0, 1, 1], [0, 2, 1], [0, 3, 1], [0, 4, 1],
  // top, middle, bottom strokes (the top one is missing its last dot)
  [1, 0, .86], [2, 0, .74],
  [1, 2, .86], [2, 2, .7],
  [1, 4, .86], [2, 4, .74], [3, 4, .62],
];
const TRAIL: Array<[number, number, number]> = [[2.95, -.15, .34], [3.55, -.62, .5]];
const FREE: [number, number, number] = [4.35, -1.3, 1];

export function LogoMark({ size = 34, className = "" }: { size?: number; className?: string }) {
  const cell = 7;
  const at = (value: number) => 6 + value * cell;
  return <svg className={`elysa-mark ${className}`} width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <rect className="elysa-mark-tile" x="1" y="1" width="46" height="46" rx="13" />
    <g transform="translate(4 12)">
      {E.map(([x, y, r], index) => <circle key={index} className="elysa-mark-dot" cx={at(x)} cy={at(y)} r={2.9 * r} style={{ "--i": index } as CSSProperties} />)}
      {TRAIL.map(([x, y, r], index) => <circle key={`t${index}`} className="elysa-mark-trail" cx={at(x)} cy={at(y)} r={2.9 * r} style={{ "--i": E.length + index } as CSSProperties} />)}
      <circle className="elysa-mark-free" cx={at(FREE[0])} cy={at(FREE[1])} r={3.3} style={{ "--i": E.length + 2 } as CSSProperties} />
    </g>
  </svg>;
}

/** The mark with the wordmark in the dot-matrix face. */
export function Logo({ size = 34 }: { size?: number }) {
  return <span className="elysa-logo">
    <LogoMark size={size} />
    <span className="elysa-wordmark" aria-label="ElysaPay"><span aria-hidden="true">ELYSA<b>PAY</b></span></span>
  </span>;
}
