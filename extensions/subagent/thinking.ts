import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { SubagentModel, SubagentThinkingLevel } from './types.ts';

export const SUBAGENT_THINKING_LEVELS = ['inherit', 'low', 'medium', 'high'] as const;
export const MAX_INHERITED_SUBAGENT_THINKING_LEVEL: SubagentThinkingLevel = 'high';

const THINKING_LEVEL_ORDER: readonly SubagentThinkingLevel[] = [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
];

export type ConfiguredSubagentThinkingLevel = (typeof SUBAGENT_THINKING_LEVELS)[number];
export type DisplayedSubagentThinkingLevel = SubagentThinkingLevel | 'unsupported';

export function resolveSubagentThinkingConfiguration(
    value: boolean | string | undefined
): ConfiguredSubagentThinkingLevel {
    const configured = value ?? 'inherit';
    if (
        typeof configured !== 'string' ||
        !(SUBAGENT_THINKING_LEVELS as readonly string[]).includes(configured)
    ) {
        throw new Error(
            `--subagent-thinking must be one of: ${SUBAGENT_THINKING_LEVELS.join(', ')}`
        );
    }
    return configured as ConfiguredSubagentThinkingLevel;
}

export function resolveSubagentThinkingLevel(
    configured: ConfiguredSubagentThinkingLevel,
    model: SubagentModel,
    inherited: SubagentThinkingLevel
): SubagentThinkingLevel {
    if (configured !== 'inherit') return clampThinkingLevel(model, configured);

    const maximumIndex = THINKING_LEVEL_ORDER.indexOf(MAX_INHERITED_SUBAGENT_THINKING_LEVEL);
    const inheritedIndex = THINKING_LEVEL_ORDER.indexOf(inherited);
    const requested =
        inheritedIndex > maximumIndex ? MAX_INHERITED_SUBAGENT_THINKING_LEVEL : inherited;
    const effective = clampThinkingLevel(model, requested);
    if (THINKING_LEVEL_ORDER.indexOf(effective) <= maximumIndex) return effective;

    const supported = getSupportedThinkingLevels(model);
    for (let index = maximumIndex; index >= 0; index--) {
        const candidate = THINKING_LEVEL_ORDER[index];
        if (supported.includes(candidate)) return candidate;
    }
    throw new Error(
        `${model.provider}/${model.id} does not support a subagent thinking level at or below ${MAX_INHERITED_SUBAGENT_THINKING_LEVEL}`
    );
}

/** Best-effort resolution for status UI; execution still uses the strict resolver above. */
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
