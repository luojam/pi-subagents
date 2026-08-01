import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { isTerminalRunState, RunStore, type RunStoreOptions } from './run-store.ts';
import { SubagentRunner } from './runner.ts';
import type {
    RelevantSubagentRun,
    RunId,
    SubagentExecutionHandle,
    SubagentRunHandle,
    SubagentRunnerOptions,
    SubagentRunOptions,
    SubagentRunResult,
    SubagentRunSnapshot,
} from './types.ts';

export interface ExecutionRunner {
    start(options: SubagentRunnerOptions): SubagentExecutionHandle;
    shutdown(): Promise<void>;
}

interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
}

interface PendingRun {
    readonly request: SubagentRunOptions;
    readonly result: Deferred<SubagentRunResult>;
    removeAbortListener(): void;
}

interface ActiveExecution {
    readonly runner: ExecutionRunner;
    readonly controller: AbortController;
    released: boolean;
    outcomeSettled: boolean;
}

export interface SubagentServiceOptions extends RunStoreOptions {
    concurrency?: number;
    createId?: () => RunId;
    childSessionDirectory?: string;
    store?: RunStore;
    runnerFactory?: () => ExecutionRunner;
}

type RunListener = (snapshot: SubagentRunSnapshot) => void;
type RelevantListener = (run: RelevantSubagentRun) => void;

function deferred<T>(): Deferred<T> {
    let resolvePromise!: (value: T) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function createAbortError(message = 'Subagent was aborted'): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

/** Owns the logical queue and admits one Runner per available execution slot. */
export class SubagentService {
    private readonly store: RunStore;
    private readonly pendingRuns = new Map<RunId, PendingRun>();
    private readonly activeExecutions = new Map<RunId, ActiveExecution>();
    private readonly concurrency: number;
    private readonly createId: () => RunId;
    private readonly childSessionDirectory: string;
    private readonly runnerFactory: () => ExecutionRunner;
    private shutdownPromise: Promise<void> | undefined;
    private draining = false;
    private disposed = false;

    constructor(options: SubagentServiceOptions = {}) {
        const concurrency = options.concurrency ?? 1;
        if (!Number.isInteger(concurrency) || concurrency < 1) {
            throw new Error('Subagent concurrency must be a positive integer');
        }
        this.concurrency = concurrency;
        this.createId = options.createId ?? randomUUID;
        this.childSessionDirectory =
            options.childSessionDirectory ?? join(getAgentDir(), 'sessions', 'subagents');
        this.runnerFactory = options.runnerFactory ?? (() => new SubagentRunner());
        this.store =
            options.store ??
            new RunStore({
                now: options.now,
                tickMs: options.tickMs,
                textUpdateThrottleMs: options.textUpdateThrottleMs,
            });
    }

    run(options: SubagentRunOptions): Promise<SubagentRunResult> {
        return this.start(options).result;
    }

    start(options: SubagentRunOptions): SubagentRunHandle {
        if (this.disposed) {
            return {
                id: '',
                result: Promise.reject(new Error('Subagent service is shut down')),
                cancel: () => false,
            };
        }

        const id = this.createId();
        const result = deferred<SubagentRunResult>();
        let removeAbortListener = (): void => {};
        if (this.store.get(id)) throw new Error(`Duplicate subagent run id: ${id}`);
        const pending: PendingRun = {
            request: options,
            result,
            removeAbortListener: () => removeAbortListener(),
        };
        this.pendingRuns.set(id, pending);
        try {
            this.store.create(id, options);
        } catch (error) {
            this.pendingRuns.delete(id);
            throw error;
        }

        // A synchronous store subscriber may cancel the newly published queued run.
        if (this.pendingRuns.has(id)) {
            if (options.signal) {
                const onAbort = () => this.cancel(id);
                options.signal.addEventListener('abort', onAbort, { once: true });
                removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort);
            }

            if (options.signal?.aborted) this.cancel(id);
            else this.drainQueue();
        }

        return {
            id,
            result: result.promise,
            cancel: () => this.cancel(id),
        };
    }

    cancel(id: RunId): boolean {
        const snapshot = this.store.get(id);
        if (!snapshot || isTerminalRunState(snapshot.state)) return false;

        if (snapshot.state === 'queued') {
            this.store.apply(id, { type: 'cancel_requested' });
            const pending = this.pendingRuns.get(id);
            if (pending) {
                pending.removeAbortListener();
                this.pendingRuns.delete(id);
                pending.result.reject(createAbortError());
            }
            this.drainQueue();
            return true;
        }

        this.store.apply(id, { type: 'cancel_requested' });
        this.activeExecutions.get(id)?.controller.abort();
        return true;
    }

    get(id: RunId): SubagentRunSnapshot | undefined {
        return this.store.get(id);
    }

    list(): readonly SubagentRunSnapshot[] {
        return this.store.list();
    }

    subscribe(listener: (snapshot: SubagentRunSnapshot) => void): () => void {
        return this.store.subscribe(listener);
    }

    subscribeRun(id: RunId, listener: RunListener): () => void {
        return this.store.subscribeRun(id, listener);
    }

    subscribeRelevant(listener: RelevantListener): () => void {
        const publish = () => {
            try {
                listener(this.store.getRelevant());
            } catch {
                // UI publication is best-effort.
            }
        };
        publish();
        const unsubscribe = this.store.subscribe(publish);
        return unsubscribe;
    }

    shutdown(): Promise<void> {
        if (!this.shutdownPromise) this.shutdownPromise = this.shutdownOnce();
        return this.shutdownPromise;
    }

    private async shutdownOnce(): Promise<void> {
        this.disposed = true;
        const logicalResults = [...this.pendingRuns.values()].map(
            (pending) => pending.result.promise
        );
        for (const snapshot of this.store.list()) {
            if (!isTerminalRunState(snapshot.state)) this.cancel(snapshot.id);
        }

        await this.shutdownExecutions();

        for (const [id, pending] of [...this.pendingRuns]) {
            const error = createAbortError('Subagent service shut down');
            this.store.apply(id, { type: 'cancelled', error });
            this.finishLogical(id, pending);
            pending.result.reject(error);
        }
        this.activeExecutions.clear();

        await Promise.allSettled(logicalResults);
        this.store.dispose();
    }

    private async shutdownExecutions(): Promise<void> {
        const shutDown = new Set<ExecutionRunner>();
        // Let an admission which synchronously reentered shutdown finish registering.
        await Promise.resolve();
        while (true) {
            const runners = [...this.activeExecutions.values()]
                .map((execution) => execution.runner)
                .filter((runner) => !shutDown.has(runner));
            if (runners.length === 0) return;
            for (const runner of runners) shutDown.add(runner);
            await Promise.allSettled(runners.map((runner) => runner.shutdown()));
        }
    }

    private drainQueue(): void {
        if (this.draining || this.disposed) return;
        this.draining = true;
        try {
            while (this.occupiedCapacity() < this.concurrency) {
                const snapshot = this.store.getQueued(1)[0];
                if (!snapshot) break;
                const pending = this.pendingRuns.get(snapshot.id);
                if (!pending) {
                    this.store.apply(snapshot.id, {
                        type: 'interrupted',
                        error: 'Queued subagent request was unavailable',
                    });
                    continue;
                }
                this.admit(snapshot.id, pending);
            }
        } finally {
            this.draining = false;
        }
    }

    private admit(id: RunId, pending: PendingRun): void {
        const controller = new AbortController();
        let runner: ExecutionRunner;
        try {
            runner = this.runnerFactory();
        } catch (error) {
            this.finishFailedStart(id, pending, error);
            return;
        }

        const active: ActiveExecution = {
            runner,
            controller,
            released: false,
            outcomeSettled: false,
        };
        // Register ownership before publishing `starting`; a synchronous subscriber
        // may invoke shutdown from that transition.
        this.activeExecutions.set(id, active);
        this.store.apply(id, { type: 'admitted' });
        if (this.disposed) return;

        if (this.store.get(id)?.state === 'cancelling') controller.abort();
        try {
            const handle = runner.start({
                ...pending.request,
                signal: controller.signal,
                childSessionDirectory: this.childSessionDirectory,
                onEvent: (event) => this.store.apply(id, { type: 'runner_event', event }),
            });
            void handle.outcome.then(
                (result) => this.finishSucceeded(id, result),
                (error: unknown) => this.finishFailed(id, error)
            );
            void handle.released.then(
                () => this.release(id),
                () => this.release(id)
            );
        } catch (error) {
            this.activeExecutions.delete(id);
            this.finishFailedStart(id, pending, error);
        }
    }

    private finishSucceeded(id: RunId, result: Awaited<SubagentExecutionHandle['outcome']>): void {
        this.settleExecutionOutcome(id);
        const pending = this.pendingRuns.get(id);
        if (!pending) return;
        const cancelling = this.store.get(id)?.state === 'cancelling';
        const snapshot = this.store.apply(id, {
            type: cancelling ? 'cancelled' : 'completed',
        });
        this.finishLogical(id, pending);
        if (cancelling || !snapshot) pending.result.reject(createAbortError());
        else pending.result.resolve({ ...result, details: snapshot });
    }

    private finishFailed(id: RunId, error: unknown): void {
        this.settleExecutionOutcome(id);
        const pending = this.pendingRuns.get(id);
        if (!pending) return;
        const cancelled = this.store.get(id)?.state === 'cancelling' || isAbortError(error);
        if (cancelled) this.store.apply(id, { type: 'cancelled', error });
        else this.store.apply(id, { type: 'failed', error });
        this.finishLogical(id, pending);
        pending.result.reject(cancelled && !isAbortError(error) ? createAbortError() : error);
    }

    private finishFailedStart(id: RunId, pending: PendingRun, error: unknown): void {
        this.store.apply(id, { type: 'failed', error });
        this.finishLogical(id, pending);
        pending.result.reject(error);
    }

    private finishLogical(id: RunId, pending: PendingRun): void {
        pending.removeAbortListener();
        this.pendingRuns.delete(id);
    }

    private occupiedCapacity(): number {
        let occupied = 0;
        for (const execution of this.activeExecutions.values()) {
            if (!execution.released) occupied++;
        }
        return occupied;
    }

    private settleExecutionOutcome(id: RunId): void {
        const execution = this.activeExecutions.get(id);
        if (!execution) return;
        execution.outcomeSettled = true;
        if (execution.released) this.activeExecutions.delete(id);
    }

    private release(id: RunId): void {
        const execution = this.activeExecutions.get(id);
        if (!execution || execution.released) return;
        execution.released = true;
        if (execution.outcomeSettled) this.activeExecutions.delete(id);
        this.drainQueue();
    }
}
