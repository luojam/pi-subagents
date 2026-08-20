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
        enabled: true,
        maxParallelism: 3,
        maxParallelismLimit: 8,
        onEnabledChange: () => {},
        onThinkingLevelChange: () => {},
        onMaxParallelismChange: () => {},
    },
    customKeybindings?: KeybindingsManager,
    terminalRows = 18
) {
    const requestRender = vi.fn();
    const terminal = { rows: terminalRows };
    const tui = {
        terminal,
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
                'tui.select.confirm': ['enter'],
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
    return { close, modal, requestRender, terminal };
}

it('lists all runs, reports activity counts, and moves the selected row', () => {
    const source = new TestRunSource([
        run('active', 'running', 'inspect\nactive work'),
        run('queued', 'queued', 'wait for a slot'),
        run('done', 'completed', 'already finished'),
    ]);
    const { close, modal, requestRender } = setup(source, undefined, undefined, 24);

    let lines = modal.render(80);
    expect(lines.join('\n')).toContain('Configuration');
    expect(lines.join('\n')).toContain('Subagent tool    ‹ enabled ›');
    expect(lines.join('\n')).toContain('Reasoning level  ‹ inherit ›');
    expect(lines.join('\n')).toContain('Max parallelism  ‹ 3 ›');
    const settingRows = ['Subagent tool', 'Reasoning level', 'Max parallelism'].map(
        (label) => lines.find((line) => line.includes(label)) ?? ''
    );
    expect(new Set(settingRows.map((line) => line.indexOf('‹'))).size).toBe(1);
    expect(lines.join('\n')).toContain('1 active');
    expect(lines.join('\n')).toContain('1 queued');
    expect(lines.join('\n')).toContain('3 total');
    const activityRow = lines.findIndex((line) => line.includes('Activity'));
    expect(lines[activityRow + 1]).toBe(`│${' '.repeat(78)}│`);
    expect(lines.join('\n')).toContain('↑/↓ select · → expand · esc close');
    expect(lines.join('\n')).not.toContain('enter expand');
    expect(lines.join('\n')).not.toContain('escape/ctrl+c close');
    expect(lines.join('\n')).toContain('inspect active work');
    expect(lines.join('\n')).toContain('wait for a slot');
    expect(lines.join('\n')).toContain('✓ completed  already finished');
    const emptyPaddedRow = `│${' '.repeat(78)}│`;
    const maxParallelismRow = lines.findIndex((line) => line.includes('Max parallelism'));
    expect(lines.slice(maxParallelismRow + 1, maxParallelismRow + 4)).toEqual([
        emptyPaddedRow,
        `│ ${'─'.repeat(76)} │`,
        emptyPaddedRow,
    ]);
    expect(lines.find((line) => line.includes('Reasoning level'))).toMatch(/^│ .* │$/u);
    expect(lines.every((line) => !line.includes('\n') && visibleWidth(line) <= 80)).toBe(true);
    expect(lines.find((line) => line.includes('inspect active work'))).toContain('\x1b[7m');

    modal.handleInput('tui.select.down');
    lines = modal.render(80);
    expect(requestRender).toHaveBeenCalledOnce();
    expect(lines.find((line) => line.includes('wait for a slot'))).toContain('\x1b[7m');
    expect(lines.find((line) => line.includes('inspect active work'))).not.toContain('\x1b[7m');

    modal.handleInput('tui.input.tab');
    lines = modal.render(80);
    expect(lines.find((line) => line.includes('Subagent tool'))).toContain('\x1b[7m');
    expect(lines.find((line) => line.includes('wait for a slot'))).not.toContain('\x1b[7m');

    modal.handleInput('tui.select.down');
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

it('keeps a newly completed run ahead of older history', () => {
    const older = {
        ...run('older', 'completed', 'older task'),
        queuedAt: 10,
        endedAt: 100,
    };
    const finishing = { ...run('latest', 'running', 'latest task'), queuedAt: 20 };
    const active = { ...run('active', 'running', 'active task'), queuedAt: 30 };
    const source = new TestRunSource([older, finishing, active]);
    const { modal } = setup(source, undefined, undefined, 24);

    let lines = modal.render(80);
    expect(lines.find((line) => line.includes('latest task'))).toContain('\x1b[7m');

    source.publish([older, { ...finishing, state: 'completed', endedAt: 200 }, active]);
    lines = modal.render(80);

    const activeRow = lines.findIndex((line) => line.includes('active task'));
    const latestRow = lines.findIndex((line) => line.includes('latest task'));
    const olderRow = lines.findIndex((line) => line.includes('older task'));
    expect(activeRow).toBeGreaterThan(-1);
    expect(latestRow).toBeGreaterThan(activeRow);
    expect(olderRow).toBeGreaterThan(latestRow);
    expect(lines[latestRow]).toContain('\x1b[7m');
});

it('expands the selected run without changing modal dimensions or exposing response data', () => {
    const expandedTail = 'EXPANDED_TASK_TAIL';
    const source = new TestRunSource([
        {
            ...run(
                'active',
                'running',
                `inspect ${'wrapped task content '.repeat(4)}\n${expandedTail}`
            ),
            responseTail: 'HIDDEN_RESPONSE_TAIL',
        },
    ]);
    const { modal, requestRender } = setup(source, undefined, undefined, 24);

    const collapsed = modal.render(40);
    expect(collapsed.join('\n')).not.toContain(expandedTail);

    modal.handleInput('tui.select.confirm');
    expect(modal.render(40).join('\n')).not.toContain(expandedTail);
    expect(requestRender).not.toHaveBeenCalled();

    modal.handleInput('\x1b[C');
    const expanded = modal.render(40);
    expect(requestRender).toHaveBeenCalledOnce();
    expect(expanded.join('\n')).toContain(expandedTail);
    expect(expanded.join('\n')).not.toContain('HIDDEN_RESPONSE_TAIL');
    expect(expanded.find((line) => line.includes(expandedTail))).toContain('\x1b[7m');
    expect(expanded).toHaveLength(collapsed.length);
    expect(expanded.every((line) => visibleWidth(line) === 40)).toBe(true);
    expect(expanded.at(-1)).toMatch(/^╰─+╯$/u);
    expect(modal.render(80).join('\n')).toContain('↑/↓ select · ← collapse · esc close');

    modal.handleInput('\x1b[D');
    expect(modal.render(40).join('\n')).not.toContain(expandedTail);
});

it('pages through an expanded run that is taller than the activity viewport', () => {
    const expandedTail = 'OVERSIZED_TASK_TAIL';
    const source = new TestRunSource([
        run('active', 'running', `${'activity detail '.repeat(20)}${expandedTail}`),
    ]);
    const { modal } = setup(source, undefined, undefined, 18);
    const initialHeight = modal.render(40).length;

    modal.handleInput('\x1b[C');
    let lines = modal.render(40);
    expect(lines.join('\n')).not.toContain(expandedTail);

    for (let page = 0; page < 20 && !lines.join('\n').includes(expandedTail); page++) {
        modal.handleInput('tui.select.pageDown');
        lines = modal.render(40);
    }

    expect(lines.join('\n')).toContain(expandedTail);
    expect(lines.find((line) => line.includes(expandedTail))).toContain('\x1b[7m');
    expect(lines).toHaveLength(initialHeight);
    expect(lines.at(-1)).toMatch(/^╰─+╯$/u);

    source.publish([run('active', 'running', `${'activity detail '.repeat(20)}${expandedTail}`)]);
    expect(modal.render(40).join('\n')).toContain(expandedTail);
});

it('honors pending navigation when a live update arrives before rendering', () => {
    const task = Array.from({ length: 10 }, (_, index) => `LINE_${index}`).join('\n');
    const runs = [run('expanded', 'running', task), run('last', 'queued')];
    const source = new TestRunSource(runs);
    const { modal } = setup(source, undefined, undefined, 18);
    modal.render(40);
    modal.handleInput('\x1b[C');
    let lines = modal.render(40);

    for (let page = 0; page < 10 && !lines.join('\n').includes('LINE_9'); page++) {
        modal.handleInput('tui.select.pageDown');
        lines = modal.render(40);
    }
    expect(lines.join('\n')).toContain('LINE_9');
    modal.handleInput('tui.select.down');
    modal.render(40);
    modal.handleInput('tui.select.down');
    source.publish(runs);

    expect(modal.render(40).join('\n')).toContain('LINE_0');
});

it('keeps an expanded run within its paging range after the viewport grows', () => {
    const task = Array.from({ length: 10 }, (_, index) => `LINE_${index}`).join('\n');
    const source = new TestRunSource([
        run('expanded', 'running', task),
        ...Array.from({ length: 10 }, (_, index) => run(`queued-${index}`, 'queued')),
    ]);
    const { modal, terminal } = setup(source, undefined, undefined, 18);
    modal.render(40);
    modal.handleInput('\x1b[C');
    let lines = modal.render(40);

    for (let page = 0; page < 10 && !lines.join('\n').includes('LINE_9'); page++) {
        modal.handleInput('tui.select.pageDown');
        lines = modal.render(40);
    }
    expect(lines.join('\n')).toContain('LINE_9');
    terminal.rows = 24;
    lines = modal.render(40);

    expect(lines.join('\n')).toContain('LINE_9');
    expect(lines.join('\n')).toContain('Runtime');
});

it('navigates into tall expanded runs from either direction', () => {
    const expandedTail = 'TALL_EXPANDED_TAIL';
    const runs = [
        run('first', 'running'),
        run('expanded', 'running', `${'expanded row content '.repeat(12)}${expandedTail}`),
        run('last', 'queued'),
    ];
    const source = new TestRunSource(runs);
    const { modal } = setup(source, undefined, undefined, 18);
    modal.render(40);

    modal.handleInput('tui.select.down');
    expect(modal.render(40).find((line) => line.includes('expanded row'))).toContain('\x1b[7m');
    source.publish(runs);
    expect(modal.render(40).find((line) => line.includes('expanded row'))).toContain('\x1b[7m');

    modal.handleInput('\x1b[C');
    modal.render(40);
    modal.handleInput('tui.select.up');
    modal.render(40);
    modal.handleInput('tui.select.pageDown');

    let lines = modal.render(40);
    expect(lines.find((line) => line.includes('expanded row'))).toContain('\x1b[7m');
    expect(lines.find((line) => line.includes('last task'))).toBeUndefined();

    modal.handleInput('tui.select.down');
    modal.render(40);
    modal.handleInput('tui.select.pageUp');
    lines = modal.render(40);
    for (let page = 0; page < 10 && !lines.join('\n').includes(expandedTail); page++) {
        modal.handleInput('tui.select.pageUp');
        lines = modal.render(40);
    }
    expect(lines.find((line) => line.includes(expandedTail))).toContain('\x1b[7m');
});

it('shows runtime and stats for an expanded run', () => {
    const source = new TestRunSource([
        {
            ...run('active', 'running'),
            sessionFile: '/tmp/subagent.jsonl',
            elapsedMs: 65_000,
            contextUsage: { tokens: 1_500, contextWindow: 8_000, percent: 18.75 },
            usage: {
                input: 1_200,
                output: 345,
                cacheRead: 678,
                cacheWrite: 90,
                total: 2_313,
                cost: 0.0123,
            },
        },
    ]);
    const { modal } = setup(source, undefined, undefined, 40);
    modal.render(100);

    modal.handleInput('\x1b[C');
    const expanded = modal.render(100).join('\n');

    expect(expanded).toContain('Runtime');
    expect(expanded).toContain('cwd: /project');
    expect(expanded).toContain('model: test/model · thinking off');
    expect(expanded).toContain('transcript: /tmp/subagent.jsonl');
    expect(expanded).toContain('Stats');
    expect(expanded).toContain('1.5k/8k (19%) · 1m 5s');
    expect(expanded).toContain('↑1.2k ↓345 · R678 W90 · $0.0123');
});

it('closes when the modal shortcut is pressed again', () => {
    const source = new TestRunSource([]);
    const { close, modal } = setup(source);

    modal.handleInput('\x1b\x13');

    expect(close).toHaveBeenCalledOnce();
    expect(source.listeners.size).toBe(0);
});

it('keeps rendered rows within extremely narrow widths', () => {
    const { modal } = setup(new TestRunSource([]));

    for (const width of [2, 3]) {
        expect(modal.render(width).every((line) => visibleWidth(line) === width)).toBe(true);
    }
});

it('renders every control at the minimum full modal height', () => {
    const { modal } = setup(new TestRunSource([]), undefined, undefined, 17);
    const lines = modal.render(80);

    expect(lines).toHaveLength(15);
    expect(lines.join('\n')).toContain('Subagent tool');
    expect(lines.join('\n')).toContain('Reasoning level');
    expect(lines.join('\n')).toContain('Max parallelism');
    expect(lines.join('\n')).toContain('Activity');
    expect(lines.join('\n')).not.toContain('Terminal too small');
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
    expect(modal.render(80).find((line) => line.includes('Subagent tool'))).toContain('\x1b[7m');

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

it('applies enabled, reasoning, and parallelism changes through independent callbacks', () => {
    const source = new TestRunSource([]);
    const onEnabledChange = vi.fn();
    const onThinkingLevelChange = vi.fn();
    const onMaxParallelismChange = vi.fn();
    const { modal } = setup(source, {
        enabled: true,
        thinkingLevel: 'inherit',
        maxParallelism: 3,
        maxParallelismLimit: 8,
        onEnabledChange,
        onThinkingLevelChange,
        onMaxParallelismChange,
    });

    modal.handleInput('tui.input.tab');
    let lines = modal.render(80);
    expect(lines.join('\n')).toContain('←/→ change');
    expect(lines.join('\n')).not.toContain('preview');

    modal.handleInput('\x1b[C');
    expect(onEnabledChange).toHaveBeenLastCalledWith(false);
    expect(onThinkingLevelChange).not.toHaveBeenCalled();
    expect(onMaxParallelismChange).not.toHaveBeenCalled();
    lines = modal.render(80);
    expect(lines.find((line) => line.includes('Subagent tool'))).toContain('disabled');

    modal.handleInput('tui.select.down');
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
    expect(onEnabledChange).toHaveBeenCalledOnce();
    expect(onThinkingLevelChange).toHaveBeenCalledTimes(5);
    lines = modal.render(80);
    expect(lines.find((line) => line.includes('Max parallelism'))).toContain('2');
});

it('ignores hidden controls when the terminal is too short', () => {
    const source = new TestRunSource([]);
    const onEnabledChange = vi.fn();
    const onThinkingLevelChange = vi.fn();
    const onMaxParallelismChange = vi.fn();
    const { close, modal } = setup(
        source,
        {
            enabled: true,
            thinkingLevel: 'inherit',
            maxParallelism: 3,
            maxParallelismLimit: 8,
            onEnabledChange,
            onThinkingLevelChange,
            onMaxParallelismChange,
        },
        undefined,
        8
    );

    expect(modal.render(80).join('\n')).toContain('Terminal too small');
    modal.handleInput('tui.input.tab');
    modal.handleInput('\x1b[C');

    expect(onEnabledChange).not.toHaveBeenCalled();
    expect(onThinkingLevelChange).not.toHaveBeenCalled();
    expect(onMaxParallelismChange).not.toHaveBeenCalled();
    modal.handleInput('tui.select.cancel');
    expect(close).toHaveBeenCalledOnce();
});

it('updates a displayed setting only after its callback succeeds', () => {
    const source = new TestRunSource([]);
    const { modal } = setup(source, {
        enabled: true,
        thinkingLevel: 'inherit',
        maxParallelism: 3,
        maxParallelismLimit: 8,
        onEnabledChange: () => {
            throw new Error('configuration failed');
        },
        onThinkingLevelChange: () => {},
        onMaxParallelismChange: () => {},
    });
    modal.handleInput('tui.input.tab');

    expect(() => modal.handleInput('\x1b[C')).toThrow('configuration failed');
    expect(modal.render(80).find((line) => line.includes('Subagent tool'))).toContain('enabled');
});

it('updates live, preserves selection by run id, and unsubscribes when disposed', () => {
    const source = new TestRunSource([run('first', 'running'), run('selected', 'queued')]);
    const { modal, requestRender } = setup(source, undefined, undefined, 19);
    modal.render(80);
    modal.handleInput('tui.select.down');

    source.publish([
        run('first', 'completed'),
        run('selected', 'completed', 'still selected'),
        run('new', 'queued'),
    ]);

    const lines = modal.render(80);
    expect(lines.join('\n')).toContain('0 active');
    expect(lines.join('\n')).toContain('1 queued');
    expect(lines.join('\n')).toContain('3 total');
    expect(lines.find((line) => line.includes('still selected'))).toContain('\x1b[7m');
    expect(requestRender).toHaveBeenCalledTimes(2);

    modal.handleInput('\x1b[C');
    modal.render(40);
    source.publish([
        run('new', 'queued'),
        run('selected', 'completed', 'still selected\nEXPANDED'),
    ]);
    source.publish([
        run('other', 'queued'),
        run('new', 'queued'),
        run('selected', 'completed', 'still selected\nEXPANDED'),
    ]);
    expect(modal.render(40).join('\n')).toContain('EXPANDED');

    source.publish([run('new', 'queued', `${'collapsed content '.repeat(5)}NOT_EXPANDED`)]);
    expect(modal.render(40).join('\n')).not.toContain('NOT_EXPANDED');

    const renderRequestsBeforeDispose = requestRender.mock.calls.length;
    modal.dispose();
    expect(source.listeners.size).toBe(0);
    source.publish([run('later', 'queued')]);
    expect(requestRender).toHaveBeenCalledTimes(renderRequestsBeforeDispose);
});
