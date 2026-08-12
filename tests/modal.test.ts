import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import { type TUI, visibleWidth } from '@earendil-works/pi-tui';
import { expect, it, vi } from 'vitest';
import {
    type SubagentRunSource,
    SubagentsModal,
    type SubagentsModalOptions,
} from '../extensions/subagent/modal.ts';
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

function setup(
    source: SubagentRunSource,
    options: SubagentsModalOptions = {
        maxParallelism: 3,
        maxParallelismLimit: 8,
        onThinkingLevelChange: () => {},
        onMaxParallelismChange: () => {},
    },
    customKeybindings?: KeybindingsManager,
    terminalRows = 16
) {
    const requestRender = vi.fn();
    const tui = {
        terminal: { rows: terminalRows },
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
                'tui.input.tab': ['tab'],
            };
            return keys[action] ?? [];
        },
    } as unknown as KeybindingsManager;
    const close = vi.fn();
    const modal = new SubagentsModal(
        tui,
        theme,
        customKeybindings ?? keybindings,
        close,
        source,
        options
    );
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
    expect(lines.join('\n')).toContain('Configuration');
    expect(lines.join('\n')).toContain('Reasoning level  ‹ inherit ›');
    expect(lines.join('\n')).toContain('Max parallelism  ‹ 3 ›');
    expect(lines.join('\n')).toContain('1 active');
    expect(lines.join('\n')).toContain('1 queued');
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

    modal.handleInput('tui.input.tab');
    lines = modal.render(80);
    expect(lines.find((line) => line.includes('Reasoning level'))).toContain('\x1b[7m');
    expect(lines.find((line) => line.includes('wait for a slot'))).not.toContain('\x1b[7m');

    modal.handleInput('tui.select.down');
    modal.handleInput('\x1b[C');
    lines = modal.render(80);
    expect(lines.find((line) => line.includes('Max parallelism'))).toContain('\x1b[7m');
    expect(lines.find((line) => line.includes('Max parallelism'))).toContain('4');

    modal.handleInput('tui.input.tab');
    lines = modal.render(80);
    expect(lines.find((line) => line.includes('wait for a slot'))).toContain('\x1b[7m');

    modal.handleInput('tui.select.cancel');
    expect(close).toHaveBeenCalledOnce();
    expect(source.listeners.size).toBe(0);
});

it('uses only the configured section keybinding and reports when it is unbound', () => {
    const source = new TestRunSource([run('active', 'running')]);
    const reboundKeybindings = {
        matches: (data: string, action: string) =>
            action === 'tui.input.tab' ? data === 'ctrl+t' : data === action,
        getKeys: (action: string) => (action === 'tui.input.tab' ? ['ctrl+t'] : []),
    } as unknown as KeybindingsManager;
    const { modal } = setup(source, undefined, reboundKeybindings);

    modal.handleInput('\t');
    expect(modal.render(80).find((line) => line.includes('active task'))).toContain('\x1b[7m');
    modal.handleInput('ctrl+t');
    expect(modal.render(80).find((line) => line.includes('Reasoning level'))).toContain('\x1b[7m');

    const unboundKeybindings = {
        matches: () => false,
        getKeys: () => [],
    } as unknown as KeybindingsManager;
    const { modal: unboundModal } = setup(source, undefined, unboundKeybindings);
    unboundModal.handleInput('\t');
    const unboundLines = unboundModal.render(80);
    expect(unboundLines.find((line) => line.includes('active task'))).toContain('\x1b[7m');
    expect(unboundLines.join('\n')).toContain('section unbound');
});

it('applies reasoning and parallelism changes through independent callbacks', () => {
    const source = new TestRunSource([]);
    const onThinkingLevelChange = vi.fn();
    const onMaxParallelismChange = vi.fn();
    const { modal } = setup(source, {
        thinkingLevel: 'inherit',
        maxParallelism: 3,
        maxParallelismLimit: 8,
        onThinkingLevelChange,
        onMaxParallelismChange,
    });

    modal.handleInput('tui.input.tab');
    let lines = modal.render(80);
    expect(lines.join('\n')).toContain('←/→ change');
    expect(lines.join('\n')).not.toContain('preview');

    modal.handleInput('\x1b[C');
    expect(onThinkingLevelChange).toHaveBeenLastCalledWith('low');
    expect(onMaxParallelismChange).not.toHaveBeenCalled();
    lines = modal.render(80);
    expect(lines.find((line) => line.includes('Reasoning level'))).toContain('low');

    modal.handleInput('tui.select.confirm');
    expect(onThinkingLevelChange).toHaveBeenLastCalledWith('medium');
    modal.handleInput('tui.select.confirm');
    modal.handleInput('tui.select.confirm');
    modal.handleInput('tui.select.confirm');
    expect(onThinkingLevelChange).toHaveBeenLastCalledWith('max');
    expect(modal.render(80).find((line) => line.includes('Reasoning level'))).toContain('max');

    modal.handleInput('tui.select.down');
    modal.handleInput('\x1b[D');
    expect(onMaxParallelismChange).toHaveBeenLastCalledWith(2);
    expect(onThinkingLevelChange).toHaveBeenCalledTimes(5);
    lines = modal.render(80);
    expect(lines.find((line) => line.includes('Max parallelism'))).toContain('2');
});

it('ignores hidden controls when the terminal is too short', () => {
    const source = new TestRunSource([]);
    const onThinkingLevelChange = vi.fn();
    const onMaxParallelismChange = vi.fn();
    const { close, modal } = setup(
        source,
        {
            thinkingLevel: 'inherit',
            maxParallelism: 3,
            maxParallelismLimit: 8,
            onThinkingLevelChange,
            onMaxParallelismChange,
        },
        undefined,
        8
    );

    expect(modal.render(80).join('\n')).toContain('Terminal too small');
    modal.handleInput('tui.input.tab');
    modal.handleInput('\x1b[C');

    expect(onThinkingLevelChange).not.toHaveBeenCalled();
    expect(onMaxParallelismChange).not.toHaveBeenCalled();
    modal.handleInput('tui.select.cancel');
    expect(close).toHaveBeenCalledOnce();
});

it('updates a displayed setting only after its callback succeeds', () => {
    const source = new TestRunSource([]);
    const { modal } = setup(source, {
        thinkingLevel: 'inherit',
        maxParallelism: 3,
        maxParallelismLimit: 8,
        onThinkingLevelChange: () => {
            throw new Error('configuration failed');
        },
        onMaxParallelismChange: () => {},
    });
    modal.handleInput('tui.input.tab');

    expect(() => modal.handleInput('\x1b[C')).toThrow('configuration failed');
    expect(modal.render(80).find((line) => line.includes('Reasoning level'))).toContain('inherit');
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
