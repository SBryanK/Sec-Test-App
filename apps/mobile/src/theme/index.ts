import { Dimensions, Platform, PixelRatio, useWindowDimensions } from 'react-native';

/**
 * Design tokens.
 *
 * Modernised from the reference screenshots: same blue/near-black identity, but
 * with a restrained surface palette, consistent 4pt spacing rhythm and a single
 * radius scale so every card, input and chip lines up across the app.
 */

export const palette = {
  /** Brand */
  primary: '#3B7DFF',
  primaryDark: '#2A62D6',
  primarySoft: '#E8F0FF',
  primaryBorder: '#C7DBFF',

  /** Neutrals */
  ink: '#0B1B33',
  inkMuted: '#5A6478',
  inkSubtle: '#8A94A6',
  line: '#E3E9F2',
  lineStrong: '#CDD7E5',
  surface: '#FFFFFF',
  surfaceAlt: '#F7F9FC',
  surfaceSunken: '#EFF3F9',
  canvas: '#FFFFFF',

  /** Status */
  success: '#1FA463',
  successSoft: '#E3F6EC',
  warning: '#E0A008',
  warningSoft: '#FDF3DC',
  danger: '#DC3E42',
  dangerSoft: '#FDE9EA',
  info: '#3B7DFF',
  infoSoft: '#E8F0FF',

  /** Verdicts */
  blocked: '#1FA463',
  blockedSoft: '#E3F6EC',
  bypassed: '#DC3E42',
  bypassedSoft: '#FDE9EA',
  passed: '#3B7DFF',
  passedSoft: '#E8F0FF',
  errored: '#8A94A6',
  erroredSoft: '#EFF3F9',

  /** Brand mark */
  navy: '#0B1B33',
  navySoft: '#16294A',
} as const;

export const severityColor: Record<string, { fg: string; bg: string }> = {
  critical: { fg: '#8E1B1F', bg: '#FBD5D7' },
  high: { fg: '#B4441A', bg: '#FCE4D6' },
  medium: { fg: '#8A6100', bg: '#FDF1D6' },
  low: { fg: '#1F5BB5', bg: '#E4EDFD' },
  info: { fg: '#5A6478', bg: '#EFF3F9' },
};

export const verdictColor: Record<string, { fg: string; bg: string }> = {
  blocked: { fg: '#137247', bg: palette.blockedSoft },
  bypassed: { fg: '#A8282C', bg: palette.bypassedSoft },
  passed: { fg: '#1F5BB5', bg: palette.passedSoft },
  error: { fg: '#5A6478', bg: palette.erroredSoft },
  inconclusive: { fg: '#5A6478', bg: palette.erroredSoft },
};

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 40,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 26,
  pill: 999,
} as const;

export const fontSize = {
  micro: 10,
  tiny: 11,
  small: 13,
  body: 15,
  bodyLg: 16,
  h3: 17,
  h2: 21,
  h1: 26,
  display: 30,
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  extrabold: '800',
} as const;

/** Font family names as registered by expo-font. */
export const font = {
  regular: 'PlusJakartaSans_400Regular',
  medium: 'PlusJakartaSans_500Medium',
  semibold: 'PlusJakartaSans_600SemiBold',
  bold: 'PlusJakartaSans_700Bold',
  extrabold: 'PlusJakartaSans_800ExtraBold',
} as const;

export const shadow = {
  none: {},
  card: Platform.select({
    ios: {
      shadowColor: '#0B1B33',
      shadowOpacity: 0.06,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 4 },
    },
    android: { elevation: 2 },
    default: {},
  }),
  raised: Platform.select({
    ios: {
      shadowColor: '#0B1B33',
      shadowOpacity: 0.12,
      shadowRadius: 20,
      shadowOffset: { width: 0, height: 8 },
    },
    android: { elevation: 6 },
    default: {},
  }),
  fab: Platform.select({
    ios: {
      shadowColor: '#2A62D6',
      shadowOpacity: 0.32,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 8 },
    },
    android: { elevation: 8 },
    default: {},
  }),
} as const;

/* ------------------------------------------------------------------ *
 * Responsive layout
 * ------------------------------------------------------------------ */

const BASE_WIDTH = 390; // iPhone 14 / Pixel-width reference

export interface Responsive {
  width: number;
  height: number;
  /** 0.85 – 1.25 multiplier applied to type and spacing. */
  scale: number;
  isCompact: boolean;
  isTablet: boolean;
  /** Max content width so lines stay readable on tablets and foldables. */
  contentWidth: number;
  gutter: number;
}

/**
 * Screen-fit strategy.
 *
 * Rather than hard-coding sizes, every screen lays out against a scale derived
 * from the *smallest* usable dimension. Compact phones (≤360dp) get tighter
 * gutters and slightly smaller type; tablets get a centred, width-capped column
 * instead of stretching cards across a 1000dp canvas.
 */
export function useResponsive(): Responsive {
  const { width, height } = useWindowDimensions();
  const shortest = Math.min(width, height);

  const rawScale = shortest / BASE_WIDTH;
  const scale = Math.max(0.85, Math.min(rawScale, 1.25));

  const isTablet = Math.min(width, height) >= 600;
  const isCompact = width <= 360;

  const gutter = isCompact ? spacing.lg : spacing.xl;
  const contentWidth = isTablet ? 640 : width;

  return { width, height, scale, isCompact, isTablet, contentWidth, gutter };
}

/** Font scale that respects the user's OS accessibility setting. */
export function scaledFont(size: number): number {
  return Math.round(size * Math.min(PixelRatio.getFontScale(), 1.3));
}

export function screenWidth(): number {
  return Dimensions.get('window').width;
}
