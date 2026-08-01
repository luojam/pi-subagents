import { expect, it } from 'vitest';
import {
    appendStreamedText,
    MODEL_OUTPUT_MAX_BYTES,
    summarizeToolArguments,
    truncateModelOutput,
} from '../extensions/subagent/text-policy.ts';

it('summarizes unrecognized tool arguments without exposing content fields or terminal escapes', () => {
    const summary = summarizeToolArguments('custom', {
        path: '\x1B[31msrc/file.ts',
        content: 'secret',
        nested: { patch: 'replacement' },
    });

    expect(summary).toBe(
        '{"path":"src/file.ts","content":"[6 bytes]","nested":{"patch":"[11 bytes]"}}'
    );
});

it('keeps only a sanitized, UTF-8-safe tail of streamed text', () => {
    const result = appendStreamedText('discard me', `${'x'.repeat(9_000)}\x1B[31mLATEST😀`);

    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(8 * 1024);
    expect(result).not.toContain('\x1B');
    expect(result).toMatch(/LATEST😀$/u);
});

it('bounds oversized model output and includes a truncation notice', () => {
    const result = truncateModelOutput('😀'.repeat(MODEL_OUTPUT_MAX_BYTES));

    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(MODEL_OUTPUT_MAX_BYTES);
    expect(result).toMatch(/\[Subagent output truncated to 2,000 lines or 50 KiB\.\]$/u);
    expect(result).not.toContain('\uFFFD');
});
