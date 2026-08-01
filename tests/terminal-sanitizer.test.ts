import { expect, it } from 'vitest';
import { sanitizeTerminalText } from '../extensions/subagent/formatting/terminal-sanitizer.ts';

it('removes ST-terminated OSC 8 escapes while preserving visible link text', () => {
    const input = 'before \x1B]8;;https://example.com\x1B\\visible link\x1B]8;;\x1B\\ after';

    expect(sanitizeTerminalText(input)).toBe('before visible link after');
});
