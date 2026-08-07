# π Subagent extension

An in-process Pi subagent extension with isolated child sessions and bounded parallel execution.

- `SubagentService` owns a FIFO queue, cancellation, and code-configurable execution capacity.
- `RunStore` owns immutable logical snapshots for tools and UI subscribers.
- Each admitted `SubagentRunner` owns exactly one child execution and reports logical outcome separately from physical resource release.
- Child sessions are persisted as JSONL under Pi's agent session directory. Their `sessionFile` is published in live run details once available and retained in final tool details for successful runs; failed and cancelled calls may expose it only through transient updates.

## Concurrency

The extension admits up to **3** subagents concurrently by default. Set the process-wide limit with:

```bash
pi -e ./extensions/subagent/index.ts --subagent-concurrency 4
```

The accepted range is `1` through `8`. Use `--subagent-concurrency 1` to force serial execution.

## Thinking

Subagents inherit the parent's effective thinking level by default. To set one process-wide level for every subagent, use:

```bash
pi -e ./extensions/subagent/index.ts --subagent-thinking high
```

Accepted values are `inherit`, `low`, `medium`, and `high`. `inherit` is the default and resolves the parent's current effective level when each tool call executes, capped at the code-level maximum of `high`, so parent model or thinking changes during the session are respected without inheriting `xhigh` or `max`. An explicit value overrides the parent level. In both cases, the requested level is clamped to the selected model's capabilities; run snapshots and child sessions use the resulting effective level.

The tool still delegates one task per call. Pi executes sibling tool calls in parallel, so the parent model controls dependencies through when it emits calls:

1. Emit independent subagent calls together in one assistant turn.
2. Pi waits for the sibling tool batch to finish.
3. Emit dependent work in a later turn, after the prerequisite results are available.

Parallel execution is best suited to research, exploration, review, tests, and work in disjoint modules. Child model contexts are isolated, but their filesystem is not: calls using the same `cwd` share one mutable workspace. Avoid parallel writes to overlapping files and contention on Git state, generated files, package managers, tests, ports, databases, or other shared resources.

## Test without installing

```bash
pi -e ./extensions/subagent/index.ts
```
