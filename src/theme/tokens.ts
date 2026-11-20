/**
 * Zoyra design tokens: "cinematic" theme from the Components board of the Zoyra canvas.
 * Near-black background, red accent with orange / gold companions, red-tinted frosted glass.
 * Key names are kept from the original coral theme so every screen picks up the new palette.
 */

/** `#RRGGBB` + alpha → `rgba(r,g,b,a)`. Use this instead of hand-written rgba literals in screens. */
export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export const colors = {
  bg: '#050505',
  bgSecondary: '#111111',
  bgTertiary: '#1A1A1A',
  surface: '#1E1E1E',
  surfaceElevated: '#2B2B2B',
  /** Cinematic surface ladder (lightest last). */
  surface1: '#111111',
  surface2: '#1A1A1A',
  surface3: '#1E1E1E',
  surface4: '#2B2B2B',
  playerBg: '#0A0A0A',

  accent: '#FA2D48',
  accentLight: '#FF7A8C',
  accentDark: '#8E0B14',
  accentTint: 'rgba(250,45,72,0.18)',
  red: '#FA2D48',
  orange: '#FF6F91',
  gold: '#FFB020',
  amber: '#FDCB6E',
  rose: '#FF6B81',
  /** Pale neutral used for player timestamps and soft highlights. */
  peach: '#E5E5E5',
  /** Legacy "violet" companion now maps to the cinematic orange. */
  violet: '#FF6F91',
  violetLight: '#FFB27A',
  violetDeep: '#7F1D1D',
  /** Legacy "indigo" companion now maps to deep red. */
  indigo: '#C8203A',
  indigoLight: '#FF7A8C',
  /** Legacy "sky" companion now maps to gold. */
  sky: '#FFB020',
  mint: '#34D399',

  text: '#F5F5F5',
  textSecondary: '#A3A3A3',
  textTertiary: '#5C5C5C',
  /** Text / icons on accent (red) fills. */
  onAccent: '#FFFFFF',
  /** Text / icons on light (white) fills, e.g. the selected pill chip. */
  onLight: '#050505',
  white: '#FFFFFF',
  black: '#000000',

  success: '#00B894',
  warning: '#FDCB6E',
  error: '#FF6B6B',
  info: '#74B9FF',
  like: '#FF6B81',
  live: '#FF4B4B',

  track: '#2B2B2B',
  trackLight: '#3A3A3A',
  border: '#2B2B2B',
  handle: '#4A4A4A',
  divider: 'rgba(255,255,255,0.06)',
  hairline: 'rgba(255,255,255,0.1)',
  /** Unselected pill chip outline. */
  chipOutline: 'rgba(255,255,255,0.14)',

  /** Flat glass fallback (the Glass component draws the full 145deg gradient). */
  glass: 'rgba(255,255,255,0.07)',
  glassBorder: 'rgba(255,255,255,0.16)',
  glassStrong: 'rgba(20,20,20,0.88)',
  glassTop: 'rgba(255,255,255,0.14)',
  glassMid: 'rgba(255,255,255,0.04)',
  glassTint: 'rgba(250,45,72,0.05)',
  glassHighlight: 'rgba(255,255,255,0.28)',
  /** Frosted panel over artwork (stat widgets, frosted sheets). */
  frost: 'rgba(20,20,20,0.6)',
  sheet: 'rgba(28,28,28,0.92)',
  overlay: 'rgba(0,0,0,0.7)',
  chipGhost: 'rgba(255,255,255,0.1)',
  iconGhost: 'rgba(255,255,255,0.08)',
  /** Dark round backing for icons drawn over artwork. */
  scrim: 'rgba(0,0,0,0.4)',
  /** Darken layer over images (busy / edit states). */
  shade: 'rgba(0,0,0,0.45)',
  shadow: '#000000',
  /** Light-theme preview paper (Theme screen). */
  paper: '#F4F3FA',
} as const;

/** Two-stop 135deg gradients used for album art, avatars and tiles. */
export const art = {
  /** Kept for compatibility: now the red gradient. */
  coral: ['#FA2D48', '#3A0B16'],
  /** Kept for compatibility: now the red gradient. */
  cyan: ['#FA2D48', '#3A0B16'],
  red: ['#FA2D48', '#3A0B16'],
  /** Kept for compatibility: now the orange gradient. */
  violet: ['#FF6F91', '#4A0D14'],
  orange: ['#FF6F91', '#4A0D14'],
  amber: ['#FDCB6E', '#5C3A12'],
  rose: ['#FF6B81', '#5A1B3A'],
  blue: ['#74B9FF', '#16305F'],
  green: ['#00B894', '#0F4A3A'],
  /** Logo tile and brand highlights. */
  sunrise: ['#FA2D48', '#FF6F91'],
  hot: ['#FF6F91', '#FF6B81'],
  logo: ['#FA2D48', '#FF6F91'],
} as const satisfies Record<string, readonly [string, string]>;

export type ArtName = keyof typeof art;
export const artCycle: ArtName[] = ['red', 'orange', 'rose', 'amber', 'blue', 'green'];

/** Multi-stop vertical backgrounds (player, lyrics, vinyl). */
export const gradients = {
  player: ['#3A0B16', '#2A080C', '#0A0A0A'],
  lyrics: ['#3A0B16', '#1A0508', '#0A0A0A'],
  /** Vinyl groove wedge colours (dark, light, highlight). */
  vinyl: ['#1A1A1A', '#2B2B2B', '#3A3A3A'],
  wrapped: ['#C8203A', '#FF6B81', '#FDCB6E'],
  /** Poster hero: dark red → near-black (165deg) under red / rose glows. */
  poster: ['#3A0B16', '#050505'],
} as const;

/** Solid genre tile colors (Search › Browse all, genre picker). */
export const tile = {
  coral: '#8E0B14',
  rose: '#7F1D1D',
  bronze: '#8A5A12',
  gold: '#7A5200',
  blue: '#2757B8',
  green: '#0F6E56',
  navy: '#1E1E1E',
} as const;

export const radius = {
  xs: 10,
  sm: 14,
  md: 22,
  pill: 24,
  card: 26,
  lg: 28,
  xl: 32,
  xxl: 36,
  round: 999,
} as const;

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48, 16: 64 } as const;

/** Screen side gutter and top inset used on every artboard (status area is 56 px tall in the mocks). */
export const layout = {
  gutter: 16,
  topPad: 56,
  minTouch: 44,
} as const;

export const fonts = {
  extraLight: 'Inter_200ExtraLight',
  light: 'Inter_300Light',
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  extraBold: 'Inter_800ExtraBold',
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
} as const;

export type Weight = 200 | 300 | 400 | 500 | 600 | 700 | 800;
export const fontForWeight = (w: Weight): string =>
  w >= 800 ? fonts.extraBold : w >= 700 ? fonts.bold : w >= 600 ? fonts.semibold : w >= 500 ? fonts.medium : w >= 400 ? fonts.regular : w >= 300 ? fonts.light : fonts.extraLight;

/** Type scale (size / weight / letterSpacing). */
export const type = {
  hero: { fontSize: 32, weight: 700, letterSpacing: -0.5 },
  /** Cinematic page title: light 300 with tight tracking. */
  display: { fontSize: 28, weight: 300, letterSpacing: -0.5 },
  /** Cinematic big light headline ("Hi Kottai, Welcome back"). */
  displayLight: { fontSize: 42, weight: 300, letterSpacing: -1.2 },
  /** Light sub-headline (frosted sheets, section heroes). */
  headlineLight: { fontSize: 30, weight: 300, letterSpacing: -0.8 },
  title: { fontSize: 24, weight: 700, letterSpacing: -0.3 },
  section: { fontSize: 18, weight: 600, letterSpacing: 0 },
  body: { fontSize: 16, weight: 400, letterSpacing: 0 },
  bodyStrong: { fontSize: 16, weight: 600, letterSpacing: 0 },
  small: { fontSize: 14, weight: 400, letterSpacing: 0 },
  caption: { fontSize: 12, weight: 500, letterSpacing: 0.2 },
  overline: { fontSize: 10, weight: 700, letterSpacing: 1.5 },
} as const satisfies Record<string, { fontSize: number; weight: Weight; letterSpacing: number }>;

export type TypeVariant = keyof typeof type;

/** Hard "sticker" drop shadow used on buttons, tiles and badges. */
export const shadow = {
  sticker: {
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  stickerSm: {
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  float: {
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  artGlow: {
    shadowColor: '#000',
    shadowOpacity: 0.6,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 16,
  },
  /** Frosted glass card drop shadow: 0 14px 34px rgba(0,0,0,.38). */
  glass: {
    shadowColor: '#000',
    shadowOpacity: 0.38,
    shadowRadius: 17,
    shadowOffset: { width: 0, height: 14 },
    elevation: 8,
  },
} as const;

/**
 * Soft coloured glow (CSS `0 0 Npx color`). iOS renders it as a coloured shadow; Android elevation
 * shadows can't be tinted reliably, so it is a no-op there (the flat fill still reads well).
 */
export function glow(color: string, radius = 15, opacity = 0.55) {
  return {
    shadowColor: color,
    shadowOpacity: opacity,
    shadowRadius: radius,
    shadowOffset: { width: 0, height: 0 },
  } as const;
}

/** Motion tokens from the Transitions board. */
export const motion = {
  instant: 100,
  fast: 150,
  normal: 220,
  slow: 500,
  emphasis: 800,
  /** Screen push: slide distance (px). */
  pushDistance: 24,
  /** List stagger: rise distance (px), step (ms) and max animated items. */
  staggerRise: 16,
  staggerStep: 25,
  staggerMax: 6,
} as const;
