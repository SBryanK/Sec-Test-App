import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import type { UserAccount } from '@teo/shared';

import { api } from '../../src/api/client';
import { Badge, Banner, Button, Card, EmptyState, Header, Screen, Text } from '../../src/components/ui';
import { useAuth } from '../../src/state';
import { font, palette, radius, spacing } from '../../src/theme';

/**
 * Access requests — the administrator's half of the golden gate.
 *
 * Operators request access from their own device; this is where those requests
 * are approved, rejected, suspended or revoked. Only reachable by an account
 * with the admin role.
 */
export default function AdminRequestsScreen(): React.JSX.Element {
  const router = useRouter();
  const { user } = useAuth();

  const [pending, setPending] = useState<UserAccount[]>([]);
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [p, u] = await Promise.all([api.pendingRequests(), api.allUsers()]);
      setPending(p.requests);
      setUsers(u.users.filter((x) => x.status !== 'pending'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load access requests');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, action: () => Promise<unknown>, message: string): Promise<void> => {
    setBusyId(id);
    setNote(null);
    setError(null);
    try {
      await action();
      setNote(message);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  const confirmRevoke = (target: UserAccount): void => {
    Alert.alert(
      'Revoke sessions',
      `Sign ${target.displayName} out of every device immediately? They can sign in again afterwards.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: () =>
            void act(target.id, () => api.revokeUserTokens(target.id), `${target.displayName} was signed out everywhere`),
        },
      ],
    );
  };

  if (user?.role !== 'admin') {
    return (
      <Screen padded={false}>
        <Header title="Access requests" onBack={() => router.back()} centered />
        <EmptyState
          icon="lock-closed-outline"
          title="Administrator only"
          message="Your account does not have permission to manage access."
        />
      </Screen>
    );
  }

  return (
    <Screen
      scroll
      padded={false}
      bottomInset={spacing.xxl}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load();
          }}
        />
      }
    >
      <Header title="Access requests" onBack={() => router.back()} centered />

      <View style={styles.body}>
        {error ? (
          <View style={{ marginBottom: spacing.lg }}>
            <Banner tone="error" message={error} />
          </View>
        ) : null}
        {note ? (
          <View style={{ marginBottom: spacing.lg }}>
            <Banner tone="success" message={note} />
          </View>
        ) : null}

        {loading ? <ActivityIndicator color={palette.primary} /> : null}

        {/* Pending */}
        <View style={styles.sectionHead}>
          <Ionicons name="hourglass-outline" size={16} color={palette.ink} />
          <Text variant="h3" style={{ flex: 1 }}>
            Pending ({pending.length})
          </Text>
        </View>

        {!loading && pending.length === 0 ? (
          <Card style={{ backgroundColor: palette.surfaceAlt }}>
            <Text variant="small" tone="muted">
              No one is waiting for access.
            </Text>
          </Card>
        ) : null}

        {pending.map((request) => (
          <Card key={request.id} style={styles.card}>
            <View style={styles.rowHead}>
              <View style={styles.avatar}>
                <Text variant="h3" tone="primary">
                  {initials(request.displayName)}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text variant="h3" numberOfLines={1}>
                  {request.displayName}
                </Text>
                <Text variant="small" tone="muted" numberOfLines={1}>
                  {request.email}
                </Text>
              </View>
              <Badge label="pending" fg="#8A6100" bg={palette.warningSoft} size="sm" />
            </View>

            <Text variant="tiny" tone="subtle" style={{ marginTop: spacing.sm }}>
              Requested {request.requestedAt ? new Date(request.requestedAt).toLocaleString() : '—'}
            </Text>

            <View style={styles.actions}>
              {busyId === request.id ? (
                <ActivityIndicator color={palette.primary} />
              ) : (
                <>
                  <Button
                    label="Approve"
                    size="sm"
                    icon="checkmark"
                    onPress={() =>
                      void act(
                        request.id,
                        () => api.approveRequest(request.id),
                        `${request.displayName} can now sign in`,
                      )
                    }
                  />
                  <Button
                    label="Reject"
                    size="sm"
                    variant="ghost"
                    icon="close"
                    onPress={() =>
                      void act(
                        request.id,
                        () => api.rejectRequest(request.id),
                        `${request.displayName}'s request was rejected`,
                      )
                    }
                  />
                </>
              )}
            </View>
          </Card>
        ))}

        {/* Existing operators */}
        <View style={[styles.sectionHead, { marginTop: spacing.xxl }]}>
          <Ionicons name="people-outline" size={16} color={palette.ink} />
          <Text variant="h3" style={{ flex: 1 }}>
            Operators ({users.length})
          </Text>
        </View>

        {users.map((operator) => (
          <Card key={operator.id} style={styles.card}>
            <View style={styles.rowHead}>
              <View style={styles.avatar}>
                <Text variant="h3" tone="primary">
                  {initials(operator.displayName)}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text variant="small" style={{ fontFamily: font.semibold }} numberOfLines={1}>
                  {operator.displayName}
                  {operator.id === user.id ? '  (you)' : ''}
                </Text>
                <Text variant="tiny" tone="muted" numberOfLines={1}>
                  {operator.email}
                </Text>
              </View>
              <Badge
                label={operator.role === 'admin' ? 'admin' : operator.status}
                fg={operator.status === 'active' ? '#137247' : '#A8282C'}
                bg={operator.status === 'active' ? palette.successSoft : palette.dangerSoft}
                size="sm"
              />
            </View>

            {operator.id !== user.id ? (
              <View style={styles.actions}>
                {busyId === operator.id ? (
                  <ActivityIndicator color={palette.primary} />
                ) : operator.status === 'suspended' ? (
                  <Button
                    label="Reinstate"
                    size="sm"
                    icon="refresh"
                    onPress={() =>
                      void act(operator.id, () => api.activateUser(operator.id), `${operator.displayName} was reinstated`)
                    }
                  />
                ) : (
                  <>
                    <Button
                      label="Suspend"
                      size="sm"
                      variant="secondary"
                      icon="pause"
                      onPress={() =>
                        void act(operator.id, () => api.suspendUser(operator.id), `${operator.displayName} was suspended`)
                      }
                    />
                    <Button
                      label="Sign out everywhere"
                      size="sm"
                      variant="ghost"
                      icon="log-out-outline"
                      onPress={() => confirmRevoke(operator)}
                    />
                  </>
                )}
              </View>
            ) : null}
          </Card>
        ))}

        <Card style={{ marginTop: spacing.xl, backgroundColor: palette.surfaceAlt }}>
          <Text variant="small" style={{ fontFamily: font.bold, marginBottom: spacing.sm }}>
            How access works
          </Text>
          {[
            'Operators request access from their own device.',
            'Nothing works until you approve the request here.',
            'Suspending takes effect immediately, on every device.',
            'Revoking signs someone out everywhere without locking the account.',
          ].map((line) => (
            <View key={line} style={styles.bulletRow}>
              <Ionicons name="ellipse" size={4} color={palette.inkSubtle} style={{ marginTop: 8 }} />
              <Text variant="small" tone="muted" style={{ flex: 1, lineHeight: 20 }}>
                {line}
              </Text>
            </View>
          ))}
        </Card>
      </View>
    </Screen>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  card: { marginBottom: spacing.md, padding: spacing.lg },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: radius.pill,
    backgroundColor: palette.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, flexWrap: 'wrap' },
  bulletRow: { flexDirection: 'row', gap: spacing.sm, marginTop: 2 },
});

void Pressable;
