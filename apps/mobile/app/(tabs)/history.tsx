import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { HistoryFilter, RunRecord, RunStatus, TestCategoryId } from '@teo/shared';
import { SEVERITY_RANK, getTest } from '@teo/shared';

import { api, type TestSummary } from '../../src/api/client';
import { OutlinedInput } from '../../src/components/fields';
import {
  Badge,
  Banner,
  Button,
  Card,
  Chip,
  EmptyState,
  Screen,
  Text,
} from '../../src/components/ui';
import { useI18n } from '../../src/i18n';
import { useCatalog } from '../../src/state';
import { font, palette, radius, spacing } from '../../src/theme';

const STATUSES: Array<{ key: RunStatus | 'any'; label: string }> = [
  { key: 'any', label: 'Any Status' },
  { key: 'success', label: 'SUCCESS' },
  { key: 'failed', label: 'FAILED' },
  { key: 'cancelled', label: 'CANCELLED' },
];

const CATEGORY_KEYS: TestCategoryId[] = [
  'dos_protection',
  'web_protection',
  'bot_management',
  'api_protection',
];

type QuickRange = '24h' | '7d' | '30d' | null;

export default function HistoryScreen(): React.JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const { categories } = useCatalog();

  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  // Filter state
  const [showFilters, setShowFilters] = useState(false);
  const [status, setStatus] = useState<RunStatus | 'any'>('any');
  const [selectedCategories, setSelectedCategories] = useState<TestCategoryId[]>([]);
  const [domainContains, setDomainContains] = useState('');
  const [quickRange, setQuickRange] = useState<QuickRange>(null);

  const filter = useMemo<HistoryFilter>(() => {
    const now = Date.now();
    const from =
      quickRange === '24h'
        ? new Date(now - 86_400_000).toISOString()
        : quickRange === '7d'
          ? new Date(now - 7 * 86_400_000).toISOString()
          : quickRange === '30d'
            ? new Date(now - 30 * 86_400_000).toISOString()
            : undefined;

    return {
      status,
      categories: selectedCategories.length > 0 ? selectedCategories : undefined,
      domainContains: domainContains || undefined,
      from,
      limit: 50,
    };
  }, [status, selectedCategories, domainContains, quickRange]);

  /**
   * Requests are sequenced.
   *
   * `filter` contains the free-text domain box, so this fires on every
   * keystroke. Without a guard, a response for "ex" landing after the response
   * for "example.com" would leave the list showing results for a prefix of what
   * the input says — and the operator could act on the wrong set.
   */
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = (requestSeq.current += 1);
    try {
      setError(null);
      const page = await api.history(filter);
      if (seq !== requestSeq.current) return; // a newer request superseded this one
      setRuns(page.runs);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [filter, t]);

  // Debounce so typing does not fire one request per character.
  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return runs;
    return runs.filter((run) => {
      if (run.target.toLowerCase().includes(needle)) return true;
      if (run.label.toLowerCase().includes(needle)) return true;
      return run.testIds.some((id) => {
        try {
          return getTest(id).label.toLowerCase().includes(needle);
        } catch {
          return false;
        }
      });
    });
  }, [runs, search]);

  const activeFilterCount =
    (status !== 'any' ? 1 : 0) + selectedCategories.length + (domainContains ? 1 : 0) + (quickRange ? 1 : 0);

  const clearFilters = (): void => {
    setStatus('any');
    setSelectedCategories([]);
    setDomainContains('');
    setQuickRange(null);
  };

  return (
    <View style={styles.flex}>
      <Screen
        scroll
        padded={false}
        bottomInset={96}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load();
            }}
          />
        }
      >
        <View style={{ paddingTop: insets.top + spacing.xl }}>
          <Text variant="h1" center>
            {t('history.title')}
          </Text>
        </View>

        <View style={styles.body}>
          <OutlinedInput
            label=""
            value={search}
            onChangeText={setSearch}
            placeholder={t('history.searchPlaceholder')}
            surface={palette.canvas}
            minHeight={50}
          />

          <View style={styles.actionRow}>
            <Pressable
              onPress={() => {
                setRefreshing(true);
                void load();
              }}
              accessibilityRole="button"
              style={styles.linkRow}
            >
              <Ionicons name="sync-outline" size={15} color={palette.primary} />
              <Text variant="small" tone="primary" style={{ fontFamily: font.semibold }}>
                {t('history.syncNow')}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => router.push('/export')}
              accessibilityRole="button"
              style={styles.linkRow}
            >
              <Ionicons name="download-outline" size={15} color={palette.primary} />
              <Text variant="small" tone="primary" style={{ fontFamily: font.semibold }}>
                {t('history.exportAll')}
              </Text>
            </Pressable>
          </View>

          {error ? (
            <View style={{ marginBottom: spacing.lg }}>
              <Banner tone="error" message={error} />
            </View>
          ) : null}

          {loading ? (
            <ActivityIndicator style={{ marginTop: spacing.xxl }} color={palette.primary} />
          ) : visible.length === 0 ? (
            <EmptyState icon="calendar-outline" title={t('history.empty')} message={t('history.emptyHint')} />
          ) : (
            visible.map((run) => (
              <RunCard
                key={run.id}
                run={run}
                open={expanded === run.id}
                onToggle={() => setExpanded(expanded === run.id ? null : run.id)}
                onOpen={() => router.push(`/result/${run.id}`)}
              />
            ))
          )}
        </View>
      </Screen>

      {/* Filter FAB */}
      <Pressable
        onPress={() => setShowFilters(true)}
        accessibilityRole="button"
        accessibilityLabel={t('history.filters')}
        style={({ pressed }) => [
          styles.fab,
          { bottom: insets.bottom + 66 },
          pressed && { opacity: 0.9 },
        ]}
      >
        <Ionicons name="options-outline" size={22} color={palette.primary} />
        {activeFilterCount > 0 ? (
          <View style={styles.fabDot}>
            <Text style={styles.fabDotText}>{activeFilterCount}</Text>
          </View>
        ) : null}
      </Pressable>

      {/* Filters sheet */}
      <Modal visible={showFilters} transparent animationType="slide" onRequestClose={() => setShowFilters(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowFilters(false)}>
          <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + spacing.xl }]} onPress={(e) => e.stopPropagation()}>
            <View style={styles.grabber} />
            <ScrollView showsVerticalScrollIndicator={false}>
              <Text variant="h2" style={{ marginBottom: spacing.lg }}>
                {t('history.filters')}
              </Text>

              <Text variant="small" style={{ fontFamily: font.semibold, marginBottom: spacing.sm }}>
                {t('history.status')}
              </Text>
              <View style={styles.chipWrap}>
                {STATUSES.map((s) => (
                  <Chip
                    key={s.key}
                    label={s.label}
                    selected={status === s.key}
                    onPress={() => setStatus(s.key)}
                  />
                ))}
              </View>

              <Text
                variant="small"
                style={{ fontFamily: font.semibold, marginTop: spacing.xl, marginBottom: spacing.sm }}
              >
                {t('history.category')}
              </Text>
              <View style={styles.chipWrap}>
                <Chip
                  label={t('history.all')}
                  selected={selectedCategories.length === 0}
                  onPress={() => setSelectedCategories([])}
                />
                {CATEGORY_KEYS.map((key) => {
                  const category = categories.find((c) => c.id === key);
                  const label = (category?.label ?? key).toUpperCase().slice(0, 18);
                  const selected = selectedCategories.includes(key);
                  return (
                    <Chip
                      key={key}
                      label={label}
                      selected={selected}
                      onPress={() =>
                        setSelectedCategories((prev) =>
                          selected ? prev.filter((c) => c !== key) : [...prev, key],
                        )
                      }
                    />
                  );
                })}
              </View>

              <View style={{ marginTop: spacing.xl }}>
                <OutlinedInput
                  label={t('history.domainContains')}
                  value={domainContains}
                  onChangeText={setDomainContains}
                  placeholder="example.com"
                  surface={palette.surface}
                />
              </View>

              <Text
                variant="small"
                style={{ fontFamily: font.semibold, marginTop: spacing.xl, marginBottom: spacing.sm }}
              >
                Quick range
              </Text>
              <View style={styles.chipWrap}>
                {(['24h', '7d', '30d'] as const).map((range) => (
                  <Chip
                    key={range}
                    label={range}
                    selected={quickRange === range}
                    onPress={() => setQuickRange(quickRange === range ? null : range)}
                  />
                ))}
              </View>

              <View style={styles.sheetActions}>
                <Button label={t('history.clearFilters')} variant="ghost" onPress={clearFilters} />
                <Button
                  label={t('history.apply')}
                  icon="checkmark"
                  onPress={() => setShowFilters(false)}
                  style={{ minWidth: 130 }}
                />
              </View>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Run card
 * ------------------------------------------------------------------ */

function RunCard({
  run,
  open,
  onToggle,
  onOpen,
}: {
  run: RunRecord;
  open: boolean;
  onToggle: () => void;
  onOpen: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const summary = run.summary;

  // Iteration detail is fetched lazily on first expand: putting it in the list
  // response would make history expensive once there are many runs.
  const [tests, setTests] = useState<TestSummary[] | null>(null);
  const [platforms, setPlatforms] = useState<Array<{ summary: string; probes: number }>>([]);
  useEffect(() => {
    if (!open || tests !== null) return;
    let cancelled = false;
    void api
      .getRun(run.id)
      .then((data) => {
        if (cancelled) return;
        setTests(data.tests ?? []);
        setPlatforms(data.platforms ?? []);
      })
      .catch(() => {
        if (!cancelled) setTests([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, tests, run.id]);

  const statusStyle =
    run.status === 'success'
      ? { fg: '#137247', bg: palette.successSoft, label: 'SUCCESS' }
      : run.status === 'failed'
        ? { fg: '#A8282C', bg: palette.dangerSoft, label: 'FAILED' }
        : run.status === 'running'
          ? { fg: '#1F5BB5', bg: palette.primarySoft, label: 'RUNNING' }
          : { fg: '#5A6478', bg: palette.surfaceSunken, label: run.status.toUpperCase() };

  return (
    <Card style={{ marginBottom: spacing.md }}>
      <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        <View style={styles.runHead}>
          <View style={{ flex: 1 }}>
            <Text variant="h3" numberOfLines={1}>
              {run.target}
            </Text>
            <Text variant="small" tone="muted" numberOfLines={1}>
              {run.label}
            </Text>
          </View>
          <Badge label={statusStyle.label} fg={statusStyle.fg} bg={statusStyle.bg} icon="checkmark-circle" />
        </View>

        <View style={styles.metricRow}>
          <Metric
            icon="time-outline"
            label={t('history.duration')}
            value={`${run.durationMs ?? 0}ms`}
            tone="primary"
          />
          <Metric
            icon="star-outline"
            label={t('history.credits')}
            value={String(run.creditsUsed)}
            tone="warning"
          />
        </View>

        <View style={styles.runFooter}>
          <Text variant="tiny" tone="subtle">
            {new Date(run.createdAt).toLocaleString()} · {summary?.totalProbes ?? 0} probes
          </Text>
          <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={17} color={palette.inkMuted} />
        </View>
      </Pressable>

      {open ? (
        <View style={styles.runDetail}>
          {/* 1. Where it went — the path is the context for everything else */}
          {platforms.length > 0 ? (
            <View style={styles.obsBlock}>
              <View style={styles.obsHead}>
                <Ionicons name="git-network-outline" size={14} color={palette.inkMuted} />
                <Text variant="micro" tone="subtle">
                  PATH
                </Text>
              </View>
              {platforms.map((p) => (
                <Text key={p.summary} variant="small" style={{ marginTop: 2 }}>
                  {p.summary}
                  {platforms.length > 1 ? (
                    <Text variant="micro" tone="muted">
                      {'  '}
                      ({p.probes} probes)
                    </Text>
                  ) : null}
                </Text>
              ))}
            </View>
          ) : null}

          {/* 2. What happened, in a sentence */}
          <View style={styles.obsBlock}>
            <View style={styles.obsHead}>
              <Ionicons name="information-circle-outline" size={14} color={palette.inkMuted} />
              <Text variant="micro" tone="subtle">
                OUTCOME
              </Text>
            </View>
            <Text variant="small" style={{ marginTop: 2, lineHeight: 20 }}>
              {outcomeSentence(summary, tests)}
            </Text>
          </View>

          {/* 3. The numbers, kept small and secondary */}
          <View style={styles.detailGrid}>
            <Detail label="Probes" value={String(summary?.totalProbes ?? 0)} />
            <Detail label="Blocked" value={String(summary?.blocked ?? 0)} />
            <Detail label="Bypassed" value={String(summary?.bypassed ?? 0)} />
            <Detail
              label="Mean TTFB"
              value={summary?.meanTtfbMs !== null && summary?.meanTtfbMs !== undefined ? `${summary.meanTtfbMs}ms` : '—'}
            />
          </View>

          {/* Iteration detail for every test, all at once */}
          {tests === null ? (
            <View style={{ marginTop: spacing.md }}>
              <ActivityIndicator size="small" color={palette.primary} />
            </View>
          ) : tests.length > 0 ? (
            <View style={{ marginTop: spacing.lg }}>
              <Text variant="small" style={{ fontFamily: font.bold, marginBottom: spacing.sm }}>
                Iterations
              </Text>
              {tests.map((test) => (
                <HistoryIterationRow key={test.testId} test={test} />
              ))}
            </View>
          ) : null}

          <View style={styles.testChips}>
            {run.testIds.map((id) => {
              let label: string = id;
              try {
                label = getTest(id).shortLabel;
              } catch {
                /* unknown id */
              }
              return (
                <View key={id} style={styles.testChip}>
                  <Text variant="micro" tone="muted">
                    {label}
                  </Text>
                </View>
              );
            })}
          </View>

          <Text variant="micro" tone="subtle" style={{ marginTop: spacing.md }} numberOfLines={2}>
            {run.provenance.configHash}
          </Text>

          <View style={{ marginTop: spacing.md }}>
            <Button label={t('run.viewResults')} size="sm" icon="stats-chart" onPress={onOpen} />
          </View>
        </View>
      ) : null}
    </Card>
  );
}

/** Compact per-test iteration strip for the history card. */
function HistoryIterationRow({ test }: { test: TestSummary }): React.JSX.Element {
  const segments = [
    { count: test.passed, color: palette.primary, label: 'passed' },
    { count: test.blocked, color: palette.success, label: 'blocked' },
    { count: test.bypassed, color: palette.danger, label: 'bypassed' },
    { count: test.errors, color: palette.inkSubtle, label: 'errors' },
  ].filter((seg) => seg.count > 0);

  let label: string = test.testId;
  try {
    label = getTest(test.testId as never).shortLabel;
  } catch {
    /* unknown id — show the raw value */
  }

  return (
    <View style={{ marginBottom: spacing.md }}>
      <View style={styles.iterHead}>
        <Text variant="tiny" style={{ flex: 1 }} numberOfLines={1}>
          {label}
        </Text>
        <Text variant="micro" tone="subtle">
          {test.probes} iterations
        </Text>
      </View>

      <View style={styles.iterTrack}>
        {segments.map((seg) => (
          <View key={seg.label} style={{ flex: seg.count, backgroundColor: seg.color, height: '100%' }} />
        ))}
      </View>

      {test.firstBlockedIteration !== null ? (
        <Text variant="micro" style={{ color: palette.success, marginTop: 2 }}>
          Blocked from iteration {test.firstBlockedIteration}
          {test.firstStatusCode !== null && test.lastStatusCode !== null
            ? ` (${test.firstStatusCode} → ${test.lastStatusCode})`
            : ''}
        </Text>
      ) : null}

      {test.firstBypassedIteration !== null ? (
        <Text variant="micro" style={{ color: palette.danger, marginTop: 2 }}>
          First bypass at iteration {test.firstBypassedIteration}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * One plain sentence describing the run.
 *
 * Observability is only useful if it can be read at a glance. This answers the
 * two questions an operator actually has — did anything get through, and did the
 * target fight back — before any numbers appear.
 */
function outcomeSentence(
  summary: RunRecord['summary'],
  tests: TestSummary[] | null,
): string {
  if (!summary || summary.totalProbes === 0) {
    return 'No probes were recorded for this run.';
  }

  const parts: string[] = [];
  parts.push(
    `${summary.totalProbes} request${summary.totalProbes === 1 ? '' : 's'} sent`,
  );

  if (summary.bypassed > 0) {
    const first = tests?.find((t) => t.firstBypassedIteration !== null);
    parts.push(
      `${summary.bypassed} got through` +
        (first?.firstBypassedIteration ? ` (from iteration ${first.firstBypassedIteration})` : ''),
    );
  }

  if (summary.blocked > 0) {
    const first = tests
      ?.filter((t) => t.firstBlockedIteration !== null)
      .sort((a, b) => (a.firstBlockedIteration ?? 0) - (b.firstBlockedIteration ?? 0))[0];
    parts.push(
      `${summary.blocked} were blocked` +
        (first?.firstBlockedIteration ? ` from iteration ${first.firstBlockedIteration}` : ''),
    );
  }

  if (summary.errors > 0) parts.push(`${summary.errors} failed at the network level`);

  if (summary.bypassed === 0 && summary.blocked === 0 && summary.errors === 0) {
    return `${parts.join(', ')} — all completed normally, nothing was blocked.`;
  }

  return `${parts.join(', ')}.`;
}

function Metric({
  icon,
  label,
  value,
  tone,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  tone: 'primary' | 'warning';
}): React.JSX.Element {
  const colors = {
    primary: { bg: palette.primarySoft, fg: palette.primaryDark },
    warning: { bg: palette.warningSoft, fg: '#8A6100' },
  }[tone];

  return (
    <View style={[styles.metric, { backgroundColor: colors.bg }]}>
      <Ionicons name={icon} size={14} color={colors.fg} />
      <View>
        <Text variant="micro" style={{ color: colors.fg, opacity: 0.8 }}>
          {label}
        </Text>
        <Text variant="small" style={{ color: colors.fg, fontFamily: font.bold }}>
          {value}
        </Text>
      </View>
    </View>
  );
}

function Detail({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.detailCell}>
      <Text variant="micro" tone="subtle">
        {label.toUpperCase()}
      </Text>
      <Text variant="small" style={{ fontFamily: font.semibold, marginTop: 1 }}>
        {value}
      </Text>
    </View>
  );
}

void SEVERITY_RANK;

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: palette.canvas },
  body: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.xxl },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    marginBottom: spacing.lg,
  },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  runHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  metricRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  obsBlock: { marginBottom: spacing.lg },
  obsHead: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2 },
  iterHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: 4 },
  iterTrack: {
    flexDirection: 'row',
    height: 10,
    borderRadius: 5,
    overflow: 'hidden',
    backgroundColor: palette.surfaceSunken,
  },
  metric: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
  },
  runFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
  },
  runDetail: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: palette.line,
  },
  detailGrid: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  detailCell: {
    flex: 1,
    backgroundColor: palette.surfaceAlt,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  testChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.md },
  testChip: {
    backgroundColor: palette.surfaceAlt,
    paddingVertical: 3,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
  },
  fab: {
    position: 'absolute',
    right: spacing.xl,
    width: 52,
    height: 52,
    borderRadius: radius.lg,
    backgroundColor: palette.primarySoft,
    borderWidth: 1,
    borderColor: palette.primaryBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabDot: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 19,
    height: 19,
    borderRadius: 10,
    backgroundColor: palette.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: palette.canvas,
  },
  fabDotText: { color: '#FFFFFF', fontFamily: font.bold, fontSize: 10 },
  backdrop: { flex: 1, backgroundColor: 'rgba(11,27,51,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: palette.surface,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    padding: spacing.xl,
    maxHeight: '86%',
  },
  grabber: {
    alignSelf: 'center',
    width: 42,
    height: 4,
    borderRadius: 2,
    backgroundColor: palette.lineStrong,
    marginBottom: spacing.lg,
  },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  sheetActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xxl,
  },
});
