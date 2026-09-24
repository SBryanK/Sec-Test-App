/**
 * Live run progress.
 *
 * Status resolution is the subtle part: the SSE stream is an accelerator and
 * polling is authoritative, so the displayed status prefers whichever source
 * has reached a terminal state. Taking the stream's value first would strand
 * the screen on "Running" forever if the stream dropped mid-run — the header
 * is hidden and this route disables the back gesture, so that is a trap with
 * no way out.
 *
 * `require-atomic-updates` is disabled file-wide: it flags the standard
 * "check a flag, set it, await, clear it in finally" polling guard as a race.
 * It is not one here — JavaScript is single-threaded and the flag is set
 * synchronously before the first await.
 */
/* eslint-disable require-atomic-updates */
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RunProgress, RunRecord, RunStatus } from '@teo/shared';
import { getTest } from '@teo/shared';

import { api, streamRun } from '../../src/api/client';
import { Badge, Banner, Button, Card, ProgressBar, Screen, Text } from '../../src/components/ui';
import { useI18n } from '../../src/i18n';
import { useAuth } from '../../src/state';
import { font, palette, radius, spacing } from '../../src/theme';

const TERMINAL = new Set(['success', 'failed', 'cancelled']);

export default function RunScreen(): React.JSX.Element {
  const { runId } = useLocalSearchParams<{ runId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const { refresh } = useAuth();

  const [run, setRun] = useState<RunRecord | null>(null);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const doneRef = useRef(false);
  /** Guards against overlapping polls on a slow link. */
  const inFlightRef = useRef(false);

  // A new run id means a fresh screen state; without this, a reused instance
  // would never poll or detect completion again.
  useEffect(() => {
    doneRef.current = false;
    setProgress(null);
    setRun(null);
    setError(null);
  }, [runId]);

  // Initial fetch + polling fallback for when SSE is unavailable.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const settle = (): void => {
      if (timer) clearInterval(timer);
      void Haptics.notificationAsync(
        run?.status === 'cancelled'
          ? Haptics.NotificationFeedbackType.Warning
          : Haptics.NotificationFeedbackType.Success,
      );
      void refresh();
    };

    const load = async (): Promise<void> => {
      // Guard against overlapping polls: on a slow link a stale 'running'
      // response could otherwise land after the terminal one.
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const data = await api.getRun(runId);
        if (cancelled) return;
        setRun(data.run);
        // Clear a transient poll failure once a fetch succeeds, rather than
        // pinning a red banner for the rest of the run.
        setError(null);
        if (TERMINAL.has(data.run.status) && !doneRef.current) {
          doneRef.current = true;
          settle();
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t('common.error'));
      } finally {
        inFlightRef.current = false;
      }
    };

    void load();
    timer = setInterval(() => {
      if (!doneRef.current) void load();
    }, 1500);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [runId, refresh, t, run?.status]);

  // Live progress stream. Purely an accelerator: polling above is authoritative.
  useEffect(() => {
    const stop = streamRun(runId, {
      onProgress: (p) => {
        setProgress(p);
        if (TERMINAL.has(p.status) && !doneRef.current) {
          doneRef.current = true;
          void api
            .getRun(runId)
            .then((d) => setRun(d.run))
            .catch(() => undefined);
          void refresh();
        }
      },
      onError: () => {
        // The stream died. Polling keeps the screen correct, so a dropped SSE
        // connection must not strand the UI — which is why the status below
        // prefers a terminal value from either source.
      },
    });
    return stop;
  }, [runId, refresh]);

  /**
   * Prefer whichever source has reached a terminal state.
   *
   * Taking `progress.status` first meant a stream that dropped mid-run left
   * `progress` pinned at 'running' forever: polling would fetch the real
   * 'success' record and stop, but the screen kept spinning with no way out —
   * the header is hidden and the route disables the back gesture.
   */
  const status: RunStatus = TERMINAL.has(progress?.status ?? 'queued')
    ? (progress?.status as RunStatus)
    : run && TERMINAL.has(run.status)
      ? run.status
      : (progress?.status ?? run?.status ?? 'queued');
  const finished = TERMINAL.has(status);

  const cancel = (): void => {
    Alert.alert(t('run.cancel'), 'Stop this run? Completed probes are kept.', [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('run.cancel'),
        style: 'destructive',
        onPress: () => {
          setCancelling(true);
          void api
            .cancelRun(runId)
            .catch((err: unknown) =>
              setError(err instanceof Error ? err.message : t('common.error')),
            )
            .finally(() => setCancelling(false));
        },
      },
    ]);
  };

  const completed = progress?.completedProbes ?? run?.summary?.totalProbes ?? 0;
  const planned = progress?.plannedProbes ?? 0;
  const ratio = planned > 0 ? completed / planned : progress?.progress ?? 0;

  const statusMeta = {
    queued: { label: 'Queued', color: palette.inkMuted, icon: 'time-outline' as const },
    running: { label: 'Running', color: palette.primary, icon: 'sync-outline' as const },
    success: { label: 'Success', color: palette.success, icon: 'checkmark-circle' as const },
    failed: { label: 'Failed', color: palette.danger, icon: 'alert-circle' as const },
    cancelled: { label: 'Cancelled', color: palette.inkMuted, icon: 'close-circle' as const },
  }[status] ?? { label: status, color: palette.inkMuted, icon: 'ellipse-outline' as const };

  return (
    <Screen scroll padded={false} bottomInset={120}>
      <View style={[styles.top, { paddingTop: insets.top + spacing.xl }]}>
        <View style={[styles.statusRing, { borderColor: statusMeta.color }]}>
          {status === 'running' ? (
            <ActivityIndicator color={statusMeta.color} />
          ) : (
            <Ionicons name={statusMeta.icon} size={30} color={statusMeta.color} />
          )}
        </View>

        <Text variant="h1" center style={{ marginTop: spacing.lg }}>
          {finished
            ? status === 'success'
              ? t('run.complete')
              : status === 'cancelled'
                ? t('run.cancelled')
                : t('run.failed')
            : t('run.title')}
        </Text>

        <Text variant="small" tone="muted" center style={{ marginTop: spacing.xs }}>
          {run?.label ?? '…'} · {run?.target ?? ''}
        </Text>
      </View>

      <View style={styles.body}>
        {error ? (
          <View style={{ marginBottom: spacing.lg }}>
            <Banner tone="error" message={error} />
          </View>
        ) : null}

        {/* Progress */}
        <Card>
          <View style={styles.progressHead}>
            <Text variant="small" style={{ fontFamily: font.semibold }}>
              {t('run.probes', { done: completed, total: planned || '…' })}
            </Text>
            <Text variant="small" tone="primary" style={{ fontFamily: font.bold }}>
              {Math.round(ratio * 100)}%
            </Text>
          </View>

          <View style={{ marginTop: spacing.sm }}>
            <ProgressBar value={ratio} color={statusMeta.color} height={10} />
          </View>

          <View style={styles.statRow}>
            <MiniStat label="Elapsed" value={fmtDuration(progress?.elapsedMs ?? 0)} />
            <MiniStat label="Rate" value={progress?.achievedRps ? `${progress.achievedRps}/s` : '—'} />
            <MiniStat label={t('result.blocked')} value={String(progress?.blocked ?? 0)} tone="success" />
            <MiniStat label={t('result.bypassed')} value={String(progress?.bypassed ?? 0)} tone="danger" />
          </View>

          {progress?.message ? (
            <Text variant="tiny" tone="muted" style={{ marginTop: spacing.md }} numberOfLines={2}>
              {progress.message}
            </Text>
          ) : null}
        </Card>

        {/* What is being run */}
        <Card style={{ marginTop: spacing.md }}>
          <Text variant="small" style={{ fontFamily: font.bold, marginBottom: spacing.sm }}>
            Tests in this run ({run?.testIds.length ?? 0})
          </Text>
          {(run?.testIds ?? []).map((id) => {
            let label = id as string;
            try {
              label = getTest(id).label;
            } catch {
              /* unknown id — show raw */
            }
            const active = progress?.currentTestId === id;
            return (
              <View key={id} style={styles.testRow}>
                <Ionicons
                  name={active && !finished ? 'radio-button-on' : 'ellipse-outline'}
                  size={13}
                  color={active && !finished ? palette.primary : palette.inkSubtle}
                />
                <Text variant="small" style={{ flex: 1 }} numberOfLines={1}>
                  {label}
                </Text>
                {active && !finished ? (
                  <Badge label="running" fg="#1F5BB5" bg={palette.primarySoft} size="sm" />
                ) : null}
              </View>
            );
          })}
        </Card>

        {run?.error ? (
          <View style={{ marginTop: spacing.md }}>
            <Banner tone="error" message={run.error} />
          </View>
        ) : null}
      </View>

      {/* Footer */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        {finished ? (
          <>
            <Button
              label={t('run.viewResults')}
              icon="stats-chart"
              size="lg"
              onPress={() => router.replace(`/result/${runId}`)}
              style={{ flex: 1 }}
            />
            <Button
              label={t('common.done')}
              variant="secondary"
              size="lg"
              onPress={() => router.replace('/history')}
            />
          </>
        ) : (
          <Button
            label={t('run.cancel')}
            variant="secondary"
            icon="stop-circle-outline"
            loading={cancelling}
            onPress={cancel}
            fullWidth
            size="lg"
          />
        )}
      </View>
    </Screen>
  );
}

function MiniStat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'success' | 'danger';
}): React.JSX.Element {
  const color =
    tone === 'success' ? palette.success : tone === 'danger' ? palette.danger : palette.ink;
  return (
    <View style={styles.miniStat}>
      <Text variant="micro" tone="subtle">
        {label.toUpperCase()}
      </Text>
      <Text variant="small" style={{ fontFamily: font.bold, color, marginTop: 1 }}>
        {value}
      </Text>
    </View>
  );
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

const styles = StyleSheet.create({
  top: { alignItems: 'center', paddingHorizontal: spacing.xl },
  statusRing: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { paddingHorizontal: spacing.xl, marginTop: spacing.xl },
  progressHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  miniStat: {
    flex: 1,
    backgroundColor: palette.surfaceAlt,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
  },
  testRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 5 },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    backgroundColor: palette.canvas,
    borderTopWidth: 1,
    borderTopColor: palette.line,
  },
});
