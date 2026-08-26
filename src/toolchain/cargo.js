// Running cargo, and finding what it produced.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { CARGO_HOME, CARGO_TARGET_DIR, VENDOR_DIR } = require('./rust-toolchain');

/**
 * The environment every cargo invocation gets.
 *
 * All three relocations matter, and they are not interchangeable. CARGO_HOME
 * caches *downloads* -- the registry index and .crate files. CARGO_TARGET_DIR
 * caches *compiled artifacts*, and is the one that saves the expensive part:
 * without it every deploy recompiles napi, syn, quote and proc-macro2 from
 * source. Doing only one of them will mean doing the wrong one.
 *
 * Both must live under node_modules, because that is the only directory
 * Render's build cache preserves.
 */
function cargoEnv(root) {
  const bin = path.join(root, VENDOR_DIR, 'bin');
  return {
    ...process.env,
    CARGO_HOME: path.join(root, CARGO_HOME),
    CARGO_TARGET_DIR: path.join(root, CARGO_TARGET_DIR),
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  };
}

/**
 * Builds the crate and returns the path to its cdylib.
 *
 * The artifact path is read out of cargo's own JSON rather than guessed at
 * `target/release/lib<name>.so`. That guess is wrong under a relocated target
 * directory, a custom profile, or an explicit --target, all three of which this
 * package does routinely.
 */
function build({
  root,
  cargo,
  crate = '.',
  profile = 'release',
  features = [],
  target = null,
  flags = [],
  log = () => {},
}) {
  const args = [
    'build',
    '--message-format=json-render-diagnostics',
    ...(profile === 'release' ? ['--release'] : profile === 'debug' ? [] : ['--profile', profile]),
    ...(features.length ? ['--features', features.join(',')] : []),
    ...(target ? ['--target', target] : []),
    ...flags,
  ];

  const started = Date.now();
  const result = spawnSync(cargo, args, {
    cwd: path.resolve(root, crate),
    env: cargoEnv(root),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // stdout is the JSON stream; diagnostics are rendered inside it and are
    // re-printed below, so stderr passes straight through for cargo's own
    // progress lines.
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  if (result.error) throw result.error;

  const artifacts = [];
  for (const line of (result.stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.reason === 'compiler-message' && message.message?.rendered) {
      process.stderr.write(message.message.rendered);
    }
    if (
      message.reason === 'compiler-artifact' &&
      (message.target?.kind ?? []).includes('cdylib')
    ) {
      artifacts.push(...(message.filenames ?? []));
    }
  }

  if (result.status !== 0) {
    throw new Error(`cargo build failed (exit ${result.status})`);
  }

  const lib = artifacts.filter((f) => /\.(so|dylib|dll)$/.test(f)).pop();
  if (!lib) {
    throw new Error(
      'cargo produced no cdylib.\n' +
        '  Add this to Cargo.toml:\n\n    [lib]\n    crate-type = ["cdylib"]\n\n' +
        '  Without it cargo builds an rlib, which Node cannot load.',
    );
  }

  log(`cargo build ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return lib;
}

module.exports = { cargoEnv, build };
