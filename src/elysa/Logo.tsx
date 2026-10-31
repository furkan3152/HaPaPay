import { useId } from "react";

/**
 * The ElysaPay mark, "Ascent": an aurora badge in which a payment rises on its orbit and arrives as a star. The orbit
 * is the Elysian sky, the swoosh is the transfer, the four-pointed star is the name it reaches. It draws itself once,
 * and under the pointer the orbit turns and the star flares.
 */
export function LogoMark({ size = 34, className = "" }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  return <svg className={`elysa-mark ${className}`} width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}-aurora`} x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#7CF2D4" />
        <stop offset=".5" stopColor="#7AA7FF" />
        <stop offset="1" stopColor="#A78BFF" />
      </linearGradient>
      <radialGradient id={`${id}-glow`} cx="34" cy="13" r="18" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#FFFFFF" stopOpacity=".55" />
        <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
      </radialGradient>
      <linearGradient id={`${id}-swoosh`} x1="8" y1="38" x2="34" y2="13" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#FFFFFF" stopOpacity=".15" />
        <stop offset="1" stopColor="#FFFFFF" />
      </linearGradient>
    </defs>
    <rect x="2" y="2" width="44" height="44" rx="14" fill={`url(#${id}-aurora)`} />
    <rect x="2" y="2" width="44" height="44" rx="14" fill={`url(#${id}-glow)`} />
    <g className="elysa-mark-orbit">
      <ellipse cx="24" cy="25" rx="15" ry="7.5" transform="rotate(-28 24 25)" fill="none" stroke="#0B1030" strokeOpacity=".28" strokeWidth="1.4" />
    </g>
    <path className="elysa-mark-swoosh" d="M9.5 37.5C16 37 25.5 31 32.5 15.5" fill="none" stroke={`url(#${id}-swoosh)`} strokeWidth="4.2" strokeLinecap="round" pathLength={1} />
    <path className="elysa-mark-star" d="M34 6.6c.7 3.6 2 4.9 5.6 5.6-3.6.7-4.9 2-5.6 5.6-.7-3.6-2-4.9-5.6-5.6 3.6-.7 4.9-2 5.6-5.6Z" fill="#FFFFFF" />
  </svg>;
}

/** The mark with the wordmark: "elysa" in the display face, "pay" in the aurora. */
export function Logo({ size = 34 }: { size?: number }) {
  return <span className="elysa-logo">
    <LogoMark size={size} />
    <span className="elysa-wordmark">elysa<b>pay</b></span>
  </span>;
}
