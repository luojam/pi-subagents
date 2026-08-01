import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { SubagentRunnerEvent } from './types.ts';

export interface AssistantCompletion {
    stopReason?: string;
    errorMessage?: string;
}

/** Adapt AgentSession's event stream into UI-independent structured observations. */
export function observeSubagentSession(
    session: AgentSession,
    emit: (event: SubagentRunnerEvent) => void,
    onAssistantEnd: (completion: AssistantCompletion) => void
): () => void {
    const refreshStats = (): void => {
        emit({ type: 'stats_refreshed', stats: session.getSessionStats() });
    };

    return session.subscribe((event: AgentSessionEvent) => {
        switch (event.type) {
            case 'turn_start':
                emit({ type: 'turn_started' });
                break;
            case 'turn_end':
                emit({ type: 'turn_ended' });
                refreshStats();
                break;
            case 'message_update':
                if (event.assistantMessageEvent.type === 'thinking_delta') {
                    emit({
                        type: 'thinking_delta',
                        delta: event.assistantMessageEvent.delta,
                    });
                } else if (event.assistantMessageEvent.type === 'text_delta') {
                    emit({ type: 'text_delta', delta: event.assistantMessageEvent.delta });
                }
                break;
            case 'tool_execution_start':
                emit({
                    type: 'tool_started',
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    args: event.args,
                });
                break;
            case 'tool_execution_update':
                emit({
                    type: 'tool_updated',
                    toolCallId: event.toolCallId,
                    partialResult: event.partialResult,
                });
                break;
            case 'tool_execution_end':
                emit({
                    type: 'tool_ended',
                    toolCallId: event.toolCallId,
                    isError: event.isError,
                });
                break;
            case 'message_end':
                if (event.message.role === 'assistant') {
                    onAssistantEnd({
                        stopReason: event.message.stopReason,
                        errorMessage: event.message.errorMessage,
                    });
                    refreshStats();
                }
                break;
        }
    });
}
