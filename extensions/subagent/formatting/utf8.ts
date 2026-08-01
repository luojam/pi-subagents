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
