import { dirname, resolve } from 'node:path';
import {
    type AgentSession,
    type AgentSessionRuntime,
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
    getAgentDir,
    SessionManager,
    SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { createInheritedModelRuntime, type InheritedModelRuntimeSetup } from './model-runtime.ts';
import { getSubagentSystemPrompt } from './prompts.ts';
import { truncateModelOutput, usageFromEntries } from './run-utils.ts';
import { observeSubagentSession } from './session-observer.ts';
import type { SubagentRunnerEvent, SubagentRunnerOptions, SubagentRunnerResult } from './types.ts';

export const SHUTDOWN_GRACE_MS = 3_000;

export interface ChildSessionLifecycle {
    isShuttingDown(): boolean;
    addActiveSession(session: AgentSession): void;
    removeActiveSession(session: AgentSession): void;
    trackCleanup(cleanup: Promise<void>): void;
    holdSerialGateUntil(cleanup: Promise<void>): void;
}

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

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(createAbortError());

    return new Promise((resolvePromise, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(createAbortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolvePromise(value);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            }
        );
    });
}

function settled(promise: Promise<unknown>): Promise<void> {
    return promise.then(
        () => undefined,
        () => undefined
    );
}

function validateCanContinue(signal: AbortSignal, lifecycle: ChildSessionLifecycle): void {
    if (signal.aborted) throw createAbortError();
    if (lifecycle.isShuttingDown()) throw new Error('Subagent runner is shutting down');
}

function trustedAgentsFilesOverride(agentDir: string, projectTrusted: boolean) {
    if (projectTrusted) return undefined;
    return (base: { agentsFiles: Array<{ path: string; content: string }> }) => ({
        // Default discovery always includes project AGENTS.md files. Preserve only
        // trusted global context when the parent has not trusted this project.
        agentsFiles: base.agentsFiles.filter(
            (file) => dirname(resolve(file.path)) === resolve(agentDir)
        ),
    });
}

function createChildRuntime(
    options: SubagentRunnerOptions,
    inheritedRuntime: InheritedModelRuntimeSetup
): Promise<AgentSessionRuntime> {
    const { modelRuntime, inheritedProvider } = inheritedRuntime;
    const agentDir = getAgentDir();
    const sessionManager = SessionManager.inMemory(options.cwd);

    return createAgentSessionRuntime(
        async ({
            cwd,
            agentDir: runtimeAgentDir,
            sessionManager: runtimeSessionManager,
            sessionStartEvent,
        }) => {
            const settingsManager = SettingsManager.create(cwd, runtimeAgentDir, {
                projectTrusted: options.projectTrusted,
            });
            const services = await createAgentSessionServices({
                cwd,
                agentDir: runtimeAgentDir,
                modelRuntime,
                settingsManager,
                resourceLoaderOptions: {
                    appendSystemPrompt: [getSubagentSystemPrompt()],
                    agentsFilesOverride: trustedAgentsFilesOverride(
                        runtimeAgentDir,
                        options.projectTrusted
                    ),
                },
            });

            // Child extension discovery can register the selected provider ID,
            // replacing or composing over the inherited auth proxy. Put the same
            // child-owned proxy back last so the parent provider snapshot remains
            // the effective provider used by this session.
            services.modelRuntime.registerNativeProvider(inheritedProvider);

            return {
                ...(await createAgentSessionFromServices({
                    services,
                    sessionManager: runtimeSessionManager,
                    model: options.model,
                    thinkingLevel: options.thinkingLevel,
                    excludeTools: ['subagent'],
                    sessionStartEvent,
                })),
                services,
                diagnostics: services.diagnostics,
            };
        },
        { cwd: options.cwd, agentDir, sessionManager }
    );
}

function assertSubagentToolExcluded(session: AgentSession): void {
    if (
        session.getActiveToolNames().includes('subagent') ||
        session.getAllTools().some((tool) => tool.name === 'subagent')
    ) {
        throw new Error('Subagent tool exclusion was not preserved in the child session');
    }
}

async function disposeLateRuntime(
    runtime: AgentSessionRuntime,
    lifecycle: ChildSessionLifecycle
): Promise<void> {
    const session = runtime.session;
    lifecycle.addActiveSession(session);
    try {
        await settleWithin([session.abort()], SHUTDOWN_GRACE_MS);
        // AgentSessionRuntime emits session_shutdown before releasing the session.
        await runtime.dispose();
    } finally {
        lifecycle.removeActiveSession(session);
    }
}

/** Create, observe, run, and dispose exactly one child session. */
export async function runChildSession(
    options: SubagentRunnerOptions,
    signal: AbortSignal,
    lifecycle: ChildSessionLifecycle
): Promise<SubagentRunnerResult> {
    validateCanContinue(signal, lifecycle);

    const emit = (event: SubagentRunnerEvent): void => options.onEvent?.(event);
    emit({ type: 'setup_started' });

    // Parent auth resolution and ModelRuntime.create() are not abort-aware. Return
    // cancellation promptly, but preserve serial isolation until setup settles.
    const inheritedRuntimeCreation = createInheritedModelRuntime(
        options.modelRegistry,
        options.model
    );
    let inheritedRuntime: InheritedModelRuntimeSetup;
    try {
        inheritedRuntime = await raceWithAbort(inheritedRuntimeCreation, signal);
    } catch (error) {
        if (signal.aborted) {
            lifecycle.holdSerialGateUntil(settled(inheritedRuntimeCreation));
            throw createAbortError();
        }
        throw error;
    }
    validateCanContinue(signal, lifecycle);

    // Service creation loads cwd-bound resources once inside the SDK helper. If
    // cancellation wins, let creation finish and dispose any session it creates.
    const runtimeCreation = createChildRuntime(options, inheritedRuntime);
    let runtime: AgentSessionRuntime;
    try {
        runtime = await raceWithAbort(runtimeCreation, signal);
    } catch (error) {
        if (signal.aborted) {
            const lateCleanup = runtimeCreation.then(
                (lateRuntime) => disposeLateRuntime(lateRuntime, lifecycle),
                () => undefined
            );
            lifecycle.holdSerialGateUntil(lateCleanup);
            throw createAbortError();
        }
        throw error;
    }

    const session = runtime.session;
    lifecycle.addActiveSession(session);
    emit({ type: 'session_ready', sessionId: session.sessionId });

    let finishCleanup!: () => void;
    const cleanupDone = new Promise<void>((resolveCleanup) => {
        finishCleanup = resolveCleanup;
    });
    lifecycle.trackCleanup(cleanupDone);

    let lastStopReason: string | undefined;
    let lastErrorMessage: string | undefined;
    let unsubscribe = (): void => {};
    let abortPromise: Promise<void> | undefined;
    let cleanupPromise: Promise<void> | undefined;
    let cleanupTransferred = false;
    let executionError: unknown;

    const abort = () => {
        abortPromise ??= session.abort();
        void abortPromise.catch(() => undefined);
    };
    const cleanupSession = (): Promise<void> =>
        (cleanupPromise ??= (async () => {
            try {
                signal.removeEventListener('abort', abort);
                if (abortPromise) await Promise.allSettled([abortPromise]);
                unsubscribe();
                // Runtime disposal emits child session_shutdown before releasing
                // AgentSession resources.
                await runtime.dispose();
            } finally {
                lifecycle.removeActiveSession(session);
                finishCleanup();
            }
        })());

    try {
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) {
            abort();
            throw createAbortError();
        }
        if (lifecycle.isShuttingDown()) {
            abort();
            throw new Error('Subagent runner is shutting down');
        }

        unsubscribe = observeSubagentSession(session, emit, (completion) => {
            lastStopReason = completion.stopReason;
            lastErrorMessage = completion.errorMessage;
        });

        // Binding emits session_start/resources_discover and can run asynchronous
        // handlers. Never dispose concurrently with a handler still mutating state.
        const binding = session.bindExtensions({});
        try {
            await raceWithAbort(binding, signal);
        } catch (error) {
            if (!signal.aborted) throw error;

            cleanupTransferred = true;
            const lateCleanup = binding.then(cleanupSession, cleanupSession);
            lifecycle.holdSerialGateUntil(lateCleanup);
            throw createAbortError();
        }
        validateCanContinue(signal, lifecycle);
        assertSubagentToolExcluded(session);

        await session.prompt(`Task: ${options.task}`, {
            expandPromptTemplates: false,
        });
        if (signal.aborted) throw createAbortError();

        if (lastStopReason === 'aborted') {
            throw createAbortError(lastErrorMessage || 'Subagent was aborted');
        }
        if (lastStopReason === 'error') {
            throw new Error(lastErrorMessage || 'Subagent stopped with an error');
        }

        const text = session.getLastAssistantText();
        if (!text) throw new Error('Subagent completed without an assistant response');

        emit({ type: 'stats_refreshed', stats: session.getSessionStats() });
        return {
            text: truncateModelOutput(text),
            usage: usageFromEntries(session.sessionManager.getEntries()),
        };
    } catch (error) {
        executionError = signal.aborted ? createAbortError() : error;
        throw executionError;
    } finally {
        if (!cleanupTransferred) {
            try {
                await cleanupSession();
            } catch (cleanupError) {
                // Cleanup failure should fail an otherwise successful run, but it
                // must not hide an AbortError (or another primary execution error).
                // biome-ignore lint/correctness/noUnsafeFinally: overriding a successful return is intentional.
                if (executionError === undefined) throw cleanupError;
            }
        }
    }
}
