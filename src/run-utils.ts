import type { Usage } from '@earendil-works/pi-ai';
import {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    type SessionEntry,
    truncateHead,
} from '@earendil-works/pi-coding-agent';

export const MODEL_OUTPUT_MAX_BYTES = DEFAULT_MAX_BYTES;
export const MODEL_OUTPUT_MAX_LINES = DEFAULT_MAX_LINES;
export const UPDATE_TEXT_MAX_BYTES = 8 * 1024;

function safeHeadBoundary(text: string, index: number): number {
    if (
        index > 0 &&
        index < text.length &&
        /[\uD800-\uDBFF]/.test(text[index - 1]) &&
        /[\uDC00-\uDFFF]/.test(text[index])
    ) {
        return index - 1;
    }
    return index;
}

function safeTailBoundary(text: string, index: number): number {
    if (
        index > 0 &&
        index < text.length &&
        /[\uD800-\uDBFF]/.test(text[index - 1]) &&
        /[\uDC00-\uDFFF]/.test(text[index])
    ) {
        return index + 1;
    }
    return index;
}

export function truncateUtf8Head(text: string, maxBytes: number): string {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= maxBytes) low = middle;
        else high = middle - 1;
    }
    return text.slice(0, safeHeadBoundary(text, low));
}

export function truncateUtf8Tail(text: string, maxBytes: number): string {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (Buffer.byteLength(text.slice(middle), 'utf8') <= maxBytes) high = middle;
        else low = middle + 1;
    }
    return text.slice(safeTailBoundary(text, low));
}

export function truncateModelOutput(text: string): string {
    const truncation = truncateHead(text, {
        maxLines: MODEL_OUTPUT_MAX_LINES,
        maxBytes: MODEL_OUTPUT_MAX_BYTES,
    });
    if (!truncation.truncated) return text;

    const suffix = '\n\n[Subagent output truncated to 2,000 lines or 50 KiB.]';
    const contentMaxBytes = MODEL_OUTPUT_MAX_BYTES - Buffer.byteLength(suffix, 'utf8');
    const contentTruncation = truncateHead(text, {
        // Reserve two line breaks and the suffix itself so the complete tool result
        // remains within Pi's limits.
        maxLines: MODEL_OUTPUT_MAX_LINES - 2,
        maxBytes: contentMaxBytes,
    });
    const content = contentTruncation.firstLineExceedsLimit
        ? truncateUtf8Head(text, contentMaxBytes)
        : contentTruncation.content;
    return content + suffix;
}

export function emptyUsage(): Usage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

export function usageFromEntries(entries: SessionEntry[]): Usage {
    const usage = emptyUsage();
    for (const entry of entries) {
        if ((entry.type === 'branch_summary' || entry.type === 'compaction') && entry.usage) {
            addUsage(usage, entry.usage);
        } else if (entry.type === 'message') {
            if (entry.message.role === 'assistant') {
                addUsage(usage, entry.message.usage);
            } else if (entry.message.role === 'toolResult' && entry.message.usage) {
                addUsage(usage, entry.message.usage);
            }
        }
    }
    return usage;
}

export function addUsage(total: Usage, usage: Usage): void {
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.totalTokens += usage.totalTokens;
    total.cost.input += usage.cost.input;
    total.cost.output += usage.cost.output;
    total.cost.cacheRead += usage.cost.cacheRead;
    total.cost.cacheWrite += usage.cost.cacheWrite;
    total.cost.total += usage.cost.total;
    if (usage.cacheWrite1h !== undefined) {
        total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
    }
    if (usage.reasoning !== undefined) {
        total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
    }
}
