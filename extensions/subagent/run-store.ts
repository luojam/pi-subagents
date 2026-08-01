import {
    appendStreamedText,
    sanitizeError,
    sanitizeModelPart,
    sanitizePath,
    sanitizeTask,
    sanitizeToolName,
    summarizeToolArguments,
    summarizeToolProgress,
} from './text-policy.ts';
import type {
    RelevantSubagentRun,
    RunId,
    SubagentRunnerEvent,
    SubagentRunOptions,
    SubagentRunSnapshot,
    SubagentRunState,
    SubagentToolCallSnapshot,
} from './types.ts';

const TICK_MS = 1_000;
const TEXT_UPDATE_THROTTLE_MS = 100;
const MAX_RECENT_TOOLS = 10;

const TERMINAL_STATES = new Set<SubagentRunState>([
    'completed',
    'failed',
    'cancelled',
    'interrupted',
]);

export function isTerminalRunState(state: SubagentRunState): boolean {
    return TERMINAL_STATES.has(state);
}

interface StoredRun extends SubagentRunSnapshot {
    /** Serializable parallel-tool state which is intentionally omitted from public snapshots. */
    readonly activeToolCalls: readonly SubagentToolCallSnapshot[];
}

export type RunTransition =
    | { readonly type: 'admitted' }
    | { readonly type: 'runner_event'; readonly event: SubagentRunnerEvent }
    | { readonly type: 'cancel_requested' }
    | { readonly type: 'completed' }
    | { readonly type: 'failed'; readonly error: unknown }
    | { readonly type: 'cancelled'; readonly error?: unknown }
    | { readonly type: 'interrupted'; readonly error?: unknown }
    | { readonly type: 'tick' };

export interface RunStoreOptions {
    now?: () => number;
    tickMs?: number;
    textUpdateThrottleMs?: number;
}

type RunListener = (snapshot: SubagentRunSnapshot) => void;
type StoreListener = (snapshot: SubagentRunSnapshot) => void;

function freezeTool(tool: SubagentToolCallSnapshot): SubagentToolCallSnapshot {
    return Object.freeze({ ...tool });
}

function freezeRun(run: StoredRun): StoredRun {
    const activeToolCalls = Object.freeze(run.activeToolCalls.map(freezeTool));
    const currentTool = activeToolCalls.at(-1);
    const frozen: StoredRun = {
        ...run,
        model: Object.freeze({ ...run.model }),
        ...(currentTool ? { currentTool } : {}),
        recentToolCalls: Object.freeze(run.recentToolCalls.map(freezeTool)),
        activeToolCalls,
        ...(run.contextUsage ? { contextUsage: Object.freeze({ ...run.contextUsage }) } : {}),
        ...(run.usage ? { usage: Object.freeze({ ...run.usage }) } : {}),
    };
    const optionalKeys = [
        'threadId',
        'sessionId',
        'sessionFile',
        'startedAt',
        'endedAt',
        'currentTool',
        'contextUsage',
        'usage',
        'error',
    ] as const;
    for (const key of optionalKeys) {
        if (frozen[key] === undefined) delete frozen[key];
    }
    return Object.freeze(frozen);
}

function publicSnapshot(run: StoredRun): SubagentRunSnapshot {
    const { activeToolCalls: _activeToolCalls, ...snapshot } = run;
    return Object.freeze(snapshot);
}

function elapsed(run: StoredRun, now: number, endedAt = run.endedAt): number {
    return Math.max(0, (endedAt ?? now) - (run.startedAt ?? run.queuedAt));
}

function finishActiveTools(run: StoredRun, now: number): readonly SubagentToolCallSnapshot[] {
    return [
        ...[...run.activeToolCalls]
            .reverse()
            .map((tool) => freezeTool({ ...tool, state: 'failed', endedAt: tool.endedAt ?? now })),
        ...run.recentToolCalls,
    ].slice(0, MAX_RECENT_TOOLS);
}

function terminalTransition(
    run: StoredRun,
    state: Extract<SubagentRunState, 'completed' | 'failed' | 'cancelled' | 'interrupted'>,
    now: number,
    error?: unknown
): StoredRun {
    const endedAt = now;
    return freezeRun({
        ...run,
        state,
        endedAt,
        elapsedMs: elapsed(run, now, endedAt),
        activeToolCalls: [],
        currentTool: undefined,
        recentToolCalls: finishActiveTools(run, now),
        ...(state === 'completed'
            ? { error: undefined }
            : { error: sanitizeError(error ?? `Subagent ${state}`) }),
    });
}

/** Pure logical transition. Events after a terminal state are ignored. */
function reduceRun(run: StoredRun, transition: RunTransition, now: number): StoredRun {
    if (isTerminalRunState(run.state)) return run;

    if (transition.type === 'admitted') {
        return freezeRun({
            ...run,
            state: 'starting',
            startedAt: run.startedAt ?? now,
            elapsedMs: elapsed({ ...run, startedAt: run.startedAt ?? now }, now),
        });
    }
    if (transition.type === 'cancel_requested') {
        if (run.state === 'queued') return terminalTransition(run, 'cancelled', now);
        if (run.state === 'cancelling') return run;
        return freezeRun({ ...run, state: 'cancelling', elapsedMs: elapsed(run, now) });
    }
    if (transition.type === 'completed') return terminalTransition(run, 'completed', now);
    if (transition.type === 'failed') {
        return terminalTransition(run, 'failed', now, transition.error);
    }
    if (transition.type === 'cancelled') {
        return terminalTransition(run, 'cancelled', now, transition.error);
    }
    if (transition.type === 'interrupted') {
        return terminalTransition(run, 'interrupted', now, transition.error);
    }
    if (transition.type === 'tick') {
        return freezeRun({ ...run, elapsedMs: elapsed(run, now) });
    }

    const event = transition.event;
    let next = run;
    switch (event.type) {
        case 'setup_started':
            next = {
                ...run,
                state: run.state === 'cancelling' ? 'cancelling' : 'starting',
                startedAt: run.startedAt ?? now,
            };
            break;
        case 'session_ready':
            next = {
                ...run,
                sessionId: event.sessionId,
                sessionFile: event.sessionFile,
                state: run.state === 'cancelling' ? 'cancelling' : 'running',
                startedAt: run.startedAt ?? now,
            };
            break;
        case 'turn_started':
            next = {
                ...run,
                state: run.state === 'cancelling' ? 'cancelling' : 'running',
                startedAt: run.startedAt ?? now,
                turn: run.turn + 1,
            };
            break;
        case 'turn_ended':
            break;
        case 'thinking_delta':
            next = {
                ...run,
                thinkingTail: appendStreamedText(run.thinkingTail, event.delta),
            };
            break;
        case 'text_delta':
            next = { ...run, responseTail: appendStreamedText(run.responseTail, event.delta) };
            break;
        case 'tool_started': {
            const tool = freezeTool({
                id: event.toolCallId,
                name: sanitizeToolName(event.toolName),
                inputSummary: summarizeToolArguments(event.toolName, event.args),
                state: 'running',
                startedAt: now,
            });
            next = { ...run, activeToolCalls: [...run.activeToolCalls, tool], currentTool: tool };
            break;
        }
        case 'tool_updated': {
            const progressSummary = summarizeToolProgress(event.partialResult);
            const activeToolCalls = run.activeToolCalls.map((tool) =>
                tool.id === event.toolCallId
                    ? freezeTool({
                          ...tool,
                          ...(progressSummary === undefined ? {} : { progressSummary }),
                      })
                    : tool
            );
            next = { ...run, activeToolCalls, currentTool: activeToolCalls.at(-1) };
            break;
        }
        case 'tool_ended': {
            const tool = run.activeToolCalls.find((candidate) => candidate.id === event.toolCallId);
            if (!tool) break;
            const completed = freezeTool({
                ...tool,
                state: event.isError ? 'failed' : 'completed',
                endedAt: now,
            });
            const activeToolCalls = run.activeToolCalls.filter(
                (candidate) => candidate.id !== event.toolCallId
            );
            next = {
                ...run,
                activeToolCalls,
                currentTool: activeToolCalls.at(-1),
                recentToolCalls: [completed, ...run.recentToolCalls].slice(0, MAX_RECENT_TOOLS),
            };
            break;
        }
        case 'stats_refreshed':
            next = {
                ...run,
                contextUsage: event.stats.contextUsage
                    ? Object.freeze({ ...event.stats.contextUsage })
                    : undefined,
                usage: Object.freeze({
                    input: event.stats.tokens.input,
                    output: event.stats.tokens.output,
                    cacheRead: event.stats.tokens.cacheRead,
                    cacheWrite: event.stats.tokens.cacheWrite,
                    total: event.stats.tokens.total,
                    cost: event.stats.cost,
                }),
            };
            break;
    }

    return freezeRun({ ...next, elapsedMs: elapsed(next, now) });
}

export class RunStore {
    private readonly runs = new Map<RunId, StoredRun>();
    private readonly runListeners = new Map<RunId, Set<RunListener>>();
    private readonly listeners = new Set<StoreListener>();
    private readonly now: () => number;
    private readonly tickMs: number;
    private readonly textUpdateThrottleMs: number;
    private tickTimer: NodeJS.Timeout | undefined;
    private readonly textUpdateTimers = new Map<RunId, NodeJS.Timeout>();
    private readonly publicationQueue: StoredRun[] = [];
    private publishing = false;
    private disposed = false;

    constructor(options: RunStoreOptions = {}) {
        this.now = options.now ?? Date.now;
        this.tickMs = options.tickMs ?? TICK_MS;
        this.textUpdateThrottleMs = options.textUpdateThrottleMs ?? TEXT_UPDATE_THROTTLE_MS;
    }

    create(id: RunId, options: SubagentRunOptions): SubagentRunSnapshot {
        if (this.disposed) throw new Error('Run store is disposed');
        if (this.runs.has(id)) throw new Error(`Duplicate subagent run id: ${id}`);
        const queuedAt = this.now();
        const run = freezeRun({
            id,
            state: 'queued',
            task: sanitizeTask(options.task),
            cwd: sanitizePath(options.cwd),
            model: {
                provider: sanitizeModelPart(options.model.provider),
                id: sanitizeModelPart(options.model.id),
            },
            thinkingLevel: options.thinkingLevel,
            queuedAt,
            elapsedMs: 0,
            turn: 0,
            activeToolCalls: [],
            recentToolCalls: [],
            thinkingTail: '',
            responseTail: '',
        });
        this.runs.set(id, run);
        this.ensureTicking();
        this.publish(run);
        return publicSnapshot(run);
    }

    apply(id: RunId, transition: RunTransition): SubagentRunSnapshot | undefined {
        const current = this.runs.get(id);
        if (!current || this.disposed) return undefined;
        const next = reduceRun(current, transition, this.now());
        if (next === current) return publicSnapshot(current);
        this.runs.set(id, next);

        const isText =
            transition.type === 'runner_event' &&
            (transition.event.type === 'thinking_delta' || transition.event.type === 'text_delta');
        if (isText && !isTerminalRunState(next.state)) this.scheduleTextUpdate(next);
        else {
            this.cancelTextUpdate(id);
            this.publish(next);
        }
        if (
            isTerminalRunState(next.state) &&
            !this.getActive().length &&
            !this.getQueued().length
        ) {
            this.stopTicking();
        }
        return publicSnapshot(next);
    }

    get(id: RunId): SubagentRunSnapshot | undefined {
        const run = this.runs.get(id);
        return run ? publicSnapshot(run) : undefined;
    }

    list(): readonly SubagentRunSnapshot[] {
        return Object.freeze(
            [...this.runs.values()]
                .sort((left, right) => left.queuedAt - right.queuedAt)
                .map(publicSnapshot)
        );
    }

    getQueued(limit = Number.POSITIVE_INFINITY): readonly SubagentRunSnapshot[] {
        return Object.freeze(
            this.list()
                .filter((run) => run.state === 'queued')
                .slice(0, Math.max(0, limit))
        );
    }

    getActive(): readonly SubagentRunSnapshot[] {
        return Object.freeze(
            this.list().filter(
                (run) =>
                    run.state === 'starting' ||
                    run.state === 'running' ||
                    run.state === 'cancelling'
            )
        );
    }

    getRelevant(): RelevantSubagentRun {
        const active = this.getActive()[0];
        const queued = this.getQueued();
        return Object.freeze({
            ...((active ?? queued[0]) ? { snapshot: active ?? queued[0] } : {}),
            queuedCount: queued.length,
        });
    }

    subscribe(listener: StoreListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    subscribeRun(id: RunId, listener: RunListener): () => void {
        const listeners = this.runListeners.get(id) ?? new Set<RunListener>();
        listeners.add(listener);
        this.runListeners.set(id, listeners);
        const run = this.runs.get(id);
        if (run) this.callListener(listener, publicSnapshot(run));
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) this.runListeners.delete(id);
        };
    }

    dispose(): void {
        this.disposed = true;
        this.stopTicking();
        for (const timer of this.textUpdateTimers.values()) clearTimeout(timer);
        this.textUpdateTimers.clear();
        this.publicationQueue.length = 0;
        this.runListeners.clear();
        this.listeners.clear();
    }

    private scheduleTextUpdate(run: StoredRun): void {
        if (this.textUpdateTimers.has(run.id) || this.disposed) return;
        const timer = setTimeout(() => {
            this.textUpdateTimers.delete(run.id);
            const latest = this.runs.get(run.id);
            if (latest && !isTerminalRunState(latest.state)) this.publish(latest);
        }, this.textUpdateThrottleMs);
        this.textUpdateTimers.set(run.id, timer);
    }

    private cancelTextUpdate(id: RunId): void {
        const timer = this.textUpdateTimers.get(id);
        if (!timer) return;
        clearTimeout(timer);
        this.textUpdateTimers.delete(id);
    }

    private ensureTicking(): void {
        if (this.tickTimer || this.disposed) return;
        this.tickTimer = setInterval(() => {
            let changed = false;
            for (const [id, run] of this.runs) {
                if (isTerminalRunState(run.state)) continue;
                const next = reduceRun(run, { type: 'tick' }, this.now());
                this.runs.set(id, next);
                this.publish(next);
                changed = true;
            }
            if (!changed) this.stopTicking();
        }, this.tickMs);
    }

    private stopTicking(): void {
        if (!this.tickTimer) return;
        clearInterval(this.tickTimer);
        this.tickTimer = undefined;
    }

    private publish(run: StoredRun): void {
        if (this.disposed) return;
        this.publicationQueue.push(run);
        if (this.publishing) return;

        this.publishing = true;
        try {
            while (!this.disposed) {
                const next = this.publicationQueue.shift();
                if (!next) break;
                const snapshot = publicSnapshot(next);
                this.publishRun(next);
                for (const listener of this.listeners) this.callListener(listener, snapshot);
            }
        } finally {
            this.publishing = false;
            if (this.disposed) this.publicationQueue.length = 0;
        }
    }

    private publishRun(run: StoredRun): void {
        const snapshot = publicSnapshot(run);
        for (const listener of this.runListeners.get(run.id) ?? []) {
            this.callListener(listener, snapshot);
        }
    }

    private callListener(listener: RunListener, snapshot: SubagentRunSnapshot): void {
        try {
            listener(snapshot);
        } catch {
            // Observation is best-effort and must not affect execution.
        }
    }
}
