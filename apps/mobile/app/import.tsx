import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { TestParametersDocument } from '@teo/shared';

import { api, type SavedConfig } from '../src/api/client';
import { OutlinedInput } from '../src/components/fields';
import { Badge, Banner, Button, Card, Header, Screen, Text } from '../src/components/ui';
import { useI18n } from '../src/i18n';
import { useCart, useCatalog } from '../src/state';
import { font, palette, radius, spacing } from '../src/theme';

const SAMPLE = `{
  "version": 1,
  "tests": [
    {
      "testId": "sql_injection",
      "target": { "domain": "example.com" },
      "values": { "sql.target_param": "id" }
    }
  ]
}`;

export default function ImportScreen(): React.JSX.Element {
  const router = useRouter();
  const { t } = useI18n();
  const { configs } = useCart();
  const { tests } = useCatalog();

  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [tone, setTone] = useState<'success' | 'error' | 'info'>('info');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<SavedConfig[]>([]);
  const { add } = useCart();

  // Saved configurations were previously write-only: the config screen claimed
  // to save and there was nowhere to load them back from.
  useEffect(() => {
    void api
      .savedConfigs()
      .then((data) => setSaved(data.configs))
      .catch(() => setSaved([]));
  }, []);

  const doImport = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const parsed = JSON.parse(text) as TestParametersDocument;
      const result = await api.importDocument(parsed, configs);

      if (result.errors.length > 0) {
        setTone('error');
        setNote(
          `Imported ${result.added} test(s) with ${result.errors.length} error(s): ` +
            result.errors.map((e) => `#${e.index} ${e.message}`).join('; '),
        );
      } else {
        setTone('success');
        setNote(`Added ${result.added} test(s). Cart now holds ${result.total}. Nothing was overwritten.`);
      }
    } catch (err) {
      setTone('error');
      setNote(err instanceof Error ? err.message : 'Could not parse the document');
    } finally {
      setBusy(false);
    }
  };

  const loadTemplate = async (testId: string): Promise<void> => {
    try {
      const doc = await api.template(testId);
      setText(JSON.stringify(doc, null, 2));
      setTone('info');
      setNote(`Loaded the ${testId} template. Set the target domain, then import.`);
    } catch (err) {
      setTone('error');
      setNote(err instanceof Error ? err.message : 'Could not load template');
    }
  };

  return (
    <Screen scroll padded={false}>
      <Header title={t('test.importConfig')} onBack={() => router.back()} centered />

      <View style={styles.body}>
        <Card>
          <View style={styles.noteHead}>
            <Ionicons name="document-text-outline" size={16} color={palette.primary} />
            <Text variant="small" style={{ fontFamily: font.bold }}>
              Import Templates
            </Text>
          </View>
          {[
            'Import TestParameters JSON to auto-add test to cart',
            'Use example templates, or load one below',
            'Additive Import: New tests added to existing cart (no override)',
          ].map((line) => (
            <View key={line} style={styles.bulletRow}>
              <Ionicons name="ellipse" size={4} color={palette.inkSubtle} style={{ marginTop: 8 }} />
              <Text variant="small" tone="muted" style={{ flex: 1, lineHeight: 20 }}>
                {line}
              </Text>
            </View>
          ))}
        </Card>

        {saved.length > 0 ? (
          <>
            <Text
              variant="small"
              style={{ fontFamily: font.semibold, marginTop: spacing.lg, marginBottom: spacing.sm }}
            >
              Saved configurations ({saved.length})
            </Text>
            {saved.map((entry) => (
              <Pressable
                key={entry.id}
                onPress={() => {
                  add(entry.config);
                  setTone('success');
                  setNote(`Added "${entry.name}" to the cart.`);
                }}
                accessibilityRole="button"
                accessibilityLabel={`Add saved config ${entry.name}`}
                style={({ pressed }) => [styles.savedRow, pressed && { opacity: 0.7 }]}
              >
                <Ionicons name="bookmark-outline" size={16} color={palette.primary} />
                <View style={{ flex: 1 }}>
                  <Text variant="small" numberOfLines={1} style={{ fontFamily: font.semibold }}>
                    {entry.name}
                  </Text>
                  <Text variant="tiny" tone="muted" numberOfLines={1}>
                    {new Date(entry.updatedAt).toLocaleString()}
                  </Text>
                </View>
                <Ionicons name="add-circle-outline" size={18} color={palette.primary} />
              </Pressable>
            ))}
          </>
        ) : null}

        <Text variant="small" style={{ fontFamily: font.semibold, marginTop: spacing.lg, marginBottom: spacing.sm }}>
          Load a template
        </Text>
        <View style={styles.templateRow}>
          {['sql_injection', 'connection_flood', 'oversized_body'].map((id) => (
            <Pressable
              key={id}
              onPress={() => void loadTemplate(id)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.templateChip, pressed && { opacity: 0.7 }]}
            >
              <Text variant="tiny" tone="primary">
                {id}.json
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={{ height: spacing.lg }} />

        <OutlinedInput
          label="TestParameters JSON"
          value={text}
          onChangeText={setText}
          placeholder={SAMPLE}
          multiline
          minHeight={220}
          surface={palette.canvas}
          inputStyle={{ fontFamily: 'monospace', fontSize: 12, lineHeight: 18 }}
          hint={`${text.length} characters · ${tests.length} test types available`}
        />

        <View style={styles.actionRow}>
          <Button
            label="Paste"
            variant="secondary"
            size="sm"
            icon="clipboard-outline"
            onPress={() => {
              void Clipboard.getStringAsync().then((v) => {
                if (v) setText(v);
              });
            }}
          />
          <Button
            label="Sample"
            variant="secondary"
            size="sm"
            icon="code-outline"
            onPress={() => setText(SAMPLE)}
          />
          <View style={{ flex: 1 }} />
          <Badge label={`${configs.length} in cart`} fg="#1F5BB5" bg={palette.primarySoft} size="sm" />
        </View>

        {note ? (
          <View style={{ marginTop: spacing.lg }}>
            <Banner tone={tone} message={note} />
          </View>
        ) : null}

        <View style={{ height: spacing.xl }} />

        <Button
          label={t('config.import')}
          icon="download-outline"
          onPress={() => void doImport()}
          loading={busy}
          disabled={!text.trim()}
          fullWidth
          size="lg"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.xl, paddingBottom: spacing.huge },
  noteHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.sm },
  bulletRow: { flexDirection: 'row', gap: spacing.sm, marginTop: 2 },
  templateRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  templateChip: {
    backgroundColor: palette.primarySoft,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.primaryBorder,
  },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  savedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: palette.line,
  },
});
