//! Real OS threads inside the task process.
//!
//! This is what a native addon gives that a JavaScript task cannot: the work
//! runs on threads in the same process, with no subprocess and no serialisation
//! at the boundary.
//!
//! Whether it goes *faster* is a separate question, and one to measure rather
//! than assume. A Render workflow instance reports a large `nproc` but is
//! bounded by a cgroup quota that has been observed at exactly one CPU -- and
//! on one CPU, threads buy nothing but scheduling. `compare` exists to give a
//! number instead of an opinion.

use napi_derive::napi;

/// Deliberately expensive, and deliberately not optimisable away.
fn work(seed: u64, rounds: u32) -> u64 {
    let mut h = seed ^ 0x9e37_79b9_7f4a_7c15;
    for _ in 0..rounds {
        h ^= h >> 30;
        h = h.wrapping_mul(0xbf58_476d_1ce4_e5b9);
        h ^= h >> 27;
        h = h.wrapping_mul(0x94d0_49bb_1331_11eb);
        h ^= h >> 31;
    }
    h
}

/// Runs `jobs` units of work one after another.
#[napi(catch_unwind)]
pub fn sequential(jobs: u32, rounds: u32) -> Vec<String> {
    (0..jobs as u64).map(|i| work(i, rounds).to_string()).collect()
}

/// Runs the same work across N threads.
///
/// `std::thread::scope` lets the threads borrow from this stack frame, so
/// nothing needs an Arc and nothing outlives the call.
#[napi(catch_unwind)]
pub fn parallel(jobs: u32, rounds: u32, threads: u32) -> Vec<String> {
    let threads = threads.max(1) as usize;
    let chunk = (jobs as usize).div_ceil(threads);

    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..threads)
            .map(|t| {
                scope.spawn(move || {
                    let start = (t * chunk) as u64;
                    let end = ((t + 1) * chunk).min(jobs as usize) as u64;
                    (start..end).map(|i| work(i, rounds).to_string()).collect::<Vec<_>>()
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap()).collect()
    })
}

#[napi(object)]
pub struct Comparison {
    pub jobs: u32,
    pub threads: u32,
    pub parallelism: u32,
    pub sequential_ms: f64,
    pub parallel_ms: f64,
    pub speedup: f64,
}

/// Both ways, timed inside the process, so the number excludes task overhead.
#[napi(catch_unwind)]
pub fn compare(jobs: u32, rounds: u32) -> Comparison {
    let threads = std::thread::available_parallelism()
        .map(|p| p.get() as u32)
        .unwrap_or(1);

    let t0 = std::time::Instant::now();
    let _ = sequential(jobs, rounds);
    let seq = t0.elapsed().as_secs_f64() * 1000.0;

    let t1 = std::time::Instant::now();
    let _ = parallel(jobs, rounds, threads);
    let par = t1.elapsed().as_secs_f64() * 1000.0;

    Comparison {
        jobs,
        threads,
        parallelism: threads,
        sequential_ms: seq,
        parallel_ms: par,
        speedup: if par > 0.0 { seq / par } else { 0.0 },
    }
}
