import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { Card, Header, Screen, Text } from '../src/components/ui';
import { font, palette, radius, spacing } from '../src/theme';

/**
 * Privacy Policy.
 *
 * The reference build rendered this as raw markdown (literal `##` and `**`
 * characters). Here the same content is expressed as structured blocks so it
 * reads as a real document.
 */

interface Section {
  heading: string;
  icon: keyof typeof Ionicons.glyphMap;
  paragraphs?: string[];
  bullets?: string[];
}

const SECTIONS: Section[] = [
  {
    heading: 'What this app does',
    icon: 'information-circle-outline',
    paragraphs: [
      'EdgeOne Security Test helps authorised operators perform security testing against domains and systems they are permitted to test. This policy explains what the app collects and how that data is handled.',
    ],
  },
  {
    heading: 'Acceptance',
    icon: 'checkmark-circle-outline',
    paragraphs: ['By using this app you agree to this policy.'],
  },
  {
    heading: 'Data we collect',
    icon: 'server-outline',
    bullets: [
      'Account identity — your email address and role, used to attribute runs to an operator.',
      'Engagement data — the targets you test, the configurations you run, and the results.',
      'Per-request telemetry — timings, byte counts, status codes, and response previews captured during a run.',
      'Device context — platform and app version, recorded with each run for reproducibility.',
    ],
  },
  {
    heading: 'Why we collect it',
    icon: 'analytics-outline',
    bullets: [
      'To execute the tests you request and return results to you.',
      'To produce an auditable record of what was tested, when, and by whom.',
      'To diagnose failures and improve detection accuracy.',
    ],
  },
  {
    heading: 'What is never collected',
    icon: 'shield-checkmark-outline',
    bullets: [
      'We do not read personal files, contacts, photos, or messages on your device.',
      'Credential-bearing headers are truncated before storage — a trace log never holds a live secret.',
      'No advertising or third-party analytics SDKs are bundled with this app.',
    ],
  },
  {
    heading: 'Retention',
    icon: 'time-outline',
    paragraphs: [
      'Runs and their telemetry are retained for the length of the engagement plus the period required by your organisation’s audit policy. Deleting a run removes its findings and all associated per-request records.',
    ],
  },
  {
    heading: 'Your responsibilities',
    icon: 'alert-circle-outline',
    bullets: [
      'Only test targets you are explicitly authorised to test.',
      'Treat every result as confidential customer information.',
      'Report suspected data exposure to the security team immediately.',
    ],
  },
];

export default function PrivacyScreen(): React.JSX.Element {
  return (
    <Screen scroll padded={false}>
      <Header title="Privacy Policy" onBack={() => undefined} />

      <View style={styles.body}>
        <Text variant="h1">Privacy Policy</Text>
        <Text variant="h3" tone="primary" style={{ marginTop: spacing.xs }}>
          EdgeOne Security Test
        </Text>
        <Text variant="small" tone="muted" style={{ marginTop: spacing.sm }}>
          Effective: 16 September 2025
        </Text>

        <View style={{ height: spacing.xl }} />

        {SECTIONS.map((section) => (
          <Card key={section.heading} style={styles.section}>
            <View style={styles.heading}>
              <View style={styles.icon}>
                <Ionicons name={section.icon} size={17} color={palette.primary} />
              </View>
              <Text variant="h3" style={{ flex: 1 }}>
                {section.heading}
              </Text>
            </View>

            {section.paragraphs?.map((p) => (
              <Text key={p} variant="body" style={styles.paragraph}>
                {p}
              </Text>
            ))}

            {section.bullets?.map((b) => (
              <View key={b} style={styles.bulletRow}>
                <Ionicons name="ellipse" size={5} color={palette.primary} style={{ marginTop: 8 }} />
                <Text variant="body" style={styles.bulletText}>
                  {b}
                </Text>
              </View>
            ))}
          </Card>
        ))}

        <Text variant="tiny" tone="subtle" center style={{ marginTop: spacing.lg }}>
          Questions about this policy? Contact the EdgeOne security team.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.xl, paddingBottom: spacing.huge },
  section: { marginBottom: spacing.md, padding: spacing.lg },
  heading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  icon: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    backgroundColor: palette.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  paragraph: { marginTop: spacing.md, lineHeight: 23 },
  bulletRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  bulletText: { flex: 1, lineHeight: 23 },
});

void font;
