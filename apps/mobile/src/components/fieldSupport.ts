import type { FieldType } from '@teo/shared';

/**
 * The field types `FieldRenderer` knows how to draw.
 *
 * Kept in a plain module (no React Native imports) so it can be asserted in
 * tests: a new test added to the catalog with a field type the renderer does not
 * handle would otherwise only surface as a silently blank control at runtime.
 */
export const SUPPORTED_FIELD_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  'text',
  'textarea',
  'lines',
  'number',
  'select',
  'slider',
  'checkbox',
  'segmented',
  'keyvalue',
  'note',
  'section',
  'divider',
]);

export function isSupportedFieldType(type: string): boolean {
  return SUPPORTED_FIELD_TYPES.has(type as FieldType);
}
