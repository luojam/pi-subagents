import type { Theme } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';
import { createSubagentWidget, renderSubagentWidget } from '../extensions/subagent/render.ts';
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
    enabled = true,
    spinnerFrame?: string,
    width = 200
): string {
    return (
        renderSubagentWidget(activeRuns, 0, enabled, idleThinkingLevel, theme, spinnerFrame).render(
            width
        )[0] ?? ''
    );
}

afterEach(() => vi.useRealTimers());

it('renders unsupported idle resolution without hiding the widget', () => {
    expect(widgetLine([], 'unsupported', false).trim()).toBe('subagent · disabled · unsupported');
});

it('uses run snapshots for active thinking labels', () => {
    expect(widgetLine([run('high')], 'low')).toContain(' · high');
    expect(widgetLine([run('low'), run('high')], 'medium')).toContain(' · mixed');
});

it('keeps the working indicator left while aligning subagent status right', () => {
    expect(widgetLine([run('high')], 'low', true, '⠋', 42)).toBe(
        ` ⠋ Working...  subagent · 1 active · high `
    );
});

it('animates while Pi is working and stops cleanly', () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    const widget = createSubagentWidget({ requestRender }, [], 0, true, 'low', true, theme);

    expect(widget.render(42)[0]).toBe(` ⠋ Working...${' '.repeat(7)}subagent · idle · low `);
    vi.advanceTimersByTime(80);
    expect(widget.render(42)[0]).toBe(` ⠙ Working...${' '.repeat(7)}subagent · idle · low `);

    widget.update([], 0, true, 'low', false);
    const renderRequestsAfterStop = requestRender.mock.calls.length;
    vi.advanceTimersByTime(160);
    expect(requestRender).toHaveBeenCalledTimes(renderRequestsAfterStop);
    expect(widget.render(42)[0]).toBe(`${' '.repeat(20)}subagent · idle · low `);

    widget.update([], 0, true, 'low', true);
    widget.dispose();
    const renderRequestsAfterDispose = requestRender.mock.calls.length;
    vi.advanceTimersByTime(160);
    expect(requestRender).toHaveBeenCalledTimes(renderRequestsAfterDispose);
});
