import { writeFileSync } from 'node:fs';
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
import { observeSubagentSession } from './session-observer.ts';
import { truncateModelOutput } from './text-policy.ts';
import type {
    SubagentExecutionResult,
    SubagentRunnerEvent,
    SubagentRunnerOptions,
} from './types.ts';
import { usageFromEntries } from './usage.ts';

export const SHUTDOWN_GRACE_MS = 3_000;

export interface ChildSessionResource {
    readonly session: AgentSession;
    abort(): Promise<void>;
    dispose(): Promise<void>;
}

export interface ChildSessionLifecycle {
    isShuttingDown(): boolean;
    adoptRuntime(runtime: AgentSessionRuntime): ChildSessionResource;
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
        agentsFiles: base.agentsFiles.filter(
            (file) => dirname(resolve(file.path)) === resolve(agentDir)
        ),
    });
}

function createPersistentSessionManager(cwd: string, sessionDirectory: string): SessionManager {
    const sessionManager = SessionManager.create(cwd, sessionDirectory);
    const sessionFile = sessionManager.getSessionFile();
    const header = sessionManager.getHeader();
    if (!sessionFile || !header) {
        throw new Error('Persistent subagent session did not expose a session header');
    }

    // SessionManager.create() reserves a path but delays creating the JSONL until
    // the first assistant message. Materialize the header, then reopen it through
    // the public API so SessionManager also records that the file is flushed.
    writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { flag: 'wx' });
    sessionManager.setSessionFile(sessionFile);
    return sessionManager;
}

function createChildRuntime(
    options: SubagentRunnerOptions,
    inheritedRuntime: InheritedModelRuntimeSetup
): Promise<AgentSessionRuntime> {
    const { modelRuntime, inheritedProvider } = inheritedRuntime;
    const agentDir = getAgentDir();
    const sessionManager = createPersistentSessionManager(
        options.cwd,
        options.childSessionDirectory
    );

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
    const resource = lifecycle.adoptRuntime(runtime);
    try {
        await settleWithin([resource.abort()], SHUTDOWN_GRACE_MS);
    } finally {
        // AgentSessionRuntime emits session_shutdown before releasing the session.
        await resource.dispose();
    }
}

/** Create, observe, run, and dispose exactly one child session. */
export async function runChildSession(
    options: SubagentRunnerOptions,
    signal: AbortSignal,
    lifecycle: ChildSessionLifecycle
): Promise<SubagentExecutionResult> {
    validateCanContinue(signal, lifecycle);

    const emit = (event: SubagentRunnerEvent): void => {
        try {
            options.onEvent?.(event);
        } catch {
            // Observations are best-effort and must not affect execution or cleanup.
        }
    };
    emit({ type: 'setup_started' });

    const inheritedRuntimeCreation = createInheritedModelRuntime(
        options.modelRegistry,
        options.model
    );
    let inheritedRuntime: InheritedModelRuntimeSetup;
    try {
        inheritedRuntime = await raceWithAbort(inheritedRuntimeCreation, signal);
    } catch (error) {
        if (signal.aborted) {
            // The externally visible outcome is already cancelled by SubagentRunner.
            // Keep this physical execution alive until non-abort-aware setup settles.
            await settled(inheritedRuntimeCreation);
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
            // Do not settle the physical execution until a runtime created after
            // cancellation has been adopted and disposed.
            await runtimeCreation
                .then(
                    (lateRuntime) => disposeLateRuntime(lateRuntime, lifecycle),
                    () => undefined
                )
                .catch(() => undefined);
            throw createAbortError();
        }
        throw error;
    }

    const resource = lifecycle.adoptRuntime(runtime);
    const session = resource.session;
    let lastStopReason: string | undefined;
    let lastErrorMessage: string | undefined;
    let unsubscribe = (): void => {};
    let abortPromise: Promise<void> | undefined;
    let executionError: unknown;

    const abort = () => {
        abortPromise ??= resource.abort();
        void abortPromise.catch(() => undefined);
    };

    try {
        if (!session.sessionFile) {
            throw new Error('Persistent subagent session did not expose a session file');
        }
        emit({
            type: 'session_ready',
            sessionId: session.sessionId,
            sessionFile: session.sessionFile,
        });

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

        const binding = session.bindExtensions({});
        try {
            await raceWithAbort(binding, signal);
        } catch (error) {
            if (!signal.aborted) throw error;

            // Extension binding is not abort-aware. Keep the physical execution
            // pending so disposal cannot race a handler which is still mutating state.
            await settled(binding);
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
        signal.removeEventListener('abort', abort);
        if (abortPromise) await Promise.allSettled([abortPromise]);
        let cleanupError: unknown;
        try {
            unsubscribe();
        } catch (error) {
            cleanupError = error;
        }
        try {
            await resource.dispose();
        } catch (error) {
            cleanupError ??= error;
        }
        // Cleanup failure should fail an otherwise successful run, but it must
        // not hide an AbortError (or another primary execution error).
        // biome-ignore lint/correctness/noUnsafeFinally: overriding a successful return is intentional.
        if (executionError === undefined && cleanupError !== undefined) throw cleanupError;
    }
}
