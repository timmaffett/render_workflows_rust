//! Render Workflows tasks, in Rust.
//!
//! Every `#[napi]` function exported here becomes a task, named as JavaScript
//! sees it: `sum_squares` registers as `sumSquares`.
//!
//! `catch_unwind` is not optional in practice. Without it a panic -- including
//! one from an `unwrap()` or an out-of-range index -- aborts the Node process
//! rather than failing the run, taking every concurrent run on the instance
//! with it. With it, the panic message reaches Render as the task's error.

use napi_derive::napi;

/// Squares each number and sums the result.
#[napi(catch_unwind)]
pub fn sum_squares(numbers: Vec<i64>) -> i64 {
    numbers.iter().map(|n| n * n).sum()
}

/// Naive recursive Fibonacci -- CPU-bound work, which is the reason to be here.
#[napi(catch_unwind)]
pub fn fib(n: u32) -> i64 {
    fn go(n: u32) -> i64 {
        if n < 2 {
            n as i64
        } else {
            go(n - 1) + go(n - 2)
        }
    }
    go(n)
}

/// An expected failure, returned rather than panicked.
///
/// This is the distinction worth internalising: a `Result::Err` fails one task
/// run cleanly. A panic is for a violated invariant, and even caught it is a
/// blunter instrument.
#[napi(catch_unwind)]
pub fn parse_port(text: String) -> napi::Result<u16> {
    text.trim()
        .parse::<u16>()
        .map_err(|e| napi::Error::from_reason(format!("{text:?} is not a port: {e}")))
}

/// What this instance actually is.
#[napi(object)]
pub struct InstanceInfo {
    pub parallelism: u32,
    pub cpu_quota: String,
    pub memory_max: String,
}

/// Reports the real resource limits.
///
/// `available_parallelism()` reads the cgroup quota, so it returns what the
/// instance can actually use. Do not size a thread pool from `nproc`, which
/// reports the host's core count -- 32 or 48 on Render, against a real quota
/// of one CPU.
#[napi(catch_unwind)]
pub fn instance_info() -> InstanceInfo {
    let read = |p: &str| {
        std::fs::read_to_string(p)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    InstanceInfo {
        parallelism: std::thread::available_parallelism()
            .map(|p| p.get() as u32)
            .unwrap_or(0),
        cpu_quota: read("/sys/fs/cgroup/cpu.max"),
        memory_max: read("/sys/fs/cgroup/memory.max"),
    }
}
