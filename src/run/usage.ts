import type { Usage } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

function emptyUsage(): Usage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

function addUsage(total: Usage, usage: Usage): void {
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
