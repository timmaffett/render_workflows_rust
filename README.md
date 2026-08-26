# render-rust

Write [Render Workflows](https://render.com/docs/workflows) tasks in Rust.

**Unofficial.** Not affiliated with or endorsed by Render.

```rust
#[napi(catch_unwind)]
pub fn sum_squares(numbers: Vec<i64>) -> i64 {
    numbers.iter().map(|n| n * n).sum()
}
```

```bash
npx render-rust init my-tasks
cd my-tasks && npm install && npx render-rust build
render workflows start my-tasks/sumSquares --input='[[2, 3, 4]]' --local
```

## Why this exists

Render Workflows ships an SDK for **TypeScript and Python only**. A workflow
service accepts `elixir`, `go`, `node`, `python` or `ruby` — Rust is a
first-class Render runtime for web services and background workers, but is not
offered for Workflows, and there is no Rust SDK to register tasks with.

`buildCommand` and `runCommand` are free-form strings, though, and the runtime
only constrains the build image. So the Rust compiles to a **native Node addon**
through [NAPI-RS](https://napi.rs), and a two-line JavaScript entrypoint
registers its exports with Render's own SDK. No Docker. API provisioning and
`render workflows dev` both keep working.

The addon runs **in the task process**. There is no subprocess, no serialisation
across a pipe, and the boundary itself costs about **28 ns** per call — measured
on Render, against 3 ns for a plain JavaScript call.

## The one rule

**Write `#[napi(catch_unwind)]`, not `#[napi]`.**

Without it a panic — from an `unwrap()`, an out-of-range index, anything —
**aborts the Node process** instead of failing the run, taking every other run
in flight on that instance with it. With it, the message arrives at Render as
the task's error, verbatim:

```
status   failed
error    deliberate panic from Rust
```

`render-rust build` warns about every bare `#[napi]` it finds, and refuses to
build on the two related traps: a `Cargo.toml` without `crate-type = ["cdylib"]`
(cargo would emit an rlib, which Node cannot load), and `panic = "abort"` in the
active profile (which silently defeats `catch_unwind`).

Prefer `napi::Result` for anything you expect to fail. A panic is for a violated
invariant; an `Err` fails one run cleanly.

## Tasks

Every `#[napi]` function the addon exports becomes a task, named as JavaScript
sees it — `sum_squares` registers as `sumSquares`. Arguments and return values
are JSON, capped by Render at 4 MB per invocation.

`index.js` is the whole entrypoint:

```js
require('render-rust/runtime').runTasks('./build/tasks.node');
```

Per-task options go in `package.json`, which is the one unsatisfying part of
this release — the settings live apart from the function they describe:

```json
"renderRust": {
  "tasks": { "fetchUrl": { "retry": { "maxRetries": 2 } } },
  "exclude": ["helperNotATask"]
}
```

## Commands

| | |
| --- | --- |
| `render-rust build` | Compile the crate to `build/tasks.node`, skipping if unchanged |
| `render-rust dev` | Build, then start Render's local task server |
| `render-rust init [dir] [--template <name>]` | Scaffold from an example |
| `render-rust rust` | Which Rust this project uses, and why |
| `render-rust rust --list` | What the archive offers |

Configure through `renderRust` in `package.json`:

```json
{
  "renderRust": {
    "crate": ".",
    "out": "build/tasks.node",
    "profile": "release",
    "features": [],
    "target": null,
    "cargoFlags": [],
    "rustVersion": "1.98.0"
  }
}
```

## Choosing a Rust version

Three places, highest first — the flag for trying one once, the environment for
varying a build without a commit, and `package.json` for the answer that should
travel with the project:

```bash
npx render-rust build --rust-version 1.97.0
RENDER_RUST_VERSION=1.97.0 npx render-rust build
```

```json
"renderRust": { "rustVersion": "1.97.0" }
```

A version can be exact, `latest`, or a channel — `stable`, `beta`, `nightly`. An
exact version needs no network to interpret, so a pinned project keeps building
when the archive is unreachable.

**A pin set explicitly wins over a Rust already on `PATH`.** If they differ, the
requested version is downloaded. Only the built-in default defers to a local
toolchain — it exists so a first build has something to fetch, not to override a
Rust you installed deliberately.

Downloads are checked against the archive's published SHA-256 before being
unpacked, hashed while the archive streams to disk so it costs no extra I/O.

## Deploying

A workflow service with:

| | |
| --- | --- |
| runtime | `node` |
| build command | `npm install && npm run build` |
| start command | `npm start` |

**Use `npm install`, never `npm ci`.** The toolchain, the cargo registry and
every compiled dependency are vendored into `node_modules`, which is the only
directory Render's build cache preserves. `npm ci` deletes it before each build,
turning every deploy back into a cold one with no error to explain why.

Measured on a real free-tier deploy:

| | |
| --- | --- |
| Cold build | **25 s** — 365 MB toolchain fetched in 2 s, unpacked in 12 s, cargo 10 s |
| Warm rebuild | **1 s** — toolchain cache hit, cargo not invoked |
| Cached | 577 MB toolchain + 25 MB registry + 100 MB build artifacts |
| Addon | ~600 KB |

## What a workflow instance actually is

`nproc` reports 32 or 48. The cgroup quota is **1.0 CPU and 2 GB**:

```
cpu.max     100000 100000
memory.max  2147483648
```

`std::thread::available_parallelism()` reads that quota and returns **1**, so
sizing a thread pool from it is correct and sizing one from `nproc` is not. The
build container is more generous — 2 CPU, 8 GB — which is why builds are quick
and tasks are not.

Threads are genuinely available, and the `threads` example measures whether they
help. On one CPU, the honest answer is usually no.

## Examples

Each is a working project, a deployable service, and an `init --template`:

| | |
| --- | --- |
| `default` | Four tasks, no dependencies beyond `napi` |
| `threads` | Real OS threads, and an honest measurement of them |

## Requirements

Node 20.17+ (napi-rs's floor; Render currently runs 26.x). No local Rust needed —
one is fetched if `cargo` is not on `PATH`.

## License

MIT
