# Working on render-rust

The npm package that lets Rust tasks run on Render Workflows. Sibling to
[`render-dart`](https://github.com/timmaffett/render-dart), and a lot of the
design is carried over from it deliberately — where a comment here says "the
sibling package", that is a bug someone already paid for.

This file is for working **on** the package. `runtime/AGENTS.md` is a different
document: `init` copies it into a scaffolded project, and it is the only text an
agent working in a *user's* repository is certain to see, because agents do not
read `node_modules`.

## Orientation

| | |
| --- | --- |
| `src/cli.js` | `build`, `dev`, `init`, `rust`. No arg-parsing dependency |
| `src/runtime.js` | The Render contract: auto-start, registration, fan-out |
| `src/toolchain/rust-version.js` | *What* was asked for |
| `src/toolchain/rust-toolchain.js` | *Where* it is |
| `src/toolchain/cargo.js` | Running cargo, finding the artifact |
| `src/toolchain/addon.js` | The content-hash cache above cargo |
| `src/toolchain/lint.js` | Three mistakes that only appear in production |
| `examples/` | Working projects, `init` templates, and deployed services |

**No runtime dependencies, and keep it that way.** The package installs into
every user's project; a TOML parser to read three lines out of `Cargo.toml` is
not worth the supply chain.

## Rules that are not obvious

**`RENDER_SDK_AUTO_START = 'false'` must be set before `@renderinc/sdk` is
required**, which is why `runtime.js` exists at all rather than being inlined.
The SDK's `task()` schedules its own `startTaskServer()` via `setImmediate` the
moment it sees `RENDER_SDK_SOCKET_PATH`; combined with the explicit start, every
task body runs **twice** — doubled side effects, doubled billing.

**There is no `{$ok}`/`{$err}` envelope, and none is needed.** The Dart sibling
has one because a converted Dart exception reaches Render as the opaque *"Dart
exception thrown from converted Future…"*. `#[napi(catch_unwind)]` produces a
real JS `Error` carrying the panic message. Verified end to end on Render: a
task panicking with `deliberate panic from Rust` fails with exactly that string,
and the server answers the next call. Do not add an envelope.

**Arguments pass through as varargs.** The Dart runtime collapses them into one
array only because a dart2js closure has fixed arity. A `#[napi]` function has
real arity, so nothing needs collapsing.

**`rustVersion` is not defaulted in `config()`.** `requestedVersion()` has to
distinguish "unset" from "set to the default", because only the first should
defer to a toolchain on `PATH`. Defaulting it there quietly breaks the whole
precedence model.

**The toolchain records its version in `node_modules/.rust/VERSION`.** Without
that sidecar the cache key is directory existence, and changing a pin does
nothing on any machine that has built once — including every Render build after
the first. That was a real bug in the sibling package.

**`render-rust rust` passes `fetch: false`.** A question must not install
365 MB. The sibling shipped that bug; a test holds the line here.

**Both cargo caches must be relocated, and they are not interchangeable.**
`CARGO_HOME` caches downloads; `CARGO_TARGET_DIR` caches compiled artifacts.
Only the second saves the expensive part, and `node_modules` is the only
directory Render preserves.

**The addon cache is keyed on file contents, never mtime.** Every Render deploy
is a fresh git checkout that restamps every file, so an mtime cache can never
hit. This sits *above* cargo because cargo itself fingerprints local sources by
mtime — without it the crate relinks on every deploy, including one that touched
only `index.js`.

## The lint exists for a reason

Three mistakes compile cleanly and then misbehave. Two are refused outright,
one warns:

1. **No `crate-type = ["cdylib"]`** — cargo emits an rlib, no addon exists, and
   the error reads like a missing file.
2. **`panic = "abort"`** in the active profile — silently defeats
   `catch_unwind`, so a panic kills the task server and every concurrent run on
   the instance.
3. **A bare `#[napi]`** on a sync function — same outcome as (2) if it ever
   panics.

It is line-based rather than a real parser, on purpose. A guard that becomes the
reason a legitimate build fails is worse than one that occasionally misses.

## Changing the Rust side

`examples/` are simultaneously documentation, `init` templates, and deployed
services, so a broken example is a broken template *and* a failing deploy. Run
`npm test` — "every example is a usable template" scaffolds each one.

## Testing

Offline by construction, and it must stay that way: resolving an alias and
downloading a toolchain both need the network, and a suite that reaches it fails
for reasons unrelated to the code.

- Fake a toolchain with a shell script that echoes `cargo <version>`; that drives
  every branch of `resolveCargo` without 365 MB.
- Build fixture crates in `mkdtemp` directories.
- Drive the CLI as a subprocess — `cli.js` calls `main()` on require, and it is
  also the real `npx render-rust init` path.
- Assert the `--help` text against the implementation's precedence order. In the
  sibling package a stray backtick in that template literal turned every command
  into a `SyntaxError` while all 67 tests still passed, because every test
  shelled out to a fixture directory and none of them ever parsed the CLI.

## Releasing

Bump `package.json`, write the changelog, `npm publish`. Publishing needs the
maintainer's 2FA — ask rather than attempting it.

After publishing, install from the registry into a scratch directory and check
what resolves. The sibling shipped three releases whose scaffolds silently
installed an old version, because the template pinned a literal `^0.1.0` and npm
reads that as `<0.2.0`. `init` derives the pin from this package's own version
and a test guards it, but the habit is the real fix.

## Do not

- Add a runtime dependency.
- Add a `{$ok}`/`{$err}` envelope.
- Commit `build/`, `target/` or an addon binary.
- Put `npm ci` in any documented build command.
