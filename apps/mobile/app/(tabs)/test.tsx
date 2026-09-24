import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import React from 'react';
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CartFab } from '../../src/components/CartFab';
import { GradientButton, Banner, Card, Screen, Text } from '../../src/components/ui';
import { useI18n } from '../../src/i18n';
import { useCart, useCatalog } from '../../src/state';
import { font, palette, radius, shadow, spacing, useResponsive } from '../../src/theme';

export default function TestCatalogScreen(): React.JSX.Element {
  const { t } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { gutter, isCompact, width } = useResponsive();
  const { categories, tests, testCount, ready, error, reload } = useCatalog();
  const { configs, addAll } = useCart();
  const [refreshing, setRefreshing] = React.useState(false);
  const [runAllNote, setRunAllNote] = React.useState<string | null>(null);

  const cardWidth = (Math.min(width, 640) - gutter * 2 - spacing.md) / 2;

  const onRefresh = async (): Promise<void> => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  };

  const startRunAll = (): void => {
    // Uses the most recent target the operator entered; falls back to the cart.
    const domain = configs[0]?.target.domain ?? '';
    if (!domain) {
      setRunAllNote('Add a target first — open any test and enter a domain.');
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    addAll(domain);
    router.push('/cart');
  };

  return (
    <View style={styles.flex}>
      <Screen
        scroll
        padded={false}
        bottomInset={96}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
      >
        <View style={{ paddingHorizontal: gutter, paddingTop: insets.top + spacing.xl }}>
          <Text variant="h1" center>
            {t('test.title')}
          </Text>

          <Pressable
            onPress={() => router.push('/import')}
            accessibilityRole="button"
            style={({ pressed }) => [styles.importRow, pressed && { opacity: 0.6 }]}
          >
            <Ionicons name="document-attach-outline" size={17} color={palette.primary} />
            <Text variant="body" tone="primary" style={{ fontFamily: font.semibold }}>
              {t('test.importConfig')}
            </Text>
          </Pressable>

          {error ? (
            <View style={{ marginBottom: spacing.lg }}>
              <Banner tone="error" message={error} />
            </View>
          ) : null}

          {!ready ? (
            <ActivityIndicator style={{ marginTop: spacing.xxl }} color={palette.primary} />
          ) : null}

          {/* Grid */}
          <View style={styles.grid}>
            {categories.map((category) => {
              const count = category.testIds.length;
              return (
                <Pressable
                  key={category.id}
                  onPress={() => router.push(`/category/${category.id}`)}
                  accessibilityRole="button"
                  accessibilityLabel={`${category.label}, ${count} tests`}
                  style={({ pressed }) => [
                    styles.categoryCard,
                    { width: cardWidth },
                    pressed && { opacity: 0.85, transform: [{ scale: 0.985 }] },
                  ]}
                >
                  <View style={styles.categoryIcon}>
                    <Ionicons
                      name={category.icon as keyof typeof Ionicons.glyphMap}
                      size={26}
                      color={palette.primary}
                    />
                  </View>
                  <Text
                    variant={isCompact ? 'body' : 'h3'}
                    center
                    style={{ marginTop: spacing.md, fontFamily: font.bold }}
                  >
                    {category.label}
                  </Text>
                  <Text variant="tiny" tone="subtle" center style={{ marginTop: 2 }}>
                    {category.blurb}
                  </Text>
                  <View style={styles.countPill}>
                    <Text variant="micro" tone="primary">
                      {count} {count === 1 ? 'TEST' : 'TESTS'}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>

          {/* Run everything at once */}
          <View style={{ marginTop: spacing.lg }}>
            <GradientButton
              label={t('test.runAll')}
              sublabel={t('test.runAllHint', { count: testCount })}
              icon="flash"
              onPress={startRunAll}
            />
          </View>

          {runAllNote ? (
            <View style={{ marginTop: spacing.md }}>
              <Banner tone="warning" message={runAllNote} />
            </View>
          ) : null}

          {/* Catalog summary — makes the "defaults are visible" promise concrete */}
          <Card style={{ marginTop: spacing.lg }}>
            <View style={styles.summaryHead}>
              <Ionicons name="list-outline" size={17} color={palette.ink} />
              <Text variant="small" style={{ fontFamily: font.bold }}>
                {testCount} tests · {categories.length} categories
              </Text>
            </View>
            {tests.map((test) => (
              <Pressable
                key={test.id}
                onPress={() => router.push(`/test/${test.id}`)}
                accessibilityRole="button"
                style={({ pressed }) => [styles.summaryRow, pressed && { opacity: 0.6 }]}
              >
                <Ionicons
                  name={test.icon as keyof typeof Ionicons.glyphMap}
                  size={15}
                  color={palette.primary}
                />
                <Text variant="small" style={{ flex: 1 }} numberOfLines={1}>
                  {test.label}
                </Text>
                <FeasibilityDot feasibility={test.feasibility} />
              </Pressable>
            ))}
          </Card>
        </View>
      </Screen>

      {/* Cart FAB — docked above the tab bar so it never covers form controls */}
      <CartFab />
    </View>
  );
}

/** Small coloured dot explaining where a test actually runs. */
export function FeasibilityDot({
  feasibility,
}: {
  feasibility: 'phone' | 'hybrid' | 'server';
}): React.JSX.Element {
  const map = {
    phone: { color: palette.success, label: 'Runs on device' },
    hybrid: { color: palette.warning, label: 'Device + server executor' },
    server: { color: palette.inkSubtle, label: 'Server executor only' },
  };
  const c = map[feasibility];
  return (
    <View style={[styles.dot, { backgroundColor: c.color }]} accessibilityLabel={c.label} />
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: palette.canvas },
  importRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    marginTop: spacing.md,
    marginBottom: spacing.xl,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  categoryCard: {
    backgroundColor: palette.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: palette.line,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    ...shadow.card,
  },
  categoryIcon: {
    width: 54,
    height: 54,
    borderRadius: radius.lg,
    backgroundColor: palette.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countPill: {
    marginTop: spacing.sm,
    backgroundColor: palette.surfaceAlt,
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
  },
  summaryHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: palette.line,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
