# π Subagent extension

An in-process Pi subagent extension with isolated child sessions.

- `SubagentService` owns the FIFO queue and cancellation, and supports code-configurable execution capacity.
- `RunStore` owns immutable logical snapshots for tools and UI subscribers.
- Each admitted `SubagentRunner` owns exactly one child execution and reports logical outcome separately from physical resource release.
- Child sessions are persisted as JSONL under Pi's agent session directory. Their `sessionFile` is published in live run details once available and retained in final tool details for successful runs; failed and cancelled calls may expose it only through transient updates.

The shipped extension currently uses the service's default serial capacity (`concurrency: 1`); it does not yet expose concurrency as a user setting.

## Test without installing

```bash
pi -e ./extensions/subagent/index.ts
```
