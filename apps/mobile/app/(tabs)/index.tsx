import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ConnectionResult } from '../../src/api/client';
import { api } from '../../src/api/client';
import { OutlinedInput } from '../../src/components/fields';
import { ShieldMark } from '../../src/components/ShieldMark';
import { Badge, Banner, Button, Card, EmptyState, Screen, Text } from '../../src/components/ui';
import { useI18n } from '../../src/i18n';
import { font, palette, radius, spacing, useResponsive } from '../../src/theme';

export default function SearchScreen(): React.JSX.Element {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const { gutter, isCompact } = useResponsive();

  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ConnectionResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    if (!input.trim()) {
      setError('Domain cannot be empty');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await api.validateConnection(input.trim());
      setResults(data.results);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
      setResults(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll padded={false} bottomInset={spacing.xxl}>
      <View style={{ paddingHorizontal: gutter, paddingTop: insets.top + spacing.xxl }}>
        <View style={styles.hero}>
          <ShieldMark size={isCompact ? 92 : 112} />
          <Text variant="h1" center style={{ marginTop: spacing.lg }}>
            {t('search.title')}
          </Text>
        </View>

        <Card style={styles.formCard}>
          <OutlinedInput
            label=""
            value={input}
            onChangeText={setInput}
            placeholder={t('search.placeholder')}
            multiline
            minHeight={56}
            autoCapitalize="none"
          />

          <Text variant="small" tone="muted" style={{ marginTop: spacing.md, lineHeight: 20 }}>
            {t('search.tip')}
          </Text>

          <View style={{ height: spacing.lg }} />

          <Button
            label={busy ? t('search.testing') : t('search.test')}
            icon="play"
            onPress={() => void run()}
            loading={busy}
            disabled={!input.trim()}
            fullWidth
            size="lg"
          />
        </Card>

        {error ? (
          <View style={{ marginTop: spacing.lg }}>
            <Banner tone="error" message={error} />
          </View>
        ) : null}
      </View>

      <View style={{ paddingHorizontal: gutter, marginTop: spacing.xl }}>
        {busy && !results ? (
          <View style={styles.loading}>
            <ActivityIndicator color={palette.primary} />
            <Text variant="small" tone="muted" style={{ marginTop: spacing.sm }}>
              {t('search.testing')}
            </Text>
          </View>
        ) : null}

        {results === null && !busy ? (
          <EmptyState icon="globe-outline" title={t('search.title')} message={t('search.noResults')} />
        ) : null}

        {results?.map((result) => (
          <ConnectionCard
            key={result.input}
            result={result}
            expanded={expanded === result.input}
            onToggle={() => setExpanded(expanded === result.input ? null : result.input)}
          />
        ))}
      </View>
    </Screen>
  );
}

/* ------------------------------------------------------------------ *
 * Result card
 * ------------------------------------------------------------------ */

function ConnectionCard({
  result,
  expanded,
  onToggle,
}: {
  result: ConnectionResult;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const ok = result.reachable;

  return (
    <Card style={{ marginBottom: spacing.md }}>
      <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded }}>
        <View style={styles.cardHead}>
          <View style={{ flex: 1 }}>
            <Text variant="h3" numberOfLines={1}>
              {result.host ?? result.input}
            </Text>
            <Text variant="small" tone="muted" numberOfLines={1}>
              {result.origin ?? result.input}
            </Text>
          </View>
          <Badge
            label={ok ? t('search.reachable') : t('search.unreachable')}
            fg={ok ? '#137247' : '#A8282C'}
            bg={ok ? palette.successSoft : palette.dangerSoft}
            icon={ok ? 'checkmark-circle' : 'close-circle'}
          />
        </View>

        {ok ? (
          <>
            <View style={styles.metricRow}>
              <Metric label="HTTP" value={String(result.statusCode ?? '—')} />
              <Metric label="TTFB" value={fmtMs(result.timing.ttfbMs)} />
              <Metric label="Total" value={fmtMs(result.timing.totalMs)} />
              <Metric label="Bytes" value={String(result.bytesReceived)} />
            </View>

            <View style={styles.tagRow}>
              {result.platform?.edge ? (
                <Tag icon="shield-checkmark" text={result.platform.edge.name} />
              ) : (
                <Tag icon="alert-circle-outline" text="No edge / WAF detected" muted />
              )}
              {result.platform?.origin ? (
                <Tag icon="server-outline" text={result.platform.origin.name} muted />
              ) : result.server ? (
                <Tag icon="server-outline" text={result.server} muted />
              ) : null}
              {result.platform?.cacheStatus ? (
                <Tag icon="flash-outline" text={`cache ${result.platform.cacheStatus}`} muted />
              ) : null}
              {result.tls ? (
                <Tag
                  icon={result.tls.authorized ? 'lock-closed' : 'lock-open'}
                  text={`${result.tls.protocol ?? 'TLS'}${result.tls.daysUntilExpiry !== null ? ` · ${result.tls.daysUntilExpiry}d` : ''}`}
                  muted={!result.tls.authorized}
                />
              ) : null}
            </View>
          </>
        ) : (
          <View style={{ marginTop: spacing.md }}>
            <Banner tone="error" message={result.error ?? 'Target did not respond'} />
          </View>
        )}
      </Pressable>

      {expanded && ok ? (
        <View style={styles.detail}>
          <Text variant="small" style={{ fontFamily: font.bold, marginBottom: spacing.sm }}>
            {t('search.timing')}
          </Text>
          <TimingRow label="DNS" value={result.timing.dnsMs} max={result.timing.totalMs ?? 1} />
          <TimingRow label="TCP" value={result.timing.tcpMs} max={result.timing.totalMs ?? 1} />
          <TimingRow label="TLS" value={result.timing.tlsMs} max={result.timing.totalMs ?? 1} />
          <TimingRow label="First byte" value={result.timing.ttfbMs} max={result.timing.totalMs ?? 1} />
          <TimingRow label="Total" value={result.timing.totalMs} max={result.timing.totalMs ?? 1} />

          {result.tls ? (
            <>
              <Text
                variant="small"
                style={{ fontFamily: font.bold, marginTop: spacing.lg, marginBottom: spacing.sm }}
              >
                {t('search.tls')}
              </Text>
              <KeyValue label="Protocol" value={result.tls.protocol ?? '—'} />
              <KeyValue label="Cipher" value={result.tls.cipher ?? '—'} />
              <KeyValue label="Subject" value={result.tls.subject ?? '—'} />
              <KeyValue label="Issuer" value={result.tls.issuer ?? '—'} />
              <KeyValue label="Expires" value={result.tls.validTo ?? '—'} />
            </>
          ) : null}

          {/* What identified the platform — the conclusion plus its evidence */}
          {result.platform && result.platform.signals.length > 0 ? (
            <>
              <Text
                variant="small"
                style={{ fontFamily: font.bold, marginTop: spacing.lg, marginBottom: spacing.sm }}
              >
                Platform detected
              </Text>
              <KeyValue
                label="Path"
                value={result.platformSummary ?? result.platform.edge?.name ?? 'Unknown'}
              />
              {result.platform.directToOrigin ? (
                <Text variant="tiny" tone="muted" style={{ marginTop: spacing.xs, lineHeight: 18 }}>
                  No edge identified — the request appears to have gone straight to an origin.
                </Text>
              ) : null}
              {result.platform.signals.map((signal) => (
                <KeyValue key={signal} label="Signal" value={signal} />
              ))}
            </>
          ) : null}

          {result.redirectChain.length > 0 ? (
            <>
              <Text
                variant="small"
                style={{ fontFamily: font.bold, marginTop: spacing.lg, marginBottom: spacing.sm }}
              >
                Redirects
              </Text>
              {result.redirectChain.map((hop, i) => (
                <KeyValue key={`${hop}-${i}`} label={`Hop ${i + 1}`} value={hop} />
              ))}
            </>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.metric}>
      <Text variant="micro" tone="subtle">
        {label.toUpperCase()}
      </Text>
      <Text variant="small" style={{ fontFamily: font.semibold, marginTop: 1 }}>
        {value}
      </Text>
    </View>
  );
}

function Tag({
  icon,
  text,
  muted,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
  muted?: boolean;
}): React.JSX.Element {
  return (
    <View style={[styles.tag, muted && { backgroundColor: palette.surfaceSunken }]}>
      <Ionicons name={icon} size={12} color={muted ? palette.inkMuted : palette.primaryDark} />
      <Text variant="tiny" style={{ color: muted ? palette.inkMuted : palette.primaryDark }}>
        {text}
      </Text>
    </View>
  );
}

function TimingRow({
  label,
  value,
  max,
}: {
  label: string;
  value: number | null;
  max: number;
}): React.JSX.Element {
  const pct = value !== null && max > 0 ? Math.min(1, value / max) : 0;
  return (
    <View style={styles.timingRow}>
      <Text variant="tiny" tone="muted" style={{ width: 72 }}>
        {label}
      </Text>
      <View style={styles.timingTrack}>
        <View style={[styles.timingFill, { width: `${pct * 100}%` }]} />
      </View>
      <Text variant="tiny" style={{ width: 64, textAlign: 'right', fontFamily: font.medium }}>
        {fmtMs(value)}
      </Text>
    </View>
  );
}

function KeyValue({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.kvLine}>
      <Text variant="tiny" tone="muted" style={{ width: 76 }}>
        {label}
      </Text>
      <Text variant="tiny" style={{ flex: 1 }} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

function fmtMs(value: number | null): string {
  if (value === null || value === undefined) return '—';
  return value < 1 ? `${value.toFixed(2)}ms` : `${Math.round(value)}ms`;
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', marginBottom: spacing.xl },
  formCard: { padding: spacing.lg },
  loading: { alignItems: 'center', paddingVertical: spacing.xxl },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  metricRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  metric: {
    flex: 1,
    backgroundColor: palette.surfaceAlt,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
  },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.md },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: palette.primarySoft,
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
  },
  detail: { marginTop: spacing.lg, paddingTop: spacing.lg, borderTopWidth: 1, borderTopColor: palette.line },
  timingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: 6 },
  timingTrack: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: palette.surfaceSunken,
    overflow: 'hidden',
  },
  timingFill: { height: '100%', borderRadius: 3, backgroundColor: palette.primary },
  kvLine: { flexDirection: 'row', gap: spacing.sm, marginBottom: 5 },
});
