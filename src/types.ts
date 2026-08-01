import type { Usage } from '@earendil-works/pi-ai';
import type {
    CreateAgentSessionOptions,
    ModelRegistry,
    SessionStats,
} from '@earendil-works/pi-coding-agent';

export type SubagentModel = NonNullable<CreateAgentSessionOptions['model']>;
export type SubagentThinkingLevel = NonNullable<CreateAgentSessionOptions['thinkingLevel']>;

export type SubagentRunState =
    | 'queued'
    | 'starting'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled';

export type SubagentToolCallState = 'running' | 'completed' | 'failed';

export interface SubagentToolCallSnapshot {
    readonly id: string;
    readonly name: string;
    /** Sanitized, bounded, single-line argument summary. */
    readonly inputSummary: string;
    /** Sanitized, bounded progress summary, when a tool streams useful progress. */
    readonly progressSummary?: string;
    readonly state: SubagentToolCallState;
    readonly startedAt: number;
    readonly endedAt?: number;
}

export interface SubagentContextUsage {
    readonly tokens: number | null;
    readonly contextWindow: number;
    readonly percent: number | null;
}

export interface SubagentSessionUsage {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
    readonly cost: number;
}

/** Immutable, bounded observable state for one manager-owned run. */
export interface SubagentRunSnapshot {
    /** Stable manager identifier, available before the child session exists. */
    readonly id: string;
    /** Isolated in-memory AgentSession identifier, once created. */
    readonly sessionId?: string;
    readonly state: SubagentRunState;
    readonly task: string;
    readonly cwd: string;
    readonly model: Readonly<Pick<SubagentModel, 'provider' | 'id'>>;
    readonly thinkingLevel: SubagentThinkingLevel;
    readonly queuedAt: number;
    readonly startedAt?: number;
    readonly endedAt?: number;
    readonly elapsedMs: number;
    readonly turn: number;
    readonly currentTool?: SubagentToolCallSnapshot;
    readonly recentToolCalls: readonly SubagentToolCallSnapshot[];
    readonly contextUsage?: SubagentContextUsage;
    readonly usage?: SubagentSessionUsage;
    /** Bounded provider-exposed reasoning text. */
    readonly thinkingTail: string;
    /** Bounded rolling assistant text. */
    readonly responseTail: string;
    readonly error?: string;
}

/** Structured observations emitted by the runner and reduced only by the manager. */
export type SubagentRunnerEvent =
    | { readonly type: 'setup_started' }
    | { readonly type: 'session_ready'; readonly sessionId: string }
    | { readonly type: 'turn_started' }
    | { readonly type: 'turn_ended' }
    | { readonly type: 'thinking_delta'; readonly delta: string }
    | { readonly type: 'text_delta'; readonly delta: string }
    | {
          readonly type: 'tool_started';
          readonly toolCallId: string;
          readonly toolName: string;
          readonly args: unknown;
      }
    | {
          readonly type: 'tool_updated';
          readonly toolCallId: string;
          readonly partialResult: unknown;
      }
    | {
          readonly type: 'tool_ended';
          readonly toolCallId: string;
          readonly isError: boolean;
      }
    | { readonly type: 'stats_refreshed'; readonly stats: SessionStats };

export interface SubagentRunOptions {
    task: string;
    cwd: string;
    model: SubagentModel;
    /** Parent registry used to inherit its effective provider and resolved runtime auth. */
    modelRegistry: ModelRegistry;
    thinkingLevel: SubagentThinkingLevel;
    projectTrusted: boolean;
    signal?: AbortSignal;
}

export interface SubagentRunnerOptions extends SubagentRunOptions {
    onEvent?: (event: SubagentRunnerEvent) => void;
}

export interface SubagentRunnerResult {
    text: string;
    usage: Usage;
}

export interface SubagentRunResult extends SubagentRunnerResult {
    details: SubagentRunSnapshot;
}

export interface RelevantSubagentRun {
    readonly snapshot?: SubagentRunSnapshot;
    readonly queuedCount: number;
}
