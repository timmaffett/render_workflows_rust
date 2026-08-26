// Build-time checks for mistakes that only show up in production.
//
// render-dart refuses to build on a `dart:io` import, because dart2js compiles
// it without complaint and then throws at runtime. Rust has three equivalents.
// All three build cleanly, and all three fail in a way that is hard to trace
// back here -- one of them by killing the task server rather than failing a run.

const { existsSync, readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

const SKIP_DIRS = new Set(['target', 'build', 'node_modules', '.git']);

/** Every .rs file under a crate. */
function rustFiles(dir, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) rustFiles(full, found);
    else if (entry.name.endsWith('.rs')) found.push(full);
  }
  return found;
}

/**
 * Checks a crate, returning a list of problems.
 *
 * Deliberately line-based rather than a TOML parser: this package has no
 * runtime dependencies, and the three things being looked for are all single
 * lines. The cost is that a genuinely exotic Cargo.toml could slip past, which
 * is the right trade for a guard that must never be the reason a build fails.
 */
function check({ root, crate = '.', profile = 'release' }) {
  const base = path.resolve(root, crate);
  const problems = [];

  const manifestPath = path.join(base, 'Cargo.toml');
  if (!existsSync(manifestPath)) {
    return [
      {
        what: 'no Cargo.toml',
        why: `Nothing to build at ${path.relative(root, base) || '.'}.`,
        fix: 'Set renderRust.crate to the directory holding Cargo.toml.',
      },
    ];
  }
  const manifest = readFileSync(manifestPath, 'utf8');

  // 1. Without cdylib, cargo builds an rlib, no .node is produced, and the
  //    failure surfaces as a confusing missing file.
  const libSection = /\[lib\]([\s\S]*?)(\n\[|$)/.exec(manifest);
  if (!libSection || !/crate-type\s*=\s*\[[^\]]*"cdylib"/.test(libSection[1])) {
    problems.push({
      what: 'Cargo.toml does not declare a cdylib',
      why: 'cargo will build an rlib, which Node cannot load.',
      fix: 'Add:\n\n    [lib]\n    crate-type = ["cdylib"]',
    });
  }

  // 2. panic = "abort" silently defeats #[napi(catch_unwind)]. A panicking
  //    task then kills the task server -- and with it every other run on that
  //    instance -- instead of failing one run with its message.
  const profileSection = new RegExp(`\\[profile\\.${profile}\\]([\\s\\S]*?)(\\n\\[|$)`).exec(manifest);
  if (profileSection && /^\s*panic\s*=\s*"abort"/m.test(profileSection[1])) {
    problems.push({
      what: `[profile.${profile}] sets panic = "abort"`,
      why:
        'catch_unwind cannot catch an aborting panic, so a panic takes down the ' +
        'task server and every concurrent run on that instance.',
      fix: `Remove panic = "abort" from [profile.${profile}].`,
    });
  }

  // 3. A #[napi] function with no catch_unwind has the same outcome as (2) if
  //    it ever panics -- including on an unwrap() or an array index.
  const bare = [];
  for (const file of rustFiles(path.join(base, 'src'))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('#[napi')) return;
      if (trimmed.includes('catch_unwind')) return;
      // An async fn returns a Result to JS and does not need it.
      const next = (lines[i + 1] ?? '') + (lines[i + 2] ?? '');
      if (/\basync\s+fn\b/.test(next)) return;
      if (!/\bfn\b/.test(next)) return; // #[napi] on a struct or impl block
      bare.push(`${path.relative(root, file)}:${i + 1}`);
    });
  }
  if (bare.length) {
    problems.push({
      what: `${bare.length} #[napi] function(s) without catch_unwind`,
      why:
        'A panic in one of these aborts the Node process rather than failing ' +
        'the task run, taking every concurrent run on the instance with it.',
      fix: `Write #[napi(catch_unwind)]. At:\n    ${bare.slice(0, 8).join('\n    ')}`,
      warning: true,
    });
  }

  return problems;
}

module.exports = { check, rustFiles };
