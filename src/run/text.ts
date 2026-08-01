import {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    truncateHead,
} from '@earendil-works/pi-coding-agent';
import { sanitizeTerminalText } from '../terminal-sanitizer.ts';
import { truncateUtf8Head, truncateUtf8Tail } from '../utf8.ts';

const TASK_MAX_BYTES = 8 * 1024;
const PATH_MAX_BYTES = 2 * 1024;
const MODEL_PART_MAX_BYTES = 512;
const TOOL_NAME_MAX_BYTES = 128;
const TOOL_ARGUMENT_MAX_BYTES = 2 * 1024;
const TOOL_PROGRESS_MAX_BYTES = 512;
const ERROR_MAX_BYTES = 2 * 1024;
const STREAMED_TEXT_MAX_BYTES = 8 * 1024;

export const MODEL_OUTPUT_MAX_BYTES = DEFAULT_MAX_BYTES;
export const MODEL_OUTPUT_MAX_LINES = DEFAULT_MAX_LINES;

function boundedSingleLine(value: string, maxBytes: number): string {
    return truncateUtf8Head(sanitizeTerminalText(value), maxBytes);
}

export function sanitizeTask(value: string): string {
    return truncateUtf8Head(sanitizeTerminalText(value, true), TASK_MAX_BYTES);
}

export function sanitizePath(value: string): string {
    return boundedSingleLine(value, PATH_MAX_BYTES);
}

export function sanitizeModelPart(value: string): string {
    return boundedSingleLine(value, MODEL_PART_MAX_BYTES);
}

export function sanitizeToolName(value: string): string {
    return boundedSingleLine(value, TOOL_NAME_MAX_BYTES);
}

export function sanitizeError(error: unknown): string {
    return boundedSingleLine(
        error instanceof Error ? error.message : String(error),
        ERROR_MAX_BYTES
    );
}

export function appendStreamedText(current: string, delta: string): string {
    return truncateUtf8Tail(current + sanitizeTerminalText(delta, true), STREAMED_TEXT_MAX_BYTES);
}

function summarizeKnownTool(toolName: string, args: Record<string, unknown>): string | undefined {
    const text = (key: string): string | undefined =>
        typeof args[key] === 'string' ? args[key] : undefined;
    const path = text('path');

    switch (toolName) {
        case 'read': {
            if (!path) return undefined;
            const offset = typeof args.offset === 'number' ? args.offset : undefined;
            const limit = typeof args.limit === 'number' ? args.limit : undefined;
            const start = offset ?? (limit === undefined ? undefined : 1);
            const range =
                start === undefined
                    ? ''
                    : `:${start}${limit === undefined ? '' : `-${start + limit - 1}`}`;
            return `${path}${range}`;
        }
        case 'bash':
            return text('command');
        case 'edit': {
            if (!path) return undefined;
            const count = Array.isArray(args.edits) ? args.edits.length : undefined;
            return count && count > 1 ? `${path} (${count} edits)` : path;
        }
        case 'write':
            return path;
        case 'grep': {
            const pattern = text('pattern');
            const searchPath = path ?? text('cwd');
            if (!pattern) return searchPath;
            return `/${pattern.replaceAll('/', '\\/')}/${searchPath ? ` in ${searchPath}` : ''}`;
        }
        case 'find': {
            const pattern = text('pattern');
            return [pattern, path ? `in ${path}` : undefined].filter(Boolean).join(' ');
        }
        default:
            return undefined;
    }
}

function sanitizeJsonValue(value: unknown, key: string | undefined, depth: number): unknown {
    if (depth > 3) return '[nested]';
    if (typeof value === 'string') {
        if (key && /^(?:content|oldText|newText|replacement|patch)$/iu.test(key)) {
            return `[${Buffer.byteLength(value, 'utf8')} bytes]`;
        }
        return boundedSingleLine(value, 512);
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
        const items = value
            .slice(0, 5)
            .map((item) => sanitizeJsonValue(item, undefined, depth + 1));
        if (value.length > items.length) items.push(`[${value.length - items.length} more]`);
        return items;
    }
    if (typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [childKey, childValue] of Object.entries(value).slice(0, 12)) {
            result[childKey] = sanitizeJsonValue(childValue, childKey, depth + 1);
        }
        return result;
    }
    return String(value);
}

export function summarizeToolArguments(toolName: string, args: unknown): string {
    if (!args || typeof args !== 'object') {
        return boundedSingleLine(typeof args === 'string' ? args : '', TOOL_ARGUMENT_MAX_BYTES);
    }

    const known = summarizeKnownTool(toolName, args as Record<string, unknown>);
    if (known !== undefined) return boundedSingleLine(known, TOOL_ARGUMENT_MAX_BYTES);

    try {
        return boundedSingleLine(
            JSON.stringify(sanitizeJsonValue(args, undefined, 0)) ?? '',
            TOOL_ARGUMENT_MAX_BYTES
        );
    } catch {
        return '[unserializable arguments]';
    }
}

export function summarizeToolProgress(partialResult: unknown): string | undefined {
    if (!partialResult || typeof partialResult !== 'object') return undefined;
    const content = (partialResult as { content?: unknown }).content;
    if (!Array.isArray(content)) return undefined;
    const text = content.find(
        (item): item is { type: 'text'; text: string } =>
            !!item &&
            typeof item === 'object' &&
            (item as { type?: unknown }).type === 'text' &&
            typeof (item as { text?: unknown }).text === 'string'
    )?.text;
    return text ? boundedSingleLine(text, TOOL_PROGRESS_MAX_BYTES) : undefined;
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
