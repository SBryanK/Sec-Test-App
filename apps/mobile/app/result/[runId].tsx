import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import type { RunRecord, Severity } from '@teo/shared';
import { SEVERITY_RANK, getTest } from '@teo/shared';

import type { Finding, TestSummary, TraceRow } from '../../src/api/client';
import { api } from '../../src/api/client';
import { exportRun } from '../../src/lib/export';
import {
  Badge,
  Banner,
  Button,
  Card,
  CodeBlock,
  Divider,
  EmptyState,
  Header,
  Screen,
  StatTile,
  Text,
} from '../../src/components/ui';
import { useI18n } from '../../src/i18n';
import { font, palette, radius, severityColor, spacing, verdictColor } from '../../src/theme';

type Tab = 'findings' | 'perTest' | 'traces';

export default function ResultScreen(): React.JSX.Element {
  const { runId } = useLocalSearchParams<{ runId: string }>();
  const router = useRouter();
  const { t } = useI18n();

  const [run, setRun] = useState<RunRecord | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [traces, setTraces] = useState<TraceRow[]>([]);
  const [tests, setTests] = useState<TestSummary[]>([]);
  const [traceCount, setTraceCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('findings');
  const [expandedFinding, setExpandedFinding] = useState<string | null>(null);
  const [expandedTrace, setExpandedTrace] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await api.getRun(runId);
      setRun(data.run);
      setFindings(data.findings);
      setTraceCount(data.traceCount);
      setTests(data.tests ?? []);
      const { traces: rows } = await api.getTraces(runId, { limit: 300 });
      setTraces(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [runId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = run?.summary ?? null;

  /** Group traces by test for the per-test view. */
  const byTest = useMemo(() => {
    const map = new Map<string, TraceRow[]>();
    for (const trace of traces) {
      const list = map.get(trace.test_id) ?? [];
      list.push(trace);
      map.set(trace.test_id, list);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [traces]);

  const doExport = async (format: 'json' | 'csv' | 'html'): Promise<void> => {
    setExporting(format);
    setExportNote(null);
    try {
      const note = await exportRun(runId, format, run?.target ?? 'run');
      setExportNote(note);
    } catch (err) {
      setExportNote(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(null);
    }
  };

  if (loading) {
    return (
      <Screen padded={false}>
        <Header title={t('result.title')} onBack={() => router.back()} />
        <ActivityIndicator style={{ marginTop: spacing.huge }} color={palette.primary} />
      </Screen>
    );
  }

  if (!run) {
    return (
      <Screen padded={false}>
        <Header title={t('result.title')} onBack={() => router.back()} />
        <EmptyState icon="alert-circle-outline" title={t('common.error')} message={error ?? undefined} />
      </Screen>
    );
  }

  const statusColor =
    run.status === 'success' ? palette.success : run.status === 'failed' ? palette.danger : palette.inkMuted;

  return (
    <Screen
      scroll
      padded={false}
      bottomInset={spacing.xxl}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />}
    >
      <Header
        title={t('result.title')}
        subtitle={`${run.label} · ${run.target}`}
        onBack={() => router.back()}
        right={
          <Pressable onPress={() => void doExport('html')} hitSlop={8} accessibilityRole="button">
            <Ionicons name="share-outline" size={20} color={palette.primary} />
          </Pressable>
        }
      />

      <View style={styles.body}>
        {error ? (
          <View style={{ marginBottom: spacing.lg }}>
            <Banner tone="error" message={error} />
          </View>
        ) : null}

        {/* Run header */}
        <Card>
          <View style={styles.runHead}>
            <View style={{ flex: 1 }}>
              <Text variant="h2">{run.label}</Text>
              <Text variant="small" tone="muted" style={{ marginTop: 2 }}>
                {run.target} · {new Date(run.createdAt).toLocaleString()}
              </Text>
            </View>
            <Badge
              label={run.status}
              fg={statusColor}
              bg={run.status === 'success' ? palette.successSoft : run.status === 'failed' ? palette.dangerSoft : palette.surfaceSunken}
              icon={run.status === 'success' ? 'checkmark-circle' : 'information-circle'}
            />
          </View>

          <View style={styles.statGrid}>
            <StatTile label="Probes" value={summary?.totalProbes ?? 0} icon="pulse-outline" />
            <StatTile label={t('result.bypassed')} value={summary?.bypassed ?? 0} tone="danger" icon="warning-outline" />
            <StatTile label={t('result.blocked')} value={summary?.blocked ?? 0} tone="success" icon="shield-checkmark-outline" />
            <StatTile label={t('result.errors')} value={summary?.errors ?? 0} tone="muted" icon="alert-outline" />
          </View>

          <Divider style={{ marginVertical: spacing.lg }} />

          <DetailRow label={t('history.duration')} value={`${run.durationMs ?? 0} ms`} />
          <DetailRow label="Mean first byte" value={summary?.meanTtfbMs !== null && summary?.meanTtfbMs !== undefined ? `${summary.meanTtfbMs} ms` : '—'} />
          <DetailRow label="Achieved rate" value={summary?.achievedRps ? `${summary.achievedRps} req/s` : '—'} />
          <DetailRow label="Bytes sent" value={fmtBytes(summary?.bytesSent ?? 0)} />
          <DetailRow label="Bytes received" value={fmtBytes(summary?.bytesReceived ?? 0)} />

          <Divider style={{ marginVertical: spacing.lg }} />

          <Text variant="micro" tone="subtle">
            PROVENANCE
          </Text>
          <Text variant="tiny" tone="muted" style={{ marginTop: spacing.xs }}>
            {run.provenance.operatorEmail} · {run.provenance.platform} · {run.provenance.device}
          </Text>
          <Text variant="tiny" tone="subtle" style={{ marginTop: 2 }} numberOfLines={2}>
            {run.provenance.configHash}
          </Text>
        </Card>

        {/* What happened — plain language, no jargon */}
        <Card style={{ marginTop: spacing.md }}>
          <View style={styles.happenedHead}>
            <Ionicons name="information-circle-outline" size={17} color={palette.ink} />
            <Text variant="small" style={{ fontFamily: font.bold, flex: 1 }}>
              What happened
            </Text>
          </View>
          <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
            {plainSummary(tests, findings.length).map((line, i) => (
              <View key={i} style={styles.happenedRow}>
                <Ionicons
                  name={line.icon}
                  size={15}
                  color={line.tone}
                  style={{ marginTop: 1 }}
                />
                <Text variant="small" style={{ flex: 1, lineHeight: 21 }}>
                  {line.text}
                </Text>
              </View>
            ))}
          </View>
        </Card>

        {/* Iteration breakdown — when did it start blocking? */}
        {tests.length > 0 ? (
          <Card style={{ marginTop: spacing.md }}>
            <View style={styles.happenedHead}>
              <Ionicons name="repeat-outline" size={17} color={palette.ink} />
              <Text variant="small" style={{ fontFamily: font.bold, flex: 1 }}>
                Iterations
              </Text>
            </View>
            <Text variant="tiny" tone="muted" style={{ marginTop: 2, marginBottom: spacing.md }}>
              Each attempt in order, and where the target started pushing back.
            </Text>
            {tests.map((test) => (
              <IterationBar key={test.testId} test={test} />
            ))}
          </Card>
        ) : null}

        {/* Tabs */}
        <View style={styles.tabs}>
          {(
            [
              ['findings', `Findings (${findings.length})`],
              ['perTest', `Per-test (${byTest.length})`],
              ['traces', `Requests (${traceCount})`],
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <Pressable
              key={key}
              onPress={() => setTab(key)}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected: tab === key }}
              style={[styles.tab, tab === key && styles.tabActive]}
            >
              <Text
                variant="small"
                style={{
                  color: tab === key ? palette.primaryDark : palette.inkMuted,
                  fontFamily: tab === key ? font.bold : font.medium,
                }}
              >
                {label}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Findings */}
        {tab === 'findings' ? (
          findings.length === 0 ? (
            <EmptyState
              icon="shield-checkmark-outline"
              title={t('result.noFindings')}
              message={t('result.noFindingsHint')}
            />
          ) : (
            findings.map((finding) => {
              const sev = severityColor[finding.severity] ?? severityColor.info!;
              const open = expandedFinding === finding.id;
              return (
                <Card key={finding.id} style={{ marginBottom: spacing.md }}>
                  <Pressable
                    onPress={() => setExpandedFinding(open ? null : finding.id)}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: open }}
                  >
                    <View style={styles.findingHead}>
                      <Badge label={finding.severity} fg={sev.fg} bg={sev.bg} />
                      <Text variant="tiny" tone="muted" style={{ marginLeft: spacing.sm }}>
                        {testLabel(finding.testId)}
                      </Text>
                      <View style={{ flex: 1 }} />
                      <Ionicons
                        name={open ? 'chevron-up' : 'chevron-down'}
                        size={17}
                        color={palette.inkMuted}
                      />
                    </View>
                    <Text variant="h3" style={{ marginTop: spacing.sm }}>
                      {finding.title}
                    </Text>
                    <Text variant="small" tone="muted" style={{ marginTop: spacing.xs }}>
                      {finding.description}
                    </Text>
                  </Pressable>

                  {open ? (
                    <View style={{ marginTop: spacing.md }}>
                      <Text variant="micro" tone="subtle">
                        {t('result.evidence').toUpperCase()}
                      </Text>
                      <View style={{ marginTop: spacing.xs }}>
                        <CodeBlock>{finding.evidence}</CodeBlock>
                      </View>

                      <Text variant="micro" tone="subtle" style={{ marginTop: spacing.lg }}>
                        {t('result.remediation').toUpperCase()}
                      </Text>
                      <Text variant="small" style={{ marginTop: spacing.xs, lineHeight: 21 }}>
                        {finding.remediation}
                      </Text>

                      {finding.references.length > 0 ? (
                        <>
                          <Text variant="micro" tone="subtle" style={{ marginTop: spacing.lg }}>
                            {t('result.references').toUpperCase()}
                          </Text>
                          <View style={styles.refRow}>
                            {finding.references.map((ref) => (
                              <View key={ref} style={styles.refChip}>
                                <Text variant="tiny" tone="muted">
                                  {ref}
                                </Text>
                              </View>
                            ))}
                          </View>
                        </>
                      ) : null}
                    </View>
                  ) : null}
                </Card>
              );
            })
          )
        ) : null}

        {/* Per-test */}
        {tab === 'perTest' ? (
          byTest.length === 0 ? (
            <EmptyState icon="list-outline" title="No probes recorded" />
          ) : (
            byTest.map(([testId, rows]) => {
              const blocked = rows.filter((r) => r.verdict === 'blocked').length;
              const bypassed = rows.filter((r) => r.verdict === 'bypassed').length;
              const errors = rows.filter((r) => r.verdict === 'error').length;
              const worst = rows.reduce<Severity | null>((acc, r) => {
                const current = r.severity as Severity | null;
                if (!current) return acc;
                if (!acc) return current;
                return SEVERITY_RANK[current] > SEVERITY_RANK[acc] ? current : acc;
              }, null);
              const sev = worst ? severityColor[worst] : null;
              const meanTtfb =
                rows.filter((r) => r.ttfb_ms !== null).reduce((sum, r) => sum + (r.ttfb_ms ?? 0), 0) /
                Math.max(1, rows.filter((r) => r.ttfb_ms !== null).length);

              return (
                <Card key={testId} style={{ marginBottom: spacing.md }}>
                  <View style={styles.findingHead}>
                    <Text variant="h3" style={{ flex: 1 }} numberOfLines={2}>
                      {testLabel(testId)}
                    </Text>
                    {sev && worst ? <Badge label={worst} fg={sev.fg} bg={sev.bg} size="sm" /> : null}
                  </View>

                  <View style={styles.statGrid}>
                    <StatTile label="Probes" value={rows.length} />
                    <StatTile label={t('result.blocked')} value={blocked} tone="success" />
                    <StatTile label={t('result.bypassed')} value={bypassed} tone="danger" />
                    <StatTile label={t('result.errors')} value={errors} tone="muted" />
                  </View>

                  <DetailRow label="Mean first byte" value={`${Math.round(meanTtfb * 100) / 100} ms`} />
                  <DetailRow
                    label="Status codes"
                    value={[...new Set(rows.map((r) => r.status_code ?? 'err'))].sort().join(', ')}
                  />
                </Card>
              );
            })
          )
        ) : null}

        {/* Request log */}
        {tab === 'traces' ? (
          traces.length === 0 ? (
            <EmptyState icon="document-text-outline" title="No request traces" />
          ) : (
            <>
              <Text variant="tiny" tone="muted" style={{ marginBottom: spacing.sm }}>
                Showing {traces.length} of {traceCount} probes · tap a row for full telemetry
              </Text>
              {traces.map((trace) => (
                <TraceCard
                  key={trace.id}
                  trace={trace}
                  open={expandedTrace === trace.id}
                  onToggle={() => setExpandedTrace(expandedTrace === trace.id ? null : trace.id)}
                />
              ))}
            </>
          )
        ) : null}

        {/* Export */}
        <Card style={{ marginTop: spacing.lg }}>
          <Text variant="small" style={{ fontFamily: font.bold, marginBottom: spacing.sm }}>
            {t('result.export')}
          </Text>
          <View style={styles.exportRow}>
            <Button
              label="HTML"
              size="sm"
              variant="secondary"
              icon="document-text-outline"
              loading={exporting === 'html'}
              onPress={() => void doExport('html')}
            />
            <Button
              label="JSON"
              size="sm"
              variant="secondary"
              icon="code-outline"
              loading={exporting === 'json'}
              onPress={() => void doExport('json')}
            />
            <Button
              label="CSV"
              size="sm"
              variant="secondary"
              icon="grid-outline"
              loading={exporting === 'csv'}
              onPress={() => void doExport('csv')}
            />
          </View>
          {exportNote ? (
            <View style={{ marginTop: spacing.md }}>
              <Banner tone="info" message={exportNote} />
            </View>
          ) : null}
        </Card>
      </View>
    </Screen>
  );
}


/* ------------------------------------------------------------------ *
 * Plain-language summary
 * ------------------------------------------------------------------ */

interface PlainLine {
  icon: keyof typeof Ionicons.glyphMap;
  tone: string;
  text: string;
}

/**
 * Turn the numbers into sentences.
 *
 * The cards above the tabs are precise but dense. This says what actually
 * happened, in the order an operator would ask it: did anything get through,
 * did the target fight back, and if so from which attempt.
 */
function plainSummary(tests: TestSummary[], findingCount: number): PlainLine[] {
  if (tests.length === 0) {
    return [
      {
        icon: 'hourglass-outline',
        tone: palette.inkMuted,
        text: 'No probes were recorded for this run.',
      },
    ];
  }

  const lines: PlainLine[] = [];
  const totalProbes = tests.reduce((n, t) => n + t.probes, 0);
  const totalBypassed = tests.reduce((n, t) => n + t.bypassed, 0);
  const totalBlocked = tests.reduce((n, t) => n + t.blocked, 0);
  const totalErrors = tests.reduce((n, t) => n + t.errors, 0);

  lines.push({
    icon: 'pulse-outline',
    tone: palette.inkMuted,
    text: `${totalProbes} request${totalProbes === 1 ? '' : 's'} sent across ${tests.length} test${tests.length === 1 ? '' : 's'}.`,
  });

  if (totalBypassed > 0) {
    const worst = tests
      .filter((t) => t.bypassed > 0)
      .sort((a, b) => b.bypassed - a.bypassed)[0];
    lines.push({
      icon: 'warning-outline',
      tone: palette.danger,
      text:
        `${totalBypassed} request${totalBypassed === 1 ? '' : 's'} got through without being stopped — ${findingCount} finding${findingCount === 1 ? '' : 's'} recorded.` +
        (worst?.firstBypassedIteration
          ? ` Earliest was iteration ${worst.firstBypassedIteration} of ${testLabel(worst.testId)}.`
          : ''),
    });
  }

  if (totalBlocked > 0) {
    const throttled = tests
      .filter((t) => t.firstBlockedIteration !== null)
      .sort((a, b) => (a.firstBlockedIteration ?? 0) - (b.firstBlockedIteration ?? 0))[0];
    lines.push({
      icon: 'shield-checkmark-outline',
      tone: palette.success,
      text:
        `Protection stopped ${totalBlocked} request${totalBlocked === 1 ? '' : 's'}.` +
        (throttled?.firstBlockedIteration
          ? ` Blocking began at iteration ${throttled.firstBlockedIteration} of ${testLabel(throttled.testId)}.`
          : ''),
    });
  }

  if (totalErrors > 0) {
    const errored = tests.find((t) => t.firstErrorIteration !== null);
    lines.push({
      icon: 'alert-outline',
      tone: palette.inkMuted,
      text:
        `${totalErrors} request${totalErrors === 1 ? '' : 's'} failed at the network level.` +
        (errored?.firstErrorIteration ? ` First at iteration ${errored.firstErrorIteration}.` : ''),
    });
  }

  if (totalBypassed === 0 && totalBlocked === 0 && totalErrors === 0) {
    lines.push({
      icon: 'checkmark-circle-outline',
      tone: palette.success,
      text: 'Every request completed normally. Nothing was blocked and nothing got through that should not have.',
    });
  }

  return lines;
}

/* ------------------------------------------------------------------ *
 * Iteration bar
 * ------------------------------------------------------------------ */

/**
 * A single strip showing every attempt in order, coloured by outcome, with
 * markers for the first block and the first bypass.
 *
 * A 500-request run is unreadable as rows; this makes "it started blocking
 * about a third of the way in" visible at a glance.
 */
function IterationBar({ test }: { test: TestSummary }): React.JSX.Element {
  const segments: Array<{ count: number; color: string; label: string }> = [
    { count: test.passed, color: palette.primary, label: 'passed' },
    { count: test.blocked, color: palette.success, label: 'blocked' },
    { count: test.bypassed, color: palette.danger, label: 'bypassed' },
    { count: test.errors, color: palette.inkSubtle, label: 'errors' },
  ].filter((seg) => seg.count > 0);

  return (
    <View style={{ marginBottom: spacing.lg }}>
      <View style={styles.iterHead}>
        <Text variant="small" style={{ fontFamily: font.semibold, flex: 1 }} numberOfLines={1}>
          {testLabel(test.testId)}
        </Text>
        <Text variant="tiny" tone="muted">
          {test.probes} iteration{test.probes === 1 ? '' : 's'}
        </Text>
      </View>

      <View style={styles.iterTrack}>
        {segments.map((seg) => (
          <View key={seg.label} style={{ flex: seg.count, backgroundColor: seg.color, height: '100%' }} />
        ))}
      </View>

      <View style={styles.iterLegend}>
        {segments.map((seg) => (
          <View key={seg.label} style={styles.iterLegendItem}>
            <View style={[styles.iterDot, { backgroundColor: seg.color }]} />
            <Text variant="micro" tone="muted">
              {seg.count} {seg.label}
            </Text>
          </View>
        ))}
      </View>

      {test.firstBlockedIteration !== null ? (
        <Text variant="tiny" style={{ color: palette.success, marginTop: 2 }}>
          Blocking began at iteration {test.firstBlockedIteration}
          {test.firstStatusCode !== null && test.lastStatusCode !== null
            ? ` — status went ${test.firstStatusCode} → ${test.lastStatusCode}`
            : ''}
        </Text>
      ) : null}

      {test.firstBypassedIteration !== null ? (
        <Text variant="tiny" style={{ color: palette.danger, marginTop: 2 }}>
          First successful bypass at iteration {test.firstBypassedIteration}
        </Text>
      ) : null}

      {test.statusCodes.length > 0 ? (
        <Text variant="micro" tone="subtle" style={{ marginTop: 2 }}>
          STATUS CODES SEEN: {test.statusCodes.join(', ')}
        </Text>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Trace row
 * ------------------------------------------------------------------ */

function TraceCard({
  trace,
  open,
  onToggle,
}: {
  trace: TraceRow;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const vc = verdictColor[trace.verdict] ?? verdictColor.inconclusive!;
  const sev = trace.severity ? severityColor[trace.severity] : null;

  return (
    <Card style={{ marginBottom: spacing.sm, padding: spacing.md }}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Probe ${trace.iteration ?? trace.seq}: ${trace.method} ${trace.status_code ?? 'no response'}, ${trace.verdict}`}
      >
        <View style={styles.traceHead}>
          <Text variant="tiny" tone="subtle" style={{ width: 34 }}>
            #{trace.seq}
          </Text>
          <View style={{ flex: 1 }}>
            <Text variant="tiny" numberOfLines={1} style={{ fontFamily: font.semibold }}>
              {trace.method} {shortUrl(trace.url)}
            </Text>
            <Text variant="micro" tone="muted" style={{ marginTop: 1 }}>
              HTTP {trace.status_code ?? '—'} · {trace.ttfb_ms ?? '—'}ms · {trace.response_bytes}B
            </Text>
          </View>
          {sev && trace.severity ? <Badge label={trace.severity} fg={sev.fg} bg={sev.bg} size="sm" /> : null}
          <Badge label={trace.verdict} fg={vc.fg} bg={vc.bg} size="sm" />
        </View>
      </Pressable>

      {open ? (
        <View style={styles.traceDetail}>
          {/* Connection overview — the shape a browser network panel shows */}
          <Text variant="micro" tone="subtle">
            OVERVIEW
          </Text>
          <View style={{ marginTop: spacing.xs }}>
            <OverviewRow label="Request URL" value={trace.url} mono />
            <OverviewRow label="Request method" value={trace.method} />
            <OverviewRow
              label="Status code"
              value={trace.status_code !== null ? `${trace.status_code}` : 'no response'}
              tone={trace.status_code === null ? 'danger' : trace.status_code >= 400 ? 'warn' : 'ok'}
            />
            <OverviewRow
              label="Remote address"
              value={trace.remote_address ?? '—'}
              hint="The IP that actually answered — for a CDN-fronted target this is the edge node"
            />
            <OverviewRow
              label="Referrer policy"
              value={headerValue(trace.response_headers, 'referrer-policy') ?? '—'}
            />
            <OverviewRow
              label="Server"
              value={headerValue(trace.response_headers, 'server') ?? '—'}
            />
            <OverviewRow
              label="Iteration"
              value={trace.iteration !== null ? `#${trace.iteration}` : `#${trace.seq}`}
            />
          </View>

          <Text variant="micro" tone="subtle" style={{ marginTop: spacing.md }}>
            REQUEST ({trace.request_bytes} B)
          </Text>
          <View style={{ marginTop: spacing.xs }}>
            <CodeBlock>{`${trace.method} ${trace.url}\n${Object.entries(trace.request_headers)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n')}${trace.request_body_preview ? `\n\n${trace.request_body_preview}` : ''}`}</CodeBlock>
          </View>

          <Text variant="micro" tone="subtle" style={{ marginTop: spacing.md }}>
            RESPONSE HEADERS ({Object.keys(trace.response_headers).length})
          </Text>
          <View style={{ marginTop: spacing.xs }}>
            {Object.keys(trace.response_headers).length === 0 ? (
              <Text variant="tiny" tone="muted">
                No response headers were received.
              </Text>
            ) : (
              Object.entries(trace.response_headers)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, value]) => (
                  <View key={key} style={styles.headerRow}>
                    <Text variant="tiny" tone="muted" style={{ width: 150 }} numberOfLines={2}>
                      {key}
                    </Text>
                    <Text variant="tiny" style={{ flex: 1 }} selectable>
                      {value}
                    </Text>
                  </View>
                ))
            )}
          </View>

          <Text variant="micro" tone="subtle" style={{ marginTop: spacing.md }}>
            TIMING (ms)
          </Text>
          <View style={styles.timingGrid}>
            <TimingCell label="DNS" value={trace.dns_ms} />
            <TimingCell label="TCP" value={trace.tcp_ms} />
            <TimingCell label="TLS" value={trace.tls_ms} />
            <TimingCell label="1st byte" value={trace.ttfb_ms} />
            <TimingCell label="Total" value={trace.total_ms} />
          </View>

          <Text variant="micro" tone="subtle" style={{ marginTop: spacing.md }}>
            SIZE
          </Text>
          <DetailRow label="Request bytes" value={`${trace.request_bytes} B`} />
          <DetailRow label="Response bytes" value={`${trace.response_bytes} B`} />
          <DetailRow label="Payload" value={trace.payload ?? '—'} />
          <DetailRow label="Injection point" value={trace.injection_point ?? '—'} />

          {trace.reason ? (
            <>
              <Text variant="micro" tone="subtle" style={{ marginTop: spacing.md }}>
                VERDICT
              </Text>
              <Text variant="small" style={{ marginTop: spacing.xs }}>
                {trace.reason}
              </Text>
              {trace.signature ? (
                <Text variant="micro" tone="primary" style={{ marginTop: spacing.xs }}>
                  {trace.signature}
                </Text>
              ) : null}
            </>
          ) : null}

          {trace.response_body_preview ? (
            <>
              <Text variant="micro" tone="subtle" style={{ marginTop: spacing.md }}>
                RESPONSE PREVIEW
              </Text>
              <CodeBlock>{trace.response_body_preview.slice(0, 800)}</CodeBlock>
            </>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

/** Case-insensitive response header lookup. */
function headerValue(headers: Record<string, string>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

function OverviewRow({
  label,
  value,
  hint,
  mono,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
  tone?: 'ok' | 'warn' | 'danger';
}): React.JSX.Element {
  const color =
    tone === 'danger' ? palette.danger : tone === 'warn' ? '#8A6100' : palette.ink;
  return (
    <View style={{ paddingVertical: 4 }}>
      <Text variant="micro" tone="subtle">
        {label.toUpperCase()}
      </Text>
      <Text
        variant="tiny"
        selectable
        style={{
          color,
          fontFamily: mono ? 'monospace' : undefined,
          lineHeight: 17,
        }}
      >
        {value}
      </Text>
      {hint ? (
        <Text variant="micro" tone="subtle" style={{ marginTop: 1 }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

function TimingCell({ label, value }: { label: string; value: number | null }): React.JSX.Element {
  return (
    <View style={styles.timingCell}>
      <Text variant="micro" tone="subtle">
        {label.toUpperCase()}
      </Text>
      <Text variant="tiny" style={{ fontFamily: font.semibold, marginTop: 1 }}>
        {value === null ? '—' : value < 1 ? value.toFixed(2) : Math.round(value)}
      </Text>
    </View>
  );
}

function DetailRow({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}): React.JSX.Element {
  return (
    <View style={styles.detailRow}>
      <Text variant="small" tone="muted" style={{ flex: 1 }}>
        {label}
      </Text>
      <Text
        variant="small"
        numberOfLines={1}
        style={{ fontFamily: font.semibold, maxWidth: '58%', color: valueColor ?? palette.ink }}
      >
        {value}
      </Text>
    </View>
  );
}

function testLabel(testId: string): string {
  try {
    return getTest(testId as never).label;
  } catch {
    return testId;
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search}`.slice(0, 70);
  } catch {
    return url.slice(0, 70);
  }
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl },
  runHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.lg },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    gap: spacing.sm,
  },
  tabs: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginVertical: spacing.lg,
    backgroundColor: palette.surfaceAlt,
    padding: 4,
    borderRadius: radius.lg,
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm, borderRadius: radius.md },
  tabActive: { backgroundColor: palette.surface },
  findingHead: { flexDirection: 'row', alignItems: 'center' },
  refRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
  refChip: {
    backgroundColor: palette.surfaceAlt,
    paddingVertical: 3,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
  },
  happenedHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  happenedRow: { flexDirection: 'row', gap: spacing.sm },
  iterHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: 4 },
  iterTrack: {
    flexDirection: 'row',
    height: 14,
    borderRadius: 7,
    overflow: 'hidden',
    backgroundColor: palette.surfaceSunken,
  },
  iterLegend: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: 6 },
  iterLegendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  iterDot: { width: 7, height: 7, borderRadius: 4 },
  headerRow: {
    flexDirection: 'row',
    paddingVertical: 3,
    borderBottomWidth: 1,
    borderBottomColor: palette.line,
    gap: spacing.sm,
  },
  traceHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  traceDetail: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: palette.line,
  },
  timingGrid: { flexDirection: 'row', gap: spacing.xs, marginTop: spacing.xs },
  timingCell: {
    flex: 1,
    backgroundColor: palette.surfaceAlt,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  exportRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
});
