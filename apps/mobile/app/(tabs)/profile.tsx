import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { ShieldMark } from '../../src/components/ShieldMark';
import { OutlinedInput } from '../../src/components/fields';
import { Badge, Banner, Button, Card, Divider, Header, Screen, Text } from '../../src/components/ui';
import { useI18n } from '../../src/i18n';
import { useApiBaseUrl, useAuth } from '../../src/state';
import { font, palette, radius, spacing } from '../../src/theme';

export default function ProfileScreen(): React.JSX.Element {
  const router = useRouter();
  const { t, language, setLanguage } = useI18n();
  const { user, signOut } = useAuth();
  const [apiUrl, setApiUrl] = useApiBaseUrl();
  const [endpoint, setEndpoint] = useState('');
  const [editing, setEditing] = useState(false);

  useEffect(() => setEndpoint(apiUrl), [apiUrl]);

  const confirmLogout = (): void => {
    Alert.alert(t('profile.logOut'), 'End this session on this device?', [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('profile.logOut'),
        style: 'destructive',
        onPress: () => {
          void signOut().then(() => router.replace('/login'));
        },
      },
    ]);
  };

  return (
    <Screen scroll padded={false}>
      <Header title={t('profile.title')} centered large />

      <View style={styles.body}>
        <View style={styles.identity}>
          <ShieldMark size={92} />
          <Text variant="body" tone="muted" style={{ marginTop: spacing.md }} numberOfLines={1}>
            {user?.email ?? '—'}
          </Text>
          <View style={styles.roleRow}>
            <Badge
              label={user?.role ?? 'operator'}
              fg="#1F5BB5"
              bg={palette.primarySoft}
              icon="shield-checkmark"
              size="sm"
            />
            <Text variant="tiny" tone="subtle">
              {user?.creditsRemaining ?? 0} credits remaining
            </Text>
          </View>
        </View>

        {/* Language toggle — EN / 中文 */}
        <View style={styles.langRow}>
          {(['en', 'zh'] as const).map((code) => {
            const active = language === code;
            return (
              <Pressable
                key={code}
                onPress={() => {
                  setLanguage(code);
                  void import('../../src/api/client').then(({ api }) =>
                    api.setLanguage(code).catch(() => undefined),
                  );
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={code === 'en' ? 'English' : '中文'}
                style={[styles.langOption, active && styles.langOptionActive]}
              >
                {active ? <Ionicons name="checkmark" size={15} color={palette.ink} /> : null}
                <Text variant="body" style={{ fontFamily: active ? font.bold : font.medium }}>
                  {code === 'en' ? 'EN' : '中文'}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {user?.role === 'admin' ? (
          <MenuRow
            icon="people-outline"
            label="Access requests"
            sublabel="Approve operators and manage sessions"
            onPress={() => router.push('/admin/requests')}
          />
        ) : null}

        <MenuRow
          icon="ribbon-outline"
          label={t('profile.userCredits')}
          sublabel={`${user?.creditsUsed ?? 0} used · ${user?.creditsRemaining ?? 0} remaining`}
          onPress={() => router.push('/credits')}
        />
        <MenuRow
          icon="lock-closed-outline"
          label={t('profile.privacyPolicy')}
          onPress={() => router.push('/privacy')}
        />
        <MenuRow icon="information-circle-outline" label={t('profile.help')} onPress={() => router.push('/help')} />
        <MenuRow
          icon="log-out-outline"
          label={t('profile.logOut')}
          tone="danger"
          onPress={confirmLogout}
        />

        {/* Endpoint configuration */}
        <Card style={{ marginTop: spacing.xl }}>
          <View style={styles.endpointHead}>
            <Ionicons name="server-outline" size={17} color={palette.ink} />
            <Text variant="small" style={{ fontFamily: font.bold, flex: 1 }}>
              {t('profile.apiEndpoint')}
            </Text>
            <Pressable
              onPress={() => router.push('/connect')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Change server"
            >
              <Text variant="small" tone="primary" style={{ fontFamily: font.semibold }}>
                Change
              </Text>
            </Pressable>
          </View>

          {editing ? (
            <View style={{ marginTop: spacing.md }}>
              <OutlinedInput
                label={t('profile.apiEndpoint')}
                value={endpoint}
                onChangeText={setEndpoint}
                placeholder="http://10.0.2.2:8787"
                surface={palette.surface}
              />
              <View style={{ height: spacing.md }} />
              <Button
                label={t('common.done')}
                icon="checkmark"
                onPress={() => {
                  void setApiUrl(endpoint.trim());
                  setEditing(false);
                }}
              />
            </View>
          ) : (
            <Text variant="tiny" tone="muted" style={{ marginTop: spacing.xs }} numberOfLines={1}>
              {apiUrl || '—'}
            </Text>
          )}
        </Card>

        <Divider />

        <Text variant="micro" tone="subtle" center>
          EDGEONE SECURITY TEST · INTERNAL USE ONLY
        </Text>
        <Text variant="micro" tone="subtle" center style={{ marginTop: spacing.xs }}>
          All activity on this device is logged with operator identity and target.
        </Text>
      </View>
    </Screen>
  );
}

function MenuRow({
  icon,
  label,
  sublabel,
  onPress,
  tone,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  sublabel?: string;
  onPress: () => void;
  tone?: 'danger';
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.menuRow, pressed && { opacity: 0.7 }]}
    >
      <View style={[styles.menuIcon, tone === 'danger' && { backgroundColor: palette.dangerSoft }]}>
        <Ionicons
          name={icon}
          size={19}
          color={tone === 'danger' ? palette.danger : palette.primary}
        />
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="bodyLg" style={{ fontFamily: font.semibold }}>
          {label}
        </Text>
        {sublabel ? (
          <Text variant="tiny" tone="muted" style={{ marginTop: 1 }}>
            {sublabel}
          </Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={palette.inkSubtle} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl },
  identity: { alignItems: 'center', marginBottom: spacing.xl },
  roleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  langRow: {
    flexDirection: 'row',
    alignSelf: 'center',
    backgroundColor: palette.surfaceAlt,
    borderRadius: radius.pill,
    padding: 4,
    marginBottom: spacing.xl,
    borderWidth: 1,
    borderColor: palette.line,
  },
  langOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.pill,
  },
  langOptionActive: { backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: palette.surfaceAlt,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  menuIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: palette.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  endpointHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});

void Banner;
