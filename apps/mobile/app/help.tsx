import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Card, Header, Screen, Text } from '../src/components/ui';
import { font, palette, radius, spacing } from '../src/theme';

interface Topic {
  heading: string;
  icon: keyof typeof Ionicons.glyphMap;
  steps: string[];
}

const TOPICS: Topic[] = [
  {
    heading: 'Quick start',
    icon: 'flash-outline',
    steps: [
      'Open Tests and pick a category.',
      'Choose a test type, then configure it.',
      'Add it to the cart — or use Run All Tests to queue every test at once.',
      'Confirm & Start, then watch live progress.',
      'Review the success screen, or find the run later in History.',
    ],
  },
  {
    heading: 'Validate a target first',
    icon: 'globe-outline',
    steps: [
      'Use the Search tab to check reachability before a run.',
      'It reports DNS, TCP, TLS and first-byte timings in one request.',
      'It also fingerprints the edge or WAF sitting in front of the origin.',
      'Enter several targets separated by commas, semicolons or new lines.',
    ],
  },
  {
    heading: 'App navigation',
    icon: 'compass-outline',
    steps: [
      'Tests — browse and configure the full catalog.',
      'Search — quick connection checks against any target.',
      'History — past runs, filters and export.',
      'Profile — language, credits, endpoint and policy.',
    ],
  },
  {
    heading: 'Running all tests at once',
    icon: 'layers-outline',
    steps: [
      'Run All Tests queues every test in the catalog against one target.',
      'They execute simultaneously, so the target sees the combined surface.',
      'The cart shows the full list before anything starts — nothing is hidden.',
      'Per-test runs stay available: add just the tests you want.',
    ],
  },
  {
    heading: 'Reading results',
    icon: 'stats-chart-outline',
    steps: [
      'Blocked — protection stopped the probe. This is the good outcome.',
      'Bypassed — the attack got through. These become findings.',
      'Passed — the request behaved normally; not a finding.',
      'Open Request log for per-request telemetry: DNS, TCP, TLS, first byte, byte counts and status.',
    ],
  },
  {
    heading: 'Where tests actually run',
    icon: 'git-compare-outline',
    steps: [
      'Device — the test is fully effective from the phone.',
      'Device + server — the phone can drive it, but real intensity needs the server executor.',
      'Server only — physically impossible from a handset (raw sockets, volumetric load).',
      'Each test shows its own badge on the category screen.',
    ],
  },
];

export default function HelpScreen(): React.JSX.Element {
  const [open, setOpen] = useState<string | null>('Quick start');

  return (
    <Screen scroll padded={false}>
      <Header title="Help" onBack={() => undefined} />

      <View style={styles.body}>
        <Text variant="h1">Help</Text>
        <Text variant="body" tone="muted" style={{ marginTop: spacing.sm, lineHeight: 23 }}>
          Use this guide to run tests, read results, and manage settings.
        </Text>

        <View style={{ height: spacing.xl }} />

        {TOPICS.map((topic) => {
          const expanded = open === topic.heading;
          return (
            <Card key={topic.heading} style={styles.card}>
              <Pressable
                onPress={() => setOpen(expanded ? null : topic.heading)}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
              >
                <View style={styles.heading}>
                  <View style={styles.icon}>
                    <Ionicons name={topic.icon} size={17} color={palette.primary} />
                  </View>
                  <Text variant="h3" tone="primary" style={{ flex: 1 }}>
                    {topic.heading}
                  </Text>
                  <Ionicons
                    name={expanded ? 'chevron-up' : 'chevron-down'}
                    size={17}
                    color={palette.inkMuted}
                  />
                </View>
              </Pressable>

              {expanded ? (
                <View style={{ marginTop: spacing.md }}>
                  {topic.steps.map((step, index) => (
                    <View key={step} style={styles.stepRow}>
                      <View style={styles.stepIndex}>
                        <Text variant="micro" tone="primary">
                          {index + 1}
                        </Text>
                      </View>
                      <Text variant="body" style={{ flex: 1, lineHeight: 23 }}>
                        {step}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </Card>
          );
        })}

        <Card style={{ backgroundColor: palette.surfaceAlt }}>
          <Text variant="small" style={{ fontFamily: font.bold }}>
            Before you run anything
          </Text>
          <Text variant="small" tone="muted" style={{ marginTop: spacing.xs, lineHeight: 21 }}>
            Only test targets you are authorised to test. Every run records the operator, the
            target and a hash of the exact configuration used.
          </Text>
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.xl, paddingBottom: spacing.huge },
  card: { marginBottom: spacing.md, padding: spacing.lg },
  heading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  icon: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    backgroundColor: palette.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md },
  stepIndex: {
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    backgroundColor: palette.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
});
