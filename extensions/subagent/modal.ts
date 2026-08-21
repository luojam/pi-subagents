import type { ExtensionContext, KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import {
    type Component,
    Key,
    matchesKey,
    type TUI,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import {
    formatSubagentRuntime,
    formatSubagentStats,
    formatSubagentTextTail,
} from './formatting/run-details.ts';
import { isTerminalRunState } from './run-store.ts';
import { type ConfiguredSubagentThinkingLevel, cycleSubagentThinkingLevel } from './thinking.ts';
import type { SubagentRunSnapshot, SubagentRunState } from './types.ts';

const TARGET_HEIGHT_RATIO = 0.93;
const FULL_MODAL_HEIGHT = 15;
const SECTION_ROWS = 11;
const SUBAGENT_MODAL_SHORTCUT = Key.ctrlAlt('s');

type ModalSection = 'activity' | 'configuration';
type ConfigurationSetting = 'enabled' | 'reasoning' | 'parallelism';

interface RunSpan {
    readonly start: number;
    readonly end: number;
}

const CONFIGURATION_SETTINGS: readonly ConfigurationSetting[] = [
    'enabled',
    'reasoning',
    'parallelism',
];
const CONFIGURATION_SETTINGS_LABELS: Record<ConfigurationSetting, string> = {
    enabled: 'Subagent tool',
    reasoning: 'Reasoning level',
    parallelism: 'Max parallelism',
};
const CONFIGURATION_LABEL_WIDTH = Math.max(
    ...CONFIGURATION_SETTINGS.map((setting) => visibleWidth(CONFIGURATION_SETTINGS_LABELS[setting]))
);

export interface SubagentsModalOptions {
    enabled: boolean;
    thinkingLevel?: ConfiguredSubagentThinkingLevel;
    maxParallelism: number;
    maxParallelismLimit: number;
    onEnabledChange(enabled: boolean): void;
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

function compactKeyLabel(key: string | undefined): string | undefined {
    if (!key) return undefined;

    const labels: Record<string, string> = {
        up: '↑',
        down: '↓',
        left: '←',
        right: '→',
        pageUp: 'pgup',
        pageDown: 'pgdn',
        escape: 'esc',
    };
    return labels[key] ?? key;
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

function currentRunsFirst(source: SubagentRunSource | undefined): readonly SubagentRunSnapshot[] {
    const current: SubagentRunSnapshot[] = [];
    const terminal: SubagentRunSnapshot[] = [];
    for (const run of source?.list() ?? []) {
        (isTerminalRunState(run.state) ? terminal : current).push(run);
    }
    terminal.sort((left, right) => {
        const completionOrder = (right.endedAt ?? right.queuedAt) - (left.endedAt ?? left.queuedAt);
        return completionOrder || right.queuedAt - left.queuedAt;
    });
    return [...current, ...terminal];
}

export class SubagentsModal implements Component {
    private closed = false;
    private disposed = false;
    private runs: readonly SubagentRunSnapshot[];
    private focusedSection: ModalSection = 'activity';
    private selectedIndex = 0;
    private selectedSettingIndex = 0;
    private expandedRunId: string | undefined;
    private activityScrollTop = 0;
    private revealSelectedRun: 'start' | 'end' | undefined = 'start';
    private pendingSelectedViewportOffset: number | undefined;
    private runSpans: readonly RunSpan[] = [];
    private runSpansById = new Map<string, RunSpan>();
    private activityLineCount = 0;
    private activityContentWidth: number | undefined;
    private enabled: boolean;
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
    private readonly onEnabledChange: (enabled: boolean) => void;
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
        this.runs = currentRunsFirst(runSource);
        this.onEnabledChange = options.onEnabledChange;
        this.onThinkingLevelChange = options.onThinkingLevelChange;
        this.onMaxParallelismChange = options.onMaxParallelismChange;
        this.enabled = options.enabled;
        this.thinkingLevel = options.thinkingLevel ?? 'inherit';
        this.maxParallelismLimit = options.maxParallelismLimit;
        this.maxParallelism = options.maxParallelism;
        this.unsubscribe = runSource?.subscribe(() => this.refreshRuns());
    }

    handleInput(data: string): void {
        if (this.closed) return;

        if (
            matchesKey(data, SUBAGENT_MODAL_SHORTCUT) ||
            this.keybindings.matches(data, 'tui.select.cancel')
        ) {
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

        const selectedRun = this.runs[this.selectedIndex];
        const matchesNavigation = (
            [
                'tui.select.up',
                'tui.select.down',
                'tui.select.pageUp',
                'tui.select.pageDown',
            ] as const
        ).some((action) => this.keybindings.matches(data, action));
        const expand = !matchesNavigation && matchesKey(data, Key.right);
        const collapse = !matchesNavigation && matchesKey(data, Key.left);
        if (
            selectedRun &&
            ((expand && this.expandedRunId !== selectedRun.id) ||
                (collapse && this.expandedRunId === selectedRun.id))
        ) {
            this.expandedRunId = expand ? selectedRun.id : undefined;
            this.pendingSelectedViewportOffset = undefined;
            this.revealSelectedRun = 'start';
            this.relayoutActivityRuns();
            this.tui.requestRender();
            return;
        }

        let nextIndex = this.selectedIndex;
        let revealEdge: 'start' | 'end' = 'start';
        if (this.keybindings.matches(data, 'tui.select.up')) {
            nextIndex = this.selectedIndex === 0 ? this.runs.length - 1 : this.selectedIndex - 1;
            revealEdge = 'end';
        } else if (this.keybindings.matches(data, 'tui.select.down')) {
            nextIndex = this.selectedIndex === this.runs.length - 1 ? 0 : this.selectedIndex + 1;
        } else if (this.keybindings.matches(data, 'tui.select.pageUp')) {
            if (this.scrollExpandedRun(-1)) return;
            nextIndex = this.pageSelection(-1);
            revealEdge = 'end';
        } else if (this.keybindings.matches(data, 'tui.select.pageDown')) {
            if (this.scrollExpandedRun(1)) return;
            nextIndex = this.pageSelection(1);
        }

        if (nextIndex !== this.selectedIndex) {
            this.selectedIndex = nextIndex;
            this.pendingSelectedViewportOffset = undefined;
            this.revealSelectedRun = revealEdge;
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
            if (innerWidth < 2) {
                return `${border('│')}${' '.repeat(innerWidth)}${border('│')}`;
            }
            const padded = padToWidth(
                content,
                innerWidth - 2,
                alignment,
                selected ? (value) => this.theme.bg('selectedBg', value) : undefined
            );
            return `${border('│')} ${padded} ${border('│')}`;
        };

        const closeKey = compactKeyLabel(this.keybindings.getKeys('tui.select.cancel')[0]);
        const closeHint = closeKey ? `${closeKey} close` : 'close unbound';

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
        const lines = [titleBorder(), contentRow('')];
        const totalCount = this.runs.length;
        const queuedCount = this.runs.filter((run) => run.state === 'queued').length;
        const activeCount = this.runs.filter(
            (run) => !isTerminalRunState(run.state) && run.state !== 'queued'
        ).length;

        lines.push(
            contentRow(
                this.renderSectionHeader(
                    'Configuration',
                    '',
                    this.focusedSection === 'configuration'
                )
            )
        );
        lines.push(contentRow(''));
        lines.push(
            contentRow(
                this.renderSetting(
                    CONFIGURATION_SETTINGS_LABELS.enabled,
                    this.enabled ? 'enabled' : 'disabled',
                    0
                ),
                'left',
                this.focusedSection === 'configuration' && this.selectedSettingIndex === 0
            )
        );
        lines.push(
            contentRow(
                this.renderSetting(CONFIGURATION_SETTINGS_LABELS.reasoning, this.thinkingLevel, 1),
                'left',
                this.focusedSection === 'configuration' && this.selectedSettingIndex === 1
            )
        );
        lines.push(
            contentRow(
                this.renderSetting(
                    CONFIGURATION_SETTINGS_LABELS.parallelism,
                    String(this.maxParallelism),
                    2
                ),
                'left',
                this.focusedSection === 'configuration' && this.selectedSettingIndex === 2
            )
        );
        lines.push(contentRow(''));
        lines.push(contentRow(border('─'.repeat(Math.max(0, innerWidth - 2)))));
        lines.push(contentRow(''));
        lines.push(
            contentRow(
                this.renderSectionHeader(
                    'Activity',
                    `${this.theme.fg('accent', '●')} ${activeCount} active  ${queuedCount} queued  ${totalCount} total`,
                    this.focusedSection === 'activity'
                )
            )
        );
        lines.push(contentRow(''));

        const contentWidth = Math.max(0, innerWidth - 2);
        this.activityContentWidth = contentWidth;
        if (this.runs.length === 0) {
            this.runSpans = [];
            this.runSpansById = new Map();
            this.activityLineCount = 0;
            const emptyRow = Math.floor(listHeight / 2);
            for (let row = 0; row < listHeight; row++) {
                lines.push(
                    contentRow(
                        row === emptyRow ? this.theme.fg('muted', 'No subagent activity') : '',
                        'center'
                    )
                );
            }
        } else {
            const flattened = this.layoutActivityRuns(contentWidth);
            this.updateActivityViewport(listHeight);

            for (let row = 0; row < listHeight; row++) {
                const rendered = flattened[this.activityScrollTop + row];
                lines.push(
                    rendered
                        ? contentRow(rendered.content, 'left', rendered.selected)
                        : contentRow('')
                );
            }
        }

        const position =
            this.runs.length > 1 && this.activityLineCount > listHeight
                ? ` · ${this.selectedIndex + 1}/${this.runs.length}`
                : '';
        const tabKeys = this.keybindings.getKeys('tui.input.tab').join('/');
        const sectionHint = tabKeys ? `${tabKeys} section · ` : 'section unbound · ';
        const upKey = compactKeyLabel(this.keybindings.getKeys('tui.select.up')[0]);
        const downKey = compactKeyLabel(this.keybindings.getKeys('tui.select.down')[0]);
        const selectionKeys = [upKey, downKey].filter(Boolean).join('/');
        const selectionHint = selectionKeys
            ? `${selectionKeys} select · `
            : 'navigation unbound · ';
        const expanded = this.runs[this.selectedIndex]?.id === this.expandedRunId;
        const navigationHint =
            this.focusedSection === 'configuration'
                ? `${selectionHint}←/→ change · `
                : this.runs.length > 0
                  ? `${selectionHint}${expanded ? '← collapse' : '→ expand'} · `
                  : '';
        const selectedSpan = this.runSpans[this.selectedIndex];
        const pagingActive =
            this.focusedSection === 'activity' &&
            expanded &&
            selectedSpan !== undefined &&
            selectedSpan.end - selectedSpan.start > listHeight;
        const pageKeys = [
            compactKeyLabel(this.keybindings.getKeys('tui.select.pageUp')[0]),
            compactKeyLabel(this.keybindings.getKeys('tui.select.pageDown')[0]),
        ]
            .filter(Boolean)
            .join('/');
        const pagingHint = pagingActive
            ? pageKeys
                ? ` · ${pageKeys} scroll`
                : ' · paging unbound'
            : '';
        lines.push(
            contentRow(
                this.theme.fg(
                    'dim',
                    ` ${sectionHint}${navigationHint}${closeHint}${pagingHint}${position}`
                )
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
        const availableHeight = Math.max(1, Math.floor(terminalRows * 0.95));
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

        const setting = CONFIGURATION_SETTINGS[this.selectedSettingIndex];
        if (setting === 'enabled') {
            const enabled = !this.enabled;
            this.onEnabledChange(enabled);
            this.enabled = enabled;
        } else if (setting === 'reasoning') {
            const thinkingLevel = cycleSubagentThinkingLevel(this.thinkingLevel, direction);
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
        const selectedSpan = selectedId ? this.runSpansById.get(selectedId) : undefined;
        const selectedViewportOffset = selectedSpan
            ? selectedSpan.start - this.activityScrollTop
            : undefined;
        const nextRuns = currentRunsFirst(this.runSource);
        this.runs = nextRuns;

        const selectedRunIndex = selectedId
            ? nextRuns.findIndex((run) => run.id === selectedId)
            : -1;
        this.selectedIndex =
            selectedRunIndex >= 0
                ? selectedRunIndex
                : Math.max(0, Math.min(this.selectedIndex, nextRuns.length - 1));
        if (this.expandedRunId && !nextRuns.some((run) => run.id === this.expandedRunId)) {
            this.expandedRunId = undefined;
        }
        if (this.revealSelectedRun) {
            this.pendingSelectedViewportOffset = undefined;
        } else if (selectedRunIndex >= 0 && selectedViewportOffset !== undefined) {
            this.pendingSelectedViewportOffset = selectedViewportOffset;
        } else {
            this.pendingSelectedViewportOffset = undefined;
            this.revealSelectedRun = 'start';
        }
        this.relayoutActivityRuns();
        this.tui.requestRender();
    }

    private layoutActivityRuns(
        contentWidth: number
    ): Array<{ content: string; selected: boolean }> {
        const flattened: Array<{ content: string; selected: boolean }> = [];
        const spans: RunSpan[] = [];
        const spansById = new Map<string, RunSpan>();
        for (const [index, run] of this.runs.entries()) {
            const selected = this.focusedSection === 'activity' && index === this.selectedIndex;
            const start = flattened.length;
            flattened.push(
                ...this.renderRunLines(
                    run,
                    selected,
                    contentWidth,
                    run.id === this.expandedRunId
                ).map((content) => ({ content, selected }))
            );
            const span = { start, end: flattened.length };
            spans.push(span);
            spansById.set(run.id, span);
        }
        this.runSpans = spans;
        this.runSpansById = spansById;
        this.activityLineCount = flattened.length;
        return flattened;
    }

    private relayoutActivityRuns(): void {
        if (this.activityContentWidth === undefined) return;
        this.layoutActivityRuns(this.activityContentWidth);
        this.updateActivityViewport(this.visibleListHeight);
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
        const labelPadding = ' '.repeat(
            Math.max(0, CONFIGURATION_LABEL_WIDTH - visibleWidth(label))
        );
        const control = `${this.theme.fg('dim', '‹')} ${this.theme.fg(
            selected ? 'accent' : 'text',
            value
        )} ${this.theme.fg('dim', '›')}`;
        return `${prefix}${styledLabel}${labelPadding}  ${control}`;
    }

    private pageSelection(direction: -1 | 1): number {
        const selectedSpan = this.runSpans[this.selectedIndex];
        if (!selectedSpan || this.runSpans.length !== this.runs.length) {
            return Math.max(
                0,
                Math.min(
                    this.runs.length - 1,
                    this.selectedIndex + direction * this.visibleListHeight
                )
            );
        }

        const targetLine = selectedSpan.start + direction * this.visibleListHeight;
        if (direction < 0) {
            for (let index = this.selectedIndex - 1; index >= 0; index--) {
                if ((this.runSpans[index]?.start ?? 0) <= targetLine) return index;
            }
            return 0;
        }
        for (let index = this.selectedIndex + 1; index < this.runSpans.length; index++) {
            if ((this.runSpans[index]?.end ?? Number.NEGATIVE_INFINITY) > targetLine) return index;
        }
        return this.runs.length - 1;
    }

    private scrollExpandedRun(direction: -1 | 1): boolean {
        const selectedRun = this.runs[this.selectedIndex];
        const selectedSpan = this.runSpans[this.selectedIndex];
        if (
            !selectedRun ||
            selectedRun.id !== this.expandedRunId ||
            !selectedSpan ||
            selectedSpan.end - selectedSpan.start <= this.visibleListHeight
        ) {
            return false;
        }

        const boundary =
            direction < 0
                ? selectedSpan.start
                : Math.max(selectedSpan.start, selectedSpan.end - this.visibleListHeight);
        const nextScrollTop =
            direction < 0
                ? Math.max(boundary, this.activityScrollTop - this.visibleListHeight)
                : Math.min(boundary, this.activityScrollTop + this.visibleListHeight);
        if (nextScrollTop === this.activityScrollTop) return false;
        this.activityScrollTop = nextScrollTop;
        this.pendingSelectedViewportOffset = undefined;
        this.revealSelectedRun = undefined;
        this.tui.requestRender();
        return true;
    }

    private updateActivityViewport(listHeight: number): void {
        const maxScrollTop = Math.max(0, this.activityLineCount - listHeight);
        this.activityScrollTop = Math.max(0, Math.min(this.activityScrollTop, maxScrollTop));
        const selectedSpan = this.runSpans[this.selectedIndex];
        if (!selectedSpan) {
            this.activityScrollTop = 0;
            this.pendingSelectedViewportOffset = undefined;
            this.revealSelectedRun = undefined;
            return;
        }

        if (this.pendingSelectedViewportOffset !== undefined) {
            const spanHeight = selectedSpan.end - selectedSpan.start;
            const minimum =
                spanHeight > listHeight ? selectedSpan.start : selectedSpan.end - listHeight;
            const maximum =
                spanHeight > listHeight ? selectedSpan.end - listHeight : selectedSpan.start;
            const desired = selectedSpan.start - this.pendingSelectedViewportOffset;
            this.activityScrollTop = Math.max(minimum, Math.min(desired, maximum));
            this.pendingSelectedViewportOffset = undefined;
            this.revealSelectedRun = undefined;
        } else if (this.revealSelectedRun) {
            if (selectedSpan.end - selectedSpan.start > listHeight) {
                this.activityScrollTop =
                    this.revealSelectedRun === 'end'
                        ? selectedSpan.end - listHeight
                        : selectedSpan.start;
            } else if (selectedSpan.start < this.activityScrollTop) {
                this.activityScrollTop = selectedSpan.start;
            } else if (selectedSpan.end > this.activityScrollTop + listHeight) {
                this.activityScrollTop = selectedSpan.end - listHeight;
            }
            this.revealSelectedRun = undefined;
        }

        const spanHeight = selectedSpan.end - selectedSpan.start;
        const minimum =
            spanHeight > listHeight ? selectedSpan.start : selectedSpan.end - listHeight;
        const maximum =
            spanHeight > listHeight ? selectedSpan.end - listHeight : selectedSpan.start;
        this.activityScrollTop = Math.max(minimum, Math.min(this.activityScrollTop, maximum));
        this.activityScrollTop = Math.max(0, Math.min(this.activityScrollTop, maxScrollTop));
    }

    private renderRunLines(
        run: SubagentRunSnapshot,
        selected: boolean,
        width: number,
        expanded: boolean
    ): string[] {
        const prefix = this.theme.fg('accent', selected ? '› ' : '  ');
        const status = this.theme.fg(
            stateColor(run.state),
            `${stateMarker(run.state)} ${run.state}`
        );
        const taskSummary = run.task.replace(/[\r\n]+/gu, ' ').trim() || '(untitled task)';
        if (!expanded) {
            return [
                `${prefix}${status}  ${this.theme.fg(selected ? 'text' : 'muted', taskSummary)}`,
            ];
        }

        const task = run.task.replace(/\r\n?/gu, '\n').trim() || '(untitled task)';
        const heading = `${prefix}${status}  `;
        const headingWidth = visibleWidth(heading);
        const inlineTaskWidth = width - headingWidth;
        const taskColor = selected ? 'text' : 'muted';

        let taskLines: string[];
        if (inlineTaskWidth >= 8) {
            const wrappedTask = this.wrapTask(task, inlineTaskWidth);
            taskLines = wrappedTask.map((line, index) => {
                const indentation = index === 0 ? heading : ' '.repeat(headingWidth);
                return `${indentation}${this.theme.fg(taskColor, line)}`;
            });
        } else {
            const indentationWidth = Math.min(4, Math.max(0, width - 1));
            const indentation = ' '.repeat(indentationWidth);
            const wrappedTask = this.wrapTask(task, Math.max(1, width - indentationWidth));
            taskLines = [
                `${prefix}${status}`,
                ...wrappedTask.map((line) => `${indentation}${this.theme.fg(taskColor, line)}`),
            ];
        }

        return [
            ...taskLines,
            ...this.renderExpandedSection('Runtime', formatSubagentRuntime(run), width, 'muted'),
            ...this.renderExpandedSection('Stats', formatSubagentStats(run), width, 'dim'),
            ...(run.thinkingTail.trim()
                ? this.renderExpandedSection(
                      'Thinking tail (provider-exposed)',
                      formatSubagentTextTail(run.thinkingTail).filter((line) => line.trim() !== ''),
                      width,
                      'dim'
                  )
                : []),
            ...(run.responseTail.trim()
                ? this.renderExpandedSection(
                      'Response tail',
                      formatSubagentTextTail(run.responseTail),
                      width,
                      'toolOutput'
                  )
                : []),
        ];
    }

    private renderExpandedSection(
        label: string,
        details: readonly string[],
        width: number,
        color?: 'toolOutput' | 'muted' | 'dim'
    ): string[] {
        if (details.length === 0) return [];
        const labelIndentation = ' '.repeat(Math.min(4, Math.max(0, width - 1)));
        const detailIndentation = ' '.repeat(Math.min(6, Math.max(0, width - 1)));
        const detailWidth = Math.max(1, width - detailIndentation.length);
        return [
            `${labelIndentation}${this.theme.fg('accent', label)}`,
            ...details.flatMap((detail) =>
                this.wrapTask(detail, detailWidth).map(
                    (line) => `${detailIndentation}${color ? this.theme.fg(color, line) : line}`
                )
            ),
        ];
    }

    private wrapTask(task: string, width: number): string[] {
        return task.split('\n').flatMap((line) => {
            const wrapped = wrapTextWithAnsi(line, width);
            return wrapped.length > 0 ? wrapped : [''];
        });
    }
}

export async function openSubagentsModal(
    ctx: ExtensionContext,
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
                width: '95%',
                maxHeight: '95%',
                margin: 0,
            },
        }
    );
}
