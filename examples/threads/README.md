# threads

Real OS threads inside the task process — the thing a JavaScript task cannot do.

```bash
render workflows start <slug>/compare --input='[64, 20000]'
```

Read the result honestly. `parallelism` is what the cgroup quota allows, not
what `nproc` claims, and on a one-CPU instance a speedup near 1.0 is the correct
answer rather than a bug. Threads are worth reaching for when the instance has
more than one CPU to give.
