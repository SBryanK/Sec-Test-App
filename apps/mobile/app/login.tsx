import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ShieldMark } from '../src/components/ShieldMark';
import { Banner, Button, Text } from '../src/components/ui';
import { OutlinedInput } from '../src/components/fields';
import { getBaseUrl } from '../src/api/client';
import { useI18n } from '../src/i18n';
import { useAuth, useApiBaseUrl } from '../src/state';
import { font, palette, radius, spacing, useResponsive } from '../src/theme';

export default function LoginScreen(): React.JSX.Element {
  const { t } = useI18n();
  const { signIn } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { gutter, isCompact } = useResponsive();
  const [apiUrl] = useApiBaseUrl();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      router.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingHorizontal: gutter,
            paddingTop: insets.top + spacing.xxxl,
            paddingBottom: insets.bottom + spacing.xxl,
          },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.brand}>
          <ShieldMark size={isCompact ? 84 : 100} />
          <Text variant="h1" center style={{ marginTop: spacing.lg }}>
            EdgeOne Security Test
          </Text>
          <Text variant="small" tone="muted" center style={{ marginTop: spacing.xs }}>
            {t('login.subtitle')}
          </Text>
        </View>

        <View style={styles.form}>
          <Text variant="h3" style={{ marginBottom: spacing.md }}>
            {t('login.title')}
          </Text>

          <OutlinedInput
            label={t('login.email')}
            value={email}
            onChangeText={setEmail}
            placeholder="operator@edgeone.internal"
            keyboardType="default"
            autoCapitalize="none"
            surface={palette.canvas}
          />

          <View style={{ height: spacing.lg }} />

          <OutlinedInput
            label={t('login.password')}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            surface={palette.canvas}
          />

          {error ? (
            <View style={{ marginTop: spacing.lg }}>
              <Banner tone="error" message={error} />
            </View>
          ) : null}

          <View style={{ height: spacing.xl }} />

          <Button
            label={busy ? t('login.signingIn') : t('login.submit')}
            onPress={() => void submit()}
            loading={busy}
            fullWidth
            size="lg"
            icon="log-in-outline"
          />

          <Pressable
            onPress={() => router.push('/register')}
            style={styles.registerLink}
            accessibilityRole="button"
            accessibilityLabel="Request access"
          >
            <Text variant="small" tone="primary" style={{ fontFamily: font.semibold }}>
              Don't have access? Request it
            </Text>
          </Pressable>

          <Pressable
            onPress={() => router.push('/connect')}
            style={styles.advancedToggle}
            accessibilityRole="button"
            accessibilityLabel="Server connection settings"
          >
            <Ionicons name="server-outline" size={14} color={palette.primary} />
            <Text variant="small" tone="primary">
              Server: {apiUrl || getBaseUrl()}
            </Text>
            <Ionicons name="chevron-forward" size={13} color={palette.primary} />
          </Pressable>

        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: palette.canvas },
  content: { flexGrow: 1, justifyContent: 'center' },
  brand: { alignItems: 'center', marginBottom: spacing.xxxl },
  form: {
    backgroundColor: palette.surface,
    borderRadius: radius.xxl,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: palette.line,
  },
  registerLink: { alignItems: 'center', marginTop: spacing.lg },
  advancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    marginTop: spacing.lg,
  },
});
