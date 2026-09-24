import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import React, { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as RNText,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
  type RefreshControlProps,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  font,
  fontSize,
  palette,
  radius,
  shadow,
  spacing,
  useResponsive,
} from '../theme';

/* ------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------ */

type TextTone = 'default' | 'muted' | 'subtle' | 'primary' | 'danger' | 'success' | 'inverse';
type TextVariant = 'display' | 'h1' | 'h2' | 'h3' | 'body' | 'bodyLg' | 'small' | 'tiny' | 'micro';

const toneColor: Record<TextTone, string> = {
  default: palette.ink,
  muted: palette.inkMuted,
  subtle: palette.inkSubtle,
  primary: palette.primary,
  danger: palette.danger,
  success: palette.success,
  inverse: '#FFFFFF',
};

const variantStyle: Record<TextVariant, TextStyle> = {
  display: { fontFamily: font.extrabold, fontSize: fontSize.display, lineHeight: 36, letterSpacing: -0.6 },
  h1: { fontFamily: font.bold, fontSize: fontSize.h1, lineHeight: 32, letterSpacing: -0.5 },
  h2: { fontFamily: font.bold, fontSize: fontSize.h2, lineHeight: 27, letterSpacing: -0.3 },
  h3: { fontFamily: font.semibold, fontSize: fontSize.h3, lineHeight: 23, letterSpacing: -0.2 },
  bodyLg: { fontFamily: font.regular, fontSize: fontSize.bodyLg, lineHeight: 24 },
  body: { fontFamily: font.regular, fontSize: fontSize.body, lineHeight: 22 },
  small: { fontFamily: font.regular, fontSize: fontSize.small, lineHeight: 19 },
  tiny: { fontFamily: font.medium, fontSize: fontSize.tiny, lineHeight: 15 },
  micro: { fontFamily: font.semibold, fontSize: fontSize.micro, lineHeight: 13, letterSpacing: 0.4 },
};

export interface TextProps {
  children?: ReactNode;
  variant?: TextVariant;
  tone?: TextTone;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  mono?: boolean;
  center?: boolean;
  /** Allow long-press selection — useful for copying a header value or URL. */
  selectable?: boolean;
}

export function Text({
  children,
  variant = 'body',
  tone = 'default',
  style,
  numberOfLines,
  mono,
  center,
  selectable,
}: TextProps): React.JSX.Element {
  return (
    <RNText
      selectable={selectable}
      numberOfLines={numberOfLines}
      style={[
        variantStyle[variant],
        { color: toneColor[tone] },
        mono && { fontFamily: undefined, fontVariant: ['tabular-nums'] as const },
        center && { textAlign: 'center' },
        style,
      ]}
    >
      {children}
    </RNText>
  );
}

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

export interface ScreenProps {
  children: ReactNode;
  /** Apply horizontal gutters (default true). */
  padded?: boolean;
  scroll?: boolean;
  background?: string;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  /** Extra bottom padding, e.g. to clear a floating action button. */
  bottomInset?: number;
  refreshControl?: React.ReactElement<RefreshControlProps>;
}

export function Screen({
  children,
  padded = true,
  scroll = false,
  background = palette.canvas,
  style,
  contentStyle,
  bottomInset = 0,
  refreshControl,
}: ScreenProps): React.JSX.Element {
  const { gutter, contentWidth, width } = useResponsive();
  const insets = useSafeAreaInsets();

  const inner: StyleProp<ViewStyle> = [
    padded && { paddingHorizontal: gutter },
    contentWidth < width && { width: contentWidth, alignSelf: 'center' },
    { paddingBottom: insets.bottom + bottomInset + spacing.xl },
    contentStyle,
  ];

  if (scroll) {
    return (
      <ScrollView
        style={[{ flex: 1, backgroundColor: background }, style]}
        contentContainerStyle={inner}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        refreshControl={refreshControl}
      >
        {children}
      </ScrollView>
    );
  }

  return (
    <View style={[{ flex: 1, backgroundColor: background }, style]}>
      <View style={[{ flex: 1 }, inner]}>{children}</View>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Header
 * ------------------------------------------------------------------ */

export interface HeaderProps {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  right?: ReactNode;
  /** Centre the title, matching the Test/History screens. */
  centered?: boolean;
  large?: boolean;
}

export function Header({
  title,
  subtitle,
  onBack,
  right,
  centered = false,
  large = false,
}: HeaderProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const { isCompact } = useResponsive();

  return (
    <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.headerRow}>
        <View style={[styles.headerSide, centered && styles.headerSideFixed]}>
          {onBack ? (
            <Pressable
              onPress={onBack}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Go back"
              style={({ pressed }) => [styles.backButton, pressed && { opacity: 0.5 }]}
            >
              <Ionicons name="arrow-back" size={22} color={palette.ink} />
            </Pressable>
          ) : null}
        </View>

        <View style={[styles.headerTitleWrap, centered && { alignItems: 'center' }]}>
          <Text
            variant={large ? 'h1' : 'h2'}
            numberOfLines={2}
            center={centered}
            style={isCompact && !large ? { fontSize: fontSize.h3 } : undefined}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text variant="small" tone="muted" center={centered} style={{ marginTop: 2 }}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        <View style={[styles.headerSide, styles.headerSideRight]}>{right}</View>
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Card
 * ------------------------------------------------------------------ */

export interface CardProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
}

export function Card({ children, style, padded = true, onPress, accessibilityLabel }: CardProps): React.JSX.Element {
  const content = (
    <View style={[styles.card, padded && { padding: spacing.lg }, style]}>{children}</View>
  );

  if (!onPress) return content;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [pressed && { opacity: 0.88, transform: [{ scale: 0.995 }] }]}
    >
      {content}
    </Pressable>
  );
}

/* ------------------------------------------------------------------ *
 * Button
 * ------------------------------------------------------------------ */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: keyof typeof Ionicons.glyphMap;
  iconRight?: keyof typeof Ionicons.glyphMap;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  disabled,
  loading,
  fullWidth,
  style,
}: ButtonProps): React.JSX.Element {
  const isDisabled = disabled || loading;

  const heights: Record<ButtonSize, number> = { sm: 38, md: 48, lg: 54 };
  const textVariant: TextVariant = size === 'sm' ? 'small' : 'bodyLg';

  const bg: Record<ButtonVariant, string> = {
    primary: palette.primary,
    secondary: palette.surfaceAlt,
    ghost: 'transparent',
    danger: palette.danger,
    success: palette.success,
  };
  const fg: Record<ButtonVariant, string> = {
    primary: '#FFFFFF',
    secondary: palette.ink,
    ghost: palette.primary,
    danger: '#FFFFFF',
    success: '#FFFFFF',
  };

  return (
    <Pressable
      onPress={isDisabled ? undefined : onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      style={({ pressed }) => [
        styles.button,
        {
          height: heights[size],
          backgroundColor: bg[variant],
          borderWidth: variant === 'secondary' ? 1 : 0,
          borderColor: palette.line,
        },
        fullWidth && { alignSelf: 'stretch' },
        variant === 'primary' && !isDisabled && shadow.card,
        pressed && !isDisabled && { opacity: 0.85 },
        isDisabled && { opacity: 0.45 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={fg[variant]} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={size === 'sm' ? 15 : 18} color={fg[variant]} /> : null}
          <Text variant={textVariant} style={{ color: fg[variant], fontFamily: font.semibold }}>
            {label}
          </Text>
          {iconRight ? (
            <Ionicons name={iconRight} size={size === 'sm' ? 15 : 18} color={fg[variant]} />
          ) : null}
        </>
      )}
    </Pressable>
  );
}

/** Prominent gradient call-to-action used for "Run All Tests". */
export function GradientButton({
  label,
  sublabel,
  onPress,
  icon = 'flash',
  disabled,
  loading,
}: {
  label: string;
  sublabel?: string;
  onPress?: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  disabled?: boolean;
  loading?: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={disabled || loading ? undefined : onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        { borderRadius: radius.xl, overflow: 'hidden' },
        shadow.raised,
        pressed && !disabled && { opacity: 0.9 },
        (disabled || loading) && { opacity: 0.5 },
      ]}
    >
      <LinearGradient
        colors={['#4C88FF', '#2A62D6']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.gradientButton}
      >
        <View style={styles.gradientIcon}>
          {loading ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Ionicons name={icon} size={22} color="#FFFFFF" />
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="h3" style={{ color: '#FFFFFF' }}>
            {label}
          </Text>
          {sublabel ? (
            <Text variant="small" style={{ color: 'rgba(255,255,255,0.82)', marginTop: 1 }}>
              {sublabel}
            </Text>
          ) : null}
        </View>
        <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.9)" />
      </LinearGradient>
    </Pressable>
  );
}

/* ------------------------------------------------------------------ *
 * Chips & badges
 * ------------------------------------------------------------------ */

export function Chip({
  label,
  selected,
  onPress,
  icon,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.chip,
        selected && { backgroundColor: palette.primarySoft, borderColor: palette.primaryBorder },
        pressed && { opacity: 0.75 },
      ]}
    >
      {icon ? (
        <Ionicons name={icon} size={14} color={selected ? palette.primaryDark : palette.inkMuted} />
      ) : null}
      <Text
        variant="small"
        style={{
          color: selected ? palette.primaryDark : palette.ink,
          fontFamily: selected ? font.semibold : font.medium,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Badge({
  label,
  fg,
  bg,
  icon,
  size = 'md',
}: {
  label: string;
  fg: string;
  bg: string;
  icon?: keyof typeof Ionicons.glyphMap;
  size?: 'sm' | 'md';
}): React.JSX.Element {
  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: bg },
        size === 'sm' && { paddingVertical: 2, paddingHorizontal: spacing.sm },
      ]}
    >
      {icon ? <Ionicons name={icon} size={size === 'sm' ? 10 : 12} color={fg} /> : null}
      <Text
        variant="micro"
        style={{ color: fg, fontSize: size === 'sm' ? 9 : 10 }}
      >
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

export function ProgressBar({
  value,
  color = palette.primary,
  height = 8,
  track = palette.surfaceSunken,
}: {
  value: number;
  color?: string;
  height?: number;
  track?: string;
}): React.JSX.Element {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <View style={{ height, borderRadius: height / 2, backgroundColor: track, overflow: 'hidden' }}>
      <View
        style={{
          width: `${pct * 100}%`,
          height: '100%',
          borderRadius: height / 2,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

export function StatTile({
  label,
  value,
  tone = 'default',
  icon,
  style,
}: {
  label: string;
  value: string | number;
  tone?: 'default' | 'success' | 'danger' | 'primary' | 'muted';
  icon?: keyof typeof Ionicons.glyphMap;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const colors: Record<string, { bg: string; fg: string }> = {
    default: { bg: palette.surfaceAlt, fg: palette.ink },
    success: { bg: palette.successSoft, fg: palette.success },
    danger: { bg: palette.dangerSoft, fg: palette.danger },
    primary: { bg: palette.primarySoft, fg: palette.primaryDark },
    muted: { bg: palette.surfaceSunken, fg: palette.inkMuted },
  };
  const c = colors[tone] ?? colors.default!;

  return (
    <View style={[styles.statTile, { backgroundColor: c.bg }, style]}>
      {icon ? <Ionicons name={icon} size={15} color={c.fg} /> : null}
      <Text variant="small" tone="muted" style={{ marginTop: spacing.xs }}>
        {label}
      </Text>
      <Text variant="h3" style={{ color: c.fg, marginTop: 1 }}>
        {value}
      </Text>
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  message?: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon} size={30} color={palette.primary} />
      </View>
      <Text variant="h3" center style={{ marginTop: spacing.md }}>
        {title}
      </Text>
      {message ? (
        <Text variant="small" tone="muted" center style={{ marginTop: spacing.xs, maxWidth: 300 }}>
          {message}
        </Text>
      ) : null}
      {action ? <View style={{ marginTop: spacing.lg }}>{action}</View> : null}
    </View>
  );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }): React.JSX.Element {
  return <View style={[styles.divider, style]} />;
}

export function Banner({
  tone,
  message,
  icon,
}: {
  tone: 'error' | 'warning' | 'info' | 'success';
  message: string;
  icon?: keyof typeof Ionicons.glyphMap;
}): React.JSX.Element {
  const map = {
    error: { bg: palette.dangerSoft, fg: '#A8282C', icon: 'alert-circle' as const },
    warning: { bg: palette.warningSoft, fg: '#8A6100', icon: 'warning' as const },
    info: { bg: palette.infoSoft, fg: palette.primaryDark, icon: 'information-circle' as const },
    success: { bg: palette.successSoft, fg: '#137247', icon: 'checkmark-circle' as const },
  };
  const c = map[tone];

  return (
    <View style={[styles.banner, { backgroundColor: c.bg }]}>
      <Ionicons name={icon ?? c.icon} size={17} color={c.fg} />
      <Text variant="small" style={{ color: c.fg, flex: 1 }}>
        {message}
      </Text>
    </View>
  );
}

/** Monospace evidence block, horizontally scrollable when lines are long. */
export function CodeBlock({ children }: { children: string }): React.JSX.Element {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.code}>
      <Text variant="tiny" style={styles.codeText}>
        {children}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingBottom: spacing.md,
    backgroundColor: palette.canvas,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
    minHeight: 44,
  },
  headerSide: { minWidth: 44, justifyContent: 'center' },
  headerSideFixed: { width: 44 },
  headerSideRight: { alignItems: 'flex-end' },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitleWrap: { flex: 1, justifyContent: 'center' },

  card: {
    backgroundColor: palette.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: palette.line,
    ...shadow.card,
  },

  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.lg,
  },
  gradientButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  gradientIcon: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surface,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingVertical: 3,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },

  statTile: {
    flex: 1,
    minWidth: 96,
    padding: spacing.md,
    borderRadius: radius.lg,
  },

  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.huge,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: radius.pill,
    backgroundColor: palette.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },

  divider: { height: 1, backgroundColor: palette.line, marginVertical: spacing.lg },

  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
  },

  code: {
    backgroundColor: palette.navy,
    borderRadius: radius.md,
    padding: spacing.md,
    maxHeight: 240,
  },
  codeText: {
    color: '#D7E3F4',
    fontFamily: 'monospace',
    lineHeight: 17,
  },
});
