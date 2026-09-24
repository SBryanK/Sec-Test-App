import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api } from '../src/api/client';
import { OutlinedInput } from '../src/components/fields';
import { ShieldMark } from '../src/components/ShieldMark';
import { Banner, Button, Card, Header, Text } from '../src/components/ui';
import { font, palette, radius, spacing } from '../src/theme';

/**
 * Request access.
 *
 * Access is invitation-only. This submits a request; an administrator approves
 * it before the account can sign in. The screen says so plainly rather than
 * implying the account works immediately.
 */
export default function RegisterScreen(): React.JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const submit = async (): Promise<void> => {
    setError(null);
    if (!displayName.trim() || !email.trim() || !password) {
      setError('Name, email and password are all required.');
      return;
    }
    if (password.length < 12) {
      setError('Choose a password of at least 12 characters.');
      return;
    }

    setBusy(true);
    try {
      await api.register({
        email: email.trim(),
        displayName: displayName.trim(),
        password,
        note: note.trim() || undefined,
      });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit the request');
    } finally {
      setBusy(false);
    }
  };

  if (submitted) {
    return (
      <View style={styles.flex}>
        <Header title="Request sent" onBack={() => router.back()} centered />
        <View style={styles.doneBody}>
          <View style={styles.doneIcon}>
            <Ionicons name="mail-unread-outline" size={34} color={palette.primary} />
          </View>
          <Text variant="h2" center style={{ marginTop: spacing.lg }}>
            Awaiting approval
          </Text>
          <Text variant="body" tone="muted" center style={{ marginTop: spacing.sm, lineHeight: 23 }}>
            Your request has been sent to the administrator. Once it is approved you can sign in
            with the details you just chose.
          </Text>
          <View style={{ height: spacing.xxl }} />
          <Button label="Back to sign in" icon="arrow-back" onPress={() => router.back()} fullWidth size="lg" />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
        keyboardShouldPersistTaps="handled"
      >
        <Header title="Request access" onBack={() => router.back()} centered />

        <View style={styles.hero}>
          <ShieldMark size={64} />
          <Text variant="small" tone="muted" center style={{ marginTop: spacing.md }}>
            This platform is invitation-only. Submit your details and the administrator will
            approve your account.
          </Text>
        </View>

        <Card style={styles.card}>
          <OutlinedInput
            label="Full name"
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Jane Doe"
            autoCapitalize="sentences"
            surface={palette.surface}
          />
          <View style={{ height: spacing.lg }} />
          <OutlinedInput
            label="Work email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@company.com"
            surface={palette.surface}
          />
          <View style={{ height: spacing.lg }} />
          <OutlinedInput
            label="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="At least 12 characters"
            surface={palette.surface}
            hint="Minimum 12 characters"
          />
          <View style={{ height: spacing.lg }} />
          <OutlinedInput
            label="Note (optional)"
            value={note}
            onChangeText={setNote}
            placeholder="Which engagement are you joining?"
            autoCapitalize="sentences"
            surface={palette.surface}
          />

          {error ? (
            <View style={{ marginTop: spacing.lg }}>
              <Banner tone="error" message={error} />
            </View>
          ) : null}

          <View style={{ height: spacing.xl }} />

          <Button
            label={busy ? 'Sending…' : 'Request access'}
            icon="paper-plane-outline"
            onPress={() => void submit()}
            loading={busy}
            fullWidth
            size="lg"
          />
        </Card>

        <Card style={{ marginTop: spacing.lg, backgroundColor: palette.surfaceAlt }}>
          <Text variant="small" style={{ fontFamily: font.bold, marginBottom: spacing.sm }}>
            What happens next
          </Text>
          {[
            'The administrator sees your request in the app.',
            'Once approved, you sign in from this device with these details.',
            'You can then run tests against authorised targets.',
          ].map((line) => (
            <View key={line} style={styles.bulletRow}>
              <Ionicons name="ellipse" size={4} color={palette.inkSubtle} style={{ marginTop: 8 }} />
              <Text variant="small" tone="muted" style={{ flex: 1, lineHeight: 20 }}>
                {line}
              </Text>
            </View>
          ))}
        </Card>

        <Pressable onPress={() => router.back()} style={styles.backLink} accessibilityRole="button">
          <Text variant="small" tone="primary">
            Already approved? Sign in
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: palette.canvas },
  content: { paddingHorizontal: spacing.xl },
  hero: { alignItems: 'center', marginBottom: spacing.xl },
  card: { padding: spacing.lg },
  doneBody: { paddingHorizontal: spacing.xl, paddingTop: spacing.xxxl, alignItems: 'center' },
  doneIcon: {
    width: 76,
    height: 76,
    borderRadius: radius.pill,
    backgroundColor: palette.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bulletRow: { flexDirection: 'row', gap: spacing.sm, marginTop: 2 },
  backLink: { alignItems: 'center', marginTop: spacing.xl, paddingVertical: spacing.md },
});
