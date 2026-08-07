import { expect, it } from 'vitest';
import {
    resolveSubagentThinkingConfiguration,
    resolveSubagentThinkingLevel,
} from '../extensions/subagent/thinking.ts';
import type { SubagentModel } from '../extensions/subagent/types.ts';

function model(overrides: Partial<SubagentModel> = {}): SubagentModel {
    return {
        id: 'test-model',
        name: 'Test model',
        api: 'openai-responses',
        provider: 'test',
        baseUrl: 'https://example.com',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
        ...overrides,
    } as SubagentModel;
}

it('inherits the effective parent thinking level by default', () => {
    for (const value of [undefined, 'inherit']) {
        const configured = resolveSubagentThinkingConfiguration(value);
        expect(resolveSubagentThinkingLevel(configured, model(), 'medium')).toBe('medium');
    }
});

it('uses an explicit configured thinking level instead of the parent level', () => {
    const configured = resolveSubagentThinkingConfiguration('high');
    expect(resolveSubagentThinkingLevel(configured, model(), 'low')).toBe('high');
});

it('caps inherited thinking at high', () => {
    const configured = resolveSubagentThinkingConfiguration('inherit');
    const selectedModel = model({ thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } });
    expect(resolveSubagentThinkingLevel(configured, selectedModel, 'xhigh')).toBe('high');
});

it('rejects inheritance when the model has no supported level at or below high', () => {
    const configured = resolveSubagentThinkingConfiguration('inherit');
    const selectedModel = model({
        thinkingLevelMap: {
            off: null,
            minimal: null,
            low: null,
            medium: null,
            high: null,
            xhigh: 'xhigh',
            max: 'max',
        },
    });
    expect(() => resolveSubagentThinkingLevel(configured, selectedModel, 'high')).toThrow(
        'test/test-model does not support a subagent thinking level at or below high'
    );
});

it('clamps the configured thinking level to the selected model capabilities', () => {
    const configured = resolveSubagentThinkingConfiguration('high');
    expect(resolveSubagentThinkingLevel(configured, model({ reasoning: false }), 'medium')).toBe(
        'off'
    );
});

it('rejects an invalid configured thinking level', () => {
    expect(() => resolveSubagentThinkingConfiguration('max')).toThrow(
        '--subagent-thinking must be one of: inherit, low, medium, high'
    );
});
