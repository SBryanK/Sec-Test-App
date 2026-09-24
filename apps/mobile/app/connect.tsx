import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { normaliseServerUrl, probeServer, type DiscoveryResult } from '../src/api/client';
import { OutlinedInput } from '../src/components/fields';
import { ShieldMark } from '../src/components/ShieldMark';
import { Banner, Button, Card, Header, Text } from '../src/components/ui';
import { useApiBaseUrl } from '../src/state';
import { font, palette, radius, spacing } from '../src/theme';

/**
 * Server connection screen.
 *
 * This is the one screen a team member needs before they can do anything. It
 * accepts a bare IP, a host:port, or a full URL, normalises it, and verifies it
 * against the server's discovery endpoint so a wrong address fails here with a
 * clear message rather than at login with a confusing one.
 *
 * Also reachable by deep link, so a team lead can share
 * `teosectest://connect?url=http://192.168.1.42:8787` in a group chat.
 */
export default function ConnectScreen(): React.JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { url: savedUrl } = useLocalSearchParams<{ url?: string }>();
  const [current, setCurrent] = useApiBaseUrl();

  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<DiscoveryResult | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (savedUrl) setInput(decodeURIComponent(savedUrl));
    else if (current) setInput(current);
  }, [savedUrl, current]);

  const connect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setFound(null);
    setSaved(false);
    try {
      const normalised = normaliseServerUrl(input);
      const discovery = await probeServer(normalised);
      setFound(discovery);
      await setCurrent(normalised);
      setInput(normalised);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}>
        <Header title="Server" onBack={() => router.back()} centered />

        <View style={styles.hero}>
          <ShieldMark size={78} />
          <Text variant="h2" center style={{ marginTop: spacing.md }}>
            Connect to a server
          </Text>
          <Text variant="small" tone="muted" center style={{ marginTop: spacing.xs }}>
            Enter the address your team's server printed at startup. Devices on the same
            network can share one server.
          </Text>
        </View>

        <Card style={styles.card}>
          <OutlinedInput
            label="Server address"
            value={input}
            onChangeText={(v) => {
              setInput(v);
              setSaved(false);
              setError(null);
            }}
            placeholder="192.168.1.42"
            keyboardType="url"
            surface={palette.surface}
            hint="An IP, host:port, or full URL — the port defaults to 8787"
          />

          <View style={{ height: spacing.lg }} />

          <Button
            label={busy ? 'Checking…' : 'Connect'}
            icon="link-outline"
            onPress={() => void connect()}
            loading={busy}
            disabled={!input.trim()}
            fullWidth
            size="lg"
          />

          {error ? (
            <View style={{ marginTop: spacing.lg }}>
              <Banner tone="error" message={error} />
            </View>
          ) : null}

          {found && saved ? (
            <View style={{ marginTop: spacing.lg, gap: spacing.sm }}>
              <Banner tone="success" message={`Connected to ${found.name} v${found.version}`} />
              <View style={styles.detailRow}>
                <Ionicons name="grid-outline" size={14} color={palette.inkMuted} />
                <Text variant="small" tone="muted">
                  {found.testCount} tests available
                </Text>
              </View>
              <View style={styles.detailRow}>
                <Ionicons name="checkmark-circle-outline" size={14} color={palette.inkMuted} />
                <Text variant="small" tone="muted">
                  Saved as {current}
                </Text>
              </View>
            </View>
          ) : null}
        </Card>

        {found && found.addresses.length > 1 ? (
          <Card style={{ marginTop: spacing.lg, backgroundColor: palette.surfaceAlt }}>
            <Text variant="small" style={{ fontFamily: font.bold, marginBottom: spacing.sm }}>
              Other addresses this server reported
            </Text>
            <Text variant="tiny" tone="muted" style={{ marginBottom: spacing.md }}>
              If the connection fails on another network, try one of these.
            </Text>
            {found.addresses.map((address) => (
              <Pressable
                key={address}
                onPress={() => setInput(address)}
                accessibilityRole="button"
                accessibilityLabel={`Use ${address}`}
                style={({ pressed }) => [styles.addressRow, pressed && { opacity: 0.6 }]}
              >
                <Ionicons name="globe-outline" size={14} color={palette.primary} />
                <Text variant="small" tone="primary" style={{ flex: 1 }}>
                  {address}
                </Text>
                <Ionicons name="arrow-forward" size={14} color={palette.inkSubtle} />
              </Pressable>
            ))}
          </Card>
        ) : null}

        <Card style={{ marginTop: spacing.lg, backgroundColor: palette.surfaceAlt }}>
          <Text variant="small" style={{ fontFamily: font.bold, marginBottom: spacing.sm }}>
            Setting up for a team
          </Text>
          {[
            'One person runs the server: ./ops/stack.sh',
            'It prints every address it can be reached on.',
            'Everyone else enters that address here — once.',
            'Share the teosectest://connect link to skip the typing.',
          ].map((line) => (
            <View key={line} style={styles.bulletRow}>
              <Ionicons name="ellipse" size={4} color={palette.inkSubtle} style={{ marginTop: 8 }} />
              <Text variant="small" tone="muted" style={{ flex: 1, lineHeight: 20 }}>
                {line}
              </Text>
            </View>
          ))}
        </Card>

        <View style={{ height: spacing.lg }} />

        <Button
          label="Done"
          variant="secondary"
          onPress={() => router.back()}
          fullWidth
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: palette.canvas },
  content: { paddingHorizontal: spacing.xl, flexGrow: 1 },
  hero: { alignItems: 'center', marginBottom: spacing.xl },
  card: { padding: spacing.lg },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  addressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: palette.line,
  },
  bulletRow: { flexDirection: 'row', gap: spacing.sm, marginTop: 2 },
  radius: { borderRadius: radius.md },
});
