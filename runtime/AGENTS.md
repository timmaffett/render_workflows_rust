# Working in this project

Rust tasks running on Render Workflows, via `render-rust`. The Rust compiles to
a native Node addon (`.node`) that a small JavaScript entrypoint loads and
registers with Render's own SDK.

`render-rust` is an unofficial community package, not affiliated with Render.

## Commands

```bash
npx render-rust build         # compile; --force skips the freshness check
npx render-rust dev           # build, then start Render's local task server
npx render-rust rust          # which Rust this project uses, and why
render workflows tasks list --local
render workflows start <task> --local --input='[1, 2]'
```

No Rust installation is needed. If one is on `PATH` the build uses it;
otherwise a toolchain is fetched into `node_modules`. Either way the build
prints which version it used and where it came from.

## Writing a task

Every `#[napi]` function exported from `src/lib.rs` becomes a task, named as
JavaScript sees it — `sum_squares` registers as `sumSquares`.

```rust
#[napi(catch_unwind)]
pub fn sum_squares(numbers: Vec<i64>) -> i64 {
    numbers.iter().map(|n| n * n).sum()
}
```

Arguments and return values are JSON. Render caps one invocation's input at
4 MB.

## The rule that catches people

**Write `#[napi(catch_unwind)]`, not `#[napi]`.**

Without it, a panic — including one from an `unwrap()`, an out-of-range index,
or an integer overflow in debug — **aborts the whole Node process** rather than
failing the run. That kills the task server and every other run in flight on
that instance. With it, the panic message arrives at Render as the task's error,
verbatim.

The build warns about every bare `#[napi]` function it finds. Do not silence it.

Two related traps, both of which the build refuses outright:

- **`crate-type = ["cdylib"]` is required** in `Cargo.toml`. Without it cargo
  produces an rlib, no addon exists, and the error reads like a missing file.
- **Never set `panic = "abort"`** in the active profile. It silently defeats
  `catch_unwind`, turning every caught panic back into a killed process.

Prefer returning `napi::Result` for anything you expect to fail. A panic is for
a violated invariant; `Err` fails one run cleanly and carries its message.

## Errors

Return `napi::Result<T>` and the message reaches Render intact:

```rust
#[napi(catch_unwind)]
pub fn parse_port(text: String) -> napi::Result<u16> {
    text.trim().parse().map_err(|e| napi::Error::from_reason(format!("{e}")))
}
```

## Threads

`std::thread` works — this is the capability a JavaScript task does not have.
Whether it goes faster is a separate question. Size pools from
`std::thread::available_parallelism()`, which reads the cgroup quota, and never
from `nproc`: a Render instance reports 32 or 48 cores against a quota that has
been measured at exactly one CPU.

## Deploying

A workflow service with:

| | |
| --- | --- |
| runtime | `node` |
| build command | `npm install && npm run build` |
| start command | `npm start` |

**Use `npm install`, never `npm ci`.** The Rust toolchain, the cargo registry and
the compiled dependencies are vendored into `node_modules`, which is the only
directory Render's build cache preserves. `npm ci` deletes that directory before
every build, which silently turns every deploy back into a cold one — no error,
just minutes of rebuilding.

Autodeploy only fires for changes inside the service's root directory.

## Do not commit

`build/`, `target/`, `node_modules/`. The build regenerates all of them and
maintains a `.gitignore` in `build/`.

`Cargo.lock` **should** be committed for a deployed service — it is an
application, and a reproducible deploy wants a pinned dependency graph.

## More

Runnable examples: <https://github.com/timmaffett/render_rust_workflows/tree/main/examples>
