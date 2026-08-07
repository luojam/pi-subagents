import type {
    ExtensionCommandContext,
    KeybindingsManager,
    Theme,
} from '@earendil-works/pi-coding-agent';
import {
    type Component,
    Key,
    matchesKey,
    type TUI,
    truncateToWidth,
    visibleWidth,
} from '@earendil-works/pi-tui';
import { isTerminalRunState } from './run-store.ts';
import { type ConfiguredSubagentThinkingLevel, SUBAGENT_THINKING_LEVELS } from './thinking.ts';
import type { SubagentRunSnapshot, SubagentRunState } from './types.ts';

const TARGET_HEIGHT_RATIO = 0.88;
const FULL_MODAL_HEIGHT = 8;
const SECTION_ROWS = 4;

type ModalSection = 'activity' | 'configuration';
type ConfigurationSetting = 'reasoning' | 'parallelism';

const CONFIGURATION_SETTINGS: readonly ConfigurationSetting[] = ['reasoning', 'parallelism'];

export interface SubagentsModalOptions {
    thinkingLevel?: ConfiguredSubagentThinkingLevel;
    maxParallelism: number;
    maxParallelismLimit: number;
    onThinkingLevelChange(thinkingLevel: ConfiguredSubagentThinkingLevel): void;
    onMaxParallelismChange(maxParallelism: number): void;
}

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
    private focusedSection: ModalSection = 'activity';
    private selectedIndex = 0;
    private selectedSettingIndex = 0;
    private thinkingLevel: ConfiguredSubagentThinkingLevel;
    private maxParallelism: number;
    private readonly maxParallelismLimit: number;
    private visibleListHeight = 1;
    private unsubscribe: (() => void) | undefined;
    private readonly tui: TUI;
    private readonly theme: Theme;
    private readonly keybindings: KeybindingsManager;
    private readonly onClose: () => void;
    private readonly runSource: SubagentRunSource | undefined;
    private readonly onThinkingLevelChange: (
        thinkingLevel: ConfiguredSubagentThinkingLevel
    ) => void;
    private readonly onMaxParallelismChange: (maxParallelism: number) => void;

    constructor(
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        onClose: () => void,
        runSource: SubagentRunSource | undefined,
        options: SubagentsModalOptions
    ) {
        this.tui = tui;
        this.theme = theme;
        this.keybindings = keybindings;
        this.onClose = onClose;
        this.runSource = runSource;
        this.runs = activeAndQueuedRuns(runSource);
        this.onThinkingLevelChange = options.onThinkingLevelChange;
        this.onMaxParallelismChange = options.onMaxParallelismChange;
        this.thinkingLevel = options.thinkingLevel ?? 'inherit';
        this.maxParallelismLimit = options.maxParallelismLimit;
        this.maxParallelism = options.maxParallelism;
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
        if (this.modalHeight() < FULL_MODAL_HEIGHT) return;

        if (this.keybindings.matches(data, 'tui.input.tab')) {
            this.focusedSection = this.focusedSection === 'activity' ? 'configuration' : 'activity';
            this.tui.requestRender();
            return;
        }

        if (this.focusedSection === 'configuration') {
            this.handleConfigurationInput(data);
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
        const height = this.modalHeight();

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

        if (height < FULL_MODAL_HEIGHT) {
            const lines = [titleBorder()];
            const messageRow = Math.floor((height - 3) / 2);
            for (let row = 0; row < height - 3; row++) {
                lines.push(
                    contentRow(
                        row === messageRow ? this.theme.fg('warning', 'Terminal too small') : '',
                        'center'
                    )
                );
            }
            lines.push(contentRow(this.theme.fg('dim', ` ${closeHint}`)));
            lines.push(horizontalBorder('╰', '╯'));
            return lines;
        }

        const bodyHeight = height - 3;
        const listHeight = Math.max(1, bodyHeight - SECTION_ROWS);
        this.visibleListHeight = listHeight;
        const lines = [titleBorder()];
        const activeCount = this.runs.filter((run) => run.state !== 'queued').length;
        const queuedCount = this.runs.length - activeCount;

        lines.push(
            contentRow(
                this.renderSectionHeader(
                    'Configuration',
                    '',
                    this.focusedSection === 'configuration'
                )
            )
        );
        lines.push(
            contentRow(
                this.renderSetting('Reasoning level', this.thinkingLevel, 0),
                'left',
                this.focusedSection === 'configuration' && this.selectedSettingIndex === 0
            )
        );
        lines.push(
            contentRow(
                this.renderSetting('Max parallelism', String(this.maxParallelism), 1),
                'left',
                this.focusedSection === 'configuration' && this.selectedSettingIndex === 1
            )
        );
        lines.push(
            contentRow(
                this.renderSectionHeader(
                    'Activity',
                    `${this.theme.fg('accent', '●')} ${activeCount} active  ${this.theme.fg(
                        'muted',
                        '…'
                    )} ${queuedCount} queued`,
                    this.focusedSection === 'activity'
                )
            )
        );

        if (this.runs.length === 0) {
            const emptyRow = Math.floor(listHeight / 2);
            for (let row = 0; row < listHeight; row++) {
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
                    this.selectedIndex - Math.floor(listHeight / 2),
                    this.runs.length - listHeight
                )
            );
            const endIndex = Math.min(this.runs.length, startIndex + listHeight);
            for (let row = 0; row < listHeight; row++) {
                const index = startIndex + row;
                const run = index < endIndex ? this.runs[index] : undefined;
                const selected = this.focusedSection === 'activity' && index === this.selectedIndex;
                lines.push(
                    run
                        ? contentRow(this.renderRun(run, selected), 'left', selected)
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
            this.runs.length > listHeight ? ` · ${this.selectedIndex + 1}/${this.runs.length}` : '';
        const tabKeys = this.keybindings.getKeys('tui.input.tab').join('/');
        const sectionHint = tabKeys ? `${tabKeys} section · ` : 'section unbound · ';
        const navigationHint =
            this.focusedSection === 'configuration'
                ? `${navigationKeys} select · ←/→ change · `
                : this.runs.length > 0
                  ? `${navigationKeys} select · `
                  : '';
        lines.push(
            contentRow(
                this.theme.fg('dim', ` ${sectionHint}${navigationHint}${closeHint}${position}`)
            )
        );
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

    private modalHeight(): number {
        const terminalRows = Math.max(0, this.tui.terminal.rows);
        const targetHeight = Math.max(
            FULL_MODAL_HEIGHT,
            Math.floor(terminalRows * TARGET_HEIGHT_RATIO)
        );
        // Match the overlay's maxHeight so it never slices off structural rows such
        // as the close hint or bottom border.
        const availableHeight = Math.max(1, Math.floor(terminalRows * 0.9));
        return Math.min(targetHeight, availableHeight);
    }

    private handleConfigurationInput(data: string): void {
        let nextSettingIndex = this.selectedSettingIndex;
        if (this.keybindings.matches(data, 'tui.select.up')) {
            nextSettingIndex =
                this.selectedSettingIndex === 0
                    ? CONFIGURATION_SETTINGS.length - 1
                    : this.selectedSettingIndex - 1;
        } else if (this.keybindings.matches(data, 'tui.select.down')) {
            nextSettingIndex =
                this.selectedSettingIndex === CONFIGURATION_SETTINGS.length - 1
                    ? 0
                    : this.selectedSettingIndex + 1;
        }

        if (nextSettingIndex !== this.selectedSettingIndex) {
            this.selectedSettingIndex = nextSettingIndex;
            this.tui.requestRender();
            return;
        }

        const direction = matchesKey(data, Key.left)
            ? -1
            : matchesKey(data, Key.right) || this.keybindings.matches(data, 'tui.select.confirm')
              ? 1
              : 0;
        if (direction === 0) return;

        if (CONFIGURATION_SETTINGS[this.selectedSettingIndex] === 'reasoning') {
            const currentIndex = SUBAGENT_THINKING_LEVELS.indexOf(this.thinkingLevel);
            const nextIndex =
                (currentIndex + direction + SUBAGENT_THINKING_LEVELS.length) %
                SUBAGENT_THINKING_LEVELS.length;
            const thinkingLevel = SUBAGENT_THINKING_LEVELS[nextIndex];
            this.onThinkingLevelChange(thinkingLevel);
            this.thinkingLevel = thinkingLevel;
        } else {
            const maxParallelism =
                ((this.maxParallelism - 1 + direction + this.maxParallelismLimit) %
                    this.maxParallelismLimit) +
                1;
            this.onMaxParallelismChange(maxParallelism);
            this.maxParallelism = maxParallelism;
        }
        this.tui.requestRender();
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

    private renderSectionHeader(label: string, detail: string, focused: boolean): string {
        const prefix = this.theme.fg('accent', focused ? '◆ ' : '  ');
        const heading = this.theme.fg(focused ? 'accent' : 'muted', label);
        return detail
            ? `${prefix}${heading}  ${this.theme.fg('dim', '·')}  ${detail}`
            : `${prefix}${heading}`;
    }

    private renderSetting(label: string, value: string, index: number): string {
        const selected =
            this.focusedSection === 'configuration' && this.selectedSettingIndex === index;
        const prefix = this.theme.fg('accent', selected ? '› ' : '  ');
        const styledLabel = this.theme.fg(selected ? 'text' : 'muted', label);
        const control = `${this.theme.fg('dim', '‹')} ${this.theme.fg(
            selected ? 'accent' : 'text',
            value
        )} ${this.theme.fg('dim', '›')}`;
        return `${prefix}${styledLabel}  ${control}`;
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
    runSource: SubagentRunSource | undefined,
    options: SubagentsModalOptions
): Promise<void> {
    await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) =>
            new SubagentsModal(tui, theme, keybindings, () => done(), runSource, options),
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
