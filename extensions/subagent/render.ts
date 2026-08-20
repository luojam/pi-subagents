import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { keyHint, keyText, type Theme } from '@earendil-works/pi-coding-agent';
import {
    type Component,
    sliceByColumn,
    visibleWidth,
    wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import {
    type FormattedSubagentActivity,
    formatElapsed,
    formatSubagentActivity,
    formatSubagentContext,
    formatSubagentRuntime,
    formatSubagentStats,
    formatSubagentTextTail,
    formatToolCallSummary,
} from './formatting/run-details.ts';
import { sanitizeTerminalText } from './formatting/terminal-sanitizer.ts';
import { truncateUtf8Head } from './formatting/utf8.ts';
import type { SubagentRunSnapshot, SubagentRunState, SubagentToolCallSnapshot } from './types.ts';

const TASK_SUMMARY_MAX_BYTES = 512;
const FALLBACK_MAX_BYTES = 2 * 1_024;
const EXPANDED_TEXT_MAX_BYTES = 8 * 1_024;
const TASK_MAX_LINES = 8;
const COLLAPSED_MAX_COLUMNS = 100;
const TRUNCATED_TASK_END_PADDING_COLUMNS = 3;

type ThemeColor = 'toolOutput' | 'muted' | 'dim' | 'error';

// biome-ignore lint/suspicious/noControlCharactersInRegex: Parses intentional ANSI SGR sequences.
const SGR_SEQUENCE = /\x1B\[([\d;:]*)m/gu;

/** Close styles active at the end of text without resetting its inherited background. */
function selectiveStyleTerminators(text: string): string {
    const activeTerminators = new Set<number>();

    for (const match of text.matchAll(SGR_SEQUENCE)) {
        const rawParameters = match[1] || '0';
        const parameters = rawParameters.split(';');
        for (let index = 0; index < parameters.length; index++) {
            const parameter = parameters[index] ?? '0';
            const code = Number(parameter.split(':', 1)[0] || 0);

            if (code === 0) {
                activeTerminators.clear();
            } else if (code === 1 || code === 2) {
                activeTerminators.add(22);
            } else if (code === 3) {
                activeTerminators.add(23);
            } else if (code === 4 || code === 21) {
                activeTerminators.add(24);
            } else if (code === 5 || code === 6) {
                activeTerminators.add(25);
            } else if (code === 7) {
                activeTerminators.add(27);
            } else if (code === 8) {
                activeTerminators.add(28);
            } else if (code === 9) {
                activeTerminators.add(29);
            } else if (code === 53) {
                activeTerminators.add(55);
            } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
                activeTerminators.add(39);
            } else if (code === 38) {
                activeTerminators.add(39);
                // Skip semicolon-form indexed/RGB foreground color arguments.
                if (!parameter.includes(':')) index += parameters[index + 1] === '2' ? 4 : 2;
            } else if (code === 48) {
                if (!parameter.includes(':')) index += parameters[index + 1] === '2' ? 4 : 2;
            } else if (
                code === 22 ||
                code === 23 ||
                code === 24 ||
                code === 25 ||
                code === 27 ||
                code === 28 ||
                code === 29 ||
                code === 39 ||
                code === 55
            ) {
                activeTerminators.delete(code);
            }
        }
    }

    return activeTerminators.size > 0 ? `\x1B[${[...activeTerminators].join(';')}m` : '';
}

function truncateStyledLine(text: string, maxWidth: number, ellipsis = '…'): string {
    if (maxWidth <= 0) return '';
    if (visibleWidth(text) <= maxWidth) return text;

    const ellipsisWidth = visibleWidth(ellipsis);
    if (ellipsisWidth >= maxWidth) return sliceByColumn(ellipsis, 0, maxWidth, true);
    const prefix = sliceByColumn(text, 0, maxWidth - ellipsisWidth, true);
    return prefix + ellipsis + selectiveStyleTerminators(prefix);
}

/** A stateless component which applies the terminal width after styling. */
class WidthSafeLines implements Component {
    private readonly getLines: (width: number) => string[];
    private readonly wrap: boolean;
    private readonly maxWidth?: number;

    constructor(
        getLines: (width: number) => string[],
        options: { wrap?: boolean; maxWidth?: number } = {}
    ) {
        this.getLines = getLines;
        this.wrap = options.wrap ?? false;
        this.maxWidth = options.maxWidth;
    }

    render(width: number): string[] {
        if (width <= 0) return [];
        const contentWidth = Math.min(width, this.maxWidth ?? width);
        const lines = this.getLines(contentWidth);
        if (this.wrap) {
            return lines.flatMap((line) => {
                const indent = line.match(/^ +/u)?.[0] ?? '';
                const availableWidth = contentWidth - indent.length;
                const wrapped =
                    indent && availableWidth > 0
                        ? wrapTextWithAnsi(line.slice(indent.length), availableWidth).map(
                              (content) => indent + content
                          )
                        : wrapTextWithAnsi(line, contentWidth);
                return wrapped.map((content) => truncateStyledLine(content, contentWidth));
            });
        }
        return lines.map((line) => truncateStyledLine(line, contentWidth));
    }

    invalidate(): void {
        // There is no render cache to clear.
    }
}

export function sanitizeSingleLine(text: string): string {
    return sanitizeTerminalText(text);
}

function safeMultiline(text: string): string {
    return sanitizeTerminalText(text, true);
}

function boundedLine(text: string, maxBytes: number): string {
    return truncateUtf8Head(sanitizeSingleLine(text), maxBytes);
}

function boundedMultilineLines(text: string, maxBytes: number, maxLines: number): string[] {
    const safe = safeMultiline(text);
    const byteTruncated = Buffer.byteLength(safe, 'utf8') > maxBytes;
    const bounded = truncateUtf8Head(safe, maxBytes);
    const allLines = bounded.split('\n');
    const lines = allLines.slice(0, maxLines);
    const omittedLineCount = Math.max(0, allLines.length - maxLines);

    if (byteTruncated || omittedLineCount > 0) {
        return [
            ...lines,
            byteTruncated ? '… more content omitted' : `… ${omittedLineCount} more lines omitted`,
        ];
    }
    return lines;
}

function stateLabel(state: SubagentRunState): string {
    return state;
}

function stateMarker(state: SubagentRunState): string {
    switch (state) {
        case 'queued':
        case 'starting':
            return '…';
        case 'running':
            return '→';
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
            return 'warning';
        case 'running':
            return 'accent';
        case 'cancelling':
            return 'warning';
        case 'completed':
            return 'success';
        case 'failed':
        case 'interrupted':
            return 'error';
        case 'cancelled':
            return 'warning';
    }
}

function selectedTool(snapshot: SubagentRunSnapshot): SubagentToolCallSnapshot | undefined {
    return snapshot.currentTool ?? snapshot.recentToolCalls[0];
}

function toolSummary(snapshot: SubagentRunSnapshot): string | undefined {
    const tool = selectedTool(snapshot);
    return tool ? formatToolCallSummary(tool) : undefined;
}

function snapshotStats(snapshot: SubagentRunSnapshot): string {
    return [formatSubagentContext(snapshot, false), formatElapsed(snapshot.elapsedMs)]
        .filter((part): part is string => !!part)
        .join(' · ');
}

export function conciseSnapshotStatus(snapshot: SubagentRunSnapshot): string {
    const activity = toolSummary(snapshot);
    if (activity && (snapshot.state === 'running' || snapshot.state === 'completed')) {
        return `Subagent ${stateLabel(snapshot.state)}: ${activity}`;
    }
    return `Subagent ${stateLabel(snapshot.state)}`;
}

function validNumber(value: unknown, minimum = 0): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= minimum;
}

function isToolSnapshot(value: unknown): value is SubagentToolCallSnapshot {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<SubagentToolCallSnapshot>;
    return (
        typeof candidate.id === 'string' &&
        typeof candidate.name === 'string' &&
        typeof candidate.inputSummary === 'string' &&
        (candidate.progressSummary === undefined ||
            typeof candidate.progressSummary === 'string') &&
        (candidate.state === 'running' ||
            candidate.state === 'completed' ||
            candidate.state === 'failed') &&
        validNumber(candidate.startedAt) &&
        (candidate.endedAt === undefined || validNumber(candidate.endedAt))
    );
}

function hasValidOptionalStats(candidate: Partial<SubagentRunSnapshot>): boolean {
    const context = candidate.contextUsage;
    if (
        context !== undefined &&
        !(
            (context.tokens === null || validNumber(context.tokens)) &&
            validNumber(context.contextWindow) &&
            (context.percent === null || validNumber(context.percent))
        )
    ) {
        return false;
    }

    const usage = candidate.usage;
    return (
        usage === undefined ||
        (validNumber(usage.input) &&
            validNumber(usage.output) &&
            validNumber(usage.cacheRead) &&
            validNumber(usage.cacheWrite) &&
            validNumber(usage.total) &&
            validNumber(usage.cost))
    );
}

export function isSubagentRunSnapshot(value: unknown): value is SubagentRunSnapshot {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<SubagentRunSnapshot>;
    return (
        typeof candidate.id === 'string' &&
        (candidate.threadId === undefined || typeof candidate.threadId === 'string') &&
        (candidate.sessionId === undefined || typeof candidate.sessionId === 'string') &&
        (candidate.sessionFile === undefined || typeof candidate.sessionFile === 'string') &&
        (candidate.state === 'queued' ||
            candidate.state === 'starting' ||
            candidate.state === 'running' ||
            candidate.state === 'cancelling' ||
            candidate.state === 'completed' ||
            candidate.state === 'failed' ||
            candidate.state === 'cancelled' ||
            candidate.state === 'interrupted') &&
        typeof candidate.task === 'string' &&
        typeof candidate.cwd === 'string' &&
        !!candidate.model &&
        typeof candidate.model.provider === 'string' &&
        typeof candidate.model.id === 'string' &&
        typeof candidate.thinkingLevel === 'string' &&
        validNumber(candidate.queuedAt) &&
        (candidate.startedAt === undefined || validNumber(candidate.startedAt)) &&
        (candidate.endedAt === undefined || validNumber(candidate.endedAt)) &&
        validNumber(candidate.elapsedMs) &&
        validNumber(candidate.turn) &&
        Array.isArray(candidate.recentToolCalls) &&
        candidate.recentToolCalls.every(isToolSnapshot) &&
        (candidate.currentTool === undefined || isToolSnapshot(candidate.currentTool)) &&
        typeof candidate.thinkingTail === 'string' &&
        typeof candidate.responseTail === 'string' &&
        (candidate.error === undefined || typeof candidate.error === 'string') &&
        hasValidOptionalStats(candidate)
    );
}

export interface SubagentSharedRenderState {
    snapshot?: SubagentRunSnapshot;
}

export function renderSubagentCall(
    args: { task?: unknown },
    theme: Theme,
    expanded = false,
    renderState: SubagentSharedRenderState = {}
): Component {
    return new WidthSafeLines(
        (width) => {
            const snapshot = renderState.snapshot;
            const status = snapshot
                ? theme.fg(
                      stateColor(snapshot.state),
                      `${stateMarker(snapshot.state)} ${stateLabel(snapshot.state)}`
                  )
                : '';
            const lines = [`${theme.fg('toolTitle', theme.bold('Subagent'))} · ${status}`];

            const task = boundedLine(
                typeof args.task === 'string' ? args.task : '',
                TASK_SUMMARY_MAX_BYTES
            );
            if (!expanded && task) {
                const taskLine = `  ${theme.fg('muted', task)}`;
                lines.push(
                    visibleWidth(taskLine) > width
                        ? truncateStyledLine(
                              taskLine,
                              Math.max(1, width - TRUNCATED_TASK_END_PADDING_COLUMNS)
                          )
                        : taskLine
                );
            }
            return lines;
        },
        { maxWidth: COLLAPSED_MAX_COLUMNS }
    );
}

function activityLine(activity: FormattedSubagentActivity, theme: Theme): string {
    const color =
        activity.status === 'current'
            ? 'accent'
            : activity.status === 'completed'
              ? 'success'
              : activity.status === 'failed'
                ? 'error'
                : 'warning';
    return theme.fg(color, activity.marker) + theme.fg('muted', ` ${activity.text}`);
}

function addSection(
    lines: string[],
    label: string,
    content: readonly string[],
    theme: Theme,
    color?: ThemeColor
): void {
    if (content.length === 0) return;
    if (lines.length > 0 && lines.at(-1) !== '') lines.push('');
    lines.push(`  ${theme.fg('accent', theme.bold(label))}`);
    for (const line of content) {
        lines.push(`    ${color ? theme.fg(color, line) : line}`);
    }
}

function expandedSnapshotLines(
    snapshot: SubagentRunSnapshot,
    result: AgentToolResult<unknown>,
    theme: Theme
): string[] {
    const lines: string[] = [];

    if (snapshot.task.trim()) {
        addSection(
            lines,
            'Task',
            boundedMultilineLines(snapshot.task, EXPANDED_TEXT_MAX_BYTES, TASK_MAX_LINES),
            theme,
            'toolOutput'
        );
    }

    addSection(lines, 'Runtime', formatSubagentRuntime(snapshot), theme, 'muted');

    const activity = formatSubagentActivity(snapshot).map((item) => activityLine(item, theme));
    addSection(lines, 'Activity', activity, theme);

    if (snapshot.thinkingTail.trim()) {
        addSection(
            lines,
            'Thinking tail (provider-exposed)',
            formatSubagentTextTail(snapshot.thinkingTail).filter((line) => line.trim() !== ''),
            theme,
            'dim'
        );
    }

    const fallback = result.content.find((item) => item.type === 'text');
    const finalText = fallback?.type === 'text' ? fallback.text : '';
    const response = snapshot.responseTail || (snapshot.state === 'completed' ? finalText : '');
    if (response.trim()) {
        addSection(lines, 'Response tail', formatSubagentTextTail(response), theme, 'toolOutput');
    }

    addSection(lines, 'Stats', formatSubagentStats(snapshot), theme, 'dim');

    if (
        (snapshot.state === 'failed' ||
            snapshot.state === 'cancelled' ||
            snapshot.state === 'interrupted') &&
        snapshot.error
    ) {
        addSection(
            lines,
            snapshot.state === 'failed'
                ? 'Failure'
                : snapshot.state === 'interrupted'
                  ? 'Interruption'
                  : 'Cancellation',
            boundedMultilineLines(snapshot.error, FALLBACK_MAX_BYTES, TASK_MAX_LINES),
            theme,
            'error'
        );
    }
    return lines;
}

export interface SubagentResultRenderState {
    readonly isPartial?: boolean;
    readonly isError?: boolean;
}

function fallbackLines(
    result: AgentToolResult<unknown>,
    expanded: boolean,
    theme: Theme,
    renderState: SubagentResultRenderState
): string[] {
    const fallback = result.content.find((item) => item.type === 'text');
    const text = fallback?.type === 'text' ? fallback.text : '';
    const color = renderState.isError ? 'error' : renderState.isPartial ? 'warning' : 'toolOutput';
    if (!text) return [theme.fg(color, 'Subagent details unavailable')];
    if (!expanded) return [theme.fg(color, boundedLine(text, FALLBACK_MAX_BYTES))];
    return boundedMultilineLines(text, FALLBACK_MAX_BYTES, TASK_MAX_LINES).map((line) =>
        theme.fg(color, line)
    );
}

export function renderSubagentResult(
    result: AgentToolResult<unknown>,
    expanded: boolean,
    theme: Theme,
    renderState: SubagentResultRenderState = {},
    sharedState: SubagentSharedRenderState = {}
): Component {
    const snapshot = isSubagentRunSnapshot(result.details) ? result.details : undefined;
    sharedState.snapshot = snapshot;

    return new WidthSafeLines(
        (width) => {
            if (!snapshot) return fallbackLines(result, expanded, theme, renderState);
            if (expanded) return expandedSnapshotLines(snapshot, result, theme);

            const stats = snapshotStats(snapshot);
            const styledStats = `  ${theme.fg('dim', stats)}`;
            const expandKey = keyText('app.tools.expand');
            const hint = expandKey ? keyHint('app.tools.expand', 'to expand') : '';
            const withHint = hint ? `${styledStats}${theme.fg('dim', ' · ')}${hint}` : styledStats;
            const lines = [hint && visibleWidth(withHint) <= width ? withHint : styledStats];

            if (
                (snapshot.state === 'failed' ||
                    snapshot.state === 'cancelled' ||
                    snapshot.state === 'interrupted') &&
                snapshot.error
            ) {
                lines.push(
                    `  ${theme.fg('error', boundedLine(snapshot.error, FALLBACK_MAX_BYTES))}`
                );
            }
            return lines;
        },
        expanded ? { wrap: true } : { maxWidth: COLLAPSED_MAX_COLUMNS }
    );
}

export function renderSubagentWidget(
    activeRuns: readonly SubagentRunSnapshot[],
    queuedCount: number,
    enabled: boolean,
    idleThinkingLevel: SubagentRunSnapshot['thinkingLevel'] | 'inherit' | 'unsupported',
    theme: Theme
): Component {
    return new WidthSafeLines(() => {
        const separator = theme.fg('dim', ' · ');
        const name = theme.fg('accent', 'subagent');
        const representative = activeRuns[0];
        const displayedThinkingLevel = representative
            ? activeRuns.every((run) => run.thinkingLevel === representative.thinkingLevel)
                ? representative.thinkingLevel
                : 'mixed'
            : idleThinkingLevel;
        const thinking = theme.fg('dim', boundedLine(displayedThinkingLevel, 128));
        if (!enabled) {
            return [[name, theme.fg('muted', 'disabled'), thinking].join(separator)];
        }
        if (activeRuns.length === 0 && queuedCount === 0) {
            return [[name, theme.fg('muted', 'idle'), thinking].join(separator)];
        }

        const parts = [
            name,
            activeRuns.length > 0 ? theme.fg('accent', `${activeRuns.length} active`) : undefined,
            queuedCount > 0 ? theme.fg('dim', `${queuedCount} queued`) : undefined,
            thinking,
        ].filter((part): part is string => !!part);
        return [parts.join(separator)];
    });
}
