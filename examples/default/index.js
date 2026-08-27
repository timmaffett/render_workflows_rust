// Loads the compiled addon and registers every function it exports as a task.
require('render-workflows-rust/runtime').runTasks('./build/tasks.node');
