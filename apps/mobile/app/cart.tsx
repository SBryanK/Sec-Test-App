import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import React, { useMemo, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AnonymityMode, AttackConfig } from '@teo/shared';
import { TEST_COUNT, getTest } from '@teo/shared';

import { api } from '../src/api/client';
import { OutlinedInput } from '../src/components/fields';
import { Badge, Banner, Button, Card, EmptyState, Header, Screen, Text } from '../src/components/ui';
import { useI18n } from '../src/i18n';
import { useAuth, useCart } from '../src/state';
import { font, palette, radius, spacing } from '../src/theme';

export default function CartScreen(): React.JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const { configs, credits, remove, clear, addAll } = useCart();
  const { user, refresh } = useAuth();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const targets = useMemo(
    () => [...new Set(configs.map((c) => c.target.domain).filter(Boolean))],
    [configs],
  );
  const mixedTargets = targets.length > 1;
  const isFullSet = configs.length === TEST_COUNT && !mixedTargets;

  const insufficient = user !== null && credits > user.creditsRemaining;

  const start = async (): Promise<void> => {
    if (configs.length === 0) return;
    if (mixedTargets) {
      setError('All cart items must share one target before starting a run.');
      return;
    }
    if (!configs[0]?.target.domain.trim()) {
      setError('Domain cannot be empty');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const { run } = await api.createRun({
        configs,
        mode: configs.length === 1 ? 'single' : isFullSet ? 'batch' : 'custom',
        device: `${Platform.OS} ${Platform.Version}`,
        platform: Platform.OS,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      clear();
      void refresh();
      router.replace(`/run/${run.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(false);
    }
  };

  const confirmClear = (): void => {
    Alert.alert(t('cart.clear'), 'Remove every item from the cart?', [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('cart.clear'), style: 'destructive', onPress: () => clear() },
    ]);
  };

  if (configs.length === 0) {
    return (
      <Screen padded={false}>
        <Header title={t('cart.title')} onBack={() => router.back()} centered />
        <EmptyState
          icon="cart-outline"
          title={t('cart.empty')}
          message={t('cart.emptyHint')}
          action={
            <Button
              label={t('test.title')}
              icon="build-outline"
              onPress={() => router.replace('/test')}
            />
          }
        />
      </Screen>
    );
  }

  return (
    <View style={styles.flex}>
      <Screen scroll padded={false} bottomInset={150}>
        <Header
          title={t('cart.title')}
          subtitle={`${configs.length} test(s) · ${credits} credit(s)`}
          onBack={() => router.back()}
          centered
          right={
            <Pressable onPress={confirmClear} hitSlop={8} accessibilityRole="button">
              <Text variant="small" tone="danger" style={{ fontFamily: font.semibold }}>
                {t('cart.clear')}
              </Text>
            </Pressable>
          }
        />

        <View style={styles.body}>
          {/* Target summary */}
          <Card style={styles.targetCard}>
            <View style={styles.targetRow}>
              <Ionicons name="globe-outline" size={18} color={palette.primary} />
              <View style={{ flex: 1 }}>
                <Text variant="tiny" tone="muted">
                  TARGET
                </Text>
                <Text variant="h3" numberOfLines={1}>
                  {targets.join(', ') || 'Not set'}
                </Text>
              </View>
              <Badge
                label={isFullSet ? 'Run all' : configs.length === 1 ? 'Single' : 'Custom'}
                fg="#1F5BB5"
                bg={palette.primarySoft}
              />
            </View>

            {mixedTargets ? (
              <View style={{ marginTop: spacing.md }}>
                <Banner
                  tone="warning"
                  message={`Cart spans ${targets.length} targets. A run must use a single target.`}
                />
              </View>
            ) : null}

            {isFullSet ? (
              <View style={{ marginTop: spacing.md }}>
                <Banner
                  tone="info"
                  message={`All ${TEST_COUNT} tests will fire simultaneously against this target.`}
                />
              </View>
            ) : null}
          </Card>

          {/* Identity — what the target sees */}
          <IdentityCard />

          {/* Items */}
          {configs.map((config) => (
            <CartItem
              key={config.id}
              config={config}
              expanded={expanded === config.id}
              onToggle={() => setExpanded(expanded === config.id ? null : config.id)}
              onCustomise={() => router.push(`/test/${config.testId}?configId=${config.id}`)}
              onRemove={() => remove(config.id)}
            />
          ))}

          {/* Add the rest */}
          {!isFullSet && targets.length === 1 && targets[0] ? (
            <Button
              label={`Add remaining tests to make it ${TEST_COUNT}`}
              variant="secondary"
              icon="add-circle-outline"
              onPress={() => addAll(targets[0] as string)}
              fullWidth
              style={{ marginTop: spacing.sm }}
            />
          ) : null}

          {error ? (
            <View style={{ marginTop: spacing.lg }}>
              <Banner tone="error" message={error} />
            </View>
          ) : null}

          {insufficient ? (
            <View style={{ marginTop: spacing.lg }}>
              <Banner
                tone="error"
                message={`This run costs ${credits} credits but only ${user?.creditsRemaining ?? 0} remain.`}
              />
            </View>
          ) : null}
        </View>
      </Screen>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        <View style={styles.footerSummary}>
          <Text variant="small" tone="muted">
            {configs.length} test(s)
          </Text>
          <Text variant="h3" tone="primary">
            {credits} credit{credits === 1 ? '' : 's'}
          </Text>
        </View>
        <Button
          label={busy ? t('cart.starting') : t('cart.confirm')}
          icon="play"
          size="lg"
          loading={busy}
          disabled={insufficient || mixedTargets || configs.some((c) => !c.target.domain.trim())}
          onPress={() => void start()}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Identity selector
 * ------------------------------------------------------------------ */

const IDENTITY_MODES: Array<{
  mode: AnonymityMode;
  label: string;
  hint: string;
  icon: keyof typeof Ionicons.glyphMap;
}> = [
  {
    mode: 'neutral',
    label: 'Neutral',
    hint: 'No tool name, no browser mimicry. The target learns nothing about you.',
    icon: 'eye-off-outline',
  },
  {
    mode: 'browser',
    label: 'Browser',
    hint: 'Full browser fingerprint — matching UA, client hints and header order, rotated per request.',
    icon: 'globe-outline',
  },
  {
    mode: 'identify',
    label: 'Identify',
    hint: 'Announces the tool by name. Use only when the customer expects and allow-lists you.',
    icon: 'megaphone-outline',
  },
];

function IdentityCard(): React.JSX.Element {
  const { anonymity, setAnonymity, egressProxy, setEgressProxy } = useCart();
  const [showProxy, setShowProxy] = useState(false);
  const [proxyDraft, setProxyDraft] = useState(egressProxy ?? '');

  const active = IDENTITY_MODES.find((m) => m.mode === anonymity) ?? IDENTITY_MODES[0]!;

  return (
    <Card style={styles.identityCard}>
      <View style={styles.identityHead}>
        <Ionicons name="finger-print-outline" size={17} color={palette.ink} />
        <Text variant="small" style={{ fontFamily: font.bold, flex: 1 }}>
          What the target sees
        </Text>
        <Pressable onPress={() => setShowProxy((v) => !v)} hitSlop={8} accessibilityRole="button">
          <Text variant="tiny" tone="primary" style={{ fontFamily: font.semibold }}>
            {egressProxy ? 'Proxy on' : 'Proxy'}
          </Text>
        </Pressable>
      </View>

      <View style={styles.modeRow}>
        {IDENTITY_MODES.map((option) => {
          const selected = option.mode === anonymity;
          return (
            <Pressable
              key={option.mode}
              onPress={() => setAnonymity(option.mode)}
              accessibilityRole="button"
              accessibilityLabel={`Identity: ${option.label}`}
              accessibilityState={{ selected }}
              style={({ pressed }) => [
                styles.modeChip,
                selected && { backgroundColor: palette.primarySoft, borderColor: palette.primaryBorder },
                pressed && { opacity: 0.75 },
              ]}
            >
              <Ionicons
                name={option.icon}
                size={14}
                color={selected ? palette.primaryDark : palette.inkMuted}
              />
              <Text
                variant="small"
                style={{
                  color: selected ? palette.primaryDark : palette.ink,
                  fontFamily: selected ? font.bold : font.medium,
                }}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text variant="tiny" tone="muted" style={{ marginTop: spacing.sm, lineHeight: 17 }}>
        {active.hint}
      </Text>

      {anonymity === 'identify' ? (
        <View style={{ marginTop: spacing.md }}>
          <Banner
            tone="warning"
            message="Identify mode puts the tool's name in the target's logs. Only use it when that is intended."
          />
        </View>
      ) : null}

      {showProxy ? (
        <View style={{ marginTop: spacing.md }}>
          <OutlinedInput
            label="Egress proxy (optional)"
            value={proxyDraft}
            onChangeText={setProxyDraft}
            placeholder="http://user:pass@proxy.internal:3128"
            surface={palette.surface}
            hint="Routes attack traffic through a proxy so the target never sees this server's address"
          />
          <View style={{ height: spacing.sm }} />
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Button
              label="Apply"
              size="sm"
              onPress={() => {
                setEgressProxy(proxyDraft);
                setShowProxy(false);
              }}
            />
            {egressProxy ? (
              <Button
                label="Clear"
                size="sm"
                variant="ghost"
                onPress={() => {
                  setProxyDraft('');
                  setEgressProxy(null);
                }}
              />
            ) : null}
          </View>
        </View>
      ) : egressProxy ? (
        <View style={styles.proxyActive}>
          <Ionicons name="git-network-outline" size={13} color={palette.success} />
          <Text variant="tiny" style={{ color: palette.success, flex: 1 }} numberOfLines={1}>
            Egress via {egressProxy}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Cart item
 * ------------------------------------------------------------------ */

function CartItem({
  config,
  expanded,
  onToggle,
  onCustomise,
  onRemove,
}: {
  config: AttackConfig;
  expanded: boolean;
  onToggle: () => void;
  onCustomise: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  const test = getTest(config.testId);
  const { t } = useI18n();

  // Only surface the settings that actually matter for this test.
  const highlights = test.fields
    .filter((f) => f.type === 'number' || f.type === 'lines' || f.type === 'segmented')
    .slice(0, 4)
    .map((f) => {
      const value = config.values[f.id];
      const display = Array.isArray(value)
        ? `${value.length} item(s)`
        : typeof value === 'boolean'
          ? value
            ? 'on'
            : 'off'
          : String(value ?? '—');
      return { label: f.label, value: display };
    });

  return (
    <Card style={styles.itemCard}>
      <View style={styles.itemHead}>
        <View style={styles.itemIcon}>
          <Ionicons
            name={test.icon as keyof typeof Ionicons.glyphMap}
            size={17}
            color={palette.primary}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="h3" numberOfLines={2}>
            {test.label}
          </Text>
          <Text variant="tiny" tone="muted" numberOfLines={1}>
            {config.http.method} {config.http.path || '/'} · {config.target.domain}
          </Text>
        </View>
        <Pressable onPress={onToggle} hitSlop={10} accessibilityRole="button">
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={palette.inkMuted} />
        </Pressable>
      </View>

      {expanded ? (
        <View style={styles.itemDetail}>
          {highlights.map((h) => (
            <View key={h.label} style={styles.detailRow}>
              <Text variant="tiny" tone="muted" style={{ flex: 1 }} numberOfLines={1}>
                {h.label}
              </Text>
              <Text variant="tiny" numberOfLines={1} style={{ maxWidth: 170, textAlign: 'right' }}>
                {h.value}
              </Text>
            </View>
          ))}

          {config.http.query.length > 0 ? (
            <>
              <Text variant="micro" tone="subtle" style={{ marginTop: spacing.sm }}>
                QUERY
              </Text>
              {config.http.query.map((q, i) => (
                <View key={`${q.key}-${i}`} style={styles.detailRow}>
                  <Text variant="tiny" tone="muted" style={{ flex: 1 }} numberOfLines={1}>
                    {q.key}
                  </Text>
                  <Text variant="tiny" style={{ maxWidth: 170 }} numberOfLines={1}>
                    {q.value}
                  </Text>
                </View>
              ))}
            </>
          ) : null}

          <View style={styles.itemActions}>
            <Button label={t('cart.customise')} size="sm" variant="secondary" icon="create-outline" onPress={onCustomise} />
            <Button label={t('cart.remove')} size="sm" variant="ghost" icon="trash-outline" onPress={onRemove} />
          </View>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: palette.canvas },
  body: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl },
  targetCard: { marginBottom: spacing.md, padding: spacing.lg },
  targetRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  identityCard: { marginBottom: spacing.md, padding: spacing.lg },
  identityHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  modeRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  modeChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surfaceAlt,
  },
  proxyActive: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.md,
  },
  itemCard: { marginBottom: spacing.md, padding: spacing.lg },
  itemHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  itemIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    backgroundColor: palette.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemDetail: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: palette.line,
  },
  detailRow: { flexDirection: 'row', gap: spacing.sm, paddingVertical: 3 },
  itemActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    backgroundColor: palette.canvas,
    borderTopWidth: 1,
    borderTopColor: palette.line,
  },
  footerSummary: { gap: 1 },
});
