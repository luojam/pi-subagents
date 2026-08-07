import type { Usage } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import type { ExecutionRunner } from '../extensions/subagent/service.ts';
import { SubagentService } from '../extensions/subagent/service.ts';
import type {
    SubagentExecutionHandle,
    SubagentExecutionResult,
    SubagentRunnerOptions,
    SubagentRunOptions,
} from '../extensions/subagent/types.ts';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

class ControlledRunner implements ExecutionRunner {
    readonly outcome = deferred<SubagentExecutionResult>();
    readonly release = deferred<void>();
    options?: SubagentRunnerOptions;

    start(options: SubagentRunnerOptions): SubagentExecutionHandle {
        this.options = options;
        options.signal?.addEventListener(
            'abort',
            () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                this.outcome.reject(error);
            },
            { once: true }
        );
        return { outcome: this.outcome.promise, released: this.release.promise };
    }

    async shutdown(): Promise<void> {
        this.release.resolve();
    }
}

function request(task: string): SubagentRunOptions {
    return {
        task,
        cwd: '/project',
        model: { provider: 'test', id: 'model' },
        modelRegistry: {},
        thinkingLevel: 'off',
        projectTrusted: true,
    } as SubagentRunOptions;
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

it('admits queued runs FIFO only after physical capacity is released', async () => {
    const runners: ControlledRunner[] = [];
    let nextId = 1;
    const service = new SubagentService({
        concurrency: 1,
        createId: () => `run-${nextId++}`,
        childSessionDirectory: '/sessions',
        runnerFactory: () => {
            const runner = new ControlledRunner();
            runners.push(runner);
            return runner;
        },
    });

    const first = service.start(request('first'));
    const cancelled = service.start(request('cancel me'));
    const third = service.start(request('third'));

    expect(runners).toHaveLength(1);
    expect(service.get(cancelled.id)?.state).toBe('queued');
    expect(cancelled.cancel()).toBe(true);
    await expect(cancelled.result).rejects.toMatchObject({ name: 'AbortError' });

    runners[0].outcome.resolve({ text: 'first done', usage });
    await expect(first.result).resolves.toMatchObject({ text: 'first done' });
    await flushPromises();
    expect(runners).toHaveLength(1);
    expect(service.get(third.id)?.state).toBe('queued');

    runners[0].release.resolve();
    await flushPromises();
    expect(runners).toHaveLength(2);
    expect(runners[1].options?.task).toBe('third');

    runners[1].outcome.resolve({ text: 'third done', usage });
    runners[1].release.resolve();
    await expect(third.result).resolves.toMatchObject({ text: 'third done' });
    await service.shutdown();
});

it('admits up to the concurrency limit and waits for physical release before refilling', async () => {
    const runners: ControlledRunner[] = [];
    let nextId = 1;
    const service = new SubagentService({
        concurrency: 2,
        createId: () => `run-${nextId++}`,
        childSessionDirectory: '/sessions',
        runnerFactory: () => {
            const runner = new ControlledRunner();
            runners.push(runner);
            return runner;
        },
    });

    const first = service.start(request('first'));
    const second = service.start(request('second'));
    const third = service.start(request('third'));

    expect(runners).toHaveLength(2);
    expect(runners.map((runner) => runner.options?.task)).toEqual(['first', 'second']);
    expect(service.get(third.id)?.state).toBe('queued');

    runners[0].outcome.resolve({ text: 'first done', usage });
    await expect(first.result).resolves.toMatchObject({ text: 'first done' });
    await flushPromises();
    expect(runners).toHaveLength(2);
    expect(service.get(third.id)?.state).toBe('queued');

    runners[0].release.resolve();
    await flushPromises();
    expect(runners).toHaveLength(3);
    expect(runners[2].options?.task).toBe('third');

    runners[1].outcome.resolve({ text: 'second done', usage });
    runners[1].release.resolve();
    runners[2].outcome.resolve({ text: 'third done', usage });
    runners[2].release.resolve();
    await expect(second.result).resolves.toMatchObject({ text: 'second done' });
    await expect(third.result).resolves.toMatchObject({ text: 'third done' });
    await service.shutdown();
});

it('does not admit an aborted run when a queued subscriber increases concurrency', async () => {
    const runners: ControlledRunner[] = [];
    let nextId = 1;
    const service = new SubagentService({
        concurrency: 1,
        createId: () => `run-${nextId++}`,
        childSessionDirectory: '/sessions',
        runnerFactory: () => {
            const runner = new ControlledRunner();
            runners.push(runner);
            return runner;
        },
    });

    const active = service.start(request('active'));
    const controller = new AbortController();
    controller.abort();
    service.subscribe((snapshot) => {
        if (snapshot.task === 'already aborted' && snapshot.state === 'queued') {
            service.setConcurrency(2);
        }
    });

    const aborted = service.start({ ...request('already aborted'), signal: controller.signal });

    expect(runners).toHaveLength(1);
    expect(service.get(aborted.id)?.state).toBe('cancelled');
    await expect(aborted.result).rejects.toMatchObject({ name: 'AbortError' });

    runners[0].outcome.resolve({ text: 'done', usage });
    runners[0].release.resolve();
    await active.result;
    await service.shutdown();
});

it('immediately admits queued runs when concurrency increases', async () => {
    const runners: ControlledRunner[] = [];
    let nextId = 1;
    const service = new SubagentService({
        concurrency: 1,
        createId: () => `run-${nextId++}`,
        childSessionDirectory: '/sessions',
        runnerFactory: () => {
            const runner = new ControlledRunner();
            runners.push(runner);
            return runner;
        },
    });

    const runs = [
        service.start(request('first')),
        service.start(request('second')),
        service.start(request('third')),
    ];
    expect(runners).toHaveLength(1);

    service.setConcurrency(3);

    expect(runners).toHaveLength(3);
    expect(runners.map((runner) => runner.options?.task)).toEqual(['first', 'second', 'third']);
    for (const runner of runners) {
        runner.outcome.resolve({ text: 'done', usage });
        runner.release.resolve();
    }
    await Promise.all(runs.map((run) => run.result));
    await service.shutdown();
});

it('does not cancel or replace active runs when concurrency decreases', async () => {
    const runners: ControlledRunner[] = [];
    let nextId = 1;
    const service = new SubagentService({
        concurrency: 3,
        createId: () => `run-${nextId++}`,
        childSessionDirectory: '/sessions',
        runnerFactory: () => {
            const runner = new ControlledRunner();
            runners.push(runner);
            return runner;
        },
    });

    const activeRuns = [
        service.start(request('first')),
        service.start(request('second')),
        service.start(request('third')),
    ];
    const queued = service.start(request('queued'));
    expect(runners).toHaveLength(3);

    service.setConcurrency(1);

    expect(runners.every((runner) => runner.options?.signal?.aborted === false)).toBe(true);
    runners[0].release.resolve();
    await flushPromises();
    expect(runners).toHaveLength(3);
    expect(service.get(queued.id)?.state).toBe('queued');

    runners[1].release.resolve();
    await flushPromises();
    expect(runners).toHaveLength(3);
    expect(service.get(queued.id)?.state).toBe('queued');

    runners[2].release.resolve();
    await flushPromises();
    expect(runners).toHaveLength(4);
    expect(runners[3].options?.task).toBe('queued');

    for (const runner of runners) {
        runner.outcome.resolve({ text: 'done', usage });
        runner.release.resolve();
    }
    await Promise.all([...activeRuns, queued].map((run) => run.result));
    await service.shutdown();
});

it('rejects invalid concurrency reconfiguration', async () => {
    const service = new SubagentService();

    expect(() => service.setConcurrency(0)).toThrow('positive integer');
    expect(() => service.setConcurrency(-1)).toThrow('positive integer');
    expect(() => service.setConcurrency(1.5)).toThrow('positive integer');
    expect(() => service.setConcurrency(Number.NaN)).toThrow('positive integer');

    await service.shutdown();
});

it('registers an admitted runner before a synchronous subscriber can shut down', async () => {
    const outcome = deferred<SubagentExecutionResult>();
    const release = deferred<void>();
    let started = false;
    let stopped = false;
    const runner: ExecutionRunner = {
        start: () => {
            started = true;
            return { outcome: outcome.promise, released: release.promise };
        },
        shutdown: async () => {
            stopped = true;
            release.resolve();
        },
    };
    const service = new SubagentService({
        createId: () => 'run',
        childSessionDirectory: '/sessions',
        runnerFactory: () => runner,
    });
    let shutdownPromise: Promise<void> | undefined;
    service.subscribe((snapshot) => {
        if (snapshot.state === 'starting') shutdownPromise = service.shutdown();
    });

    const run = service.start(request('reentrant shutdown'));
    expect(shutdownPromise).toBeDefined();
    await shutdownPromise;

    expect(started).toBe(false);
    expect(stopped).toBe(true);
    await expect(run.result).rejects.toMatchObject({ name: 'AbortError' });
});

it('shutdown finalizes a logical run after its runner shuts down without an outcome', async () => {
    const outcome = deferred<SubagentExecutionResult>();
    const release = deferred<void>();
    const runner: ExecutionRunner = {
        start: () => ({ outcome: outcome.promise, released: release.promise }),
        shutdown: async () => release.resolve(),
    };
    const service = new SubagentService({
        createId: () => 'run',
        childSessionDirectory: '/sessions',
        runnerFactory: () => runner,
    });
    const run = service.start(request('non-settling outcome'));

    await service.shutdown();

    await expect(run.result).rejects.toMatchObject({ name: 'AbortError' });
    expect(service.get(run.id)?.state).toBe('cancelled');
});

it('shutdown retains and aborts an execution whose capacity was released first', async () => {
    const runner = new ControlledRunner();
    const service = new SubagentService({
        createId: () => 'run',
        childSessionDirectory: '/sessions',
        runnerFactory: () => runner,
    });
    const run = service.start(request('release before shutdown'));

    runner.release.resolve();
    await flushPromises();
    await service.shutdown();

    expect(runner.options?.signal?.aborted).toBe(true);
    await expect(run.result).rejects.toMatchObject({ name: 'AbortError' });
    expect(service.get(run.id)?.state).toBe('cancelled');
});

it('preserves a cancellation requested after release but before outcome delivery', async () => {
    const runner = new ControlledRunner();
    const service = new SubagentService({
        createId: () => 'run',
        childSessionDirectory: '/sessions',
        runnerFactory: () => runner,
    });
    const run = service.start(request('race cancellation'));

    runner.release.resolve();
    await flushPromises();
    expect(run.cancel()).toBe(true);
    expect(service.get(run.id)?.state).toBe('cancelling');

    runner.outcome.resolve({ text: 'too late', usage });
    await expect(run.result).rejects.toMatchObject({ name: 'AbortError' });
    expect(service.get(run.id)?.state).toBe('cancelled');
    await service.shutdown();
});
