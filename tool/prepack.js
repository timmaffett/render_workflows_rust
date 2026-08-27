#!/usr/bin/env node
// Refuses to publish a tree with build artifacts in it.
//
// `files` in package.json allowlists `examples/`, and npm's usual exclusion of
// node_modules does NOT reach inside an allowlisted directory. So a build run
// in an example before publishing is swept into the tarball.
//
// That is not hypothetical: 0.1.1 shipped at 111 MB across 1,953 files --
// against 0.1.0's 0.1 MB and 29 -- carrying the cargo registry, the target
// directory, and a compiled .node binary from a maintainer's laptop. A native
// executable nobody asked for is the part that matters; the size is just how it
// was noticed.
//
// Runs from `prepack`, so it fires on `npm publish` and `npm pack` alike.

const { existsSync, readdirSync, statSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EXAMPLES = path.join(ROOT, 'examples');

/** Directories that are build output wherever they appear. */
const FORBIDDEN_DIRS = new Set(['node_modules', 'build', 'target']);

/** Compiled output, in case it is somewhere unexpected. */
const FORBIDDEN_FILES = /\.(node|so|dylib|dll|rlib)$/;

const found = [];

function walk(dir, depth = 0) {
  if (depth > 4) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (FORBIDDEN_DIRS.has(entry.name)) {
        found.push(`${path.relative(ROOT, full)}/`);
        continue; // Do not descend; one line per offending tree is enough.
      }
      walk(full, depth + 1);
    } else if (FORBIDDEN_FILES.test(entry.name)) {
      found.push(path.relative(ROOT, full));
    }
  }
}

if (existsSync(EXAMPLES)) walk(EXAMPLES);

if (found.length) {
  console.error(
    `\n[render-workflows-rust] refusing to pack: ${found.length} build artifact(s) present.\n`,
  );
  for (const f of found.slice(0, 12)) console.error(`    ${f}`);
  if (found.length > 12) console.error(`    ... and ${found.length - 12} more`);
  console.error(
    '\n  These would ship to every user, including compiled binaries built on this\n' +
      '  machine. Version 0.1.1 went out at 111 MB this way.\n\n' +
      '  Clean them and pack again:\n\n' +
      "    find examples -maxdepth 2 \\( -name node_modules -o -name build -o -name target \\) \\\n" +
      '      -prune -exec rm -rf {} +\n',
  );
  process.exit(1);
}

// Silent on success: prepack output is noise in an otherwise clean publish.
