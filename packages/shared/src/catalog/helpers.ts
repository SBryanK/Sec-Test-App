import type { FieldDef, HttpMethod, KvPair } from '../types';

/**
 * Shared field factories. Every config screen in the app is composed from
 * these, so the field vocabulary (and therefore the rendering) stays uniform
 * across all 12 tests.
 */

export const SECTION = {
  target: 'target',
  templates: 'templates',
  http: 'http',
  query: 'query',
  headers: 'headers',
  body: 'body',
} as const;

/** The "Import Templates" callout shown on the DoS config screens. */
export const importTemplatesNote: FieldDef = {
  id: 'info.import_templates',
  type: 'note',
  section: SECTION.templates,
  label: 'Import Templates',
  tone: 'info',
  body:
    '• Import TestParameters JSON to auto-add test to cart\n' +
    '• Use example templates: sql_injection_template.json, connection_flood_template.json, oversized_body_template.json\n' +
    '• Additive Import: New tests added to existing cart (no override)',
};

export function methodField(section: string, value: HttpMethod = 'GET'): FieldDef {
  return {
    id: 'http.method',
    type: 'select',
    section,
    label: 'HTTP Method',
    default: value,
    options: (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as HttpMethod[]).map(
      (m) => ({ label: m, value: m }),
    ),
  };
}

export function pathField(section: string, value = '/'): FieldDef {
  return {
    id: 'http.path',
    type: 'text',
    section,
    label: 'Request Path',
    placeholder: '/',
    default: value,
    mono: true,
  };
}

export function queryField(section: string, pairs: KvPair[] = []): FieldDef {
  return {
    id: 'http.query',
    type: 'keyvalue',
    section,
    label: 'Query Parameters',
    default: pairs,
  };
}

export function headersField(section: string, pairs: KvPair[] = []): FieldDef {
  return {
    id: 'http.headers',
    type: 'keyvalue',
    section,
    label: 'HTTP Headers',
    default: pairs,
  };
}

export function bodyField(section: string, value = ''): FieldDef {
  return {
    id: 'http.body',
    type: 'textarea',
    section,
    label: 'Request Body',
    placeholder: 'Request body',
    hint: 'Use {{PAYLOAD}} as injection placeholder',
    default: value,
    mono: true,
  };
}

export function numberField(
  id: string,
  section: string,
  label: string,
  opts: { min: number; max: number; def?: number | null; hint?: string; step?: number },
): FieldDef {
  return {
    id,
    type: 'number',
    section,
    label,
    min: opts.min,
    max: opts.max,
    step: opts.step ?? 1,
    default: opts.def === undefined ? null : opts.def,
    hint: opts.hint,
  };
}

export function linesField(
  id: string,
  section: string,
  label: string,
  def: string[],
  hint?: string,
): FieldDef {
  return {
    id,
    type: 'lines',
    section,
    label,
    default: def,
    hint,
    mono: true,
  };
}

export const INJECTION_POINT_OPTIONS = [
  { label: 'QUERY PARAM', value: 'query' },
  { label: 'REQUEST BODY', value: 'body' },
  { label: 'HTTP HEADER', value: 'header' },
  { label: 'URL PATH', value: 'path' },
  { label: 'JSON FIELD', value: 'json_field' },
];

/** Browser-like header set reused by several request-bearing tests. */
export const BROWSER_HEADERS: KvPair[] = [
  {
    key: 'User-Agent',
    value:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  },
  { key: 'Accept', value: 'application/json, text/plain, */*' },
  { key: 'Accept-Language', value: 'en-US,en;q=0.9' },
];

export const LINES_HINT = 'One per line';
