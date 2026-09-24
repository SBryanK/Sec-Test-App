import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALL_TESTS,
  ALL_TEST_IDS,
  CATEGORIES,
  buildAllTestsConfigs,
  buildDefaultConfig,
  canonicalise,
  defaultValues,
  formatIssue,
  getTest,
  hasBlockingIssue,
  normaliseTarget,
  payloadsFor,
  substitute,
  testsForCategory,
  totalCreditCost,
  validateConfig,
} from '../src/index.ts';

describe('catalog integrity', () => {
  it('exposes all 12 tests across 4 categories', () => {
    assert.equal(ALL_TESTS.length, 12);
    assert.equal(CATEGORIES.length, 4);
    assert.equal(new Set(ALL_TEST_IDS).size, 12, 'test ids must be unique');
  });

  it('accounts for every test in exactly one category', () => {
    const claimed = CATEGORIES.flatMap((c) => c.testIds);
    assert.equal(claimed.length, 12);
    assert.deepEqual([...claimed].sort(), [...ALL_TEST_IDS].sort());
  });

  it('gives each test a unique category back-reference', () => {
    for (const cat of CATEGORIES) {
      for (const id of cat.testIds) {
        assert.equal(getTest(id).category, cat.id, `${id} category mismatch`);
      }
    }
  });

  it('declares unique field ids and valid section references within each test', () => {
    for (const test of ALL_TESTS) {
      const sectionIds = new Set(test.sections.map((s) => s.id));
      const fieldIds = new Set<string>();
      for (const field of test.fields) {
        assert.ok(!fieldIds.has(field.id), `${test.id}: duplicate field ${field.id}`);
        fieldIds.add(field.id);
        assert.ok(
          sectionIds.has(field.section),
          `${test.id}: field ${field.id} references unknown section ${field.section}`,
        );
      }
    }
  });

  it('keeps every declared default inside its own min/max bounds', () => {
    for (const test of ALL_TESTS) {
      for (const field of test.fields) {
        if (field.type !== 'number' && field.type !== 'slider') continue;
        const def = field.default;
        if (def === null || def === undefined) continue;
        const num = Number(def);
        assert.ok(Number.isFinite(num), `${test.id}.${field.id}: default is not numeric`);
        if (field.min !== undefined) {
          assert.ok(num >= field.min, `${test.id}.${field.id}: default ${num} < min ${field.min}`);
        }
        if (field.max !== undefined) {
          assert.ok(num <= field.max, `${test.id}.${field.id}: default ${num} > max ${field.max}`);
        }
      }
    }
  });

  it('renders a hint on every numeric field, matching the reference UI', () => {
    for (const test of ALL_TESTS) {
      for (const field of test.fields) {
        if (field.type !== 'number') continue;
        assert.ok(field.hint, `${test.id}.${field.id} is missing a hint line`);
      }
    }
  });

  it('every category resolves to a non-empty, correctly-ordered test list', () => {
    for (const cat of CATEGORIES) {
      const tests = testsForCategory(cat.id);
      assert.equal(tests.length, cat.testIds.length);
      tests.forEach((t, i) => assert.equal(t.id, cat.testIds[i]));
    }
  });
});

describe('defaults', () => {
  it('produces a value for every input field and none for presentational fields', () => {
    for (const test of ALL_TESTS) {
      const values = defaultValues(test);
      for (const field of test.fields) {
        if (field.type === 'note' || field.type === 'section' || field.type === 'divider') {
          assert.ok(!(field.id in values), `${test.id}: ${field.id} should not carry a value`);
        } else {
          assert.ok(field.id in values, `${test.id}: ${field.id} missing a default`);
        }
      }
    }
  });

  it('builds a cart-ready config from a bare domain', () => {
    const cfg = buildDefaultConfig('sql_injection', 'example.com');
    assert.equal(cfg.testId, 'sql_injection');
    assert.equal(cfg.target.domain, 'example.com');
    assert.equal(cfg.http.method, 'POST');
    assert.equal(cfg.values['sql.target_param'], 'id');
    assert.deepEqual(payloadsFor(cfg), ["1' OR 1=1--", "1' UNION SELECT", "'; DROP TABLE users--"]);
  });

  it('produces all 12 configs for Run-All with the shared target', () => {
    const configs = buildAllTestsConfigs('target.test');
    assert.equal(configs.length, 12);
    assert.equal(new Set(configs.map((c) => c.id)).size, 12, 'config ids must be unique');
    for (const c of configs) assert.equal(c.target.domain, 'target.test');
    assert.equal(totalCreditCost(configs), 12);
  });
});

describe('target normalisation', () => {
  it('accepts a bare hostname and defaults to TLS', () => {
    const t = normaliseTarget('example.com');
    assert.equal(t.host, 'example.com');
    assert.equal(t.useTls, true);
    assert.equal(t.port, null);
    assert.equal(t.origin, 'https://example.com');
  });

  it('honours an explicit http scheme', () => {
    const t = normaliseTarget('http://example.com');
    assert.equal(t.useTls, false);
    assert.equal(t.origin, 'http://example.com');
  });

  it('keeps a non-default port in the origin but omits a default one', () => {
    assert.equal(normaliseTarget('example.com:8443').origin, 'https://example.com:8443');
    assert.equal(normaliseTarget('example.com:443').origin, 'https://example.com');
    assert.equal(normaliseTarget('http://example.com:80').origin, 'http://example.com');
  });

  it('strips path, query and fragment', () => {
    assert.equal(normaliseTarget('https://example.com/a/b?c=d#e').host, 'example.com');
  });

  it('accepts a bare IPv4 address with a port', () => {
    const t = normaliseTarget('192.168.1.10:8080');
    assert.equal(t.host, '192.168.1.10');
    assert.equal(t.port, 8080);
    assert.equal(t.origin, 'https://192.168.1.10:8080');
  });

  it('accepts a bracketed IPv6 address', () => {
    const t = normaliseTarget('[::1]:8080');
    assert.equal(t.host, '::1');
    assert.equal(t.port, 8080);
    assert.equal(t.origin, 'https://[::1]:8080');
  });

  it('rejects empty, whitespace, bad schemes and bad ports', () => {
    assert.throws(() => normaliseTarget(''), /Domain cannot be empty/);
    assert.throws(() => normaliseTarget('   '), /Domain cannot be empty/);
    assert.throws(() => normaliseTarget('ftp://example.com'), /Unsupported scheme/);
    assert.throws(() => normaliseTarget('example.com:99999'), /Port must be between/);
    assert.throws(() => normaliseTarget('example.com:abc'), /Invalid port/);
  });

  it('lets an explicit override win over inference', () => {
    assert.equal(normaliseTarget('example.com', { useTls: false }).origin, 'http://example.com');
    assert.equal(normaliseTarget('example.com', { port: 9000 }).origin, 'https://example.com:9000');
  });
});

describe('validation', () => {
  it('raises the reference banner text for an empty domain', () => {
    const issues = validateConfig(buildDefaultConfig('http_spike', ''));
    const domainIssue = issues.find((i) => i.fieldId === 'target.domain');
    assert.ok(domainIssue);
    assert.equal(formatIssue(domainIssue), 'Domain: Domain cannot be empty');
    assert.ok(hasBlockingIssue(issues));
  });

  it('passes a fully-defaulted config once a domain is supplied', () => {
    for (const id of ALL_TEST_IDS) {
      const issues = validateConfig(buildDefaultConfig(id, 'example.com'));
      const errors = issues.filter((i) => i.severity === 'error');
      assert.deepEqual(errors, [], `${id} should validate cleanly, got ${JSON.stringify(errors)}`);
    }
  });

  it('rejects an out-of-range numeric value', () => {
    const cfg = buildDefaultConfig('http_spike', 'example.com');
    cfg.values['spike.burst'] = 99_999;
    const issues = validateConfig(cfg);
    assert.ok(issues.some((i) => i.fieldId === 'spike.burst' && /at most 1000/.test(i.message)));
  });

  it('catches an inverted IDOR range and an oversized enumeration span', () => {
    const inverted = buildDefaultConfig('idor_enumeration', 'example.com');
    inverted.values['idor.start'] = 50;
    inverted.values['idor.end'] = 10;
    assert.ok(validateConfig(inverted).some((i) => i.fieldId === 'idor.end'));

    const huge = buildDefaultConfig('idor_enumeration', 'example.com');
    huge.values['idor.start'] = 1;
    huge.values['idor.end'] = 1_000_000;
    huge.values['idor.step'] = 1;
    assert.ok(validateConfig(huge).some((i) => /narrow it to 5000/.test(i.message)));
  });

  it('warns when a deep crawl is paired with a large page budget', () => {
    const cfg = buildDefaultConfig('web_crawler', 'example.com');
    cfg.values['crawl.depth'] = 5;
    cfg.values['crawl.max_pages'] = 4000;
    const issues = validateConfig(cfg);
    assert.ok(issues.some((i) => i.severity === 'warning'));
    assert.ok(!hasBlockingIssue(issues), 'a warning must not block submission');
  });
});

describe('templating and provenance', () => {
  it('substitutes known placeholders and leaves unknown ones intact', () => {
    assert.equal(
      substitute('{"u":"{{USERNAME}}","p":"{{PAYLOAD}}"}', { USERNAME: 'admin', PAYLOAD: 'x' }),
      '{"u":"admin","p":"x"}',
    );
    assert.equal(substitute('{{NOPE}}', {}), '{{NOPE}}');
    assert.equal(substitute('{{ PAYLOAD }}', { PAYLOAD: 'ok' }), 'ok');
  });

  it('canonicalises independent of key order', () => {
    assert.equal(canonicalise({ a: 1, b: [2, 3] }), canonicalise({ b: [2, 3], a: 1 }));
    assert.notEqual(canonicalise({ a: 1 }), canonicalise({ a: 2 }));
  });
});

describe('feasibility labelling', () => {
  it('marks load-generation tests as needing the server executor', () => {
    assert.equal(getTest('http_spike').feasibility, 'hybrid');
    assert.equal(getTest('connection_flood').feasibility, 'hybrid');
    assert.equal(getTest('oversized_body').feasibility, 'hybrid');
  });

  it('marks injection and API tests as fully phone-capable', () => {
    for (const id of ['sql_injection', 'xss', 'path_traversal', 'idor_enumeration'] as const) {
      assert.equal(getTest(id).feasibility, 'phone', `${id} should be phone-capable`);
    }
  });

  it('gives every test an operator-readable feasibility note', () => {
    for (const test of ALL_TESTS) {
      assert.ok(test.feasibilityNote.length > 20, `${test.id} needs a real explanation`);
    }
  });
});
