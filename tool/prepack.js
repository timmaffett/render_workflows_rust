#!/usr/bin/env node
// Refuses to publish if build output would actually reach the tarball.
//
// `files` in package.json allowlists `examples/`, and npm's usual exclusion of
// node_modules does NOT reach inside an allowlisted directory. So a build run
// in an example before publishing can be swept into the package.
//
// That is not hypothetical: 0.1.1 shipped at 111 MB across 1,953 files --
// against 0.1.0's 0.1 MB and 29 -- carrying the cargo registry, the target
// directory, and a compiled .node binary from a maintainer's laptop. A native
// executable nobody asked for is the part that matters; the size is just how it
// was noticed.
//
// It asks npm what it would pack rather than looking at the working tree. The
// first version of this checked the disk, and refused perfectly good publishes
// in the sibling package, where an examples/.npmignore already excluded
// everything it was complaining about. What matters is not whether an artifact
// exists -- it usually does, because the examples are working projects -- but
// whether one would ship.
//
// --ignore-scripts on the inner call, or this would invoke itself.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NAME = require('../package.json').name;

/** Build output, wherever it appears in the packed paths. */
const FORBIDDEN = [
  { test: (p) => /(^|\/)node_modules\//.test(p), why: 'installed dependencies' },
  { test: (p) => /(^|\/)(build|target)\//.test(p), why: 'build output' },
  { test: (p) => /\.(node|so|dylib|dll|rlib)$/.test(p), why: 'a compiled binary' },
];

let listing;
try {
  listing = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  console.error(`[${NAME}] could not determine what would be packed: ${e.message}`);
  process.exit(1);
}

let files;
try {
  files = (JSON.parse(listing)[0].files ?? []).map((f) => f.path);
} catch (e) {
  console.error(`[${NAME}] could not read npm's pack listing: ${e.message}`);
  process.exit(1);
}

const offenders = [];
for (const file of files) {
  const rule = FORBIDDEN.find((r) => r.test(file));
  if (rule) offenders.push({ file, why: rule.why });
}

if (offenders.length) {
  console.error(`\n[${NAME}] refusing to pack: ${offenders.length} file(s) that must not ship.\n`);
  for (const o of offenders.slice(0, 12)) console.error(`    ${o.file}   (${o.why})`);
  if (offenders.length > 12) console.error(`    ... and ${offenders.length - 12} more`);
  console.error(
    '\n  These would reach every user, including binaries built on this machine.\n' +
      '  0.1.1 went out at 111 MB this way.\n\n' +
      '  Either clean the tree, or add the path to examples/.npmignore if it is\n' +
      '  something that should never ship:\n\n' +
      '    find examples -maxdepth 2 \\( -name node_modules -o -name build \\\n' +
      '      -o -name target \\) -prune -exec rm -rf {} +\n',
  );
  process.exit(1);
}

console.error(`[${NAME}] prepack: ${files.length} files, no build output.`);
