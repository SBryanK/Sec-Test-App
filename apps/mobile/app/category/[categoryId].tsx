import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Badge, Card, Header, Screen, Text } from '../../src/components/ui';
import { CartFab } from '../../src/components/CartFab';
import { useI18n } from '../../src/i18n';
import { useCatalog } from '../../src/state';
import { palette, radius, spacing } from '../../src/theme';

const FEASIBILITY: Record<
  string,
  { label: string; fg: string; bg: string; icon: keyof typeof Ionicons.glyphMap }
> = {
  phone: {
    label: 'Device',
    fg: '#137247',
    bg: palette.successSoft,
    icon: 'phone-portrait-outline',
  },
  hybrid: {
    label: 'Device + server',
    fg: '#8A6100',
    bg: palette.warningSoft,
    icon: 'git-compare-outline',
  },
  server: {
    label: 'Server only',
    fg: '#5A6478',
    bg: palette.surfaceSunken,
    icon: 'server-outline',
  },
};

export default function CategoryScreen(): React.JSX.Element {
  const { categoryId } = useLocalSearchParams<{ categoryId: string }>();
  const router = useRouter();
  const { t } = useI18n();
  const { categories, tests, ready } = useCatalog();

  const category = categories.find((c) => c.id === categoryId);
  const categoryTests = tests.filter((test) => test.category === categoryId);

  return (
    <Screen scroll padded={false}>
      <Header title={t('test.selectType')} onBack={() => router.back()} />

      <View style={styles.body}>
        {category ? (
          <Text variant="small" tone="muted" style={{ marginBottom: spacing.lg }}>
            {category.label} · {categoryTests.length} tests · {category.blurb}
          </Text>
        ) : null}

        {categoryTests.map((test) => {
          const feasibility = FEASIBILITY[test.feasibility] ?? FEASIBILITY.server!;
          return (
            <Pressable
              key={test.id}
              onPress={() => router.push(`/test/${test.id}`)}
              accessibilityRole="button"
              accessibilityLabel={`${test.label}. ${test.blurb}`}
              style={({ pressed }) => [pressed && { opacity: 0.85 }]}
            >
              <Card style={styles.card}>
                <View style={styles.row}>
                  <View style={styles.icon}>
                    <Ionicons
                      name={test.icon as keyof typeof Ionicons.glyphMap}
                      size={19}
                      color={palette.primary}
                    />
                  </View>

                  <View style={{ flex: 1 }}>
                    <Text variant="h3" numberOfLines={2}>
                      {test.label}
                    </Text>
                    <Text variant="small" tone="muted" style={{ marginTop: 2 }} numberOfLines={3}>
                      {test.blurb}
                    </Text>

                    <View style={styles.badges}>
                      <Badge
                        label={feasibility.label}
                        fg={feasibility.fg}
                        bg={feasibility.bg}
                        icon={feasibility.icon}
                        size="sm"
                      />
                      <View style={styles.creditPill}>
                        <Text variant="micro" tone="muted">
                          {test.creditCost} CREDIT{test.creditCost === 1 ? '' : 'S'}
                        </Text>
                      </View>
                    </View>
                  </View>

                  <Ionicons name="chevron-forward" size={19} color={palette.inkSubtle} />
                </View>
              </Card>
            </Pressable>
          );
        })}

        {!ready && categoryTests.length === 0 ? (
          <Text variant="small" tone="muted" center style={{ marginTop: spacing.xxl }}>
            Loading catalog…
          </Text>
        ) : null}

        {ready && categoryTests.length === 0 ? (
          <Text variant="small" tone="muted" center style={{ marginTop: spacing.xxl }}>
            No tests registered for this category.
          </Text>
        ) : null}
      </View>

      <CartFab />
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl },
  card: { marginBottom: spacing.md, padding: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  icon: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    backgroundColor: palette.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badges: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  creditPill: {
    backgroundColor: palette.surfaceAlt,
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
  },
});
