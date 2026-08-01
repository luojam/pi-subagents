// These control characters are intentional: terminal text must be sanitized before display.
// biome-ignore lint/suspicious/noControlCharactersInRegex: Matches ANSI CSI/OSC escape sequences.
const TERMINAL_ESCAPE_SEQUENCE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\|$))/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Matches controls unsafe in one-line terminal text.
const SINGLE_LINE_CONTROLS = /[\x00-\x1F\x7F-\x9F]/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Matches unsafe controls while preserving line feeds.
const MULTILINE_CONTROLS = /[\x00-\x09\x0B-\x1F\x7F-\x9F]/gu;

/** Remove terminal escapes and unsafe control characters from untrusted text. */
export function sanitizeTerminalText(text: string, preserveNewlines = false): string {
    const normalized = preserveNewlines ? text.replace(/\r\n?/gu, '\n') : text;
    const withoutControls = normalized
        .replace(TERMINAL_ESCAPE_SEQUENCE, '')
        .replace(preserveNewlines ? MULTILINE_CONTROLS : SINGLE_LINE_CONTROLS, ' ');

    return preserveNewlines ? withoutControls : withoutControls.replace(/\s+/gu, ' ').trim();
}
