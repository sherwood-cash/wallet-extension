/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Sherwood palette: sand gilt on near-black. A trading terminal wants an
        // unlit ground so the data is the only thing glowing; the blacks carry just
        // enough green to stay in the forest.
        //
        // The `mint*` names are historical — they are the accent slot the whole app
        // reads from, so repointing them recolours every screen at once.
        // The surface ramp, built on #21261f — the tone asked for. Note it carries a green
        // channel lead of its own (R33 G38 B31), so the family is a very dark forest grey
        // rather than a true neutral; everything below is the same hue at lower lightness.
        ink: '#0b0d0a',
        panel: '#121510',
        panel2: '#191d17',
        edge: '#21261f',
        edgeLit: '#333a2f',
        // The accent slot. Sand gilt — the whole app reads its accent from `mint*`,
        // so these names carry the gold rather than any green.
        // Sampled from the logo itself rather than picked by eye: the mark and the favicon
        // both centre on #cdb360, the wordmark on #c6ad60. Guessing a "cleaner" gold gave a
        // brighter yellow that was no longer the brand's. mintBright is the logo's own
        // highlight (~#e1cd91).
        mint: '#cdb360',
        mint2: '#9c8845',
        mintBright: '#e3d199',
        // The pressed-key shadow under anything gilt. Dark enough to read as a cast edge.
        mintDeep: '#8a7532',
        violet: '#7c6cff',
        muted: '#8d8b83',
        // up/down stay green/red — that is a trading convention, not a brand colour
        pos: '#7fc08f',
        neg: '#d98a8a',
        gold: '#cdb360',
        goldBright: '#e3d199',
        goldDim: '#9c8845',
        goldDeep: '#8a7532',
        moss: '#9b988c',
        canopy: '#0b0b09',
        bark: '#5a4632',
        berry: '#c96a72',
        sky: '#7fa8c8',
      },
      fontFamily: {
        // PT Sans first, with a CJK stack behind it for the Chinese locale
        sans: [
          'PT Sans',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'system-ui',
          'sans-serif',
        ],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
        // Cinzel: the engraved serif used for the landing tagline
        display: ['Cinzel', 'Georgia', 'serif'],
      },
      boxShadow: {
        glow: '0 0 40px -14px rgba(194,176,103,0.45)',
        // Panels sit on the forest backdrop, so they need a drop — but a soft one.
        // The hard "sticker ledge" is spent only on the two things you press.
        card: '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 24px 48px -28px rgba(0,0,0,0.95)',
        nub: '0 1px 2px 0 rgba(0,0,0,0.5)',
        // A pressable key. Paired with .press, which flattens it on :active.
        key: '0 3px 0 0 var(--key-shadow, rgba(4,12,8,0.7))',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'pop-in': {
          '0%': { opacity: '0', transform: 'translateY(-8px) scale(0.94)' },
          '65%': { opacity: '1', transform: 'translateY(2px) scale(1.02)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        // cartoon idles
        bob: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-3px)' },
        },
        wobble: {
          '0%, 100%': { transform: 'rotate(0deg)' },
          '25%': { transform: 'rotate(-7deg)' },
          '75%': { transform: 'rotate(7deg)' },
        },
        sway: {
          '0%, 100%': { transform: 'rotate(-3deg)' },
          '50%': { transform: 'rotate(3deg)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.4s ease-out both',
        'fade-in-up': 'fade-in-up 0.5s cubic-bezier(0.16,1,0.3,1) both',
        'scale-in': 'scale-in 0.4s cubic-bezier(0.16,1,0.3,1) both',
        shimmer: 'shimmer 1.6s ease-in-out infinite',
        'pop-in': 'pop-in 0.32s cubic-bezier(0.34,1.56,0.64,1) both',
        bob: 'bob 3s ease-in-out infinite',
        wobble: 'wobble 0.5s ease-in-out',
        sway: 'sway 5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
