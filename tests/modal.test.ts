import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import { type TUI, visibleWidth } from '@earendil-works/pi-tui';
import { expect, it, vi } from 'vitest';
import { type SubagentRunSource, SubagentsModal } from '../extensions/subagent/modal.ts';
import type { SubagentRunSnapshot, SubagentRunState } from '../extensions/subagent/types.ts';

function run(id: string, state: SubagentRunState, task = `${id} task`): SubagentRunSnapshot {
    return {
        id,
        state,
        task,
        cwd: '/project',
        model: { provider: 'test', id: 'model' },
        thinkingLevel: 'off',
        queuedAt: 0,
        elapsedMs: 0,
        turn: 0,
        recentToolCalls: [],
        thinkingTail: '',
        responseTail: '',
    };
}

class TestRunSource implements SubagentRunSource {
    runs: readonly SubagentRunSnapshot[];
    readonly listeners = new Set<(snapshot: SubagentRunSnapshot) => void>();

    constructor(runs: readonly SubagentRunSnapshot[]) {
        this.runs = runs;
    }

    list(): readonly SubagentRunSnapshot[] {
        return this.runs;
    }

    subscribe(listener: (snapshot: SubagentRunSnapshot) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    publish(runs: readonly SubagentRunSnapshot[]): void {
        this.runs = runs;
        const event = runs[0] ?? run('finished', 'completed');
        for (const listener of this.listeners) listener(event);
    }
}

function setup(source: SubagentRunSource) {
    const requestRender = vi.fn();
    const tui = {
        terminal: { rows: 10 },
        requestRender,
    } as unknown as TUI;
    const theme = {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => `\x1b[7m${text}\x1b[27m`,
    } as unknown as Theme;
    const keybindings = {
        matches: (data: string, action: string) => data === action,
        getKeys: (action: string) => {
            const keys: Record<string, string[]> = {
                'tui.select.up': ['up'],
                'tui.select.down': ['down'],
                'tui.select.cancel': ['escape'],
            };
            return keys[action] ?? [];
        },
    } as unknown as KeybindingsManager;
    const close = vi.fn();
    const modal = new SubagentsModal(tui, theme, keybindings, close, source);
    return { close, modal, requestRender };
}

it('lists only active and queued runs and moves the selected row', () => {
    const source = new TestRunSource([
        run('active', 'running', 'inspect\nactive work'),
        run('queued', 'queued', 'wait for a slot'),
        run('done', 'completed', 'already finished'),
    ]);
    const { close, modal, requestRender } = setup(source);

    let lines = modal.render(80);
    expect(lines.join('\n')).toContain('inspect active work');
    expect(lines.join('\n')).toContain('wait for a slot');
    expect(lines.join('\n')).not.toContain('already finished');
    expect(lines.every((line) => !line.includes('\n') && visibleWidth(line) <= 80)).toBe(true);
    expect(lines.find((line) => line.includes('inspect active work'))).toContain('\x1b[7m');

    modal.handleInput('tui.select.down');
    lines = modal.render(80);
    expect(requestRender).toHaveBeenCalledOnce();
    expect(lines.find((line) => line.includes('wait for a slot'))).toContain('\x1b[7m');
    expect(lines.find((line) => line.includes('inspect active work'))).not.toContain('\x1b[7m');

    modal.handleInput('tui.select.cancel');
    expect(close).toHaveBeenCalledOnce();
    expect(source.listeners.size).toBe(0);
});

it('updates live, preserves selection by run id, and unsubscribes when disposed', () => {
    const source = new TestRunSource([run('first', 'running'), run('selected', 'queued')]);
    const { modal, requestRender } = setup(source);
    modal.render(80);
    modal.handleInput('tui.select.down');

    source.publish([
        run('first', 'completed'),
        run('selected', 'running', 'still selected'),
        run('new', 'queued'),
    ]);

    const lines = modal.render(80);
    expect(lines.find((line) => line.includes('still selected'))).toContain('\x1b[7m');
    expect(requestRender).toHaveBeenCalledTimes(2);

    modal.dispose();
    expect(source.listeners.size).toBe(0);
    source.publish([run('later', 'queued')]);
    expect(requestRender).toHaveBeenCalledTimes(2);
});
