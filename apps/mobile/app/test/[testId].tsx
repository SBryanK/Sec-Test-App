import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import React, { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AttackConfig, FieldDef, FieldValue, TestId } from '@teo/shared';
import {
  buildDefaultConfig,
  defaultValues,
  getTest,
  hasBlockingIssue,
  validateConfig,
} from '@teo/shared';

import { FieldRenderer, OutlinedInput } from '../../src/components/fields';
import { CartFab } from '../../src/components/CartFab';
import { Badge, Banner, Button, Card, Header, Screen, Text } from '../../src/components/ui';
import { useI18n } from '../../src/i18n';
import { api } from '../../src/api/client';
import { useCart, useCatalog } from '../../src/state';
import { font, palette, radius, spacing } from '../../src/theme';

export default function ConfigScreen(): React.JSX.Element {
  const { testId, configId } = useLocalSearchParams<{ testId: string; configId?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const { configs, add, update } = useCart();
  const { tests } = useCatalog();

  const test = useMemo(
    () => tests.find((x) => x.id === testId) ?? safeTest(testId),
    [tests, testId],
  );

  const existing = configs.find((c) => c.id === configId);
  const [config, setConfig] = useState<AttackConfig>(() => {
    if (existing) return existing;
    // Prefill with the target most recently used, which is nearly always the
    // same engagement the operator is working through.
    const previousDomain = configs[0]?.target.domain ?? '';
    return buildDefaultConfig(testId as TestId, previousDomain);
  });

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showDefaults, setShowDefaults] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saved, setSaved] = useState(false);

  const values = config.values;
  const issues = useMemo(() => validateConfig(config), [config]);
  const blocked = hasBlockingIssue(issues);
  const errorIssues = issues.filter((i) => i.severity === 'error');
  const warnIssues = issues.filter((i) => i.severity === 'warning');

  const setValue = (id: string, value: FieldValue): void => {
    setConfig((prev) => ({ ...prev, values: { ...prev.values, [id]: value } }));
    setSaved(false);
  };

  const defaults = useMemo(() => defaultValues(test), [test]);

  const fieldGroups = useMemo(() => {
    const groups: Array<{ id: string; title: string; accent: boolean; fields: FieldDef[] }> = [];
    for (const section of test.sections) {
      const fields = test.fields.filter((f) => f.section === section.id);
      if (fields.length === 0) continue;
      groups.push({
        id: section.id,
        title: section.title,
        accent: section.accent ?? false,
        fields,
      });
    }
    return groups;
  }, [test]);

  const commit = (): void => {
    const next: AttackConfig = { ...config, id: existing?.id ?? config.id };
    if (existing) update(existing.id, next);
    else add(next);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  };

  /**
   * Persist this configuration to the server.
   *
   * This previously flipped a "saved" flag and stored nothing — the button
   * reported success without doing anything. It now writes, reports failure
   * honestly, and the saved entry is loadable from the Import screen.
   */
  const save = async (): Promise<void> => {
    if (blocked) {
      setSaveError('Fix the highlighted fields before saving.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const name = `${test.label} — ${config.target.domain || 'no target'}`;
      await api.saveConfig(config.testId, name, config);
      setSaved(true);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setSaving(false);
    }
  };

  const resetDefaults = (): void => {
    setConfig((prev) => ({
      ...prev,
      http: buildDefaultConfig(prev.testId, prev.target.domain).http,
      values: defaultValues(test),
    }));
    setSaved(false);
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
    >
      <Screen scroll padded={false} bottomInset={140}>
        <Header
          title={test.label}
          onBack={() => router.back()}
          right={
            <View style={styles.headerActions}>
              <Pressable
                onPress={() => void save()}
                disabled={saving}
                accessibilityRole="button"
                accessibilityLabel={t('config.save')}
                hitSlop={8}
              >
                <Text
                  variant="body"
                  tone={saving ? 'muted' : 'primary'}
                  style={{ fontFamily: font.semibold }}
                >
                  {saving ? 'Saving…' : t('config.save')}
                </Text>
              </Pressable>
              <Pressable onPress={() => router.push('/import')} accessibilityRole="button" hitSlop={8}>
                <Text variant="body" tone="primary" style={{ fontFamily: font.semibold }}>
                  {t('config.import')}
                </Text>
              </Pressable>
            </View>
          }
        />

        <View style={styles.body}>
          {/* Target */}
          <OutlinedInput
            label={t('config.domain')}
            value={config.target.domain}
            onChangeText={(v) => {
              setConfig((prev) => ({ ...prev, target: { ...prev.target, domain: v } }));
              setSaved(false);
            }}
            placeholder={t('config.domainPlaceholder')}
            keyboardType="url"
            surface={palette.canvas}
            hint={test.feasibilityNote}
          />

          {/* Toolbar */}
          <View style={styles.toolbar}>
            <ToolbarChip
              icon={showDefaults ? 'eye-off-outline' : 'eye-outline'}
              label={t('config.defaults')}
              active={showDefaults}
              onPress={() => setShowDefaults((v) => !v)}
            />
            <ToolbarChip
              icon="options-outline"
              label={t('config.advanced')}
              active={showAdvanced}
              onPress={() => setShowAdvanced((v) => !v)}
            />
            <ToolbarChip icon="refresh-outline" label="Reset" onPress={resetDefaults} />
            <View style={{ flex: 1 }} />
            <Badge
              label={`${test.creditCost} credit`}
              fg="#1F5BB5"
              bg={palette.primarySoft}
              size="sm"
            />
          </View>

          {showDefaults ? (
            <Card style={styles.defaultsCard}>
              <Text variant="small" style={{ fontFamily: font.bold, marginBottom: spacing.sm }}>
                Catalog defaults for {test.label}
              </Text>
              <Text variant="tiny" tone="muted" style={{ marginBottom: spacing.md }}>
                These are the shipped defaults. Your changes apply to this cart item only.
              </Text>
              {test.fields
                .filter((f) => f.type !== 'note' && f.type !== 'section' && f.type !== 'divider')
                .map((field) => {
                  const def = defaults[field.id];
                  const current = values[field.id];
                  const changed = JSON.stringify(def) !== JSON.stringify(current);
                  return (
                    <View key={field.id} style={styles.defaultRow}>
                      <Text variant="tiny" tone="muted" style={{ flex: 1 }} numberOfLines={1}>
                        {field.label}
                      </Text>
                      <Text
                        variant="tiny"
                        style={{
                          fontFamily: changed ? font.bold : font.regular,
                          color: changed ? palette.primaryDark : palette.inkMuted,
                          maxWidth: 150,
                          textAlign: 'right',
                        }}
                        numberOfLines={2}
                      >
                        {formatValue(def)}
                      </Text>
                    </View>
                  );
                })}
            </Card>
          ) : null}

          {/* Schema-driven sections */}
          {fieldGroups.map((group) => {
            const visible = group.fields.filter((f) => showAdvanced || !f.advanced);
            if (visible.length === 0) return null;

            return (
              <View key={group.id} style={styles.section}>
                {group.title ? (
                  <Text
                    variant="h3"
                    style={{
                      color: group.accent ? palette.primary : palette.ink,
                      marginBottom: spacing.md,
                    }}
                  >
                    {group.title}
                  </Text>
                ) : null}

                <View style={{ gap: spacing.lg }}>
                  {visible.map((field) => (
                    <FieldRenderer
                      key={field.id}
                      field={field}
                      value={values[field.id]}
                      onChange={setValue}
                      surface={palette.canvas}
                    />
                  ))}
                </View>
              </View>
            );
          })}

          {!showAdvanced && test.fields.some((f) => f.advanced) ? (
            <Pressable onPress={() => setShowAdvanced(true)} style={styles.moreRow}>
              <Ionicons name="chevron-down" size={15} color={palette.inkMuted} />
              <Text variant="small" tone="muted">
                Show {test.fields.filter((f) => f.advanced).length} advanced option(s)
              </Text>
            </Pressable>
          ) : null}
        </View>
      </Screen>

      {/* Sticky footer: validation + add to cart */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        {errorIssues.length > 0
          ? errorIssues.slice(0, 3).map((issue) => (
              <View key={`${issue.fieldId}-${issue.message}`} style={{ marginBottom: spacing.sm }}>
                <Banner tone="error" message={`${issue.label}: ${issue.message}`} />
              </View>
            ))
          : null}

        {warnIssues.length > 0
          ? warnIssues.slice(0, 2).map((issue) => (
              <View key={`${issue.fieldId}-${issue.message}`} style={{ marginBottom: spacing.sm }}>
                <Banner tone="warning" message={`${issue.label}: ${issue.message}`} />
              </View>
            ))
          : null}

        {saved ? (
          <View style={{ marginBottom: spacing.sm }}>
            <Banner tone="success" message={`${t('config.saved')} — find it under Import`} />
          </View>
        ) : null}

        {saveError ? (
          <View style={{ marginBottom: spacing.sm }}>
            <Banner tone="error" message={saveError} />
          </View>
        ) : null}

        <Button
          label={existing ? 'Update Cart' : t('test.addToCart')}
          icon="cart-outline"
          onPress={commit}
          disabled={blocked}
          fullWidth
          size="lg"
        />
      </View>

      {/* Reachable from here too, so a save does not strand the operator. */}
      <CartFab bottomOffset={72} />
    </KeyboardAvoidingView>
  );
}

function ToolbarChip({
  icon,
  label,
  active,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  active?: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active }}
      style={({ pressed }) => [
        styles.toolbarChip,
        active && { backgroundColor: palette.primarySoft, borderColor: palette.primaryBorder },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Ionicons name={icon} size={13} color={active ? palette.primaryDark : palette.inkMuted} />
      <Text variant="tiny" style={{ color: active ? palette.primaryDark : palette.inkMuted }}>
        {label}
      </Text>
    </Pressable>
  );
}

function formatValue(value: FieldValue | undefined): string {
  if (value === undefined || value === null) return '—';
  if (Array.isArray(value)) {
    if (value.length === 0) return '—';
    if (typeof value[0] === 'string') return (value as string[]).join(', ');
    return `${value.length} row(s)`;
  }
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  const str = String(value);
  return str === '' ? '—' : str;
}

/** Fallback so the screen still renders on a deep link before the catalog loads. */
function safeTest(testId: string) {
  try {
    return getTest(testId as TestId);
  } catch {
    return {
      id: testId as TestId,
      category: 'web_protection' as const,
      label: testId,
      shortLabel: testId,
      icon: 'shield',
      blurb: '',
      feasibility: 'phone' as const,
      feasibilityNote: '',
      creditCost: 1,
      defaultDurationMs: 5000,
      sections: [],
      fields: [],
    };
  }
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: palette.canvas },
  headerActions: { flexDirection: 'row', gap: spacing.lg, alignItems: 'center' },
  body: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
    marginBottom: spacing.lg,
  },
  toolbarChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 5,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: palette.line,
  },
  defaultsCard: {
    marginBottom: spacing.lg,
    backgroundColor: palette.surfaceAlt,
    padding: spacing.lg,
  },
  defaultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 3,
  },
  section: { marginBottom: spacing.xl },
  moreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    backgroundColor: palette.canvas,
    borderTopWidth: 1,
    borderTopColor: palette.line,
  },
});
