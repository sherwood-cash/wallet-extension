// Inline SVG icon set — currentColor, no asset deps. Strokes are deliberately fat
// and round-capped: a hairline icon next to a sticker button looks like a typo.
import { useState } from 'react'
import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement>
const base = (p: P) => ({
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  ...p,
})

export const Shield = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
    <path d="M9.2 12l2 2 3.6-4" />
  </svg>
)

export const Wallet = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="6" width="18" height="13" rx="2.5" />
    <path d="M16 12h2.5" />
    <path d="M3 9h13a2 2 0 012 2" />
  </svg>
)

export const Trophy = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 4h10v5a5 5 0 01-10 0V4z" />
    <path d="M7 6H4.5v1.5A3.5 3.5 0 007.6 11" />
    <path d="M17 6h2.5v1.5A3.5 3.5 0 0116.4 11" />
    <path d="M12 14v3.5" />
    <path d="M8.5 20h7" />
    <path d="M10 20c.2-1.4.8-2.3 2-2.5 1.2.2 1.8 1.1 2 2.5" />
  </svg>
)

export const Menu = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 7h16" />
    <path d="M4 12h16" />
    <path d="M4 17h16" />
  </svg>
)

export const Close = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12" />
    <path d="M18 6L6 18" />
  </svg>
)

export const Eye = (p: P) => (
  <svg {...base(p)}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

export const EyeOff = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 3l18 18" />
    <path d="M10.6 6.2A9.8 9.8 0 0112 6c6.5 0 10 6 10 6a16 16 0 01-3.3 3.9" />
    <path d="M6.2 6.6A16 16 0 002 12s3.5 6 10 6a9.6 9.6 0 003.9-.8" />
    <path d="M9.9 9.9a3 3 0 004.2 4.2" />
  </svg>
)

export const ExternalLink = (p: P) => (
  <svg {...base(p)}>
    <path d="M14 4h6v6" />
    <path d="M20 4l-9 9" />
    <path d="M19 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2h4" />
  </svg>
)

export const ChevronDown = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 9l6 6 6-6" />
  </svg>
)

export const LogOut = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 21H6a2 2 0 01-2-2V5a2 2 0 012-2h3" />
    <path d="M16 17l5-5-5-5" />
    <path d="M21 12H9" />
  </svg>
)

export const Copy = (p: P) => (
  <svg {...base(p)}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 012-2h10" />
  </svg>
)

export const Refresh = (p: P) => (
  <svg {...base(p)}>
    <path d="M21 12a9 9 0 11-2.6-6.4" />
    <path d="M21 4v5h-5" />
  </svg>
)

export const History = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 3v5h5" />
    <path d="M3.05 11a9 9 0 1 0 2.13-5.66L3 8" />
    <path d="M12 7v5l3 2" />
  </svg>
)

export const Plus = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </svg>
)

export const Help = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.6 9.2a2.5 2.5 0 114.2 2.1c-.9.7-1.8 1.2-1.8 2.4" />
    <path d="M12 17h.01" />
  </svg>
)

/** Cards view: four panes of equal weight, which is what the grid shows. */
export const GridView = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
  </svg>
)

/** Heatmap view: panes of unequal weight — the treemap's whole point, in a 20px glyph. */
export const TreemapView = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.5" y="3.5" width="10.5" height="11" rx="1.6" />
    <rect x="17" y="3.5" width="3.5" height="5" rx="1.2" />
    <rect x="17" y="11" width="3.5" height="3.5" rx="1.2" />
    <rect x="3.5" y="17" width="6" height="3.5" rx="1.2" />
    <rect x="12.5" y="17" width="8" height="3.5" rx="1.2" />
  </svg>
)

/**
 * Bridge: a deck on two towers, cables sagging between them.
 *
 * Not a shield — that is what the vault uses, and the bridge is the one tab that hands
 * value to something outside it, which is the opposite claim.
 */
export const Bridge = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 16.5h18" />
    <path d="M7 16.5V5.5" />
    <path d="M17 16.5V5.5" />
    <path d="M3 12.2c2.2 0 4-3 4-6.7" />
    <path d="M7 5.5c0 3.7 2.2 6.7 5 6.7s5-3 5-6.7" />
    <path d="M17 5.5c0 3.7 1.8 6.7 4 6.7" />
  </svg>
)

// A clean, symmetric 6-tooth gear (Heroicons cog-6-tooth), which reads far better at
// 15–18px than the old hand-drawn path that looked lopsided in the toolbar.
export const Cog = (p: P) => (
  <svg {...base(p)}>
    <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.214 1.28c.062.375.312.687.644.87.074.04.147.084.22.128.326.196.72.257 1.077.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.004.827c-.292.24-.437.613-.43.992.004.085.004.17 0 .255-.007.378.138.75.43.99l1.004.828c.424.35.534.954.26 1.43l-1.297 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.332.183-.582.495-.644.869l-.214 1.281c-.09.543-.56.94-1.11.94h-2.593c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.063-.374-.313-.686-.645-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.828c.292-.24.437-.612.43-.99a7.03 7.03 0 010-.255c.007-.38-.138-.751-.43-.991l-1.004-.827a1.125 1.125 0 01-.26-1.431l1.297-2.247a1.125 1.125 0 011.37-.49l1.216.455c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

export const Info = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <path d="M12 8h.01" />
  </svg>
)

export const ArrowDown = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14" />
    <path d="M6 13l6 6 6-6" />
  </svg>
)

export const ArrowUp = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 19V5" />
    <path d="M6 11l6-6 6 6" />
  </svg>
)

/* ---- storybook forest set ------------------------------------------------
   Solid, filled shapes rather than outlines — these are the props of the set
   (leaves, acorns, toadstools), so they should read at 14px like a sticker. */

export const Leaf = (p: P) => (
  <svg {...base({ fill: 'currentColor', stroke: 'none', ...p })}>
    <path d="M20 3c-8.5-.6-14 3.2-14 9.3 0 2 .6 3.7 1.7 5L4.6 20a1 1 0 001.4 1.4l3-3a8 8 0 004.6 1.4C19 19.8 21 14 20 3z" />
    <path
      d="M17 6.5c-4 1.6-7 4.6-8.8 8.6"
      stroke="#0f0d06"
      strokeWidth={1.6}
      strokeLinecap="round"
      opacity={0.35}
      fill="none"
    />
  </svg>
)

export const Acorn = (p: P) => (
  <svg {...base({ fill: 'currentColor', stroke: 'none', ...p })}>
    <path d="M5.2 9h13.6a1 1 0 00.7-1.7C17.9 5.7 15.2 4.4 12 4.4S6.1 5.7 4.5 7.3A1 1 0 005.2 9z" />
    <path d="M6.2 10.6h11.6c-.3 5.6-2.9 9-5.8 9s-5.5-3.4-5.8-9z" opacity={0.75} />
    <path d="M12 2v2.2" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
  </svg>
)

export const Toadstool = (p: P) => (
  <svg {...base({ fill: 'currentColor', stroke: 'none', ...p })}>
    <path d="M3 11.4C3 7.3 7 4 12 4s9 3.3 9 7.4a1 1 0 01-1 1H4a1 1 0 01-1-1z" />
    <circle cx="8.4" cy="8.6" r="1.5" fill="#0f0d06" opacity={0.45} />
    <circle cx="14.6" cy="7.9" r="1.1" fill="#0f0d06" opacity={0.45} />
    <path d="M9.6 14.4h4.8c-.3 2.4-.3 4.2 0 5.4a1 1 0 01-1 1.2h-2.8a1 1 0 01-1-1.2c.3-1.2.3-3 0-5.4z" opacity={0.7} />
  </svg>
)

/**
 * The hood — Sherwood's mascot, and the wallet's profile picture.
 *
 * Three tones, not one: the hood itself, the shadow inside the opening, and the eyes.
 * A single-colour silhouette at 26px reads as a blob; it is the dark face hole with two
 * lit eyes in it that makes a viewer see someone hooded looking back.
 */
export const Hood = ({
  eyes = '#e0d3a0',
  shadow = '#070806',
  ...p
}: P & { eyes?: string; shadow?: string }) => (
  <svg {...base({ fill: 'currentColor', stroke: 'none', ...p })}>
    {/* cape + shoulders */}
    <path d="M12 21.9c-3.6 0-6.6-1-8.2-2.1.5-3.1 3.3-5.2 5.6-6l2.6 2 2.6-2c2.3.8 5.1 2.9 5.6 6-1.6 1.1-4.6 2.1-8.2 2.1z" />
    {/* the hood, peaked and drawn forward over the brow */}
    <path d="M12 1.5c-4.3 0-7.4 3.6-7.4 8.4 0 3 1 5.6 2.6 7.2.5-2.1 2.4-3.6 4.8-3.6s4.3 1.5 4.8 3.6c1.6-1.6 2.6-4.2 2.6-7.2 0-4.8-3.1-8.4-7.4-8.4z" />
    {/* the opening: everything you can see of the face is shadow */}
    <path d="M12 4.9c-2.7 0-4.6 2.2-4.6 5 0 1.7.7 3.2 1.9 4.1a5.6 5.6 0 015.4 0c1.2-.9 1.9-2.4 1.9-4.1 0-2.8-1.9-5-4.6-5z" fill={shadow} />
    <ellipse cx="10.1" cy="10.2" rx="1.15" ry="1.35" fill={eyes} />
    <ellipse cx="13.9" cy="10.2" rx="1.15" ry="1.35" fill={eyes} />
  </svg>
)

/**
 * Swap: two arrows passing each other, one down one up.
 *
 * Not the circular repeat glyph — that one means "do it again" everywhere else in a UI,
 * and a swap happens once. Two shafts going opposite ways say "these two changed places",
 * which is the actual operation, and it stays legible down to 13px where a loop's
 * arrowhead turns to mush.
 */
export const SwapArrows = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 3.8v16.4" />
    <path d="M4.4 16.6L8 20.2l3.6-3.6" />
    <path d="M16 20.2V3.8" />
    <path d="M12.4 7.4L16 3.8l3.6 3.6" />
  </svg>
)

export const Sparkle = (p: P) => (
  <svg {...base({ fill: 'currentColor', stroke: 'none', ...p })}>
    <path d="M12 2.5l1.9 5.9 5.9 1.9-5.9 1.9L12 18.1l-1.9-5.9L4.2 10.3l5.9-1.9z" />
    <path d="M19.2 15.4l.8 2.3 2.3.8-2.3.8-.8 2.3-.8-2.3-2.3-.8 2.3-.8z" opacity={0.7} />
  </svg>
)

// Spinning loader ring — inherits color from `currentColor`. Used in busy buttons.
export function Spinner({ size = 16, className = '' }: { size?: number; className?: string }) {
  return <span className={`spinner ${className}`} style={{ width: size, height: size }} aria-hidden />
}

// Local token logos (downloaded into /public/tokens). Keyed by uppercased symbol.
const TOKEN_LOGOS: Record<string, string> = {
  USDG: '/tokens/usdg.png',
  USDC: '/tokens/usdc.png',
  WETH: '/tokens/weth.png',
  ETH: '/tokens/eth.png',
  HYPE: '/tokens/hype.png',
  BTC: '/tokens/btc.png',
}

// Circular token badge: real asset logo when we have one, else a colored
// letter fallback (also used if the image fails to load).
//
// Drawn like a profile picture rather than a chart legend swatch: a dark 2px
// collar so it pops off any surface, then the token's own accent as a halo.
export function TokenIcon({
  symbol,
  accent,
  size = 32,
  src,
  plain = false,
}: {
  symbol: string
  accent: string
  size?: number
  src?: string // remote logo, e.g. from the Uniswap token gateway
  /** Drop the collar. For tight rows where an ancestor clips it: a ring sliced off on one
   *  side looks like a rendering fault, and no ring reads better than half a ring. */
  plain?: boolean
}) {
  const logo = src || TOKEN_LOGOS[symbol.toUpperCase()]
  const [failed, setFailed] = useState(false)
  const collar = plain
    ? undefined
    : `0 0 0 2px #0b0d0a, 0 0 0 3.5px ${accent}55, 0 2px 6px -1px rgba(0,0,0,0.7)`

  if (logo && !failed) {
    return (
      <img
        src={logo}
        alt={symbol}
        width={size}
        height={size}
        onError={() => setFailed(true)}
        className="shrink-0 rounded-full"
        style={{ width: size, height: size, boxShadow: collar }}
      />
    )
  }

  return (
    <span
      className="inline-grid shrink-0 place-items-center rounded-full text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        fontWeight: 700,
        background: `radial-gradient(circle at 32% 24%, ${accent}, ${accent}bb 72%)`,
        boxShadow: collar,
        textShadow: '0 1px 1px rgba(0,0,0,0.35)',
      }}
    >
      {symbol.slice(0, 1)}
    </span>
  )
}
