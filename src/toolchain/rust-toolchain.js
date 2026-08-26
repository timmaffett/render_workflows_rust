// Where a Rust toolchain is: already vendored, on PATH, or downloaded.
//
// Deliberately free of Render specifics -- this is the piece worth extracting
// into a general Rust/Node bridge.

const { createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { mkdir, readFile, rm, writeFile, access } = require('node:fs/promises');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');

const { DIST, resolveVersion } = require('./rust-version');

// Inside node_modules because Render's build cache preserves that and nothing
// else. Measured on a real deploy: a 365 MB toolchain downloads in 2s and
// unpacks in 12s, so a cold build is 25s and a warm one is 1s -- but only
// because this directory survives. Put it at the project root instead and
// every deploy pays the full 25s again.
//
// Dot-prefixed so `npm install` leaves it alone. `npm ci` does NOT: it deletes
// node_modules wholesale, which silently makes every build cold with no error
// message. Never put `npm ci` in a Render build command for this package.
const VENDOR_DIR = path.join('node_modules', '.rust');

/** Where cargo keeps downloads and compiled artifacts, for the same reason. */
const CARGO_HOME = path.join('node_modules', '.cargo');
const CARGO_TARGET_DIR = path.join('node_modules', '.cargo-target');

/** The host's Rust target triple. */
function hostTriple() {
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  if (!arch) throw new Error(`unsupported architecture: ${process.arch}`);
  switch (process.platform) {
    case 'linux':
      return `${arch}-unknown-linux-gnu`;
    case 'darwin':
      return `${arch}-apple-darwin`;
    default:
      throw new Error(
        `unsupported platform: ${process.platform}. ` +
          'Render builds on linux/x64; local builds need a Rust already on PATH.',
      );
  }
}

function archiveUrl(version, triple = hostTriple()) {
  return `${DIST}/rust-${version}-${triple}.tar.gz`;
}

const exists = (p) => access(p).then(() => true, () => false);

/** `cargo --version` -> "1.98.0", or null if it cannot be read. */
function versionOf(cargoBin) {
  try {
    const out = execFileSync(cargoBin, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return /cargo (\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

function onPath(bin) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The version recorded beside a vendored toolchain.
 *
 * Without this the cache key is "does the directory exist", and changing the
 * pin does nothing on any machine that has already built once -- including
 * every Render build after the first. That was a real bug in the sibling
 * package; it is not a hypothetical.
 */
async function vendoredVersion(root) {
  try {
    return (await readFile(path.join(root, VENDOR_DIR, 'VERSION'), 'utf8')).trim();
  } catch {
    return null;
  }
}

/** The checksum the archive publishes beside a tarball. */
async function publishedChecksum(url) {
  const res = await fetch(`${url}.sha256`);
  if (!res.ok) return null;
  // "<hex>  rust-1.98.0-x86_64-unknown-linux-gnu.tar.gz"
  return (await res.text()).trim().split(/\s+/)[0] ?? null;
}

/**
 * Downloads, verifies and unpacks a toolchain into node_modules.
 *
 * The archive is hashed *while* it streams to disk rather than re-read
 * afterwards: on the sibling package that cost 0.18s of CPU for 228 MB against
 * roughly 30s to fetch it, so verification is effectively free.
 */
async function fetchToolchain({ root, version, triple = hostTriple(), log = () => {} }) {
  const url = archiveUrl(version, triple);
  const dir = path.join(root, VENDOR_DIR);
  const tmp = path.join(root, 'node_modules', `.rust-${version}.tar.gz`);

  await mkdir(path.dirname(tmp), { recursive: true });
  log(`downloading Rust ${version} (${triple})`);

  // Both at once: the checksum is tiny and there is no reason to wait for it.
  const [res, expected] = await Promise.all([fetch(url), publishedChecksum(url)]);
  if (!res.ok) {
    throw new Error(`could not download Rust ${version}: HTTP ${res.status} from ${url}`);
  }

  const hash = createHash('sha256');
  await pipeline(
    Readable.fromWeb(res.body),
    async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(tmp),
  );

  if (expected) {
    const actual = hash.digest('hex');
    if (actual !== expected) {
      await rm(tmp, { force: true });
      throw new Error(
        `checksum mismatch for Rust ${version}.\n` +
          `  expected ${expected}\n  actual   ${actual}\n` +
          'The archive was not unpacked. This is worth reporting: the toolchain ' +
          'is downloaded over the network and then executed.',
      );
    }
    log('checksum verified');
  } else {
    log(`no published checksum for Rust ${version}; nothing was verified`);
  }

  const unpackTo = path.join(root, 'node_modules', `.rust-unpack-${version}`);
  await rm(unpackTo, { recursive: true, force: true });
  await mkdir(unpackTo, { recursive: true });
  execFileSync('tar', ['-xzf', tmp, '-C', unpackTo, '--strip-components=1'], {
    stdio: 'inherit',
  });

  // Only what a build needs. The full archive carries documentation and
  // rust-src, which is most of its unpacked size and none of its use here.
  execFileSync(
    path.join(unpackTo, 'install.sh'),
    [
      `--prefix=${dir}`,
      `--components=rustc,cargo,rust-std-${triple}`,
      '--disable-ldconfig',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );

  await rm(tmp, { force: true });
  await rm(unpackTo, { recursive: true, force: true });
  await writeFile(path.join(dir, 'VERSION'), `${version}\n`);

  return path.join(dir, 'bin', 'cargo');
}

/**
 * Finds a cargo to build with.
 *
 * Precedence, and the `explicit` flag is what makes it correct:
 *   1. the vendored toolchain, if it is the right one (or nothing was asked for)
 *   2. cargo on PATH, under the same condition
 *   3. download
 *
 * `fetch: false` makes this a question rather than an action -- asking which
 * toolchain would be used must never install 365 MB.
 */
async function resolveCargo({
  root,
  version,
  explicit = false,
  fetch: mayFetch = true,
  log = () => {},
}) {
  const wanted = await resolveVersion(version, { log });

  const vendored = path.join(root, VENDOR_DIR, 'bin', 'cargo');
  if (await exists(vendored)) {
    const have = await vendoredVersion(root);
    if (!explicit || have === wanted) {
      log(`using Rust ${have ?? 'unknown'} (vendored)`);
      return { cargo: vendored, version: have, source: 'vendored' };
    }
    log(`vendored Rust is ${have ?? 'unknown'}, ${wanted} was asked for`);
  }

  if (onPath('cargo')) {
    const have = versionOf('cargo');
    if (!explicit || have === wanted) {
      log(`using Rust ${have ?? 'unknown'} from PATH`);
      return { cargo: 'cargo', version: have, source: 'path' };
    }
    log(`Rust on PATH is ${have ?? 'unknown'}, ${wanted} was asked for`);
  }

  if (!mayFetch) {
    return { cargo: null, version: wanted, source: 'would download' };
  }

  const cargo = await fetchToolchain({ root, version: wanted, log });
  log(`using Rust ${wanted} (downloaded)`);
  return { cargo, version: wanted, source: 'downloaded' };
}

module.exports = {
  VENDOR_DIR,
  CARGO_HOME,
  CARGO_TARGET_DIR,
  hostTriple,
  archiveUrl,
  versionOf,
  vendoredVersion,
  publishedChecksum,
  fetchToolchain,
  resolveCargo,
};
