import { expect, it } from 'vitest';
import {
    cycleSubagentThinkingLevel,
    resolveDisplayedSubagentThinkingLevel,
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

it('cycles configured thinking levels in both directions', () => {
    expect(cycleSubagentThinkingLevel('inherit')).toBe('low');
    expect(cycleSubagentThinkingLevel('max')).toBe('inherit');
    expect(cycleSubagentThinkingLevel('inherit', -1)).toBe('max');
});

it('inherits the effective parent thinking level by default', () => {
    expect(resolveSubagentThinkingLevel('inherit', model(), 'medium')).toBe('medium');
});

it('inherits extended parent thinking levels without an extension-level cap', () => {
    const selectedModel = model({ thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } });
    expect(resolveSubagentThinkingLevel('inherit', selectedModel, 'xhigh')).toBe('xhigh');
    expect(resolveSubagentThinkingLevel('inherit', selectedModel, 'max')).toBe('max');
});

it('uses an explicit modal thinking level instead of the parent level', () => {
    const selectedModel = model({ thinkingLevelMap: { max: 'max' } });
    expect(resolveSubagentThinkingLevel('max', selectedModel, 'low')).toBe('max');
});

it('clamps the configured thinking level to the selected model capabilities', () => {
    expect(resolveSubagentThinkingLevel('high', model({ reasoning: false }), 'medium')).toBe('off');
    expect(
        resolveDisplayedSubagentThinkingLevel('high', model({ reasoning: false }), 'medium')
    ).toBe('off');
});
