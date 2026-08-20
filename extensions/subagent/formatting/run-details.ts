import { homedir } from 'node:os';
import { sep } from 'node:path';
import type { SubagentRunSnapshot } from '../types.ts';
import { sanitizeTerminalText } from './terminal-sanitizer.ts';
import { truncateUtf8Head } from './utf8.ts';

const DETAIL_MAX_BYTES = 2 * 1_024;

function boundedLine(text: string, maxBytes: number): string {
    return truncateUtf8Head(sanitizeTerminalText(text), maxBytes);
}

export function formatCost(cost: number): string {
    if (!Number.isFinite(cost) || cost < 0) return 'cost ?';
    if (cost === 0) return '$0';
    if (cost < 0.0001) return '<$0.0001';
    return `$${cost.toFixed(cost < 1 ? 4 : 2)}`;
}

export function formatTokens(tokens: number): string {
    if (!Number.isFinite(tokens) || tokens < 0) return '?';
    if (tokens < 1_000) return Math.round(tokens).toString();
    if (tokens < 999_500) {
        const value = tokens / 1_000;
        return `${value >= 10 ? Math.round(value) : value.toFixed(1).replace(/\.0$/u, '')}k`;
    }
    const value = tokens / 1_000_000;
    return `${value >= 10 ? Math.round(value) : value.toFixed(1).replace(/\.0$/u, '')}M`;
}

export function formatElapsed(milliseconds: number): string {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'elapsed ?';
    const seconds = Math.floor(milliseconds / 1_000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    if (minutes < 60) return `${minutes}m${remainder ? ` ${remainder}s` : ''}`;
    const hours = Math.floor(minutes / 60);
    const minuteRemainder = minutes % 60;
    return `${hours}h${minuteRemainder ? ` ${minuteRemainder}m` : ''}`;
}

export function formatSubagentContext(
    snapshot: SubagentRunSnapshot,
    includeUnknown: boolean
): string | undefined {
    const usage = snapshot.contextUsage;
    if (!usage || (usage.tokens === null && !includeUnknown)) return undefined;
    const tokens = usage.tokens === null ? '?' : formatTokens(usage.tokens);
    const percent =
        usage.percent === null
            ? includeUnknown
                ? ' (?%)'
                : ''
            : ` (${Math.round(usage.percent)}%)`;
    return `${tokens}/${formatTokens(usage.contextWindow)}${percent}`;
}

function formatUsage(snapshot: SubagentRunSnapshot): string | undefined {
    if (!snapshot.usage) return undefined;
    const usage = snapshot.usage;
    return [
        [`↑${formatTokens(usage.input)}`, `↓${formatTokens(usage.output)}`].join(' '),
        [`R${formatTokens(usage.cacheRead)}`, `W${formatTokens(usage.cacheWrite)}`].join(' '),
        formatCost(usage.cost),
    ].join(' · ');
}

function compactPath(path: string): string {
    const safe = boundedLine(path, DETAIL_MAX_BYTES);
    const home = homedir();
    if (safe === home) return '~';
    return safe.startsWith(`${home}${sep}`) ? `~${safe.slice(home.length)}` : safe;
}

export function formatSubagentRuntime(snapshot: SubagentRunSnapshot): string[] {
    return [
        snapshot.cwd ? `cwd: ${compactPath(snapshot.cwd)}` : undefined,
        snapshot.model.provider && snapshot.model.id
            ? `model: ${boundedLine(`${snapshot.model.provider}/${snapshot.model.id}`, DETAIL_MAX_BYTES)} · thinking ${boundedLine(snapshot.thinkingLevel, 128)}`
            : undefined,
        snapshot.sessionFile ? `transcript: ${compactPath(snapshot.sessionFile)}` : undefined,
    ].filter((line): line is string => !!line);
}

export function formatSubagentStats(snapshot: SubagentRunSnapshot): string[] {
    const contextAndElapsed = [
        formatSubagentContext(snapshot, true),
        formatElapsed(snapshot.elapsedMs),
    ]
        .filter((part): part is string => !!part)
        .join(' · ');
    return [contextAndElapsed, formatUsage(snapshot)].filter((part): part is string => !!part);
}
