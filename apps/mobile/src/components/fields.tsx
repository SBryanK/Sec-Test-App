import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import type { FieldDef, FieldValue, KvPair } from '@teo/shared';

import { font, fontSize, palette, radius, shadow, spacing, useResponsive } from '../theme';
import { Slider } from './Slider';
import { Text } from './ui';

/* ------------------------------------------------------------------ *
 * Outlined input with a notched label
 * ------------------------------------------------------------------ */

interface OutlinedInputProps {
  label?: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  hint?: string;
  multiline?: boolean;
  keyboardType?: 'default' | 'number-pad' | 'numeric' | 'url';
  autoCapitalize?: 'none' | 'sentences';
  autoCorrect?: boolean;
  editable?: boolean;
  minHeight?: number;
  /** Background behind the label notch; must match the container. */
  surface?: string;
  style?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<TextStyle>;
  onBlur?: () => void;
  onFocus?: () => void;
  rightSlot?: React.ReactNode;
}

export function OutlinedInput({
  label,
  value,
  onChangeText,
  placeholder,
  hint,
  multiline,
  keyboardType = 'default',
  autoCapitalize = 'none',
  autoCorrect = false,
  editable = true,
  minHeight,
  surface = palette.surface,
  style,
  inputStyle,
  onBlur,
  onFocus,
  rightSlot,
}: OutlinedInputProps): React.JSX.Element {
  const [focused, setFocused] = useState(false);
  const { isCompact } = useResponsive();

  const height = minHeight ?? (multiline ? 96 : isCompact ? 46 : 50);

  return (
    <View style={style}>
      <View
        style={[
          styles.outline,
          { minHeight: height, backgroundColor: surface },
          focused && styles.outlineFocused,
          !editable && styles.outlineDisabled,
        ]}
      >
        {label ? (
          <View style={[styles.notch, { backgroundColor: surface }]}>
            <Text
              variant="tiny"
              style={{
                color: focused ? palette.primary : palette.inkMuted,
                fontFamily: font.semibold,
              }}
            >
              {label}
            </Text>
          </View>
        ) : null}

        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={palette.inkSubtle}
          multiline={multiline}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          editable={editable}
          onFocus={() => {
            setFocused(true);
            onFocus?.();
          }}
          onBlur={() => {
            setFocused(false);
            onBlur?.();
          }}
          textAlignVertical={multiline ? 'top' : 'center'}
          style={[
            styles.input,
            multiline && { minHeight: height - 12, paddingTop: spacing.md },
            inputStyle,
          ]}
        />
        {rightSlot}
      </View>
      {hint ? (
        <Text variant="small" tone="subtle" style={styles.hint}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Key / Value list editor
 * ------------------------------------------------------------------ */

function KeyValueEditor({
  pairs,
  onChange,
  surface = palette.surface,
}: {
  pairs: KvPair[];
  onChange: (next: KvPair[]) => void;
  surface?: string;
}): React.JSX.Element {
  const update = (index: number, patch: Partial<KvPair>): void => {
    onChange(pairs.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  };
  const remove = (index: number): void => onChange(pairs.filter((_, i) => i !== index));
  const add = (): void => onChange([...pairs, { key: '', value: '' }]);

  return (
    <View style={{ gap: spacing.md }}>
      {pairs.map((pair, index) => (
        <View key={`kv-${index}`} style={styles.kvRow}>
          <View style={styles.kvKey}>
            <OutlinedInput
              label="Key"
              value={pair.key}
              onChangeText={(v) => update(index, { key: v })}
              placeholder="Key"
              surface={surface}
              minHeight={62}
              multiline
            />
          </View>
          <View style={styles.kvValue}>
            <OutlinedInput
              label="Value"
              value={pair.value}
              onChangeText={(v) => update(index, { value: v })}
              placeholder="Value"
              surface={surface}
              minHeight={62}
              multiline
            />
          </View>
          <Pressable
            onPress={() => remove(index)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${pair.key || 'row'}`}
            style={({ pressed }) => [styles.kvTrash, pressed && { opacity: 0.5 }]}
          >
            <Ionicons name="trash-outline" size={19} color={palette.ink} />
          </Pressable>
        </View>
      ))}

      <Pressable
        onPress={add}
        accessibilityRole="button"
        accessibilityLabel="Add row"
        style={({ pressed }) => [styles.addRow, pressed && { opacity: 0.6 }]}
      >
        <Ionicons name="add-circle-outline" size={18} color={palette.primary} />
        <Text variant="small" tone="primary" style={{ fontFamily: font.semibold }}>
          Add row
        </Text>
      </Pressable>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Select (modal picker)
 * ------------------------------------------------------------------ */

function SelectField({
  label,
  value,
  options,
  onChange,
  surface = palette.surface,
}: {
  label: string;
  value: string;
  options: Array<{ label: string; value: string }>;
  onChange: (next: string) => void;
  surface?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${current?.label ?? value}`}
      >
        <View pointerEvents="none">
          <OutlinedInput
            label={label}
            value={current?.label ?? value}
            onChangeText={() => undefined}
            editable={false}
            surface={surface}
            rightSlot={
              <View style={styles.selectChevron}>
                <Ionicons name="chevron-down" size={18} color={palette.inkMuted} />
              </View>
            }
          />
        </View>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
            <Text variant="h3" style={{ marginBottom: spacing.md }}>
              {label}
            </Text>
            {options.map((option) => {
              const selected = option.value === value;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  style={({ pressed }) => [
                    styles.modalOption,
                    selected && { backgroundColor: palette.primarySoft },
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text variant="body" style={{ fontFamily: selected ? font.semibold : font.regular }}>
                    {option.label}
                  </Text>
                  {selected ? <Ionicons name="checkmark" size={19} color={palette.primary} /> : null}
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Field renderer
 * ------------------------------------------------------------------ */

/**
 * Render any config value as display text.
 *
 * A field's value can be a string, number, boolean, string list or Key/Value
 * rows. `String(value)` on the last two yields `"[object Object]"`, so an
 * imported config with an unexpected shape would render as garbage rather than
 * something an operator can act on.
 */
function displayValue(value: FieldValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    if (typeof value[0] === 'string') return (value as string[]).join('\n');
    return (value as KvPair[])
      .map((pair) => (pair.key ? `${pair.key}: ${pair.value}` : pair.value))
      .join('\n');
  }
  return '';
}

export interface FieldRendererProps {
  field: FieldDef;
  value: FieldValue | undefined;
  onChange: (id: string, value: FieldValue) => void;
  /** Background behind notched labels — matches the enclosing card. */
  surface?: string;
}

/**
 * Renders a single catalog field.
 *
 * Every config screen in the app is produced by mapping this over
 * `TestDefinition.fields`, so adding a test to the catalog automatically
 * produces a working, validated config screen with no new UI code.
 */
export function FieldRenderer({
  field,
  value,
  onChange,
  surface = palette.surface,
}: FieldRendererProps): React.JSX.Element | null {
  switch (field.type) {
    case 'section':
      return (
        <Text variant="h3" style={{ marginTop: spacing.sm }}>
          {field.label}
        </Text>
      );

    case 'divider':
      return <View style={styles.fieldDivider} />;

    case 'note': {
      const tone =
        field.tone === 'warn'
          ? { bg: palette.warningSoft, bar: palette.warning }
          : field.tone === 'danger'
            ? { bg: palette.dangerSoft, bar: palette.danger }
            : { bg: palette.surfaceAlt, bar: palette.primary };
      return (
        <View style={[styles.note, { backgroundColor: tone.bg, borderLeftColor: tone.bar }]}>
          <View style={styles.noteHeader}>
            <Ionicons name="document-text-outline" size={15} color={tone.bar} />
            <Text variant="small" style={{ color: tone.bar, fontFamily: font.bold }}>
              {field.label}
            </Text>
          </View>
          <Text variant="small" tone="muted" style={{ marginTop: spacing.xs, lineHeight: 20 }}>
            {field.body}
          </Text>
        </View>
      );
    }

    case 'text':
      return (
        <OutlinedInput
          label={field.label}
          value={displayValue(value)}
          onChangeText={(v) => onChange(field.id, v)}
          placeholder={field.placeholder}
          hint={field.hint}
          surface={surface}
          keyboardType={field.mono && /path|url|endpoint|domain/i.test(field.label) ? 'url' : 'default'}
        />
      );

    case 'textarea':
      return (
        <OutlinedInput
          label={field.label}
          value={displayValue(value)}
          onChangeText={(v) => onChange(field.id, v)}
          placeholder={field.placeholder}
          hint={field.hint}
          multiline
          minHeight={110}
          surface={surface}
          inputStyle={{ fontFamily: 'monospace', fontSize: fontSize.small, lineHeight: 19 }}
        />
      );

    case 'lines':
      return (
        <OutlinedInput
          label={field.label}
          value={displayValue(value)}
          onChangeText={(v) => onChange(field.id, v.split('\n').filter((line) => line.trim().length > 0))}
          hint={field.hint ?? 'One per line'}
          multiline
          minHeight={110}
          surface={surface}
          inputStyle={{ fontFamily: 'monospace', fontSize: fontSize.small, lineHeight: 20 }}
        />
      );

    case 'number': {
      const numeric = value === '' || value === null || value === undefined ? '' : displayValue(value);
      const outOfRange =
        numeric !== '' &&
        ((field.min !== undefined && Number(numeric) < field.min) ||
          (field.max !== undefined && Number(numeric) > field.max));
      return (
        <OutlinedInput
          label={field.label}
          value={numeric}
          onChangeText={(v) => {
            // Keep only digits so the numeric keypad cannot produce junk.
            const cleaned = v.replace(/[^0-9.]/g, '');
            onChange(field.id, cleaned === '' ? '' : Number(cleaned));
          }}
          placeholder={field.placeholder ?? '0'}
          hint={field.hint}
          keyboardType="number-pad"
          surface={surface}
          inputStyle={outOfRange ? { color: palette.danger } : undefined}
        />
      );
    }

    case 'slider': {
      const num = typeof value === 'number' ? value : Number(value ?? field.min ?? 1);
      return (
        <View>
          <Text variant="small" style={{ fontFamily: font.semibold, marginBottom: spacing.xs }}>
            {field.label}
          </Text>
          <View style={styles.sliderRow}>
            <View style={{ flex: 1 }}>
              <Slider
                value={num}
                min={field.min ?? 1}
                max={field.max ?? 5}
                step={field.step ?? 1}
                onChange={(v) => onChange(field.id, v)}
              />
            </View>
            <View style={styles.sliderValue}>
              <Text variant="small" tone="subtle">
                {field.hint ?? ''}
              </Text>
              <Text variant="h3">{num}</Text>
            </View>
          </View>
          <Text variant="micro" tone="subtle" style={{ marginTop: spacing.xs }}>
            {num} {field.hint ?? ''}
          </Text>
        </View>
      );
    }

    case 'checkbox':
      return (
        <Pressable
          onPress={() => onChange(field.id, !value)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: !!value }}
          accessibilityLabel={field.label}
          style={({ pressed }) => [styles.checkboxRow, pressed && { opacity: 0.7 }]}
        >
          <Switch
            value={!!value}
            onValueChange={(v) => onChange(field.id, v)}
            trackColor={{ false: palette.surfaceSunken, true: palette.primary }}
            thumbColor="#FFFFFF"
          />
          <View style={{ flex: 1 }}>
            <Text variant="body">{field.label}</Text>
            {field.hint ? (
              <Text variant="small" tone="subtle" style={{ marginTop: 1 }}>
                {field.hint}
              </Text>
            ) : null}
          </View>
        </Pressable>
      );

    case 'segmented':
      return (
        <View>
          <View style={styles.segmentedHeader}>
            <Text variant="small" style={{ fontFamily: font.semibold }}>
              {field.label}
            </Text>
            {field.options && field.options.length > 0 ? (
              <Text variant="micro" tone="primary" style={styles.segmentedValue}>
                {(field.options.find((o) => o.value === value)?.label ?? displayValue(value)).toUpperCase()}
              </Text>
            ) : null}
          </View>
          <View style={styles.segmentedRow}>
            {(field.options ?? []).map((option) => {
              const selected = option.value === value;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => onChange(field.id, option.value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  style={({ pressed }) => [
                    styles.segment,
                    selected && { backgroundColor: palette.primarySoft, borderColor: palette.primaryBorder },
                    pressed && { opacity: 0.75 },
                  ]}
                >
                  <Text
                    variant="micro"
                    style={{
                      color: selected ? palette.primaryDark : palette.inkMuted,
                      fontSize: 10,
                    }}
                  >
                    {option.label.toUpperCase()}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      );

    case 'select':
      return (
        <SelectField
          label={field.label}
          value={displayValue(value) || field.options?.[0]?.value || ''}
          options={field.options ?? []}
          onChange={(v) => onChange(field.id, v)}
          surface={surface}
        />
      );

    case 'keyvalue':
      return (
        <View>
          <View style={styles.kvHeader}>
            <Text variant="h3">{field.label}</Text>
            <Ionicons name="add" size={20} color={palette.ink} />
          </View>
          <KeyValueEditor
            pairs={Array.isArray(value) ? (value as KvPair[]) : []}
            onChange={(next) => onChange(field.id, next)}
            surface={surface}
          />
        </View>
      );

    default:
      // A field type the renderer does not handle means the catalog and the UI
      // have drifted. Fail loudly in development rather than rendering nothing.
      if (__DEV__) {
        throw new Error(
          `FieldRenderer has no case for field type "${String(field.type)}" (field "${field.id}"). ` +
            'Add it to SUPPORTED_FIELD_TYPES and implement the control.',
        );
      }
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Styles
 * ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  outline: {
    borderWidth: 1,
    borderColor: palette.lineStrong,
    borderRadius: radius.md,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  outlineFocused: { borderColor: palette.primary, borderWidth: 2 },
  outlineDisabled: { backgroundColor: palette.surfaceAlt, borderColor: palette.line },

  notch: {
    position: 'absolute',
    top: -8,
    left: 10,
    paddingHorizontal: 5,
    zIndex: 1,
  },
  input: {
    fontFamily: font.regular,
    fontSize: fontSize.body,
    color: palette.ink,
    paddingVertical: spacing.md,
    padding: 0,
  },
  hint: { marginTop: spacing.xs, marginLeft: spacing.xs },

  selectChevron: { position: 'absolute', right: spacing.sm, top: '50%', marginTop: -9 },

  kvRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  kvKey: { flex: 0.85 },
  kvValue: { flex: 1.15 },
  kvTrash: { paddingTop: 22, paddingHorizontal: 2 },
  kvHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(11,27,51,0.45)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: palette.surface,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    padding: spacing.xl,
    paddingBottom: spacing.huge,
    ...shadow.raised,
  },
  modalOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
  },

  note: {
    borderLeftWidth: 3,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  noteHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },

  fieldDivider: { height: 1, backgroundColor: palette.line, marginVertical: spacing.lg },

  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  sliderValue: { alignItems: 'center', minWidth: 62 },

  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },

  segmentedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  segmentedValue: {
    letterSpacing: 0.6,
  },
  segmentedRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  segment: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surfaceAlt,
  },
});
