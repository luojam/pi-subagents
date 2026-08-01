import { randomUUID } from 'node:crypto';
import {
    appendStreamedText,
    sanitizeError,
    sanitizeModelPart,
    sanitizePath,
    sanitizeTask,
    sanitizeToolName,
    summarizeToolArguments,
    summarizeToolProgress,
} from './run/text.ts';
import { SubagentRunner } from './runner.ts';
import type {
    RelevantSubagentRun,
    SubagentRunnerEvent,
    SubagentRunnerOptions,
    SubagentRunnerResult,
    SubagentRunOptions,
    SubagentRunResult,
    SubagentRunSnapshot,
    SubagentRunState,
    SubagentSessionUsage,
    SubagentToolCallSnapshot,
} from './types.ts';

const TICK_MS = 1_000;
const TEXT_UPDATE_THROTTLE_MS = 100;
const MAX_RECENT_TOOLS = 10;

const TERMINAL_STATES = new Set<SubagentRunState>(['completed', 'failed', 'cancelled']);

export interface SubagentExecutor {
    run(options: SubagentRunnerOptions): Promise<SubagentRunnerResult>;
    shutdown(): Promise<void>;
}

interface MutableToolCall {
    id: string;
    name: string;
    inputSummary: string;
    progressSummary?: string;
    state: 'running' | 'completed' | 'failed';
    startedAt: number;
    endedAt?: number;
}

interface MutableRun {
    id: string;
    sessionId?: string;
    state: SubagentRunState;
    task: string;
    cwd: string;
    model: { provider: string; id: string };
    thinkingLevel: SubagentRunOptions['thinkingLevel'];
    queuedAt: number;
    startedAt?: number;
    endedAt?: number;
    elapsedMs: number;
    turn: number;
    activeTools: Map<string, MutableToolCall>;
    currentToolId?: string;
    recentToolCalls: MutableToolCall[];
    contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
    usage?: SubagentSessionUsage;
    thinkingTail: string;
    responseTail: string;
    error?: string;
}

export interface SubagentManagerOptions {
    now?: () => number;
    createId?: () => string;
    tickMs?: number;
}

type RunListener = (snapshot: SubagentRunSnapshot) => void;
type RelevantListener = (run: RelevantSubagentRun) => void;

function isTerminal(state: SubagentRunState): boolean {
    return TERMINAL_STATES.has(state);
}

function copyTool(tool: MutableToolCall): SubagentToolCallSnapshot {
    return Object.freeze({
        id: tool.id,
        name: tool.name,
        inputSummary: tool.inputSummary,
        ...(tool.progressSummary === undefined ? {} : { progressSummary: tool.progressSummary }),
        state: tool.state,
        startedAt: tool.startedAt,
        ...(tool.endedAt === undefined ? {} : { endedAt: tool.endedAt }),
    });
}

function snapshotOf(run: MutableRun): SubagentRunSnapshot {
    const current = run.currentToolId ? run.activeTools.get(run.currentToolId) : undefined;
    return Object.freeze({
        id: run.id,
        ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
        state: run.state,
        task: run.task,
        cwd: run.cwd,
        model: Object.freeze({ ...run.model }),
        thinkingLevel: run.thinkingLevel,
        queuedAt: run.queuedAt,
        ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
        ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
        elapsedMs: run.elapsedMs,
        turn: run.turn,
        ...(current === undefined ? {} : { currentTool: copyTool(current) }),
        recentToolCalls: Object.freeze(run.recentToolCalls.map(copyTool)),
        ...(run.contextUsage === undefined
            ? {}
            : { contextUsage: Object.freeze({ ...run.contextUsage }) }),
        ...(run.usage === undefined ? {} : { usage: Object.freeze({ ...run.usage }) }),
        thinkingTail: run.thinkingTail,
        responseTail: run.responseTail,
        ...(run.error === undefined ? {} : { error: run.error }),
    });
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

export class SubagentManager {
    private readonly runs = new Map<string, MutableRun>();
    private readonly runListeners = new Map<string, Set<RunListener>>();
    private readonly relevantListeners = new Set<RelevantListener>();
    private readonly executor: SubagentExecutor;
    private readonly now: () => number;
    private readonly createId: () => string;
    private readonly tickMs: number;
    private tickTimer: NodeJS.Timeout | undefined;
    private readonly textUpdateTimers = new Map<string, NodeJS.Timeout>();
    private shutdownPromise: Promise<void> | undefined;
    private disposed = false;

    constructor(
        executor: SubagentExecutor = new SubagentRunner(),
        options: SubagentManagerOptions = {}
    ) {
        this.executor = executor;
        this.now = options.now ?? Date.now;
        this.createId = options.createId ?? randomUUID;
        this.tickMs = options.tickMs ?? TICK_MS;
    }

    run(options: SubagentRunOptions): Promise<SubagentRunResult> {
        return this.startRun(options).result;
    }

    startRun(options: SubagentRunOptions): {
        id: string;
        result: Promise<SubagentRunResult>;
    } {
        if (this.disposed) {
            return {
                id: '',
                result: Promise.reject(new Error('Subagent manager is shut down')),
            };
        }

        const queuedAt = this.now();
        const id = this.createId();
        const run: MutableRun = {
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
            activeTools: new Map(),
            recentToolCalls: [],
            thinkingTail: '',
            responseTail: '',
        };
        this.runs.set(id, run);
        this.ensureTicking();
        this.publish(run);

        return { id, result: this.execute(run, options) };
    }

    getSnapshot(id: string): SubagentRunSnapshot | undefined {
        const run = this.runs.get(id);
        return run ? snapshotOf(run) : undefined;
    }

    subscribeRun(id: string, listener: RunListener): () => void {
        const listeners = this.runListeners.get(id) ?? new Set<RunListener>();
        listeners.add(listener);
        this.runListeners.set(id, listeners);
        const run = this.runs.get(id);
        if (run) {
            try {
                listener(snapshotOf(run));
            } catch {
                // A display subscriber must not affect execution.
            }
        }
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) this.runListeners.delete(id);
        };
    }

    subscribeRelevant(listener: RelevantListener): () => void {
        this.relevantListeners.add(listener);
        try {
            listener(this.getRelevant());
        } catch {
            // UI publication is best-effort.
        }
        return () => this.relevantListeners.delete(listener);
    }

    shutdown(): Promise<void> {
        if (!this.shutdownPromise) this.shutdownPromise = this.shutdownOnce();
        return this.shutdownPromise;
    }

    private async shutdownOnce(): Promise<void> {
        this.disposed = true;
        this.stopTicking();
        this.clearTextUpdateTimers();
        this.runListeners.clear();
        this.relevantListeners.clear();
        await this.executor.shutdown();
    }

    private async execute(
        run: MutableRun,
        options: SubagentRunOptions
    ): Promise<SubagentRunResult> {
        try {
            const result = await this.executor.run({
                ...options,
                onEvent: (event) => this.reduce(run, event),
            });
            this.transitionTerminal(run, 'completed');
            return { ...result, details: snapshotOf(run) };
        } catch (error) {
            const cancelled = isAbortError(error) || options.signal?.aborted === true;
            this.transitionTerminal(run, cancelled ? 'cancelled' : 'failed', sanitizeError(error));
            throw error;
        }
    }

    private reduce(run: MutableRun, event: SubagentRunnerEvent): void {
        if (this.disposed || isTerminal(run.state)) return;
        const now = this.now();

        switch (event.type) {
            case 'setup_started':
                run.state = 'starting';
                run.startedAt ??= now;
                break;
            case 'session_ready':
                run.sessionId = event.sessionId;
                run.state = 'running';
                run.startedAt ??= now;
                break;
            case 'turn_started':
                run.state = 'running';
                run.startedAt ??= now;
                run.turn += 1;
                break;
            case 'turn_ended':
                break;
            case 'thinking_delta':
                run.thinkingTail = appendStreamedText(run.thinkingTail, event.delta);
                break;
            case 'text_delta':
                run.responseTail = appendStreamedText(run.responseTail, event.delta);
                break;
            case 'tool_started': {
                const tool: MutableToolCall = {
                    id: event.toolCallId,
                    name: sanitizeToolName(event.toolName),
                    inputSummary: summarizeToolArguments(event.toolName, event.args),
                    state: 'running',
                    startedAt: now,
                };
                run.activeTools.set(tool.id, tool);
                run.currentToolId = tool.id;
                break;
            }
            case 'tool_updated': {
                const tool = run.activeTools.get(event.toolCallId);
                if (tool) tool.progressSummary = summarizeToolProgress(event.partialResult);
                break;
            }
            case 'tool_ended': {
                const tool = run.activeTools.get(event.toolCallId);
                if (tool) {
                    tool.state = event.isError ? 'failed' : 'completed';
                    tool.endedAt = now;
                    run.activeTools.delete(tool.id);
                    run.recentToolCalls.unshift(tool);
                    run.recentToolCalls.length = Math.min(
                        run.recentToolCalls.length,
                        MAX_RECENT_TOOLS
                    );
                    if (run.currentToolId === tool.id) {
                        run.currentToolId = [...run.activeTools.keys()].at(-1);
                    }
                }
                break;
            }
            case 'stats_refreshed':
                run.contextUsage = event.stats.contextUsage
                    ? { ...event.stats.contextUsage }
                    : undefined;
                run.usage = {
                    input: event.stats.tokens.input,
                    output: event.stats.tokens.output,
                    cacheRead: event.stats.tokens.cacheRead,
                    cacheWrite: event.stats.tokens.cacheWrite,
                    total: event.stats.tokens.total,
                    cost: event.stats.cost,
                };
                break;
        }

        this.refreshElapsed(run, now);
        if (event.type === 'thinking_delta' || event.type === 'text_delta') {
            this.scheduleTextUpdate(run);
        } else {
            this.cancelTextUpdate(run.id);
            this.publish(run);
        }
    }

    private transitionTerminal(
        run: MutableRun,
        state: Extract<SubagentRunState, 'completed' | 'failed' | 'cancelled'>,
        message?: string
    ): void {
        if (isTerminal(run.state)) return;
        this.cancelTextUpdate(run.id);
        const now = this.now();
        run.state = state;
        run.endedAt = now;
        run.error = state === 'completed' ? undefined : message;
        for (const tool of run.activeTools.values()) {
            tool.state = 'failed';
            tool.endedAt = now;
            run.recentToolCalls.unshift(tool);
        }
        run.activeTools.clear();
        run.currentToolId = undefined;
        run.recentToolCalls.length = Math.min(run.recentToolCalls.length, MAX_RECENT_TOOLS);
        this.refreshElapsed(run, now);
        this.publish(run);
        if (![...this.runs.values()].some((candidate) => !isTerminal(candidate.state))) {
            this.stopTicking();
        }
    }

    private refreshElapsed(run: MutableRun, now: number): void {
        const origin = run.startedAt ?? run.queuedAt;
        run.elapsedMs = Math.max(0, (run.endedAt ?? now) - origin);
    }

    private scheduleTextUpdate(run: MutableRun): void {
        if (this.textUpdateTimers.has(run.id) || this.disposed) return;
        const timer = setTimeout(() => {
            this.textUpdateTimers.delete(run.id);
            if (this.disposed || isTerminal(run.state)) return;
            this.refreshElapsed(run, this.now());
            this.publish(run);
        }, TEXT_UPDATE_THROTTLE_MS);
        this.textUpdateTimers.set(run.id, timer);
    }

    private cancelTextUpdate(runId: string): void {
        const timer = this.textUpdateTimers.get(runId);
        if (!timer) return;
        clearTimeout(timer);
        this.textUpdateTimers.delete(runId);
    }

    private clearTextUpdateTimers(): void {
        for (const timer of this.textUpdateTimers.values()) clearTimeout(timer);
        this.textUpdateTimers.clear();
    }

    private ensureTicking(): void {
        if (this.tickTimer || this.disposed) return;
        this.tickTimer = setInterval(() => {
            const now = this.now();
            const changed: MutableRun[] = [];
            for (const run of this.runs.values()) {
                if (isTerminal(run.state)) continue;
                this.refreshElapsed(run, now);
                changed.push(run);
            }
            for (const run of changed) this.publishRunListeners(run);
            if (changed.length > 0) this.publishRelevant();
            else this.stopTicking();
        }, this.tickMs);
    }

    private stopTicking(): void {
        if (!this.tickTimer) return;
        clearInterval(this.tickTimer);
        this.tickTimer = undefined;
    }

    private publish(run: MutableRun): void {
        if (this.disposed) return;
        this.publishRunListeners(run);
        this.publishRelevant();
    }

    private publishRunListeners(run: MutableRun): void {
        const snapshot = snapshotOf(run);
        for (const listener of this.runListeners.get(run.id) ?? []) {
            try {
                listener(snapshot);
            } catch {
                // A display subscriber must not affect execution or other subscribers.
            }
        }
    }

    private publishRelevant(): void {
        const relevant = this.getRelevant();
        for (const listener of this.relevantListeners) {
            try {
                listener(relevant);
            } catch {
                // UI publication is best-effort.
            }
        }
    }

    private getRelevant(): RelevantSubagentRun {
        const nonterminal = [...this.runs.values()].filter((run) => !isTerminal(run.state));
        const active = nonterminal.find(
            (run) => run.state === 'running' || run.state === 'starting'
        );
        const queued = nonterminal.filter((run) => run.state === 'queued');
        const selected = active ?? queued[0];
        return Object.freeze({
            ...(selected ? { snapshot: snapshotOf(selected) } : {}),
            queuedCount: queued.length,
        });
    }
}
