import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALL_TESTS,
  CATEGORIES,
  buildAllTestsConfigs,
  buildDefaultConfig,
  defaultValues,
  normaliseTarget,
  payloadsFor,
  validateConfig,
} from '@teo/shared';

import { SUPPORTED_FIELD_TYPES, isSupportedFieldType } from '../src/components/fieldSupport.ts';

/**
 * Mobile-facing contract tests.
 *
 * These guard the seam between the shared catalog and the app's schema-driven
 * renderer: if the catalog grows a construct the UI cannot draw, or a default
 * the config screen cannot round-trip, that is caught here rather than by an
 * operator staring at a blank control.
 */

describe('renderer / catalog contract', () => {
  it('can render every field type used anywhere in the catalog', () => {
    for (const test of ALL_TESTS) {
      for (const field of test.fields) {
        assert.ok(
          isSupportedFieldType(field.type),
          `${test.id}.${field.id} uses unsupported field type "${field.type}"`,
        );
      }
    }
  });

  it('has no undocumented dead entries in the supported set', () => {
    // `divider` and `textarea`-adjacent primitives are part of the renderer's
    // vocabulary and may be used by future tests. Anything unused must be
    // explicitly listed here so it is a decision, not an oversight.
    const RESERVED = new Set(['divider']);

    const used = new Set(ALL_TESTS.flatMap((t) => t.fields.map((f) => f.type)));
    for (const type of SUPPORTED_FIELD_TYPES) {
      if (RESERVED.has(type)) continue;
      assert.ok(used.has(type), `SUPPORTED_FIELD_TYPES lists "${type}" but no test uses it — reserve it or drop it`);
    }
  });

  it('gives every rendered field a stable, non-empty id', () => {
    for (const test of ALL_TESTS) {
      for (const field of test.fields) {
        assert.ok(field.id.trim().length > 0, `${test.id}: a field has an empty id`);
        assert.match(field.id, /^[a-z0-9_.]+$/i, `${test.id}: field id "${field.id}" is not a clean key`);
      }
    }
  });

  it('gives every non-presentational field a label to render', () => {
    for (const test of ALL_TESTS) {
      for (const field of test.fields) {
        if (field.type === 'divider') continue;
        assert.ok(field.label.trim().length > 0, `${test.id}.${field.id} has no label`);
      }
    }
  });

  it('never puts a section heading on a section field without a section to sit in', () => {
    for (const test of ALL_TESTS) {
      const sections = new Set(test.sections.map((s) => s.id));
      for (const field of test.fields) {
        assert.ok(sections.has(field.section), `${test.id}.${field.id} points at a missing section`);
      }
    }
  });
});

describe('config screen round-trip', () => {
  it('builds a valid, non-empty default config for every test', () => {
    for (const test of ALL_TESTS) {
      const config = buildDefaultConfig(test.id, 'example.com');
      assert.equal(config.testId, test.id);
      assert.equal(config.target.domain, 'example.com');
      assert.ok(config.http.method.length > 0, `${test.id}: no HTTP method`);
      assert.ok(config.http.path.length > 0, `${test.id}: no request path`);
      assert.ok(Object.keys(config.values).length > 0, `${test.id}: no values collected`);
    }
  });

  it('survives a JSON serialise/parse cycle unchanged (cart persistence)', () => {
    for (const test of ALL_TESTS) {
      const config = buildDefaultConfig(test.id, 'example.com');
      const revived = JSON.parse(JSON.stringify(config)) as typeof config;
      assert.deepEqual(revived.values, config.values, `${test.id}: values changed across a JSON round-trip`);
      assert.deepEqual(revived.http, config.http, `${test.id}: http block changed across a JSON round-trip`);
    }
  });

  it('produces exactly one editable value per input field', () => {
    for (const test of ALL_TESTS) {
      const values = defaultValues(test);
      const expected = test.fields.filter(
        (f) => f.type !== 'note' && f.type !== 'section' && f.type !== 'divider',
      );
      assert.equal(
        Object.keys(values).length,
        expected.length,
        `${test.id}: value count does not match input field count`,
      );
    }
  });

  it('keeps every default inside the declared bounds', () => {
    for (const test of ALL_TESTS) {
      for (const field of test.fields) {
        if (field.type !== 'number' && field.type !== 'slider') continue;
        if (field.default === null || field.default === undefined) continue;
        const n = Number(field.default);
        if (field.min !== undefined) assert.ok(n >= field.min, `${test.id}.${field.id} below min`);
        if (field.max !== undefined) assert.ok(n <= field.max, `${test.id}.${field.id} above max`);
      }
    }
  });
});

describe('run-all flow', () => {
  it('produces one config per test, all sharing the target', () => {
    const configs = buildAllTestsConfigs('scan.example.com');
    assert.equal(configs.length, ALL_TESTS.length);
    assert.equal(new Set(configs.map((c) => c.testId)).size, ALL_TESTS.length);
    for (const config of configs) {
      assert.equal(config.target.domain, 'scan.example.com');
      // Every config in a Run-All must be immediately valid, or the batch
      // would be rejected server-side as a whole.
      const errors = validateConfig(config).filter((i) => i.severity === 'error');
      assert.deepEqual(errors, [], `${config.testId} would block a Run-All: ${JSON.stringify(errors)}`);
    }
  });

  it('covers every category in a Run-All', () => {
    const configs = buildAllTestsConfigs('scan.example.com');
    const covered = new Set(
      configs.map((c) => ALL_TESTS.find((t) => t.id === c.testId)?.category),
    );
    assert.equal(covered.size, CATEGORIES.length, 'Run-All must span all four categories');
  });

  it('costs one credit per test by default', () => {
    const configs = buildAllTestsConfigs('scan.example.com');
    const total = configs.reduce(
      (sum, c) => sum + (ALL_TESTS.find((t) => t.id === c.testId)?.creditCost ?? 0),
      0,
    );
    assert.equal(total, ALL_TESTS.length);
  });
});

describe('target entry', () => {
  it('accepts the forms an operator actually types', () => {
    const forms = [
      'example.com',
      'https://example.com',
      'http://example.com:8080',
      '192.168.1.10',
      'example.com/path?q=1',
      '[::1]:8443',
    ];
    for (const form of forms) {
      assert.doesNotThrow(() => normaliseTarget(form), `should accept "${form}"`);
    }
  });

  it('rejects the forms that would silently test the wrong thing', () => {
    for (const bad of ['', '   ', 'ftp://example.com', 'example.com:notaport']) {
      assert.throws(() => normaliseTarget(bad), `should reject "${bad}"`);
    }
  });
});

describe('payload wiring', () => {
  it('reads a payload list for the tests that have one', () => {
    const expectations: Array<[string, number]> = [
      ['sql_injection', 3],
      ['xss', 3],
      ['path_traversal', 3],
      ['brute_force', 3],
      ['schema_validation', 3],
      ['user_agent_anomaly', 4],
    ];
    for (const [testId, count] of expectations) {
      const config = buildDefaultConfig(testId as never, 'example.com');
      assert.equal(payloadsFor(config).length, count, `${testId} payload count`);
    }
  });

  it('returns no payloads for tests that do not use a dictionary', () => {
    for (const testId of ['http_spike', 'oversized_body', 'business_logic'] as const) {
      assert.deepEqual(payloadsFor(buildDefaultConfig(testId, 'example.com')), []);
    }
  });
});
