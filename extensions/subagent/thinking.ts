import { clampThinkingLevel } from '@earendil-works/pi-ai';
import type { SubagentModel, SubagentThinkingLevel } from './types.ts';

export const SUBAGENT_THINKING_LEVELS = [
    'inherit',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
] as const;

export type ConfiguredSubagentThinkingLevel = (typeof SUBAGENT_THINKING_LEVELS)[number];
export type DisplayedSubagentThinkingLevel = SubagentThinkingLevel | 'unsupported';

export function cycleSubagentThinkingLevel(
    current: ConfiguredSubagentThinkingLevel,
    direction: -1 | 1 = 1
): ConfiguredSubagentThinkingLevel {
    const currentIndex = SUBAGENT_THINKING_LEVELS.indexOf(current);
    const nextIndex =
        (currentIndex + direction + SUBAGENT_THINKING_LEVELS.length) %
        SUBAGENT_THINKING_LEVELS.length;
    return SUBAGENT_THINKING_LEVELS[nextIndex];
}

export function resolveSubagentThinkingLevel(
    configured: ConfiguredSubagentThinkingLevel,
    model: SubagentModel,
    inherited: SubagentThinkingLevel
): SubagentThinkingLevel {
    return clampThinkingLevel(model, configured === 'inherit' ? inherited : configured);
}

/** Best-effort resolution for status UI; execution uses the resolver above directly. */
export function resolveDisplayedSubagentThinkingLevel(
    configured: ConfiguredSubagentThinkingLevel,
    model: SubagentModel,
    inherited: SubagentThinkingLevel
): DisplayedSubagentThinkingLevel {
    try {
        return resolveSubagentThinkingLevel(configured, model, inherited);
    } catch {
        return 'unsupported';
    }
}
