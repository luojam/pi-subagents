import type {
    ExtensionCommandContext,
    KeybindingsManager,
    Theme,
} from '@earendil-works/pi-coding-agent';
import { type Component, type TUI, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

const TARGET_HEIGHT_RATIO = 0.88;
const FULL_MODAL_HEIGHT = 4;

function padToWidth(value: string, width: number, alignment: 'left' | 'center'): string {
    const safeWidth = Math.max(0, width);
    const truncated = truncateToWidth(value, safeWidth, '');
    const remaining = Math.max(0, safeWidth - visibleWidth(truncated));
    const leftPadding = alignment === 'center' ? Math.floor(remaining / 2) : 0;
    return `${' '.repeat(leftPadding)}${truncated}${' '.repeat(remaining - leftPadding)}`;
}

export class SubagentsModal implements Component {
    private closed = false;
    private readonly tui: TUI;
    private readonly theme: Theme;
    private readonly keybindings: KeybindingsManager;
    private readonly onClose: () => void;

    constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, onClose: () => void) {
        this.tui = tui;
        this.theme = theme;
        this.keybindings = keybindings;
        this.onClose = onClose;
    }

    handleInput(data: string): void {
        if (!this.closed && this.keybindings.matches(data, 'tui.select.cancel')) {
            this.closed = true;
            this.onClose();
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
        const contentRow = (content: string, alignment: 'left' | 'center' = 'left') => {
            if (safeWidth === 1) return border('│');
            return `${border('│')}${padToWidth(content, innerWidth, alignment)}${border('│')}`;
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
                        'muted',
                        'Subagent management coming soon'
                    )}`,
                    'center'
                ),
                horizontalBorder('╰', '╯'),
            ];
        }

        const bodyHeight = height - 3;
        const placeholderRow = Math.floor(bodyHeight / 2);
        const lines = [titleBorder()];

        for (let row = 0; row < bodyHeight; row++) {
            lines.push(
                contentRow(
                    row === placeholderRow
                        ? this.theme.fg('muted', 'Subagent management coming soon')
                        : '',
                    'center'
                )
            );
        }

        lines.push(contentRow(this.theme.fg('dim', ` ${closeHint}`)));
        lines.push(horizontalBorder('╰', '╯'));
        return lines;
    }

    invalidate(): void {}
}

export async function openSubagentsModal(ctx: ExtensionCommandContext): Promise<void> {
    await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) =>
            new SubagentsModal(tui, theme, keybindings, () => done()),
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
