import { randomUUID } from 'node:crypto';
import { truncateUtf8Head, truncateUtf8Tail, UPDATE_TEXT_MAX_BYTES } from './run-utils.ts';
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
const MAX_TASK_BYTES = 8 * 1024;
const MAX_PATH_BYTES = 2 * 1024;
const MAX_ARGUMENT_BYTES = 2 * 1024;
const MAX_PROGRESS_BYTES = 512;
const MAX_ERROR_BYTES = 2 * 1024;

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

function sanitizeText(text: string, preserveNewlines = false): string {
    const normalized = preserveNewlines ? text.replace(/\r\n?/gu, '\n') : text;
    const withoutControls = normalized
        .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)?)/gu, '')
        .replace(
            preserveNewlines ? /[\x00-\x09\x0B-\x1F\x7F-\x9F]/gu : /[\x00-\x1F\x7F-\x9F]/gu,
            ' '
        );
    return preserveNewlines ? withoutControls : withoutControls.replace(/\s+/gu, ' ').trim();
}

function boundedString(value: string, maxBytes: number): string {
    return truncateUtf8Head(sanitizeText(value), maxBytes);
}

function summarizeKnownTool(toolName: string, args: Record<string, unknown>): string | undefined {
    const text = (key: string): string | undefined =>
        typeof args[key] === 'string' ? args[key] : undefined;
    const path = text('path');

    switch (toolName) {
        case 'read': {
            if (!path) return undefined;
            const offset = typeof args.offset === 'number' ? args.offset : undefined;
            const limit = typeof args.limit === 'number' ? args.limit : undefined;
            const start = offset ?? (limit === undefined ? undefined : 1);
            const range =
                start === undefined
                    ? ''
                    : `:${start}${limit === undefined ? '' : `-${start + limit - 1}`}`;
            return `${path}${range}`;
        }
        case 'bash':
            return text('command');
        case 'edit': {
            if (!path) return undefined;
            const count = Array.isArray(args.edits) ? args.edits.length : undefined;
            return count && count > 1 ? `${path} (${count} edits)` : path;
        }
        case 'write':
            return path;
        case 'grep': {
            const pattern = text('pattern');
            const searchPath = path ?? text('cwd');
            if (!pattern) return searchPath;
            return `/${pattern.replaceAll('/', '\\/')}/${searchPath ? ` in ${searchPath}` : ''}`;
        }
        case 'find': {
            const pattern = text('pattern');
            return [pattern, path ? `in ${path}` : undefined].filter(Boolean).join(' ');
        }
        default:
            return undefined;
    }
}

function sanitizeJsonValue(value: unknown, key: string | undefined, depth: number): unknown {
    if (depth > 3) return '[nested]';
    if (typeof value === 'string') {
        if (key && /^(?:content|oldText|newText|replacement|patch)$/iu.test(key)) {
            return `[${Buffer.byteLength(value, 'utf8')} bytes]`;
        }
        return boundedString(value, 512);
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
        const items = value
            .slice(0, 5)
            .map((item) => sanitizeJsonValue(item, undefined, depth + 1));
        if (value.length > items.length) items.push(`[${value.length - items.length} more]`);
        return items;
    }
    if (typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [childKey, childValue] of Object.entries(value).slice(0, 12)) {
            result[childKey] = sanitizeJsonValue(childValue, childKey, depth + 1);
        }
        return result;
    }
    return String(value);
}

export function summarizeToolArguments(toolName: string, args: unknown): string {
    if (!args || typeof args !== 'object') {
        return boundedString(typeof args === 'string' ? args : '', MAX_ARGUMENT_BYTES);
    }

    const known = summarizeKnownTool(toolName, args as Record<string, unknown>);
    if (known !== undefined) return boundedString(known, MAX_ARGUMENT_BYTES);

    try {
        return boundedString(
            JSON.stringify(sanitizeJsonValue(args, undefined, 0)) ?? '',
            MAX_ARGUMENT_BYTES
        );
    } catch {
        return '[unserializable arguments]';
    }
}

function summarizeProgress(partialResult: unknown): string | undefined {
    if (!partialResult || typeof partialResult !== 'object') return undefined;
    const content = (partialResult as { content?: unknown }).content;
    if (!Array.isArray(content)) return undefined;
    const text = content.find(
        (item): item is { type: 'text'; text: string } =>
            !!item &&
            typeof item === 'object' &&
            (item as { type?: unknown }).type === 'text' &&
            typeof (item as { text?: unknown }).text === 'string'
    )?.text;
    return text ? boundedString(text, MAX_PROGRESS_BYTES) : undefined;
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

function errorMessage(error: unknown): string {
    return boundedString(error instanceof Error ? error.message : String(error), MAX_ERROR_BYTES);
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
            task: truncateUtf8Head(sanitizeText(options.task, true), MAX_TASK_BYTES),
            cwd: boundedString(options.cwd, MAX_PATH_BYTES),
            model: {
                provider: boundedString(options.model.provider, 512),
                id: boundedString(options.model.id, 512),
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
            this.transitionTerminal(run, cancelled ? 'cancelled' : 'failed', errorMessage(error));
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
                run.thinkingTail = truncateUtf8Tail(
                    run.thinkingTail + sanitizeText(event.delta, true),
                    UPDATE_TEXT_MAX_BYTES
                );
                break;
            case 'text_delta':
                run.responseTail = truncateUtf8Tail(
                    run.responseTail + sanitizeText(event.delta, true),
                    UPDATE_TEXT_MAX_BYTES
                );
                break;
            case 'tool_started': {
                const tool: MutableToolCall = {
                    id: event.toolCallId,
                    name: boundedString(event.toolName, 128),
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
                if (tool) tool.progressSummary = summarizeProgress(event.partialResult);
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
