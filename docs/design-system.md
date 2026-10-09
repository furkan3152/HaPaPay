# Design system

HaPaPay's interface is drawn in dots. The hero, the brand mark, the icons, the headings and even the way a pressed
button reacts are made of the same dot grid, so the product feels like one object rather than a template with a logo
on it. This document records the rules that keep it that way.

## Principles

1. **Everything is dots.** Shapes are halftones of dots that never touch; headings and amounts are set in a
   dot-matrix face; icons are drawn on a dot grid. Platform glyphs are the one exception: they stay solid so each
   platform is recognizable.
2. **The money stays readable.** Sentences, inputs, prices and addresses use plain faces. Decoration never moves while
   someone reads it.
3. **Nothing is decoration-only state.** A color or an animation never stands for a result on its own; status marks
   appear beside the text that states the result, and availability comes from the server.
4. **It must not look generated.** No stock scenes, gradient headlines, glows, sparkle icons, slogan headings or chatbot
   persona. Labels are plain: *Send*, *Review*, *Claim*, *Take back*.

## Layout

- `/` is the home page: what HaPaPay does, how a payment works, what can be sent, the vault, and the trust model, each
  card opening the section of `/docs` that explains it.
- `/app` is the desk: two floating cards on a dotted desk. The payment column holds the request box, examples, the
  status line, the conversation and the slips; the side panel has five tabs: **Stocks** (the boards), **Activity**,
  **Claims**, **SP** and **Identities**.
- `/docs`, `/operator/stock-escrow` and `/admin` reuse the same surfaces and type.
- A slip (a review) lists its facts as rows: network, recipient, amount, fee, total, gas, note, then one primary action.

## Color

| Token | Dark (default) | Light | Use |
|---|---|---|---|
| Canvas | `#0B0C0E` | `#F5F5F7` | The desk |
| Panel | `#121417` | `#FFFFFF` | Cards |
| Ink | `#EDEFF2` | `#1D1D1F` | Text |
| Accent (Robin Neon) | `#CCFF00` | `#CCFF00` fill, `#4E6100` text | Primary actions, the bird, the hero |
| On accent | `#110E08` | `#110E08` | Text on neon |
| Locked | `#F2B95B` on `#2A2010` | `#8A4B00` on `#FFF3E0` | Signing locked, refunds |

Each network keeps its own accent on its slips and claim pages: Robin Neon on Robinhood Chain, Solana purple
`#9945FF` with green `#14F195` on Solana, Arc's blue on Arc. Only colors are borrowed; no third-party logo, wordmark or
feather appears anywhere. Light theme text colors are darkened until they pass WCAG AA on white.

## Type

| Face | Use |
|---|---|
| **Doto** (dot-matrix, rounded) | Short capitals: headings, amounts, buttons, tab labels |
| **Space Grotesk** | Sentences and body text |
| **IBM Plex Mono** | Inputs, prices, addresses, hashes, readouts |

Dot-matrix text that decodes from binary digits or reacts to the pointer keeps the real text in the element for
assistive technology and hides only the moving letters.

## The mark

The brand mark is a swallow drawn as a halftone: its outline filled with dots on a lattice turned along its spine, full
near the shoulder and shrinking toward the wing and tail tips, with a round gap for the eye. The raised wing is its
own group, so the bird can fold and open it. The favicon is the same bird on a coarser lattice that reads at 16 px.
`src/components/BrandMark.tsx` holds the dot data; `public/favicon.svg` and `public/share.png` are drawn from it.

## Motion

- **The hero** is a canvas of dots that gathers into `$`, changes between shapes and answers the pointer, clicks and
  typing. Its engine (`src/components/dot-morph-engine.ts`) runs every frame in a worker on an offscreen canvas, so the
  page stays responsive without slowing or thinning the animation.
- **Pressed buttons** come apart into their dots and binary digits and form again within about a second, drawn on a
  canvas that covers the button's surroundings; the action itself is never delayed.
- **Small birds** report a sent request, a pending draft and the vault route.
- Ambient motion can be paused, stops off screen, and is replaced by a color change under `prefers-reduced-motion`
  and in high-contrast mode. Nothing moves in print.

## Accessibility

- Every interactive element is a real control with a visible focus ring; fields that hide the browser outline ring in
  the text accent, so focus stays visible in both themes.
- Dialogs behave as modals for keyboards and close their menus; the desk keeps working from 360 px wide.
- Status lines are announced, and refusals are shown next to the slip or link they concern.

## Copy

- Public copy is English. The request box also understands Turkish phrasing, but the interface does not use Turkish.
- Say what happens, in the order it happens, and why something is locked. Never claim an unavailable network, a
  disabled transfer or an unfunded payment is active.
- Name assets as their issuers do: "Stock Tokens" in full (never "tokenized stocks"), "xStocks", "USDG", "USDC".
- Keep the non-affiliation statements on the home page, the docs and the stock boards.
- Examples use the handles `@toly`, `@alice`, `@carol` and `@octocat`.
