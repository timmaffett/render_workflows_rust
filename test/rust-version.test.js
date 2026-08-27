const assert = require('node:assert');
const { test } = require('node:test');

const {
  CHANNELS,
  DEFAULT_RUST_VERSION,
  requestedVersion,
  isAlias,
  versionFromChannel,
  compareVersions,
} = require('../src/toolchain/rust-version');

// Everything here is offline. Resolving an alias and listing releases both need
// the network, and a suite that reaches it fails for reasons unrelated to the
// code -- so those are exercised through their pure parts instead.

test('precedence is flag, env, package.json, default', () => {
  const all = { flag: '1.90.0', env: '1.91.0', config: '1.92.0' };
  assert.strictEqual(requestedVersion(all).version, '1.90.0');
  assert.strictEqual(requestedVersion({ ...all, flag: undefined }).version, '1.91.0');
  assert.strictEqual(requestedVersion({ config: '1.92.0' }).version, '1.92.0');
  assert.strictEqual(requestedVersion({}).version, DEFAULT_RUST_VERSION);
});

test('each source names itself', () => {
  assert.strictEqual(requestedVersion({ flag: '1.90.0' }).from, '--rust-version');
  assert.strictEqual(requestedVersion({ env: '1.90.0' }).from, 'RENDER_RUST_VERSION');
  assert.strictEqual(requestedVersion({ config: '1.90.0' }).from, 'package.json');
  assert.strictEqual(requestedVersion({}).from, 'default');
});

test('the default is not explicit, and everything else is', () => {
  // The whole design rests on this. A version someone typed must beat a
  // toolchain on PATH; the built-in default must defer to it.
  assert.strictEqual(requestedVersion({}).explicit, false);
  for (const source of ['flag', 'env', 'config']) {
    assert.strictEqual(requestedVersion({ [source]: '1.90.0' }).explicit, true);
  }
});

test('channels and latest are aliases; exact versions are not', () => {
  for (const c of CHANNELS) assert.ok(isAlias(c));
  assert.ok(isAlias('latest'));
  assert.ok(!isAlias('1.98.0'));
  assert.ok(!isAlias(DEFAULT_RUST_VERSION));
});

test('the channel manifest yields rust’s version, not cargo’s', () => {
  // This is the trap the probe fell into on Render. cargo's version comes
  // FIRST in the file and is still 0.x, so taking the first `version =` asks
  // the archive for rust-0.99.0, gets a 404 page, and then fails a checksum in
  // a way that reads like corruption rather than a bad URL.
  const manifest = `
manifest-version = "2"
date = "2026-08-18"

[pkg.cargo]
version = "0.99.0 (797e8a9bc 2026-08-05)"

[pkg.rust]
version = "1.98.0 (88d9e12ae 2026-08-18)"

[pkg.rust-std]
version = "1.98.0 (88d9e12ae 2026-08-18)"
`;
  assert.strictEqual(versionFromChannel(manifest), '1.98.0');
});

test('a manifest with no rust package yields null rather than a wrong answer', () => {
  assert.strictEqual(versionFromChannel('[pkg.cargo]\nversion = "0.99.0"\n'), null);
});

test('versions sort numerically, so 1.9 is below 1.10', () => {
  const sorted = ['1.10.0', '1.9.0', '1.100.0', '1.98.0'].sort(compareVersions);
  assert.deepStrictEqual(sorted, ['1.9.0', '1.10.0', '1.98.0', '1.100.0']);
});

// --------------------------------------------------------------------------
// A version string is a security boundary, not a formatting preference. It
// reaches a URL, a download path, and an rm(recursive) target, and it can come
// from RENDER_RUST_VERSION or package.json rather than from the person running
// the build.
// --------------------------------------------------------------------------

const { assertSafeVersion, requestedVersionChecked } = require('../src/toolchain/rust-version');
const { archiveUrl } = require('../src/toolchain/rust-toolchain');
const path = require('node:path');

test('a traversing version is refused', () => {
  for (const bad of ['../../..', '../../../../tmp/x', '1.98.0/../../x', './x']) {
    assert.throws(() => assertSafeVersion(bad), /invalid Rust version/, `accepted ${bad}`);
  }
});

test('a version cannot smuggle anything into the archive URL', () => {
  for (const bad of ['1.98.0?x=', '1.98.0#f', 'latest; rm -rf /', '//evil.example/x', '']) {
    assert.throws(() => archiveUrl(bad, 'x86_64-unknown-linux-gnu'), /invalid Rust version/);
  }
});

test('the traversal that would have deleted the project is unreachable', () => {
  // Before the guard: path.join(root, 'node_modules', `.rust-unpack-${version}`)
  // with version '../../..' resolved to `root` itself, and the next statement
  // was rm(unpackTo, {recursive: true, force: true}).
  const root = '/tmp/project';
  const evil = path.join(root, 'node_modules', '.rust-unpack-../../..');
  assert.strictEqual(evil, root, 'the traversal no longer resolves as it did');
  assert.throws(() => assertSafeVersion('../../..'));
});

test('real versions and channels still pass', () => {
  for (const ok of ['1.98.0', '1.98', '0.1.0', 'stable', 'beta', 'nightly', 'latest']) {
    assert.strictEqual(assertSafeVersion(ok), ok);
  }
});

test('a bad value is caught when the request is read, not later', () => {
  assert.throws(() => requestedVersionChecked({ env: '../../..' }), /invalid Rust version/);
  assert.throws(() => requestedVersionChecked({ config: 'nightly-2026-01-01' }), /invalid Rust version/);
  assert.strictEqual(requestedVersionChecked({ flag: '1.98.0' }).version, '1.98.0');
});
