import type {
    ExtensionCommandContext,
    KeybindingsManager,
    Theme,
} from '@earendil-works/pi-coding-agent';
import { type Component, type TUI, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { isTerminalRunState } from './run-store.ts';
import type { SubagentRunSnapshot, SubagentRunState } from './types.ts';

const TARGET_HEIGHT_RATIO = 0.88;
const FULL_MODAL_HEIGHT = 4;

export interface SubagentRunSource {
    list(): readonly SubagentRunSnapshot[];
    subscribe(listener: (snapshot: SubagentRunSnapshot) => void): () => void;
}

function padToWidth(
    value: string,
    width: number,
    alignment: 'left' | 'center',
    background?: (value: string) => string
): string {
    const safeWidth = Math.max(0, width);
    const truncated = truncateToWidth(value, safeWidth, '');
    const remaining = Math.max(0, safeWidth - visibleWidth(truncated));
    const leftPadding = alignment === 'center' ? Math.floor(remaining / 2) : 0;
    const leftAndContent = `${' '.repeat(leftPadding)}${truncated}`;
    const rightPadding = ' '.repeat(remaining - leftPadding);

    if (!background) return `${leftAndContent}${rightPadding}`;
    return `${background(leftAndContent)}${rightPadding ? background(rightPadding) : ''}`;
}

function stateMarker(state: SubagentRunState): string {
    switch (state) {
        case 'queued':
        case 'starting':
            return '…';
        case 'running':
            return '●';
        case 'cancelling':
            return '■';
        case 'completed':
            return '✓';
        case 'failed':
        case 'interrupted':
            return '✗';
        case 'cancelled':
            return '■';
    }
}

function stateColor(state: SubagentRunState): 'muted' | 'warning' | 'accent' | 'success' | 'error' {
    switch (state) {
        case 'queued':
            return 'muted';
        case 'starting':
        case 'cancelling':
        case 'cancelled':
            return 'warning';
        case 'running':
            return 'accent';
        case 'completed':
            return 'success';
        case 'failed':
        case 'interrupted':
            return 'error';
    }
}

function activeAndQueuedRuns(
    source: SubagentRunSource | undefined
): readonly SubagentRunSnapshot[] {
    return source?.list().filter((run) => !isTerminalRunState(run.state)) ?? [];
}

export class SubagentsModal implements Component {
    private closed = false;
    private disposed = false;
    private runs: readonly SubagentRunSnapshot[];
    private selectedIndex = 0;
    private visibleListHeight = 1;
    private unsubscribe: (() => void) | undefined;
    private readonly tui: TUI;
    private readonly theme: Theme;
    private readonly keybindings: KeybindingsManager;
    private readonly onClose: () => void;
    private readonly runSource: SubagentRunSource | undefined;

    constructor(
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        onClose: () => void,
        runSource?: SubagentRunSource
    ) {
        this.tui = tui;
        this.theme = theme;
        this.keybindings = keybindings;
        this.onClose = onClose;
        this.runSource = runSource;
        this.runs = activeAndQueuedRuns(runSource);
        this.unsubscribe = runSource?.subscribe(() => this.refreshRuns());
    }

    handleInput(data: string): void {
        if (this.closed) return;

        if (this.keybindings.matches(data, 'tui.select.cancel')) {
            this.closed = true;
            this.dispose();
            this.onClose();
            return;
        }
        if (this.runs.length === 0) return;

        let nextIndex = this.selectedIndex;
        if (this.keybindings.matches(data, 'tui.select.up')) {
            nextIndex = this.selectedIndex === 0 ? this.runs.length - 1 : this.selectedIndex - 1;
        } else if (this.keybindings.matches(data, 'tui.select.down')) {
            nextIndex = this.selectedIndex === this.runs.length - 1 ? 0 : this.selectedIndex + 1;
        } else if (this.keybindings.matches(data, 'tui.select.pageUp')) {
            nextIndex = Math.max(0, this.selectedIndex - this.visibleListHeight);
        } else if (this.keybindings.matches(data, 'tui.select.pageDown')) {
            nextIndex = Math.min(this.runs.length - 1, this.selectedIndex + this.visibleListHeight);
        }

        if (nextIndex !== this.selectedIndex) {
            this.selectedIndex = nextIndex;
            this.tui.requestRender();
        }
    }

    render(width: number): string[] {
        const safeWidth = Math.max(0, width);
        const terminalRows = Math.max(0, this.tui.terminal.rows);
        const targetHeight = Math.max(
            FULL_MODAL_HEIGHT,
            Math.floor(terminalRows * TARGET_HEIGHT_RATIO)
        );
        // Match the overlay's maxHeight so it never slices off structural rows such
        // as the close hint or bottom border.
        const availableHeight = Math.max(1, Math.floor(terminalRows * 0.9));
        const height = Math.min(targetHeight, availableHeight);

        if (safeWidth === 0) return Array.from({ length: height }, () => '');

        const innerWidth = Math.max(0, safeWidth - 2);
        const border = (value: string) => this.theme.fg('borderAccent', value);
        const horizontalBorder = (left: string, right: string) => {
            if (safeWidth === 1) return border('─');
            return border(`${left}${'─'.repeat(innerWidth)}${right}`);
        };
        const titleBorder = () => {
            if (safeWidth === 1) return border('─');
            const title = truncateToWidth(this.theme.fg('accent', ' Subagents '), innerWidth, '');
            const fillWidth = Math.max(0, innerWidth - visibleWidth(title));
            return `${border('╭')}${title}${border(`${'─'.repeat(fillWidth)}╮`)}`;
        };
        const contentRow = (
            content: string,
            alignment: 'left' | 'center' = 'left',
            selected = false
        ) => {
            if (safeWidth === 1) return border('│');
            const padded = padToWidth(
                content,
                innerWidth,
                alignment,
                selected ? (value) => this.theme.bg('selectedBg', value) : undefined
            );
            return `${border('│')}${padded}${border('│')}`;
        };

        const cancelKeys = this.keybindings.getKeys('tui.select.cancel').join('/');
        const closeHint = cancelKeys ? `${cancelKeys} close` : 'close unbound';

        if (height === 1) {
            return [
                padToWidth(
                    `${this.theme.fg('dim', closeHint)} · ${this.theme.fg(
                        'warning',
                        'Terminal too small'
                    )}`,
                    safeWidth,
                    'center'
                ),
            ];
        }

        if (height === 2) {
            return [
                padToWidth(this.theme.fg('warning', 'Terminal too small'), safeWidth, 'center'),
                padToWidth(this.theme.fg('dim', closeHint), safeWidth, 'center'),
            ];
        }

        if (height === 3) {
            return [
                titleBorder(),
                contentRow(
                    `${this.theme.fg('dim', closeHint)} · ${this.theme.fg(
                        'warning',
                        'Terminal too small'
                    )}`,
                    'center'
                ),
                horizontalBorder('╰', '╯'),
            ];
        }

        const bodyHeight = height - 3;
        this.visibleListHeight = Math.max(1, bodyHeight);
        const lines = [titleBorder()];

        if (this.runs.length === 0) {
            const emptyRow = Math.floor(bodyHeight / 2);
            for (let row = 0; row < bodyHeight; row++) {
                lines.push(
                    contentRow(
                        row === emptyRow
                            ? this.theme.fg('muted', 'No active or queued subagents')
                            : '',
                        'center'
                    )
                );
            }
        } else {
            const startIndex = Math.max(
                0,
                Math.min(
                    this.selectedIndex - Math.floor(bodyHeight / 2),
                    this.runs.length - bodyHeight
                )
            );
            const endIndex = Math.min(this.runs.length, startIndex + bodyHeight);
            for (let row = 0; row < bodyHeight; row++) {
                const index = startIndex + row;
                const run = index < endIndex ? this.runs[index] : undefined;
                lines.push(
                    run
                        ? contentRow(
                              this.renderRun(run, index === this.selectedIndex),
                              'left',
                              index === this.selectedIndex
                          )
                        : contentRow('')
                );
            }
        }

        const upKeys = this.keybindings.getKeys('tui.select.up').join('/');
        const downKeys = this.keybindings.getKeys('tui.select.down').join('/');
        const navigationKeys =
            upKeys || downKeys
                ? [upKeys, downKeys].filter(Boolean).join('/')
                : 'navigation unbound';
        const position =
            this.runs.length > bodyHeight ? ` · ${this.selectedIndex + 1}/${this.runs.length}` : '';
        const navigationHint = this.runs.length > 0 ? `${navigationKeys} select · ` : '';
        lines.push(contentRow(this.theme.fg('dim', ` ${navigationHint}${closeHint}${position}`)));
        lines.push(horizontalBorder('╰', '╯'));
        return lines;
    }

    invalidate(): void {}

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
    }

    private refreshRuns(): void {
        if (this.disposed) return;
        const selectedId = this.runs[this.selectedIndex]?.id;
        const nextRuns = activeAndQueuedRuns(this.runSource);
        this.runs = nextRuns;

        const selectedRunIndex = selectedId
            ? nextRuns.findIndex((run) => run.id === selectedId)
            : -1;
        this.selectedIndex =
            selectedRunIndex >= 0
                ? selectedRunIndex
                : Math.max(0, Math.min(this.selectedIndex, nextRuns.length - 1));
        this.tui.requestRender();
    }

    private renderRun(run: SubagentRunSnapshot, selected: boolean): string {
        const prefix = this.theme.fg('accent', selected ? '› ' : '  ');
        const status = this.theme.fg(
            stateColor(run.state),
            `${stateMarker(run.state)} ${run.state}`
        );
        const taskSummary = run.task.replace(/[\r\n]+/gu, ' ').trim() || '(untitled task)';
        const task = this.theme.fg(selected ? 'text' : 'muted', taskSummary);
        return `${prefix}${status}  ${task}`;
    }
}

export async function openSubagentsModal(
    ctx: ExtensionCommandContext,
    runSource?: SubagentRunSource
): Promise<void> {
    await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) =>
            new SubagentsModal(tui, theme, keybindings, () => done(), runSource),
        {
            overlay: true,
            overlayOptions: {
                anchor: 'center',
                width: '94%',
                maxHeight: '90%',
                margin: 0,
            },
        }
    );
}
