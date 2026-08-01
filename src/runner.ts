import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { type ChildSessionLifecycle, runChildSession, SHUTDOWN_GRACE_MS } from './child-session.ts';
import type { SubagentRunnerOptions, SubagentRunnerResult } from './types.ts';

function createAbortError(message = 'Subagent was aborted'): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

async function settleWithin(promises: Promise<unknown>[], timeoutMs: number): Promise<boolean> {
    if (promises.length === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            Promise.allSettled(promises).then(() => true),
            new Promise<boolean>((resolveTimeout) => {
                timer = setTimeout(() => resolveTimeout(false), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function waitForTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(createAbortError());

    return new Promise((resolvePromise, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(createAbortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        previous.then(
            () => {
                signal.removeEventListener('abort', onAbort);
                if (signal.aborted) reject(createAbortError());
                else resolvePromise();
            },
            (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            }
        );
    });
}

/** Own serial scheduling, shutdown, and the set of live child resources. */
export class SubagentRunner {
    private serialTail: Promise<void> = Promise.resolve();
    private readonly activeSessions = new Set<AgentSession>();
    private readonly activeCleanups = new Set<Promise<void>>();
    private readonly runs = new Set<Promise<SubagentRunnerResult>>();
    private readonly shutdownController = new AbortController();
    private shutdownPromise: Promise<void> | undefined;
    private shuttingDown = false;

    run(options: SubagentRunnerOptions): Promise<SubagentRunnerResult> {
        if (options.signal?.aborted) return Promise.reject(createAbortError());

        const run = this.runSerial(options);
        this.runs.add(run);
        void run.then(
            () => this.runs.delete(run),
            () => this.runs.delete(run)
        );
        return run;
    }

    shutdown(): Promise<void> {
        if (!this.shutdownPromise) this.shutdownPromise = this.shutdownOnce();
        return this.shutdownPromise;
    }

    private async shutdownOnce(): Promise<void> {
        this.shuttingDown = true;
        this.shutdownController.abort();

        const deadline = Date.now() + SHUTDOWN_GRACE_MS;
        const aborts = new Map<AgentSession, Promise<void>>();
        let settled = true;
        while (this.runs.size > 0 || this.activeCleanups.size > 0 || this.activeSessions.size > 0) {
            for (const session of this.activeSessions) {
                if (!aborts.has(session)) aborts.set(session, session.abort());
            }
            const pending = [
                ...this.runs,
                ...this.activeCleanups,
                ...[...this.activeSessions].flatMap((session) => {
                    const abort = aborts.get(session);
                    return abort ? [abort] : [];
                }),
            ];
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0 || !(await settleWithin(pending, remainingMs))) {
                settled = false;
                break;
            }
            // A run can transfer non-abort-aware startup cleanup while settling.
            // Loop so shutdown also observes resources registered after the prior
            // snapshot without extending the original grace deadline.
        }

        if (!settled) {
            // In-process sessions have no hard-kill fallback. Release local
            // resources after the cooperative grace period so parent shutdown
            // can continue even when a child tool ignores abort.
            for (const session of this.activeSessions) session.dispose();
            this.activeSessions.clear();
            this.activeCleanups.clear();
            this.runs.clear();
        }
    }

    private trackCleanup(cleanup: Promise<void>): void {
        this.activeCleanups.add(cleanup);
        void cleanup.then(
            () => this.activeCleanups.delete(cleanup),
            () => this.activeCleanups.delete(cleanup)
        );
    }

    private async runSerial(options: SubagentRunnerOptions): Promise<SubagentRunnerResult> {
        let release!: () => void;
        const gate = new Promise<void>((resolveGate) => {
            release = resolveGate;
        });
        const previous = this.serialTail;
        this.serialTail = previous.then(
            () => gate,
            () => gate
        );

        const signal = options.signal
            ? AbortSignal.any([options.signal, this.shutdownController.signal])
            : this.shutdownController.signal;
        let lateCleanup: Promise<void> | undefined;

        const holdSerialGateUntil = (cleanup: Promise<void>): void => {
            this.trackCleanup(cleanup);
            lateCleanup = lateCleanup
                ? Promise.allSettled([lateCleanup, cleanup]).then(() => undefined)
                : cleanup;
        };
        const lifecycle: ChildSessionLifecycle = {
            isShuttingDown: () => this.shuttingDown,
            addActiveSession: (session) => this.activeSessions.add(session),
            removeActiveSession: (session) => this.activeSessions.delete(session),
            trackCleanup: (cleanup) => this.trackCleanup(cleanup),
            holdSerialGateUntil,
        };

        try {
            await waitForTurn(previous, signal);
            if (this.shuttingDown) throw new Error('Subagent runner is shutting down');
            return await runChildSession(options, signal, lifecycle);
        } finally {
            if (lateCleanup) {
                // Cancellation can return before non-abort-aware startup or binding
                // settles. Keep serial execution closed until cleanup completes.
                void lateCleanup.then(release, release);
            } else {
                release();
            }
        }
    }
}
