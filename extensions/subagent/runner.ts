import type { AgentSessionRuntime } from '@earendil-works/pi-coding-agent';
import {
    type ChildSessionLifecycle,
    type ChildSessionResource,
    runChildSession,
    SHUTDOWN_GRACE_MS,
} from './child-session.ts';
import type { SubagentExecutionHandle, SubagentRunnerOptions } from './types.ts';

interface OwnedRuntime extends ChildSessionResource {
    forceDispose(): Promise<void>;
}

function createAbortError(message = 'Subagent was aborted'): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(createAbortError());
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(createAbortError());
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            }
        );
    });
}

/** Owns exactly one admitted child execution and its physical resources. */
export class SubagentRunner {
    private readonly ownedRuntimes = new Set<OwnedRuntime>();
    private readonly shutdownController = new AbortController();
    private resolveReleased!: () => void;
    private readonly released = new Promise<void>((resolve) => {
        this.resolveReleased = resolve;
    });
    private executionSettled = false;
    private releaseForced = false;
    private started = false;
    private shuttingDown = false;
    private shutdownPromise: Promise<void> | undefined;

    start(options: SubagentRunnerOptions): SubagentExecutionHandle {
        if (this.started) throw new Error('A SubagentRunner can execute only one run');
        if (this.shuttingDown) throw new Error('Subagent runner is shutting down');
        this.started = true;

        const signal = options.signal
            ? AbortSignal.any([options.signal, this.shutdownController.signal])
            : this.shutdownController.signal;
        const lifecycle: ChildSessionLifecycle = {
            isShuttingDown: () => this.shuttingDown,
            adoptRuntime: (runtime) => this.adoptRuntime(runtime),
        };

        const execution = runChildSession(options, signal, lifecycle);
        execution.then(
            () => {
                this.executionSettled = true;
                this.tryRelease();
            },
            () => {
                this.executionSettled = true;
                this.tryRelease();
            }
        );

        const outcome = raceWithAbort(execution, signal);
        return { outcome, released: this.released };
    }

    shutdown(): Promise<void> {
        if (!this.shutdownPromise) this.shutdownPromise = this.shutdownOnce();
        return this.shutdownPromise;
    }

    private async shutdownOnce(): Promise<void> {
        this.shuttingDown = true;
        this.shutdownController.abort();

        if (!this.started) {
            this.forceRelease();
            return;
        }

        const aborts = [...this.ownedRuntimes].map((runtime) => runtime.abort());

        let timer: NodeJS.Timeout | undefined;
        const released = await Promise.race([
            Promise.allSettled(aborts)
                .then(() => this.released)
                .then(() => true),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS);
            }),
        ]).finally(() => {
            if (timer) clearTimeout(timer);
        });

        if (!released) {
            // There is no hard-kill fallback for an in-process session. Stop holding
            // parent shutdown after the cooperative grace period.
            for (const runtime of this.ownedRuntimes) {
                void runtime.forceDispose().catch(() => undefined);
            }
            this.forceRelease();
        }
    }

    private adoptRuntime(runtime: AgentSessionRuntime): OwnedRuntime {
        let abortPromise: Promise<void> | undefined;
        let disposePromise: Promise<void> | undefined;
        let forceDisposed = false;
        let ownershipReleased = false;
        const releaseOwnership = (): void => {
            if (ownershipReleased) return;
            ownershipReleased = true;
            this.ownedRuntimes.delete(owned);
            this.tryRelease();
        };
        const owned: OwnedRuntime = {
            session: runtime.session,
            abort: (): Promise<void> => (abortPromise ??= runtime.session.abort()),
            dispose: (): Promise<void> => {
                if (forceDisposed) return Promise.resolve();
                disposePromise ??= runtime.dispose().finally(releaseOwnership);
                return disposePromise;
            },
            forceDispose: (): Promise<void> => {
                if (ownershipReleased) return Promise.resolve();
                forceDisposed = true;
                try {
                    runtime.session.dispose();
                    return Promise.resolve();
                } catch (error) {
                    return Promise.reject(error);
                } finally {
                    releaseOwnership();
                }
            },
        };
        this.ownedRuntimes.add(owned);
        return owned;
    }

    private tryRelease(): void {
        if (!this.releaseForced && this.executionSettled && this.ownedRuntimes.size === 0) {
            this.forceRelease();
        }
    }

    private forceRelease(): void {
        if (this.releaseForced) return;
        this.releaseForced = true;
        this.resolveReleased();
    }
}
