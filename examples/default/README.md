# default

The smallest useful Rust workflow: four tasks, no dependencies beyond `napi`.

```bash
npm install
npx render-rust build
npx render-rust dev
```

Then, from another shell:

```bash
render workflows start <slug>/sumSquares --input='[[2, 3, 4]]' --local
```

`instanceInfo` is worth running on Render rather than locally — it reports the
cgroup quota, which is where the difference between `nproc` and reality shows up.
