const assert = require('node:assert');
const { execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const { mkdtemp, readdir, readFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');

const run = promisify(execFile);

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const EXAMPLES = path.join(__dirname, '..', 'examples');
const { version } = require('../package.json');

const scratch = () => mkdtemp(path.join(os.tmpdir(), 'render-rust-cli-'));

// cli.js calls main() on require, so it has to be driven as a subprocess --
// which is also the path a real `npx render-rust init` takes.

test('init pins the dependency to this package’s own version', async () => {
  const dir = await scratch();
  await run('node', [CLI, 'init', 'proj'], { cwd: dir });

  const pkg = JSON.parse(await readFile(path.join(dir, 'proj', 'package.json'), 'utf8'));
  // A hardcoded "^0.1.0" in the sibling package meant every scaffold silently
  // installed 0.1.1 for three releases, because npm reads ^0.1.0 as <0.2.0.
  assert.strictEqual(pkg.dependencies['render-rust'], `^${version}`);
});

test('init names the project after its directory', async () => {
  const dir = await scratch();
  await run('node', [CLI, 'init', 'my-tasks'], { cwd: dir });
  const pkg = JSON.parse(await readFile(path.join(dir, 'my-tasks', 'package.json'), 'utf8'));
  assert.strictEqual(pkg.name, 'my-tasks');
});

test('init restores .gitignore, which npm strips from published packages', async () => {
  const dir = await scratch();
  await run('node', [CLI, 'init', 'proj'], { cwd: dir });
  assert.ok(existsSync(path.join(dir, 'proj', '.gitignore')));
  assert.ok(!existsSync(path.join(dir, 'proj', 'gitignore')));
});

test('init writes agent guidance into the project', async () => {
  const dir = await scratch();
  await run('node', [CLI, 'init', 'proj'], { cwd: dir });

  // An agent working in a user's repository never opens node_modules, so this
  // is the only guidance certain to reach it.
  const agents = await readFile(path.join(dir, 'proj', 'AGENTS.md'), 'utf8');
  assert.match(agents, /catch_unwind/);
  assert.match(agents, /npm ci/);
  assert.ok(existsSync(path.join(dir, 'proj', 'CLAUDE.md')));
});

test('init carries no build output or lockfile', async () => {
  const dir = await scratch();
  await run('node', [CLI, 'init', 'proj'], { cwd: dir });
  const entries = await readdir(path.join(dir, 'proj'));
  for (const unwanted of ['build', 'target', 'node_modules', 'Cargo.lock']) {
    assert.ok(!entries.includes(unwanted), `scaffold contains ${unwanted}`);
  }
  assert.ok(entries.includes('Cargo.toml'));
  assert.ok(entries.includes('src'));
});

test('init refuses to overwrite an existing directory', async () => {
  const dir = await scratch();
  await run('node', [CLI, 'init', 'proj'], { cwd: dir });
  await assert.rejects(() => run('node', [CLI, 'init', 'proj'], { cwd: dir }));
});

test('every example is a usable template', async () => {
  // Templates are read from the examples directory rather than listed, so a
  // new example is a new template. This asserts the pair actually works.
  const names = (await readdir(EXAMPLES, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.ok(names.length > 0);

  for (const name of names) {
    const dir = await scratch();
    await run('node', [CLI, 'init', 'proj', '--template', name], { cwd: dir });
    const entries = await readdir(path.join(dir, 'proj'));
    assert.ok(entries.includes('Cargo.toml'), `${name} has no Cargo.toml`);
    assert.ok(entries.includes('index.js'), `${name} has no index.js`);
  }
});

test('an unknown template lists the real ones', async () => {
  const dir = await scratch();
  await assert.rejects(
    () => run('node', [CLI, 'init', 'proj', '--template', 'nope'], { cwd: dir }),
    (e) => /Available: .*default/.test(e.stderr),
  );
});

test('--help parses, exits 0, and states the version precedence', async () => {
  // The help text is one long template literal and nothing else in the suite
  // loads that branch. In the sibling package a stray backtick in it made every
  // command a SyntaxError while the whole suite still passed -- parsing this
  // file is most of the point of this test.
  const { stdout } = await run('node', [CLI, '--help']);

  for (const source of ['--rust-version', 'RENDER_RUST_VERSION', 'rustVersion']) {
    assert.ok(stdout.includes(source), `help omits ${source}`);
  }
  const at = stdout.indexOf('precedence');
  const order = ['--rust-version', 'RENDER_RUST_VERSION', 'package.json'].map((s) =>
    stdout.indexOf(s, at),
  );
  assert.ok(
    order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1])),
    'help lists the version sources out of precedence order',
  );
});

test('an unknown command exits 1, help exits 0', async () => {
  await assert.rejects(() => run('node', [CLI, 'bogus']));
  for (const ok of ['--help', '-h', 'help']) {
    await run('node', [CLI, ok]);
  }
});

test('the scaffold tells people not to use npm ci', async () => {
  const dir = await scratch();
  const { stdout } = await run('node', [CLI, 'init', 'proj'], { cwd: dir });
  // npm ci deletes node_modules, where the toolchain and every compiled
  // dependency live. It turns every build cold, with no error to explain it.
  assert.match(stdout, /npm ci/);
});
