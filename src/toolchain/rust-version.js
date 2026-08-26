// What Rust version was asked for -- not where it is.
//
// The split from rust-toolchain.js is deliberate, and is the one piece of
// design carried over wholesale from render-dart. There the two were one
// concern once, which is how a version pin came to be consulted only on the
// download path: it worked on a first build and was silently ignored
// everywhere else, for three releases, because nothing could tell "the user
// asked for this" from "this is the default".

const CHANNELS = ['stable', 'beta', 'nightly'];

// An exact version rather than `stable`, so an unpinned build is reproducible
// and needs no network to work out what it wants. The cost is that this line
// is bumped by hand; `render-rust rust --list` makes the drift visible.
const DEFAULT_RUST_VERSION = '1.98.0';

const DIST = 'https://static.rust-lang.org/dist';

/**
 * Resolves what the caller asked for, highest precedence first.
 *
 * `explicit` carries the whole design: a version someone typed must beat a
 * toolchain already on PATH, and the built-in default must not -- it exists so
 * a first build has something to fetch, not to override a Rust installed on
 * purpose. Do not collapse the two by defaulting `rustVersion` in config():
 * then nothing downstream can tell "unset" from "set to the default".
 */
function requestedVersion({ flag, env, config } = {}) {
  if (flag) return { version: flag, explicit: true, from: '--rust-version' };
  if (env) return { version: env, explicit: true, from: 'RENDER_RUST_VERSION' };
  if (config) return { version: config, explicit: true, from: 'package.json' };
  return { version: DEFAULT_RUST_VERSION, explicit: false, from: 'default' };
}

/** Is this a channel name rather than an exact version? */
function isAlias(version) {
  return CHANNELS.includes(version) || version === 'latest';
}

/**
 * Turns `stable` / `latest` / `beta` / `nightly` into an exact version.
 *
 * An exact version resolves to itself and touches nothing, which is the
 * practical argument for pinning: a pinned project keeps building when the
 * archive is unreachable.
 */
async function resolveVersion(version, { log = () => {} } = {}) {
  if (!isAlias(version)) return version;
  const channel = version === 'latest' ? 'stable' : version;

  const res = await fetch(`${DIST}/channel-rust-${channel}.toml`);
  if (!res.ok) {
    throw new Error(`could not resolve Rust ${channel}: HTTP ${res.status}`);
  }
  const resolved = versionFromChannel(await res.text());
  if (!resolved) throw new Error(`could not find a version in the ${channel} channel`);
  log(`Rust ${channel} resolves to ${resolved}`);
  return resolved;
}

/**
 * Pulls the rustc version out of a channel manifest.
 *
 * The first `version =` in that file is **cargo's** -- historically 0.99.x --
 * so taking the first match asks the archive for `rust-0.99.0`, gets a 404
 * page, and then fails a checksum for a reason that reads like corruption.
 * Seek the [pkg.rust] section.
 */
function versionFromChannel(toml) {
  let inRust = false;
  for (const line of toml.split('\n')) {
    if (line.startsWith('[pkg.')) inRust = line.trim() === '[pkg.rust]';
    if (!inRust) continue;
    const match = /^version = "([^ "]+)/.exec(line);
    if (match) return match[1];
  }
  return null;
}

/**
 * Released versions, newest first.
 *
 * Rust publishes no directory listing -- there is no equivalent of the Dart
 * archive's bucket API -- so this reads git tags, which are the release record.
 * Unauthenticated GitHub is rate limited; a failure here is reported rather
 * than retried, because listing is a convenience and never blocks a build.
 */
async function listVersions({ limit = 100 } = {}) {
  const res = await fetch(
    `https://api.github.com/repos/rust-lang/rust/tags?per_page=${Math.min(limit, 100)}`,
    { headers: { accept: 'application/vnd.github+json' } },
  );
  if (!res.ok) {
    throw new Error(
      res.status === 403
        ? 'GitHub rate limit reached; listing is unauthenticated. Try again later.'
        : `could not list Rust releases: HTTP ${res.status}`,
    );
  }
  return (await res.json())
    .map((t) => t.name)
    .filter((n) => /^\d+\.\d+(\.\d+)?$/.test(n))
    .sort(compareVersions)
    .reverse();
}

/** Numeric where numeric, so 1.9.0 sorts below 1.10.0. */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

module.exports = {
  CHANNELS,
  DEFAULT_RUST_VERSION,
  DIST,
  requestedVersion,
  isAlias,
  resolveVersion,
  versionFromChannel,
  listVersions,
  compareVersions,
};
