# Changelog

## 0.1.1

Documentation only, and a release because npm serves a README from the archive:
0.1.0's registry page still showed `render-rust` as the command.

Docs, example scripts and log lines all say `render-workflows-rust` now.
`render-rust` remains a second bin, documented as an alias for when you are
typing it often.

## 0.1.0

First release. Rust tasks on Render Workflows, through a native Node addon.

Render Workflows has SDKs for TypeScript and Python only, and its workflow
runtime enum is `elixir | go | node | python | ruby` — Rust is a first-class
Render runtime everywhere else, and absent here. But `buildCommand` and
`runCommand` are free-form strings, so a `node` workflow can bootstrap a Rust
toolchain, compile a cdylib with NAPI-RS, and register its exports with Render's
own SDK.

- **`render-workflows-rust build`** vendors a Rust toolchain into `node_modules`, verified
  against the published SHA-256 while it streams to disk, and compiles the crate
  to `build/tasks.node`.
- **Version pinning** — `--rust-version`, `RENDER_RUST_VERSION`, or
  `renderRust.rustVersion`, in that order. Exact, `latest`, or a channel. An
  explicit pin beats a toolchain on `PATH`; the built-in default defers to it.
- **A content-hash cache above cargo**, because cargo fingerprints local sources
  by mtime and every Render deploy is a fresh checkout that restamps them.
- **Three build-time checks** for mistakes that compile cleanly and then
  misbehave: a missing `crate-type = ["cdylib"]`, `panic = "abort"` defeating
  `catch_unwind`, and a bare `#[napi]` whose panic would abort the process.
- **`render-workflows-rust init`** scaffolds from the examples, which are also the
  deployed services.
- 36 tests, all offline.

Measured on a free-tier workflow service: cold build 25 s, warm rebuild 1 s,
addon ~600 KB, and about 28 ns per call across the N-API boundary.

No `{$ok}`/`{$err}` envelope, unlike the Dart sibling: `#[napi(catch_unwind)]`
already delivers a panic message to Render intact.
