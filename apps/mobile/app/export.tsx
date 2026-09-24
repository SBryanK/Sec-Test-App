import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import type { RunRecord } from '@teo/shared';

import { api } from '../src/api/client';
import { exportRun, type ExportKind } from '../src/lib/export';
import { Badge, Banner, Card, EmptyState, Header, Screen, Text } from '../src/components/ui';
import { font, palette, radius, spacing } from '../src/theme';

const FORMATS: Array<{ kind: ExportKind; label: string; hint: string; icon: keyof typeof Ionicons.glyphMap }> = [
  { kind: 'html', label: 'HTML report', hint: 'Print-styled — share sheet saves as PDF', icon: 'document-text-outline' },
  { kind: 'json', label: 'JSON bundle', hint: 'Full machine-readable export', icon: 'code-outline' },
  { kind: 'csv', label: 'CSV summary', hint: 'One row per run plus findings', icon: 'grid-outline' },
];

export default function ExportAllScreen(): React.JSX.Element {
  const router = useRouter();
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const page = await api.history({ limit: 50 });
        setRuns(page.runs);
      } catch (err) {
        setNote(err instanceof Error ? err.message : 'Could not load history');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const run = async (kind: ExportKind): Promise<void> => {
    const ids = selected.size > 0 ? [...selected] : runs.map((r) => r.id);
    if (ids.length === 0) {
      setNote('Nothing to export yet.');
      return;
    }
    setBusy(kind);
    setNote(null);
    try {
      if (ids.length === 1) {
        const target = runs.find((r) => r.id === ids[0])?.target ?? 'run';
        setNote(await exportRun(ids[0] as string, kind, target));
      } else {
        const body = await api.exportRuns({ runIds: ids, format: kind, includeTraces: false });
        const { File, Paths } = await import('expo-file-system');
        const Sharing = await import('expo-sharing');
        const filename = `teo-sectest_export_${new Date().toISOString().slice(0, 10)}.${kind}`;
        const file = new File(Paths.cache, filename);
        if (file.exists) file.delete();
        file.create({ overwrite: true });
        file.write(body);

        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(file.uri, { mimeType: kind === 'html' ? 'text/html' : kind === 'csv' ? 'text/csv' : 'application/json' });
          setNote(`Exported ${ids.length} runs as ${filename}`);
        } else {
          const Clipboard = await import('expo-clipboard');
          await Clipboard.setStringAsync(body);
          setNote(`Sharing unavailable — ${ids.length} runs copied to clipboard`);
        }
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen scroll padded={false} bottomInset={spacing.xxl}>
      <Header title="Export All" onBack={() => router.back()} centered />

      <View style={styles.body}>
        {note ? (
          <View style={{ marginBottom: spacing.lg }}>
            <Banner tone="info" message={note} />
          </View>
        ) : null}

        <Text variant="small" style={{ fontFamily: font.semibold, marginBottom: spacing.sm }}>
          Format
        </Text>
        {FORMATS.map((format) => (
          <Pressable
            key={format.kind}
            onPress={() => void run(format.kind)}
            disabled={busy !== null}
            accessibilityRole="button"
            accessibilityLabel={format.label}
            style={({ pressed }) => [pressed && { opacity: 0.85 }]}
          >
            <Card style={styles.formatCard}>
              <View style={styles.formatIcon}>
                {busy === format.kind ? (
                  <ActivityIndicator size="small" color={palette.primary} />
                ) : (
                  <Ionicons name={format.icon} size={19} color={palette.primary} />
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text variant="bodyLg" style={{ fontFamily: font.semibold }}>
                  {format.label}
                </Text>
                <Text variant="tiny" tone="muted" style={{ marginTop: 1 }}>
                  {format.hint}
                </Text>
              </View>
              <Ionicons name="share-outline" size={18} color={palette.inkSubtle} />
            </Card>
          </Pressable>
        ))}

        <View style={styles.selectionHead}>
          <Text variant="small" style={{ fontFamily: font.semibold }}>
            Runs
          </Text>
          <Pressable
            onPress={() =>
              setSelected(selected.size === runs.length ? new Set() : new Set(runs.map((r) => r.id)))
            }
            accessibilityRole="button"
          >
            <Text variant="small" tone="primary" style={{ fontFamily: font.semibold }}>
              {selected.size === runs.length && runs.length > 0 ? 'Clear' : 'Select all'}
            </Text>
          </Pressable>
        </View>

        <Text variant="tiny" tone="muted" style={{ marginBottom: spacing.md }}>
          {selected.size === 0
            ? 'Nothing selected — export will include every run listed.'
            : `${selected.size} run(s) selected.`}
        </Text>

        {loading ? (
          <ActivityIndicator color={palette.primary} />
        ) : runs.length === 0 ? (
          <EmptyState icon="calendar-outline" title="No runs to export" />
        ) : (
          runs.map((item) => {
            const checked = selected.has(item.id);
            return (
              <Pressable
                key={item.id}
                onPress={() => toggle(item.id)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked }}
                style={({ pressed }) => [styles.runRow, pressed && { opacity: 0.7 }]}
              >
                <Ionicons
                  name={checked ? 'checkbox' : 'square-outline'}
                  size={20}
                  color={checked ? palette.primary : palette.inkSubtle}
                />
                <View style={{ flex: 1 }}>
                  <Text variant="small" numberOfLines={1} style={{ fontFamily: font.semibold }}>
                    {item.target}
                  </Text>
                  <Text variant="tiny" tone="muted" numberOfLines={1}>
                    {item.label} · {new Date(item.createdAt).toLocaleDateString()}
                  </Text>
                </View>
                <Badge
                  label={item.status}
                  fg={item.status === 'success' ? '#137247' : '#5A6478'}
                  bg={item.status === 'success' ? palette.successSoft : palette.surfaceSunken}
                  size="sm"
                />
              </Pressable>
            );
          })
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.xl, paddingBottom: spacing.huge },
  formatCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.sm, padding: spacing.lg },
  formatIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: palette.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xl,
    marginBottom: spacing.xs,
  },
  runRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: palette.line,
  },
});
