import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { api } from '../src/api/client';
import { Banner, Button, Card, Header, ProgressBar, Screen, Text } from '../src/components/ui';
import { useI18n } from '../src/i18n';
import { useAuth } from '../src/state';
import { font, palette, radius, spacing } from '../src/theme';

export default function CreditsScreen(): React.JSX.Element {
  const router = useRouter();
  const { t } = useI18n();
  const { user, refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const used = user?.creditsUsed ?? 0;
  const remaining = user?.creditsRemaining ?? 0;
  const total = Math.max(1, used + remaining);
  const ratio = used / total;

  const request = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      await api.requestCredits();
      setNote(t('credits.requested'));
      await refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll padded={false}>
      <Header title={t('credits.title')} onBack={() => router.back()} />

      <View style={styles.body}>
        <Text variant="h1" style={{ marginBottom: spacing.lg }}>
          {t('credits.title')}
        </Text>

        <Card>
          <View style={styles.totals}>
            <View>
              <Text variant="small" tone="muted">
                {t('credits.used')}
              </Text>
              <Text variant="display">{used}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text variant="small" tone="muted">
                {t('credits.remaining')}
              </Text>
              <Text variant="display">{remaining}</Text>
            </View>
          </View>

          <View style={{ marginTop: spacing.lg }}>
            <ProgressBar value={ratio} height={10} />
          </View>

          <View style={styles.legendRow}>
            <Legend color={palette.primary} label={`${used} consumed`} />
            <Legend color={palette.surfaceSunken} label={`${remaining} available`} />
          </View>
        </Card>

        {note ? (
          <View style={{ marginTop: spacing.lg }}>
            <Banner tone="success" message={note} />
          </View>
        ) : null}

        <View style={{ height: spacing.xl }} />

        <Button
          label={t('credits.request')}
          icon="mail-outline"
          onPress={() => void request()}
          loading={busy}
          fullWidth
          size="lg"
        />

        <Text variant="small" tone="muted" style={{ marginTop: spacing.lg, lineHeight: 21 }}>
          {t('credits.note')}
        </Text>

        <Card style={{ marginTop: spacing.xl, backgroundColor: palette.surfaceAlt }}>
          <Text variant="small" style={{ fontFamily: font.bold, marginBottom: spacing.sm }}>
            How credits are charged
          </Text>
          {[
            'Each test in a run costs its listed credit value.',
            'A full Run-All against one target costs one credit per test.',
            'Cancelled runs are not charged.',
            'Credit usage is recorded per run so every charge reconciles.',
          ].map((line) => (
            <View key={line} style={styles.bulletRow}>
              <Ionicons name="ellipse" size={5} color={palette.inkSubtle} style={{ marginTop: 7 }} />
              <Text variant="small" tone="muted" style={{ flex: 1 }}>
                {line}
              </Text>
            </View>
          ))}
        </Card>
      </View>
    </Screen>
  );
}

function Legend({ color, label }: { color: string; label: string }): React.JSX.Element {
  return (
    <View style={styles.legend}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text variant="tiny" tone="muted">
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl },
  totals: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  legendRow: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.md },
  legend: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  legendDot: { width: 9, height: 9, borderRadius: radius.pill },
  bulletRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
});
