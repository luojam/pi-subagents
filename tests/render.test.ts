import type { Theme } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';
import { renderSubagentWidget } from '../extensions/subagent/render.ts';
import type { SubagentRunSnapshot, SubagentThinkingLevel } from '../extensions/subagent/types.ts';

const theme = {
    fg: (_color: string, text: string) => text,
} as Theme;

function run(thinkingLevel: SubagentThinkingLevel): SubagentRunSnapshot {
    return { thinkingLevel } as SubagentRunSnapshot;
}

function widgetLine(
    activeRuns: readonly SubagentRunSnapshot[],
    idleThinkingLevel: SubagentThinkingLevel | 'inherit' | 'unsupported',
    enabled = true
): string {
    return (
        renderSubagentWidget(activeRuns, 0, enabled, idleThinkingLevel, theme).render(200)[0] ?? ''
    );
}

it('renders unsupported idle resolution without hiding the widget', () => {
    expect(widgetLine([], 'unsupported', false)).toBe('subagent · disabled · thinking unsupported');
});

it('uses run snapshots for active thinking labels', () => {
    expect(widgetLine([run('high')], 'low')).toContain('thinking high');
    expect(widgetLine([run('low'), run('high')], 'medium')).toContain('thinking mixed');
});
