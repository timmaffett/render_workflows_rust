#!/usr/bin/env node
// render-workflows-rust -- write Render Workflows tasks in Rust.

const { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');

const {
  CHANNELS,
  DEFAULT_RUST_VERSION,
  requestedVersion,
  listVersions,
} = require('./toolchain/rust-version');
const { resolveCargo, hostTriple } = require('./toolchain/rust-toolchain');
const cargo = require('./toolchain/cargo');
const addon = require('./toolchain/addon');
const lint = require('./toolchain/lint');

const { version } = require('../package.json');

const log = (message) => console.log(`[render-workflows-rust] ${message}`);
const fail = (message) => {
  console.error(`[render-workflows-rust] ${message}`);
  process.exit(1);
};

/**
 * Settings from the `renderRust` block of package.json.
 *
 * `rustVersion` is deliberately NOT defaulted here. requestedVersion() has to
 * be able to tell "the user did not say" from "the user asked for the default",
 * because only the first should defer to a toolchain already on PATH.
 */
function config(root) {
  const file = path.join(root, 'package.json');
  let block = {};
  if (existsSync(file)) {
    try {
      block = JSON.parse(readFileSync(file, 'utf8')).renderRust ?? {};
    } catch (e) {
      fail(`package.json is not valid JSON: ${e.message}`);
    }
  }
  return {
    crate: block.crate ?? '.',
    out: block.out ?? 'build/tasks.node',
    profile: block.profile ?? 'release',
    features: block.features ?? [],
    target: block.target ?? null,
    cargoFlags: block.cargoFlags ?? [],
    rustVersion: block.rustVersion,
  };
}

/** `--name value` and `--name=value`. */
function flagValue(args, name) {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const at = args.indexOf(name);
  if (at !== -1 && args[at + 1] && !args[at + 1].startsWith('-')) return args[at + 1];
  return undefined;
}

async function build(root, { force = false, rustVersion } = {}) {
  const c = config(root);

  // Checked before anything is compiled, because two of these three produce a
  // build that succeeds and then misbehaves in production.
  const problems = lint.check({ root, crate: c.crate, profile: c.profile });
  const errors = problems.filter((p) => !p.warning);
  for (const p of problems) {
    const lead = p.warning ? 'warning' : 'error';
    console.error(`[render-workflows-rust] ${lead}: ${p.what}\n  ${p.why}\n  ${p.fix}\n`);
  }
  if (errors.length) fail(`${errors.length} problem(s) must be fixed before building.`);

  const asked = requestedVersion({
    flag: rustVersion,
    env: process.env.RENDER_RUST_VERSION,
    config: c.rustVersion,
  });
  log(`Rust ${asked.version} requested by ${asked.from === 'default' ? 'built-in default' : asked.from}`);

  const { cargo: cargoBin, version: using, source } = await resolveCargo({
    root,
    version: asked.version,
    explicit: asked.explicit,
    log,
  });
  if (!cargoBin) fail('no Rust toolchain available.');

  const key = addon.fingerprint({
    root,
    crate: c.crate,
    profile: c.profile,
    features: c.features,
    target: c.target,
  });

  if (!force && addon.cached(root, key)) {
    const out = addon.install(root, key, c.out);
    addon.writeGeneratedIgnore(root, c.out);
    log(`unchanged since the last build; reused ${path.relative(root, out)} (${addon.sizeKb(out)} KB)`);
    return;
  }

  const lib = cargo.build({
    root,
    cargo: cargoBin,
    crate: c.crate,
    profile: c.profile,
    features: c.features,
    target: c.target,
    flags: c.cargoFlags,
    log,
  });

  addon.store(root, key, lib);
  const out = addon.install(root, key, c.out);
  addon.writeGeneratedIgnore(root, c.out);
  log(`using Rust ${using ?? 'unknown'} (${source})`);
  log(`wrote ${path.relative(root, out)} (${addon.sizeKb(out)} KB)`);
}

async function dev(root, args) {
  await build(root, { rustVersion: flagValue(args, '--rust-version') });

  // Everything after `--` is the start command; without it, the default.
  const dashdash = args.indexOf('--');
  const command = dashdash === -1 ? ['node', 'index.js'] : args.slice(dashdash + 1);

  log(`starting local task server: render workflows dev -- ${command.join(' ')}`);
  const child = spawn('render', ['workflows', 'dev', '--', ...command], {
    cwd: root,
    stdio: 'inherit',
  });
  child.on('error', (e) => {
    if (e.code === 'ENOENT') {
      fail(
        'The Render CLI is not installed. Install it with `brew install render`, ' +
          'or see https://render.com/docs/cli',
      );
    }
    fail(e.message);
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

const EXAMPLES_DIR = path.join(__dirname, '..', 'examples');

/**
 * Templates are the examples, read from disk rather than listed here.
 *
 * A template that is not also a working, deployed example drifts from reality.
 */
function templates() {
  if (!existsSync(EXAMPLES_DIR)) return [];
  return readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function init(root, args) {
  const available = templates();
  const template = flagValue(args, '--template') ?? 'default';
  if (!available.includes(template)) {
    fail(`no template "${template}". Available: ${available.join(', ')}`);
  }

  const positional = args.filter(
    (a, i) => !a.startsWith('-') && args[i - 1] !== '--template',
  );
  const target = path.resolve(root, positional[0] ?? 'rust-workflow');
  if (existsSync(target)) fail(`${path.relative(root, target) || target} already exists.`);

  // An example is a working project; none of its artefacts belong in a
  // scaffold. Copying Cargo.lock would pin someone to whatever resolved here.
  const skip = new Set([
    'README.md',
    'node_modules',
    'build',
    'target',
    'Cargo.lock',
    'package-lock.json',
  ]);

  cpSync(path.join(EXAMPLES_DIR, template), target, {
    recursive: true,
    filter: (src) => !skip.has(path.basename(src)),
  });

  // An agent working in this project will never open node_modules, so anything
  // shipped inside the package is invisible to it. This is the only guidance
  // that reliably arrives.
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const from = path.join(__dirname, '..', 'runtime', file);
    if (existsSync(from)) cpSync(from, path.join(target, file));
  }

  // npm strips .gitignore from published packages, so it ships under a
  // different name and is restored here.
  const shipped = path.join(target, 'gitignore');
  if (existsSync(shipped)) renameSync(shipped, path.join(target, '.gitignore'));

  const pkgFile = path.join(target, 'package.json');
  if (existsSync(pkgFile)) {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    pkg.name = path.basename(target);
    // From this package's own version, never a literal. A hardcoded "^0.1.0"
    // in the sibling package meant every scaffold silently installed an old
    // release for three versions, because npm reads ^0.1.0 as <0.2.0.
    pkg.dependencies = { ...pkg.dependencies, 'render-workflows-rust': `^${version}` };
    writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  const name = path.basename(target);
  console.log(`
Created ${path.relative(root, target) || name} from the "${template}" template.

  cd ${path.relative(root, target) || name}
  npm install
  npx render-workflows-rust build
  npx render-workflows-rust dev

Deploy as a workflow service with:
  runtime        node
  build command  npm install && npm run build
  start command  npm start

Use npm install, never npm ci: the Rust toolchain is vendored into
node_modules, and npm ci deletes that directory before every build.
`);
}

async function rustInfo(root, args) {
  if (args.includes('--list')) {
    const limit = Number(flagValue(args, '--limit') ?? 20);
    let versions;
    try {
      versions = await listVersions({ limit: 100 });
    } catch (e) {
      fail(e.message);
    }
    console.log(`Rust releases (${versions.length} known):\n`);
    for (const v of versions.slice(0, limit)) console.log(`  ${v}`);
    if (versions.length > limit) {
      console.log(`\n  ... ${versions.length - limit} older, --limit N for more`);
    }
    console.log(
      `\nPin one with --rust-version, RENDER_RUST_VERSION, or\n` +
        `"renderRust": { "rustVersion": "..." } in package.json.\n` +
        `"latest" and the channel names ${CHANNELS.join(', ')} also work.`,
    );
    return;
  }

  const c = config(root);
  const asked = requestedVersion({
    flag: flagValue(args, '--rust-version'),
    env: process.env.RENDER_RUST_VERSION,
    config: c.rustVersion,
  });

  // fetch:false -- asking which toolchain would be used must never install a
  // 365 MB one. The sibling package shipped that bug and it is easy to repeat.
  const resolved = await resolveCargo({
    root,
    version: asked.version,
    explicit: asked.explicit,
    fetch: false,
    log: () => {},
  });

  const from = asked.from === 'default' ? 'built-in default' : asked.from;
  console.log(`requested: ${asked.version}  (${from})`);
  console.log(`resolved:  ${resolved.version ?? 'unknown'}  (${resolved.source})`);
  console.log(`default:   ${DEFAULT_RUST_VERSION}`);
  console.log(`target:    ${hostTriple()}`);
  console.log('\nrender-workflows-rust rust --list [--limit N]');
}

async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);
  const root = process.cwd();

  switch (command) {
    case 'build':
      await build(root, {
        force: args.includes('--force'),
        rustVersion: flagValue(args, '--rust-version'),
      });
      break;
    case 'dev':
      await dev(root, args);
      break;
    case 'init':
      init(root, args);
      break;
    case 'rust':
      await rustInfo(root, args);
      break;
    default:
      console.log(`render-workflows-rust ${version} — write Render Workflows tasks in Rust

Usage:
  render-workflows-rust build [--force] [--rust-version <v>]
                                Compile the crate to build/tasks.node
  render-workflows-rust dev [-- cmd...]   Build, then run the local task server
  render-workflows-rust init [dir] [--template <name>]
                                Scaffold a new Rust workflow project
  render-workflows-rust rust [--list] [--limit <n>]
                                Which Rust this project uses, or what exists

Rust version, highest precedence first:
  --rust-version <v>            also accepted by the dev command
  RENDER_RUST_VERSION=<v>
  "renderRust": { "rustVersion": "<v>" } in package.json
  A version may be exact, "latest", or a channel: ${CHANNELS.join(', ')}.
  An explicit one is used even if a different Rust is on PATH.

Configure via "renderRust" in package.json:
  crate, out, profile, features, target, cargoFlags, rustVersion, tasks, exclude
`);
      // Asking for help is not an error; an unknown command is.
      process.exit(command && !['--help', '-h', 'help'].includes(command) ? 1 : 0);
  }
}

main().catch((e) => fail(e.message));
