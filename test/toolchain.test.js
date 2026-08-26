const assert = require('node:assert');
const { chmodSync, mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  VENDOR_DIR,
  CARGO_HOME,
  CARGO_TARGET_DIR,
  archiveUrl,
  versionOf,
  vendoredVersion,
  resolveCargo,
} = require('../src/toolchain/rust-toolchain');
const { cargoEnv } = require('../src/toolchain/cargo');

/**
 * A toolchain that is not a toolchain.
 *
 * A shell script that answers `--version` is enough to drive every branch of
 * resolveCargo, so the vendored, pinned and mismatched paths are all covered
 * without downloading 365 MB.
 */
function fakeToolchain(root, version) {
  const bin = path.join(root, VENDOR_DIR, 'bin');
  mkdirSync(bin, { recursive: true });
  const cargo = path.join(bin, 'cargo');
  writeFileSync(cargo, `#!/bin/sh\necho "cargo ${version} (fake)"\n`);
  chmodSync(cargo, 0o755);
  writeFileSync(path.join(root, VENDOR_DIR, 'VERSION'), `${version}\n`);
  return cargo;
}

const project = () => mkdtempSync(path.join(os.tmpdir(), 'render-rust-'));

test('everything cacheable lives under node_modules', () => {
  // Render's build cache preserves node_modules and nothing else. Measured on
  // a real deploy: 25s cold, 1s warm -- entirely because of this.
  for (const dir of [VENDOR_DIR, CARGO_HOME, CARGO_TARGET_DIR]) {
    assert.ok(dir.startsWith('node_modules'), `${dir} is outside node_modules`);
    assert.ok(path.basename(dir).startsWith('.'), `${dir} is not dot-prefixed`);
  }
});

test('the archive URL names a real-looking tarball', () => {
  assert.match(
    archiveUrl('1.98.0', 'x86_64-unknown-linux-gnu'),
    /^https:\/\/static\.rust-lang\.org\/dist\/rust-1\.98\.0-x86_64-unknown-linux-gnu\.tar\.gz$/,
  );
});

test('versionOf parses cargo --version', () => {
  const root = project();
  const cargo = fakeToolchain(root, '1.98.0');
  assert.strictEqual(versionOf(cargo), '1.98.0');
});

test('versionOf returns null rather than throwing on a missing binary', () => {
  assert.strictEqual(versionOf('/nonexistent/cargo'), null);
});

test('a vendored toolchain is reused', async () => {
  const root = project();
  fakeToolchain(root, '1.98.0');
  assert.strictEqual(await vendoredVersion(root), '1.98.0');

  const found = await resolveCargo({ root, version: '1.98.0', explicit: true });
  assert.strictEqual(found.source, 'vendored');
  assert.strictEqual(found.version, '1.98.0');
});

test('changing an explicit pin invalidates the vendored toolchain', async () => {
  const root = project();
  fakeToolchain(root, '1.98.0');

  // Explicit and different: the vendored copy must not be reused. Without the
  // VERSION sidecar the cache key would be "does the directory exist", and a
  // changed pin would do nothing on any machine that had already built -- which
  // is every Render build after the first.
  const found = await resolveCargo({
    root,
    version: '1.90.0',
    explicit: true,
    fetch: false,
  });
  assert.notStrictEqual(found.source, 'vendored');
});

test('a non-explicit default still reuses whatever is vendored', async () => {
  const root = project();
  fakeToolchain(root, '1.90.0');

  // The default exists to give a first build something to fetch, not to
  // override a toolchain that is already there.
  const found = await resolveCargo({
    root,
    version: '1.98.0',
    explicit: false,
    fetch: false,
  });
  assert.strictEqual(found.source, 'vendored');
  assert.strictEqual(found.version, '1.90.0');
});

test('fetch:false installs nothing', async () => {
  const root = project();
  // A version no machine will have on PATH, so this exercises the download
  // branch wherever it runs. Asking for the current stable would pass here and
  // fail on a build box, or the reverse.
  const found = await resolveCargo({
    root,
    version: '1.0.0',
    explicit: true,
    fetch: false,
  });
  // Asking which toolchain would be used must never download one. The sibling
  // package shipped exactly that bug: a query pulled 228 MB and unpacked 624 MB.
  assert.strictEqual(found.cargo, null);
  assert.strictEqual(found.source, 'would download');
});

test('cargo runs with both caches relocated into node_modules', () => {
  const root = project();
  const env = cargoEnv(root);
  // Not interchangeable: CARGO_HOME caches downloads, CARGO_TARGET_DIR caches
  // compiled artifacts. Only the second saves the expensive part.
  assert.ok(env.CARGO_HOME.startsWith(root));
  assert.ok(env.CARGO_HOME.includes('node_modules'));
  assert.ok(env.CARGO_TARGET_DIR.startsWith(root));
  assert.ok(env.CARGO_TARGET_DIR.includes('node_modules'));
  assert.notStrictEqual(env.CARGO_HOME, env.CARGO_TARGET_DIR);
});
