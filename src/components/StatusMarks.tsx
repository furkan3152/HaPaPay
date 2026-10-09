import type { CSSProperties } from "react";
import "./status-marks.css";

const ring = Array.from({ length: 20 }, (_, index) => {
  const angle = (index / 20) * Math.PI * 2 - Math.PI / 2;
  return [24 + Math.cos(angle) * 20, 24 + Math.sin(angle) * 20] as const;
});
const check = [[14, 24.5], [17.5, 28], [21, 31.5], [24.4, 27.9], [27.8, 24.3], [31.1, 20.6], [34.5, 17]] as const;
const chase = [[7, 7], [15, 7], [23, 7], [23, 15], [23, 23], [15, 23], [7, 23], [7, 15]] as const;

/**
 * A check made of dots, stamped once the server has verified the receipt: the ring fills in and the check lands dot by
 * dot. It repeats the "verified" transaction bar beside it, so it is hidden from assistive technology.
 */
export function VerifiedMark() {
  return <svg className="verified-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    {ring.map(([x, y], index) => <circle key={`ring-${index}`} className="verified-ring" cx={x.toFixed(2)} cy={y.toFixed(2)} r="1.35" style={{ "--i": index } as CSSProperties} />)}
    {check.map(([x, y], index) => <circle key={`check-${index}`} className="verified-check" cx={x} cy={y} r="2.5" style={{ "--i": index } as CSSProperties} />)}
  </svg>;
}

/** Dots chasing round a square while a transfer waits for its receipt; the card says "Pending" or "Review" beside it. */
export function PendingMark() {
  return <svg className="pending-mark" viewBox="0 0 30 30" aria-hidden="true" focusable="false">
    {chase.map(([x, y], index) => <circle key={index} className="pending-dot" cx={x} cy={y} r="2.6" style={{ "--i": index } as CSSProperties} />)}
    <circle className="pending-core" cx="15" cy="15" r="2.6" />
  </svg>;
}

/** An empty receipt drawn in dots, for activity with nothing in it yet. */
export function EmptyMark() {
  const outline: Array<readonly [number, number]> = [];
  for (let x = 24; x <= 96; x += 8) outline.push([x, 10], [x, 82]);
  for (let y = 18; y <= 74; y += 8) outline.push([24, y], [96, y]);
  const lines = [[38, 30, 82], [38, 42, 70], [38, 54, 76]] as const;
  return <svg className="empty-mark" viewBox="0 0 120 92" aria-hidden="true" focusable="false">
    {outline.map(([x, y]) => <circle key={`${x}-${y}`} className="empty-edge" cx={x} cy={y} r="1.8" />)}
    {lines.map(([from, y, to]) => Array.from({ length: Math.floor((to - from) / 6) + 1 }, (_, index) => <circle key={`${y}-${index}`} className="empty-line" cx={from + index * 6} cy={y} r="1.4" />))}
  </svg>;
}
