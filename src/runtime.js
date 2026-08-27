// The Node-side runtime for Rust-authored Render Workflows tasks.
//
// Render runs a workflow's start command; that command loads this module, which
// requires the compiled addon and registers its exports with @renderinc/sdk.

// MUST run before @renderinc/sdk is required, and is why this module exists
// rather than being inlined into user code.
//
// The SDK's task() schedules its own startTaskServer() via setImmediate as soon
// as it sees RENDER_SDK_SOCKET_PATH. Since we also start the server explicitly,
// leaving auto-start on produces TWO task servers and executes every task body
// TWICE -- doubled side effects and doubled billing. Neither
// `render workflows dev` nor Render in production sets this for us.
process.env.RENDER_SDK_AUTO_START = 'false';

const path = require('node:path');
const { existsSync, readFileSync } = require('node:fs');
const { task, startTaskServer } = require('@renderinc/sdk/workflows');

/** Registered tasks, by name, as returned by the SDK's task(). */
const wrapped = Object.create(null);

/**
 * Per-task options from package.json, so a task can set retry/plan/timeout.
 *
 * This is the one place v0 is unsatisfying: the options live apart from the
 * function they describe, which is exactly what render-dart moved *away* from
 * when @NativeTask replaced a list in package.json. A #[render_task] macro is
 * the fix and is the next thing to build; until then, a second place to keep in
 * sync is the honest cost of having no macro.
 */
function config(root) {
  const file = path.join(root, 'package.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')).renderRust ?? {};
  } catch {
    return {};
  }
}

/**
 * Loads a compiled addon and registers every function it exports as a task.
 *
 * Unlike the Dart runtime there is no {$ok}/{$err} envelope, and none is
 * needed. A Dart exception converted across the boundary reached Render as the
 * opaque "Dart exception thrown from converted Future...", with the real
 * message boxed out of reach. #[napi(catch_unwind)] turns a Rust panic into a
 * genuine JS Error carrying its message, verified end to end on Render: a task
 * that panics with "deliberate panic from Rust" fails with exactly that text,
 * and the task server survives to answer the next call.
 *
 * Arguments pass through as varargs, because a #[napi] function has real arity.
 * (The Dart side collapses them into one array only because a dart2js closure
 * cannot.)
 */
function runTasks(addonPath = './build/tasks.node', options = {}) {
  const root = options.root ?? process.cwd();
  const resolved = path.resolve(root, addonPath);

  if (!existsSync(resolved)) {
    throw new Error(
      `no addon at ${path.relative(root, resolved)}.\n` +
        '  Run `npx render-workflows-rust build` first, or set renderRust.out if it is ' +
        'built somewhere else.',
    );
  }

  const addon = require(resolved);
  const settings = { ...config(root), ...options };
  const perTask = settings.tasks ?? {};
  const exclude = new Set(settings.exclude ?? []);

  const names = [];
  for (const [name, fn] of Object.entries(addon)) {
    if (typeof fn !== 'function' || exclude.has(name)) continue;
    wrapped[name] = task({ name, ...(perTask[name] ?? {}) }, async (...args) => fn(...args));
    names.push(name);
  }

  if (names.length === 0) {
    throw new Error(
      `${path.relative(root, resolved)} exports no functions.\n` +
        '  Mark the ones you want as tasks with #[napi(catch_unwind)].',
    );
  }

  console.log(`[render-workflows-rust] registered ${names.length} task(s): ${names.join(', ')}`);

  // The SDK reports a task failure over /callback and *then* rethrows it. Left
  // alone that surfaces as an unhandled rejection, which on Render means the
  // instance dies with a stack trace instead of the run failing cleanly.
  startTaskServer().catch((e) => {
    console.error(`[render-workflows-rust] task failed: ${e && e.message ? e.message : e}`);
    process.exit(1);
  });

  return names;
}

/**
 * Invokes another task as a child run.
 *
 * Calling an SDK-wrapped function from inside an executing task is what makes
 * Render spawn a subtask, each on its own instance -- which is how work fans
 * out.
 */
function callTask(name, ...args) {
  const fn = wrapped[name];
  if (!fn) {
    throw new Error(
      `no task named ${name}. Registered: ${Object.keys(wrapped).join(', ') || '(none)'}.\n` +
        '  Tasks must be registered before one of them runs.',
    );
  }
  return fn(...args);
}

module.exports = { runTasks, callTask };
