import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import React from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n, type TranslationKey } from '../../src/i18n';
import { useCart } from '../../src/state';
import { font, fontSize, palette, radius, spacing } from '../../src/theme';
import { Text } from '../../src/components/ui';

interface TabDef {
  name: string;
  labelKey: TranslationKey;
  icon: keyof typeof Ionicons.glyphMap;
  iconActive: keyof typeof Ionicons.glyphMap;
}

const TABS: TabDef[] = [
  { name: 'index', labelKey: 'tab.search', icon: 'search-outline', iconActive: 'search' },
  { name: 'test', labelKey: 'tab.test', icon: 'build-outline', iconActive: 'build' },
  { name: 'history', labelKey: 'tab.history', icon: 'calendar-outline', iconActive: 'calendar' },
  { name: 'profile', labelKey: 'tab.profile', icon: 'person-outline', iconActive: 'person' },
];

export default function TabsLayout(): React.JSX.Element {
  const { t } = useI18n();
  const { configs } = useCart();
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: palette.canvas } }}
      tabBar={({ state, navigation }) => (
        <View
          style={[
            styles.bar,
            { paddingBottom: Math.max(insets.bottom, spacing.sm) + (Platform.OS === 'android' ? 2 : 0) },
          ]}
        >
          {state.routes.map((route, index) => {
            const def = TABS.find((tab) => tab.name === route.name);
            if (!def) return null;
            const focused = state.index === index;
            const badge = def.name === 'test' ? configs.length : 0;

            return (
              <Pressable
                key={route.key}
                accessibilityRole="tab"
                accessibilityState={{ selected: focused }}
                accessibilityLabel={t(def.labelKey)}
                onPress={() => {
                  const event = navigation.emit({
                    type: 'tabPress',
                    target: route.key,
                    canPreventDefault: true,
                  });
                  if (!focused && !event.defaultPrevented) {
                    navigation.navigate(route.name);
                  }
                }}
                style={styles.tab}
              >
                <View style={[styles.iconWrap, focused && styles.iconWrapActive]}>
                  <Ionicons
                    name={focused ? def.iconActive : def.icon}
                    size={20}
                    color={focused ? palette.ink : palette.inkMuted}
                  />
                  {badge > 0 ? (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{badge > 9 ? '9+' : badge}</Text>
                    </View>
                  ) : null}
                </View>
                <Text
                  variant="tiny"
                  style={{
                    color: focused ? palette.ink : palette.inkMuted,
                    fontFamily: focused ? font.bold : font.medium,
                    marginTop: spacing.xs,
                  }}
                >
                  {t(def.labelKey)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    >
      {TABS.map((tab) => (
        <Tabs.Screen key={tab.name} name={tab.name} />
      ))}
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: palette.surface,
    borderTopWidth: 1,
    borderTopColor: palette.line,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.xs },
  iconWrap: {
    width: 52,
    height: 30,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapActive: { backgroundColor: palette.primarySoft },
  badge: {
    position: 'absolute',
    top: -3,
    right: 6,
    minWidth: 17,
    height: 17,
    borderRadius: 9,
    backgroundColor: palette.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    color: '#FFFFFF',
    fontFamily: font.bold,
    fontSize: fontSize.micro,
  },
});
