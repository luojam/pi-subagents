import type { Usage } from '@earendil-works/pi-ai';
import type { AgentSessionRuntime } from '@earendil-works/pi-coding-agent';
import { beforeEach, expect, it, vi } from 'vitest';
import type {
    ChildSessionLifecycle,
    ChildSessionResource,
} from '../extensions/subagent/child-session.ts';
import { SubagentRunner } from '../extensions/subagent/runner.ts';
import type {
    SubagentExecutionResult,
    SubagentRunnerOptions,
} from '../extensions/subagent/types.ts';

const childSessionMock = vi.hoisted(() => {
    const executions: Array<{
        promise: Promise<SubagentExecutionResult>;
        resolve(value: SubagentExecutionResult): void;
        reject(error: unknown): void;
        signal: AbortSignal;
        lifecycle: ChildSessionLifecycle;
    }> = [];
    return {
        executions,
        runChildSession: vi.fn(
            (
                options: SubagentRunnerOptions,
                signal: AbortSignal,
                lifecycle: ChildSessionLifecycle
            ) => {
                let resolve!: (value: SubagentExecutionResult) => void;
                let reject!: (error: unknown) => void;
                const promise = new Promise<SubagentExecutionResult>(
                    (resolvePromise, rejectPromise) => {
                        resolve = resolvePromise;
                        reject = rejectPromise;
                    }
                );
                executions.push({ promise, resolve, reject, signal, lifecycle });
                options.onEvent?.({ type: 'setup_started' });
                return promise;
            }
        ),
    };
});

vi.mock('../extensions/subagent/child-session.ts', () => ({
    SHUTDOWN_GRACE_MS: 50,
    runChildSession: childSessionMock.runChildSession,
}));

const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function deferred<T>(): {
    promise: Promise<T>;
    resolve(value: T): void;
} {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function mockRuntime(dispose: () => Promise<void> = async () => undefined): {
    runtime: AgentSessionRuntime;
    abort: ReturnType<typeof vi.fn<() => Promise<void>>>;
    disposeSession: ReturnType<typeof vi.fn<() => void>>;
    disposeRuntime: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
    const abort = vi.fn(async () => undefined);
    const disposeSession = vi.fn(() => undefined);
    const disposeRuntime = vi.fn(dispose);
    return {
        runtime: {
            session: { abort, dispose: disposeSession },
            dispose: disposeRuntime,
        } as unknown as AgentSessionRuntime,
        abort,
        disposeSession,
        disposeRuntime,
    };
}

function request(task: string): SubagentRunnerOptions {
    return {
        task,
        cwd: '/project',
        model: { provider: 'test', id: 'model' },
        modelRegistry: {},
        thinkingLevel: 'off',
        projectTrusted: true,
        childSessionDirectory: '/sessions',
    } as SubagentRunnerOptions;
}

beforeEach(() => {
    childSessionMock.executions.length = 0;
    childSessionMock.runChildSession.mockClear();
});

it('owns exactly one execution', async () => {
    const runner = new SubagentRunner();
    const handle = runner.start(request('first'));

    expect(() => runner.start(request('second'))).toThrow(
        'A SubagentRunner can execute only one run'
    );

    const result: SubagentExecutionResult = { text: 'done', usage };
    childSessionMock.executions[0].resolve(result);
    await expect(handle.outcome).resolves.toEqual(result);
    await expect(handle.released).resolves.toBeUndefined();
    await runner.shutdown();
});

it('does not release ownership until runtime disposal settles', async () => {
    const runtimeDisposal = deferred<void>();
    const { runtime, disposeRuntime, disposeSession } = mockRuntime(() => runtimeDisposal.promise);
    const runner = new SubagentRunner();
    const handle = runner.start(request('wait for disposal'));
    const resource: ChildSessionResource =
        childSessionMock.executions[0].lifecycle.adoptRuntime(runtime);

    const result: SubagentExecutionResult = { text: 'done', usage };
    childSessionMock.executions[0].resolve(result);
    await expect(handle.outcome).resolves.toEqual(result);

    let released = false;
    void handle.released.then(() => {
        released = true;
    });
    const disposal = resource.dispose();
    await Promise.resolve();

    expect(disposeRuntime).toHaveBeenCalledOnce();
    expect(disposeSession).not.toHaveBeenCalled();
    expect(released).toBe(false);

    runtimeDisposal.resolve();
    await disposal;
    await expect(handle.released).resolves.toBeUndefined();
});

it('force-disposes an owned runtime after the shutdown grace timeout', async () => {
    vi.useFakeTimers();
    try {
        const { runtime, abort, disposeRuntime, disposeSession } = mockRuntime();
        const runner = new SubagentRunner();
        const handle = runner.start(request('force disposal'));
        childSessionMock.executions[0].lifecycle.adoptRuntime(runtime);

        const outcome = expect(handle.outcome).rejects.toMatchObject({ name: 'AbortError' });
        const shutdown = runner.shutdown();
        expect(abort).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(50);
        await shutdown;
        await outcome;

        expect(disposeSession).toHaveBeenCalledOnce();
        expect(disposeRuntime).not.toHaveBeenCalled();
        await expect(handle.released).resolves.toBeUndefined();
    } finally {
        vi.useRealTimers();
    }
});

it('tracks a start before a synchronous setup event can invoke shutdown', async () => {
    const runner = new SubagentRunner();
    let shutdownPromise: Promise<void> | undefined;
    const handle = runner.start({
        ...request('reentrant shutdown'),
        onEvent: (event) => {
            if (event.type === 'setup_started') shutdownPromise = runner.shutdown();
        },
    });

    expect(shutdownPromise).toBeDefined();
    expect(childSessionMock.executions[0].signal.aborted).toBe(true);
    await expect(handle.outcome).rejects.toMatchObject({ name: 'AbortError' });

    let shutdownSettled = false;
    void shutdownPromise?.then(() => {
        shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    childSessionMock.executions[0].resolve({ text: 'late result', usage });
    await shutdownPromise;
    await expect(handle.released).resolves.toBeUndefined();
});
