/**
 * End-to-end driver for the installed Android app.
 *
 * Drives the real APK on a real emulator through the accessibility tree rather
 * than hardcoded pixel coordinates, so the flow does not silently break when a
 * layout shifts. Every step captures a screenshot as evidence.
 *
 *   node ops/e2e-app.mjs
 *
 * Requires: emulator running, APK installed, stack up (API on the host).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'artifacts');
const PKG = 'com.edgeone.sectest';

/**
 * Two different addresses, and confusing them is the classic mistake here:
 *
 *   APP_API   the API as seen FROM the emulator  -> 10.0.2.2 is the emulator's
 *             alias for the host loopback.
 *   SCAN_TARGET the target as seen FROM the backend.
 *
 * The phone does not perform the attack — the backend does. So the scan target
 * must be reachable from the API process, where 10.0.2.2 is meaningless.
 */
const SCAN_TARGET = process.env.SCAN_TARGET ?? 'http://127.0.0.1:9900';
/** Seed operator used for the sign-in step. */
const SEED_EMAIL = process.env.SEED_USER_EMAIL ?? 'operator@example.com';
const SEED_PASSWORD = process.env.SEED_USER_PASSWORD ?? 'edgeone';

/**
 * Locate the Android SDK and adb.
 *
 * Prefers a workspace-local toolchain (used when $HOME is not writable), then
 * falls back to the standard ANDROID_HOME / ANDROID_SDK_ROOT locations so this
 * script works on a normal developer machine and in CI.
 */
function findAndroidSdk() {
  const candidates = [
    process.env.ANDROID_TOOLCHAIN_HOME && `${process.env.ANDROID_TOOLCHAIN_HOME}/sdk`,
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.HOME && `${process.env.HOME}/Library/Android/sdk`,
    process.env.HOME && `${process.env.HOME}/Android/Sdk`,
    '/usr/local/share/android-sdk',
  ].filter(Boolean);

  for (const dir of candidates) {
    if (existsSync(join(dir, 'platform-tools', 'adb'))) return dir;
  }
  throw new Error(
    'Could not find the Android SDK. Set ANDROID_HOME, or ANDROID_TOOLCHAIN_HOME ' +
      'if you keep a workspace-local toolchain.',
  );
}

const SDK = findAndroidSdk();
const ADB = join(SDK, 'platform-tools', 'adb');

/**
 * adb writes its key material to $HOME/.android. When HOME is not writable (some
 * sandboxes) the toolchain provides a redirected HOME; otherwise the real
 * environment is inherited unchanged.
 */
const TOOLCHAIN_HOME = process.env.ANDROID_TOOLCHAIN_HOME;
const ADB_ENV = {
  ...process.env,
  ...(TOOLCHAIN_HOME
    ? {
        HOME: join(TOOLCHAIN_HOME, 'home'),
        ANDROID_USER_HOME: join(TOOLCHAIN_HOME, 'android-home'),
        ANDROID_AVD_HOME: join(TOOLCHAIN_HOME, 'home', '.android', 'avd'),
        JAVA_HOME: join(TOOLCHAIN_HOME, 'jdk', 'Contents', 'Home'),
      }
    : {}),
  ANDROID_HOME: SDK,
  ANDROID_SDK_ROOT: SDK,
};

mkdirSync(SHOTS, { recursive: true });

let step = 0;
const results = [];

/* ------------------------------------------------------------------ *
 * adb helpers
 * ------------------------------------------------------------------ */

/**
 * Run an adb command.
 *
 * The timeout is not optional. `uiautomator dump` and `exec-out screencap` both
 * block indefinitely when the device surface is busy — a window animation, a
 * modal, or a stale uiautomator process — and without a timeout the harness sat
 * there producing no output at all, which reads as "the app is broken" rather
 * than "the driver is wedged".
 */
const ADB_TIMEOUT_MS = 25_000;

function adb(...args) {
  return execFileSync(ADB, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: ADB_ENV,
    timeout: ADB_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
}

function sleep(ms) {
  // Braced body: an arrow returning `setTimeout(...)` hands the timer handle
  // back to the promise machinery, which cannot read it.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shot(name) {
  step += 1;
  const file = join(SHOTS, `${String(step).padStart(2, '0')}-${name}.png`);
  try {
    const buf = execFileSync(ADB, ['exec-out', 'screencap', '-p'], {
      maxBuffer: 64 * 1024 * 1024,
      env: ADB_ENV,
      timeout: ADB_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    writeFileSync(file, buf);
  } catch (err) {
    // Evidence is valuable but never worth failing a functional check over.
    console.log(`  \u001b[33m!\u001b[0m screenshot "${name}" unavailable: ${err.message.split('\n')[0]}`);
  }
  return file;
}

/** Dump the view hierarchy and parse it into addressable nodes. */
function uiNodes() {
  // Retried once: a dump started while the UI is animating returns a truncated
  // tree, and a single retry is far cheaper than a misleading assertion.
  let xml = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml');
      xml = adb('shell', 'cat', '/sdcard/ui.xml');
      if (xml.includes('<hierarchy')) break;
    } catch (err) {
      if (attempt === 1) {
        throw new Error(`Could not read the view hierarchy: ${err.message}`);
      }
      execFileSync(ADB, ['shell', 'rm', '-f', '/sdcard/ui.xml'], { env: ADB_ENV, timeout: ADB_TIMEOUT_MS });
    }
  }
  const nodes = [];
  const re = /<node\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const get = (k) => {
      const r = new RegExp(`${k}="([^"]*)"`).exec(attrs);
      return r ? r[1] : '';
    };
    const bounds = get('bounds');
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(bounds);
    if (!b) continue;
    nodes.push({
      text: get('text'),
      desc: get('content-desc'),
      cls: get('class'),
      clickable: get('clickable') === 'true',
      x: Math.round((Number(b[1]) + Number(b[3])) / 2),
      y: Math.round((Number(b[2]) + Number(b[4])) / 2),
    });
  }
  return nodes;
}

function findByText(needle, { exact = false } = {}) {
  const nodes = uiNodes();
  const lower = needle.toLowerCase();
  return nodes.find((n) => {
    const hay = `${n.text} ${n.desc}`.toLowerCase();
    return exact ? hay.trim() === lower : hay.includes(lower);
  });
}

/**
 * Find an interactive control by its accessibility label only.
 *
 * Searching text as well would match a heading that happens to share the
 * button's wording (the "Sign in" card title vs the "Sign in" button), and the
 * tap would land on a non-interactive Text node.
 */
function findByDesc(needle, { exact = false } = {}) {
  const lower = needle.toLowerCase();
  return uiNodes().find((n) => {
    const desc = n.desc.toLowerCase();
    return exact ? desc === lower : desc.includes(lower);
  });
}

/** All native text inputs, in visual order — for filling forms by position. */
function editFields() {
  return uiNodes().filter((n) => /EditText/i.test(n.cls));
}

/**
 * Poll the accessibility tree until `needle` appears.
 *
 * The one-shot `findByText` read races the UI: the screenshot can be captured
 * before the screen has laid out, which turns a working app into a failing
 * check. Prefer this for anything asserted after a navigation.
 */
async function waitForOptional(needle, timeoutMs = 15000, opts) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const node = findByText(needle, opts);
      if (node) return node;
      lastError = null;
    } catch (err) {
      // Keep polling: a transient dump failure is not evidence of absence.
      lastError = err;
    }
    if (Date.now() >= deadline) {
      if (lastError) throw lastError;
      return null;
    }
    await sleep(400);
  }
}

/**
 * Tap a control by accessibility label.
 *
 * `exact` matters for the bottom tabs: the "Test" tab and the "Test Connection"
 * button both contain the substring "test", and a loose match taps the wrong one.
 */
async function tapControl(label, { timeoutMs = 15000, exact = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const node = findByDesc(label, { exact });
    if (node) {
      adb('shell', 'input', 'tap', String(node.x), String(node.y));
      await sleep(900);
      return node;
    }
    await sleep(400);
  }
  throw new Error(`Timed out waiting for control "${label}"${exact ? ' (exact)' : ''}`);
}

/** Tap a control, returning null instead of throwing when it is absent. */
async function tryTapControl(label, opts = {}) {
  try {
    return await tapControl(label, { timeoutMs: 8000, ...opts });
  } catch {
    return null;
  }
}

/** Replace the contents of a native text field. */
async function fillField(index, value) {
  const fields = editFields();
  const field = fields[index];
  if (!field) return false;
  adb('shell', 'input', 'tap', String(field.x), String(field.y));
  await sleep(500);
  // Select-all then overwrite, so a prefilled default does not get appended to.
  adb('shell', 'input', 'keyevent', 'KEYCODE_MOVE_END');
  for (let i = 0; i < 80; i += 1) adb('shell', 'input', 'keyevent', 'KEYCODE_DEL');
  adb('shell', 'input', 'text', value);
  await sleep(500);
  adb('shell', 'input', 'keyevent', '111'); // ESC closes the soft keyboard
  await sleep(600);
  return true;
}


/** Swipe up to reveal content below the fold (uiautomator only reports visible nodes). */
async function scrollDown(times = 1) {
  for (let i = 0; i < times; i += 1) {
    adb('shell', 'input', 'swipe', '540', '1700', '540', '700', '220');
    await sleep(900);
  }
}

/**
 * Pop routes until the bottom tab bar is on screen.
 *
 * The run/result screens are pushed above the tab shell, and the category and
 * config screens may also be on the stack, so a single Back is not reliable.
 * The tab bar is detected by the presence of the Profile tab control.
 */
async function returnToTabs(maxPresses = 6) {
  for (let i = 0; i < maxPresses; i += 1) {
    if (findByDesc('Profile', { exact: true })) return true;
    adb('shell', 'input', 'keyevent', '4');
    await sleep(1200);
  }
  return !!findByDesc('Profile', { exact: true });
}

/**
 * Pop back to the sign-in screen (used after visiting the request-access form).
 *
 * Detected by the *Sign in button's accessibility label*, not by the text
 * "sign in" — the register screen also contains "Already approved? Sign in",
 * which would match and report success while still on the wrong screen.
 */
async function returnToLogin(maxPresses = 4) {
  for (let i = 0; i < maxPresses; i += 1) {
    if (findByDesc('Sign in', { exact: true })) return true;
    adb('shell', 'input', 'keyevent', '4');
    await sleep(1000);
  }
  return !!findByDesc('Sign in', { exact: true });
}

/**
 * Scroll until a control appears, then return it.
 *
 * uiautomator only reports what is currently on screen, so anything below the
 * fold is invisible to the driver. Fixed scroll counts break whenever a screen
 * grows, so search after each swipe instead.
 */
async function scrollToControl(desc, { maxScrolls = 6, exact = false } = {}) {
  for (let i = 0; i <= maxScrolls; i += 1) {
    const node = findByDesc(desc, { exact });
    if (node) return node;
    await scrollDown(1);
    await sleep(700);
  }
  return null;
}

/** Swipe down to return to the top of a screen. */
async function scrollUp(times = 1) {
  for (let i = 0; i < times; i += 1) {
    adb('shell', 'input', 'swipe', '540', '700', '540', '1700', '220');
    await sleep(900);
  }
}

/** Concatenate every visible text/desc on screen for assertion. */
function screenText() {
  return uiNodes().map((n) => `${n.text} ${n.desc}`).join(' ');
}

let currentStep = 'startup';

function step_(name) {
  currentStep = name;
  console.log(`  \u001b[2m… ${name}\u001b[0m`);
}

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '\u001b[32m✔\u001b[0m' : '\u001b[31m✖\u001b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ------------------------------------------------------------------ *
 * Flow
 * ------------------------------------------------------------------ */

async function main() {
  console.log('\n\u001b[1m── Android app E2E ──\u001b[0m');
  step_('app launch');

  // Fresh install state so the splash and login are genuinely exercised.
  adb('shell', 'pm', 'clear', PKG);
  await sleep(1500);

  /* ---- splash ---- */
  step_('splash');
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
  await sleep(400);
  shot('splash');
  const splashProcess = adb('shell', 'pidof', PKG).trim();
  check('app launches', splashProcess.length > 0, `pid ${splashProcess}`);

  await sleep(6000);
  shot('login');

  /* ---- login ---- */
  step_('login');
  const loginVisible = await waitForOptional('sign in', 10000);
  check('login screen renders', !!loginVisible);

  /* ---- Access request screen (the golden gate) ---- */
  step_('access request screen');
  // Located by accessibility label, not the visible copy.
  const requestLink = await tryTapControl('Request access', { timeoutMs: 6000 });
  if (requestLink) {
    await sleep(2000);
    shot('register');
    const reg = screenText();
    check('access request screen opens', /request access/i.test(reg));
    check(
      'it explains that approval is required',
      /administrator|approve/i.test(reg),
    );
    const regFields = editFields();
    check('request form collects name, email and password', regFields.length >= 3, `${regFields.length} inputs`);
    await returnToLogin();
    await sleep(1200);
  } else {
    check('access request link present on login', false);
  }

  // Fields are addressed by native EditText order (0 = email, 1 = password)
  // because RN does not expose each input's floating label as a separate node.
  // The email is deliberately NOT prefilled in the app — shipping a default
  // operator address would be a small information leak — so the driver types
  // both.
  const fields = editFields();
  check('login form exposes two inputs', fields.length >= 2, `${fields.length} EditText nodes`);
  if (fields.length >= 2) {
    await fillField(0, SEED_EMAIL);
    await fillField(1, SEED_PASSWORD);
  }

  await tapControl('Sign in', { exact: true });
  await sleep(7000);
  shot('after-login');

  const signedIn =
    (await waitForOptional('security tests', 12000)) ?? (await waitForOptional('validate connection', 4000));
  check('authenticates against the API', !!signedIn);
  if (!signedIn) {
    const err = (await waitForOptional('fetch failed', 1500)) ?? findByText('invalid');
    check('no auth error shown', !err, err ? 'error banner present' : '');
    finish();
    return;
  }

  /* ---- Test tab: catalog ---- */
  step_('catalog');
  await tapControl('Test', { exact: true });
  await sleep(2500);
  shot('test-catalog');

  const catalog = uiNodes();
  const hasCategories = ['DoS Protection', 'Web Protection', 'Bot Management', 'API Protection'].every(
    (label) => catalog.some((n) => `${n.text} ${n.desc}`.includes(label)),
  );
  check('all four categories render', hasCategories);

  const runAll = catalog.some((n) => `${n.text} ${n.desc}`.toLowerCase().includes('run all'));
  check('Run All Tests action is present', runAll);
  shot('run-all-visible');

  /* ---- Config screen (schema-driven) ---- */
  step_('config screen');
  await tapControl('dos protection');
  await sleep(2000);
  shot('select-test-type');
  const types = uiNodes();
  check(
    'DoS category lists its tests',
    types.some((n) => `${n.text} ${n.desc}`.includes('HTTP Spike')) &&
      types.some((n) => `${n.text} ${n.desc}`.includes('Connection Flood')),
  );

  await tapControl('http spike');
  await sleep(2500);
  shot('config-http-spike');

  const config = uiNodes();
  const configBlob = config.map((n) => `${n.text} ${n.desc}`).join(' ');
  check('config renders the target field', /primary target|target domain/i.test(configBlob));
  check('config renders HTTP method + path', /http method/i.test(configBlob) && /request path/i.test(configBlob));
  await scrollDown(2);
  shot('config-scrolled');
  check('config renders numeric params with hints', /burst requests/i.test(screenText()));
  await scrollUp(2);
  check('domain validation banner is shown when empty', /domain cannot be empty/i.test(configBlob));

  /* ---- Defaults overlay ---- */
  step_('defaults overlay');
  await tryTapControl('defaults');
  await sleep(1200);
  shot('config-defaults');
  const withDefaults = uiNodes().map((n) => `${n.text} ${n.desc}`).join(' ');
  check('defaults panel exposes shipped values', /catalog defaults/i.test(withDefaults));
  await tryTapControl('defaults');
  await sleep(800);

  /* ---- Fill a target and add to cart ---- */
  step_('add to cart');
  // Field 0 on this screen is the target domain input.
  const filled = await fillField(0, SCAN_TARGET);
  check('target field accepts input', filled);
  shot('config-filled');

  await tapControl('add to cart');
  await sleep(2500);
  shot('after-add-to-cart');

  /* ---- Cart ---- */
  step_('cart');
  const openedCart = await tryTapControl('Cart', { exact: false });
  await sleep(2000);
  shot('cart');

  const cart = uiNodes().map((n) => `${n.text} ${n.desc}`).join(' ');
  check('cart reachable from the catalog', !!openedCart);
  check('cart lists the queued test', /http spike/i.test(cart), '');
  check('cart shows the target', cart.includes('127.0.0.1') || cart.includes('9900'));
  check('cart shows credit cost', /credit/i.test(cart));

  // Opsec: what the target sees must be a deliberate, visible choice.
  check(
    'cart exposes the request-identity control',
    /what the target sees/i.test(cart),
  );
  check(
    'identity offers neutral / browser / identify',
    /neutral/i.test(cart) && /browser/i.test(cart) && /identify/i.test(cart),
  );

  // Switching to Browser must be reflected in the UI.
  await tryTapControl('Identity: Browser');
  await sleep(900);
  shot('identity-browser');
  check('identity mode is selectable', /rotated per request/i.test(screenText()));
  await tryTapControl('Identity: Neutral');
  await sleep(700);

  /* ---- Launch the run ---- */
  step_('launch run');
  const confirmBtn = await tryTapControl('confirm');
  if (confirmBtn) {
    await sleep(3000);
    shot('run-progress');

    const progress = uiNodes().map((n) => `${n.text} ${n.desc}`).join(' ');
    check('live run screen renders progress', /probes|running|%/i.test(progress));

    // Wait for the run to settle.
    for (let i = 0; i < 40; i += 1) {
      await sleep(1500);
      const now = uiNodes().map((n) => `${n.text} ${n.desc}`).join(' ');
      if (/run complete|view results|failed/i.test(now)) break;
    }
    shot('run-complete');

    const done = uiNodes().map((n) => `${n.text} ${n.desc}`).join(' ');
    check('run reaches a terminal state', /run complete|view results|failed/i.test(done));
    check('run produced no transport errors', !/errors\s*\n?\s*(1[0-9]|[2-9][0-9])/i.test(done));
  } else {
    check('confirm & start button present', false);
  }

  /* ---- Results ---- */
  step_('results');
  const viewResults = await tryTapControl('View results', { timeoutMs: 25000 });
  if (viewResults) {
    await sleep(3000);
    shot('results');

    const res = screenText();
    check('results screen shows a summary', /probes|blocked|bypassed/i.test(res));
    check('results screen explains what happened in plain language', /what happened/i.test(res));
    check('results screen shows iteration breakdown', /iterations/i.test(res));

    // Removed by request: credits and max severity should not clutter results.
    check('results no longer show a credits row', !/^credits$/im.test(res));
    check('results no longer show max severity', !/max severity/i.test(res));

    check('results screen exposes per-request tab', /requests/i.test(res));

    const requestsTab = await scrollToControl('Requests (');
    check('request log tab is reachable', !!requestsTab);
    if (requestsTab) {
      adb('shell', 'input', 'tap', String(requestsTab.x), String(requestsTab.y));
      await sleep(1500);
    }
    await sleep(1500);

    // The probe list is below the tab bar; scroll it into view before asserting.
    const firstTrace = await scrollToControl('Probe 1');
    check('probe rows are reachable by accessibility label', !!firstTrace);
    shot('results-probe-list');

    const traces = screenText();
    check('per-request telemetry renders', /HTTP \d{3}/i.test(traces));

    if (firstTrace) {
      adb('shell', 'input', 'tap', String(firstTrace.x), String(firstTrace.y));
      await sleep(1400);
    }

    // The expanded detail is long; walk it and assert on what we see at each
    // step rather than requiring the whole block to fit on one screen.
    const detail = { url: false, remote: false, headers: false, status: false };
    for (let i = 0; i < 8; i += 1) {
      const text = screenText();
      if (/request url/i.test(text)) detail.url = true;
      if (/remote address/i.test(text)) detail.remote = true;
      if (/response headers/i.test(text)) detail.headers = true;
      // The Iterations card says 'STATUS CODES SEEN'; require the singular
      // overview label so that cannot satisfy this check.
      if (/status code(?!s)/i.test(text)) detail.status = true;
      if (detail.url && detail.remote && detail.headers && detail.status) break;
      await scrollDown(1);
      await sleep(700);
    }
    shot('trace-detail');
    check('trace detail shows the request URL', detail.url);
    check('trace detail shows the remote address', detail.remote);
    check('trace detail lists response headers', detail.headers);
    check('trace detail shows the status code', detail.status);
  }

  /* ---- Back to the tab shell (Results is a full-screen route) ---- */
  step_('return to tabs');
  const backOnTabs = await returnToTabs();
  check('can navigate back to the tab shell', backOnTabs);
  await sleep(1000);

  /* ---- History ---- */
  step_('history');
  await tryTapControl('History', { exact: true });
  await sleep(3000);
  shot('history');
  const history = screenText();
  check(
    'history lists the completed run',
    /history/i.test(history) && /127\.0\.0\.1|9900/i.test(history),
  );

  // Expand the run and check the observability detail.
  const runRow = await tryTapControl('127.0.0.1', { timeoutMs: 6000 });
  if (runRow) {
    await sleep(2500);
    shot('history-expanded');
    const expanded = screenText();
    check('history shows the platform path', /PATH/i.test(expanded) && /EdgeOne/i.test(expanded));
    check('history explains the outcome in a sentence', /OUTCOME/i.test(expanded));
    check('history shows iteration detail', /iterations/i.test(expanded));
  } else {
    check('history run card is expandable', false);
  }

  /* ---- Profile ---- */
  step_('profile');
  await tryTapControl('Profile', { exact: true });
  await sleep(2500);
  shot('profile');
  const profile = screenText();
  // The signed-in address is read from the environment, not hardcoded: an
  // operator's personal email does not belong in a checked-in assertion, and a
  // different seed account would otherwise fail a test that is actually passing.
  check(
    'profile shows the account',
    /profile/i.test(profile) &&
      profile.toLowerCase().includes(SEED_EMAIL.trim().toLowerCase()),
    `expected "${SEED_EMAIL}" on screen`,
  );
  check(
    'profile exposes credits / privacy / help',
    /user credits/i.test(profile) && /privacy/i.test(profile) && /help/i.test(profile),
  );
  check('language toggle present', /EN/.test(profile) && /中文/.test(profile));

  /* ---- Server connection screen (team onboarding) ---- */
  step_('server settings');
  // Profile grows as features are added; scroll so the server section is
  // actually on screen before looking for its control.
  await scrollDown(2);
  await tryTapControl('Change server');
  await sleep(2000);
  shot('connect');
  const connect = screenText();
  check('server connection screen opens', /connect to a server/i.test(connect));
  check(
    'connect screen explains team setup',
    /team|address/i.test(connect) && /8787/.test(connect),
  );
  await returnToTabs();
  await sleep(800);

  /* ---- Search tab ---- */
  step_('search tab');
  await tryTapControl('Search', { exact: true });
  await sleep(2500);
  shot('search');

  await fillField(0, SCAN_TARGET);
  await tapControl('Test Connection', { exact: true });
  await sleep(6000);
  shot('search-result');
  const search = uiNodes().map((n) => `${n.text} ${n.desc}`).join(' ');
  check('connection validation returns a result', /reachable|unreachable/i.test(search));

  /* ---- No crashes anywhere ---- */
  step_('crash sweep');
  const logs = adb('logcat', '-d', '-t', '600');
  const fatal = logs.split('\n').filter((l) => /FATAL EXCEPTION/.test(l));
  check('no fatal exceptions during the flow', fatal.length === 0, fatal[0]?.slice(0, 120) ?? '');

  finish();
}

function finish() {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n  ${passed}/${results.length} checks passed`);
  writeFileSync(join(SHOTS, 'e2e-report.json'), JSON.stringify({ results, passed, failed }, null, 2));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nE2E driver error while "${currentStep}":`, err.message);
  try {
    shot('failure');
  } catch {
    /* ignore */
  }
  finish();
});
