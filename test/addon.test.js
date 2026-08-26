const assert = require('node:assert');
const { mkdirSync, mkdtempSync, utimesSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { fingerprint } = require('../src/toolchain/addon');
const lint = require('../src/toolchain/lint');

function crate(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'render-rust-'));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(root, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

const MANIFEST = '[package]\nname = "x"\n\n[lib]\ncrate-type = ["cdylib"]\n';

test('the fingerprint follows content, not mtime', () => {
  const root = crate({ 'Cargo.toml': MANIFEST, 'src/lib.rs': 'fn a() {}' });
  const before = fingerprint({ root, profile: 'release' });

  // Every Render deploy is a fresh git checkout, which restamps every file. An
  // mtime-keyed cache can therefore never hit -- it would silently do nothing
  // while appearing to work.
  const old = new Date(Date.now() - 86_400_000);
  utimesSync(path.join(root, 'src/lib.rs'), old, old);

  assert.strictEqual(fingerprint({ root, profile: 'release' }), before);
});

test('the fingerprint changes when source changes', () => {
  const root = crate({ 'Cargo.toml': MANIFEST, 'src/lib.rs': 'fn a() {}' });
  const before = fingerprint({ root, profile: 'release' });
  writeFileSync(path.join(root, 'src/lib.rs'), 'fn b() {}');
  assert.notStrictEqual(fingerprint({ root, profile: 'release' }), before);
});

test('the fingerprint covers the build settings too', () => {
  const root = crate({ 'Cargo.toml': MANIFEST, 'src/lib.rs': 'fn a() {}' });
  const release = fingerprint({ root, profile: 'release' });
  assert.notStrictEqual(fingerprint({ root, profile: 'debug' }), release);
  assert.notStrictEqual(fingerprint({ root, profile: 'release', features: ['x'] }), release);
  assert.notStrictEqual(
    fingerprint({ root, profile: 'release', target: 'x86_64-unknown-linux-gnu' }),
    release,
  );
});

test('build output does not feed back into the fingerprint', () => {
  const root = crate({ 'Cargo.toml': MANIFEST, 'src/lib.rs': 'fn a() {}' });
  const before = fingerprint({ root, profile: 'release' });
  mkdirSync(path.join(root, 'target', 'release'), { recursive: true });
  mkdirSync(path.join(root, 'build'), { recursive: true });
  writeFileSync(path.join(root, 'target', 'release', 'libx.so'), 'binary');
  writeFileSync(path.join(root, 'build', 'tasks.node'), 'binary');
  assert.strictEqual(fingerprint({ root, profile: 'release' }), before);
});

test('a missing cdylib is an error, not a warning', () => {
  const root = crate({ 'Cargo.toml': '[package]\nname = "x"\n', 'src/lib.rs': '' });
  const problems = lint.check({ root, crate: '.' });
  const found = problems.find((p) => p.what.includes('cdylib'));
  assert.ok(found, 'missing cdylib was not reported');
  assert.ok(!found.warning, 'missing cdylib must block the build');
});

test('panic = "abort" is an error, because it defeats catch_unwind', () => {
  const root = crate({
    'Cargo.toml': `${MANIFEST}\n[profile.release]\npanic = "abort"\n`,
    'src/lib.rs': '',
  });
  const found = lint
    .check({ root, crate: '.', profile: 'release' })
    .find((p) => p.what.includes('abort'));
  assert.ok(found);
  assert.ok(!found.warning);
});

test('panic = "abort" in an inactive profile is left alone', () => {
  const root = crate({
    'Cargo.toml': `${MANIFEST}\n[profile.dev]\npanic = "abort"\n`,
    'src/lib.rs': '',
  });
  assert.ok(
    !lint.check({ root, crate: '.', profile: 'release' }).some((p) => p.what.includes('abort')),
  );
});

test('a bare #[napi] warns, but async and catch_unwind do not', () => {
  const root = crate({
    'Cargo.toml': MANIFEST,
    'src/lib.rs': `
use napi_derive::napi;

#[napi]
pub fn risky() -> i32 { 1 }

#[napi(catch_unwind)]
pub fn safe() -> i32 { 1 }

#[napi]
pub async fn also_fine() -> i32 { 1 }

#[napi(object)]
pub struct NotAFunction { pub a: i32 }
`,
  });
  const found = lint.check({ root, crate: '.' }).find((p) => p.what.includes('catch_unwind'));
  assert.ok(found, 'bare #[napi] was not reported');
  assert.ok(found.warning, 'it should warn, not block');
  assert.match(found.what, /^1 /, `expected exactly one, got: ${found.what}`);
});

test('a crate with no Cargo.toml says so plainly', () => {
  const root = crate({ 'src/lib.rs': '' });
  const problems = lint.check({ root, crate: '.' });
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0].what, /no Cargo\.toml/);
});
