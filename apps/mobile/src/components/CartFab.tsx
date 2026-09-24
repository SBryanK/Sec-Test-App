import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n } from '../i18n';
import { useCart } from '../state';
import { font, palette, radius, shadow, spacing } from '../theme';
import { Text } from './ui';

/**
 * Floating cart button.
 *
 * Shared across every screen an operator can add a test from. Without it, the
 * flow "configure a test → Add to Cart" leaves you on the category screen with
 * no route to the cart — the cart button lives on the Test tab, but adding an
 * item navigates *back* to the category, not to the tab.
 *
 * Docked above the tab bar and hidden when the cart is empty, so it can never
 * cover a form control.
 */
export function CartFab({ bottomOffset = 0 }: { bottomOffset?: number }): React.JSX.Element | null {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const { configs, credits } = useCart();

  if (configs.length === 0) return null;

  return (
    <Pressable
      onPress={() => router.push('/cart')}
      accessibilityRole="button"
      accessibilityLabel={`${t('test.cart')}, ${configs.length} item(s)`}
      style={({ pressed }) => [
        styles.fab,
        { bottom: insets.bottom + 66 + bottomOffset },
        pressed && { opacity: 0.9, transform: [{ scale: 0.96 }] },
      ]}
    >
      <View style={styles.iconWrap}>
        <Ionicons name="cart" size={21} color="#FFFFFF" />
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{configs.length > 9 ? '9+' : configs.length}</Text>
        </View>
      </View>
      <View>
        <Text variant="micro" style={styles.credits}>
          {credits} CREDIT{credits === 1 ? '' : 'S'}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 54,
    paddingLeft: spacing.md,
    paddingRight: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: palette.primary,
    ...shadow.fab,
  },
  iconWrap: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    top: -7,
    right: -9,
    minWidth: 19,
    height: 19,
    borderRadius: 10,
    backgroundColor: palette.ink,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    borderWidth: 2,
    borderColor: palette.primary,
  },
  badgeText: { color: '#FFFFFF', fontFamily: font.bold, fontSize: 10 },
  credits: { color: 'rgba(255,255,255,0.9)', letterSpacing: 0.4 },
});
