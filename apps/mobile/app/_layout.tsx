import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/plus-jakarta-sans';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { I18nProvider } from '../src/i18n';
import { AuthProvider, CartProvider, CatalogProvider, useAuth } from '../src/state';
import { palette } from '../src/theme';

// Keep the native splash up until fonts are ready.
void SplashScreen.preventAutoHideAsync();

/** Minimum splash dwell time, as specified. */
const SPLASH_MS = 1000;

export default function RootLayout(): React.JSX.Element {
  const [fontsLoaded, fontError] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
  });
  const [minElapsed, setMinElapsed] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setMinElapsed(true), SPLASH_MS);
    return () => clearTimeout(timer);
  }, []);

  const ready = (fontsLoaded || fontError !== null) && minElapsed;

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) {
    // The native splash is still visible; render nothing underneath it.
    return <View style={styles.boot} />;
  }

  return (
      <SafeAreaProvider>
        <I18nProvider>
          <AuthProvider>
            <CatalogProvider>
              <CartProvider>
                <StatusBar style="dark" />
                <RootNavigator />
              </CartProvider>
            </CatalogProvider>
          </AuthProvider>
        </I18nProvider>
      </SafeAreaProvider>
  );
}

/** Redirects between the auth screen and the tab shell. */
function RootNavigator(): React.JSX.Element {
  const { user, ready } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const [bootDone, setBootDone] = useState(false);

  useEffect(() => {
    if (!ready) return;
    const inAuthGroup = segments[0] === 'login';
    // Server connection is pre-auth by design: you must be able to point the app
    // at a server before you have credentials for it.
    const inConnect = segments[0] === 'connect';
    const inRegister = segments[0] === 'register';

    if (!user && !inAuthGroup && !inConnect && !inRegister) {
      router.replace('/login');
    } else if (user && inAuthGroup) {
      router.replace('/');
    }
    setBootDone(true);
  }, [user, ready, segments, router]);

  if (!bootDone && !ready) return <View style={styles.boot} />;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: palette.canvas },
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="login" options={{ animation: 'fade' }} />
      <Stack.Screen name="connect" />
      <Stack.Screen name="register" />
      <Stack.Screen name="admin/requests" />
      <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
      <Stack.Screen name="cart" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="run/[runId]" options={{ gestureEnabled: false }} />
      <Stack.Screen name="result/[runId]" />
      <Stack.Screen name="import" options={{ presentation: 'modal' }} />
    </Stack>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  boot: { flex: 1, backgroundColor: palette.navy },
});
