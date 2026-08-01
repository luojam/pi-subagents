import { expect, it } from 'vitest';
import { RunStore } from '../extensions/subagent/run-store.ts';
import type { SubagentRunOptions } from '../extensions/subagent/types.ts';

function request(): SubagentRunOptions {
    return {
        task: 'inspect the project',
        cwd: '/project',
        model: { provider: 'test', id: 'model' },
        modelRegistry: {},
        thinkingLevel: 'off',
        projectTrusted: true,
    } as SubagentRunOptions;
}

it('publishes reentrant transitions to every subscriber in order', () => {
    const store = new RunStore({ tickMs: 60_000 });
    const observed: string[] = [];
    store.subscribe((snapshot) => {
        if (snapshot.state === 'queued') {
            store.apply(snapshot.id, { type: 'cancel_requested' });
        }
    });
    store.subscribe((snapshot) => observed.push(snapshot.state));

    store.create('run', request());

    expect(observed).toEqual(['queued', 'cancelled']);
    store.dispose();
});

it('keeps serializable durable references and ignores events after a terminal transition', () => {
    let now = 100;
    const store = new RunStore({ now: () => now, tickMs: 60_000 });
    store.create('run', request());
    store.apply('run', { type: 'admitted' });
    const sessionFile = `/sessions/${'x'.repeat(2_500)}.jsonl`;
    store.apply('run', {
        type: 'runner_event',
        event: {
            type: 'session_ready',
            sessionId: 'child-id',
            sessionFile,
        },
    });
    store.apply('run', {
        type: 'runner_event',
        event: {
            type: 'tool_started',
            toolCallId: 'tool-1',
            toolName: 'read',
            args: { path: 'src/index.ts' },
        },
    });

    now = 150;
    const completed = store.apply('run', { type: 'completed' });
    expect(completed).toMatchObject({
        state: 'completed',
        sessionId: 'child-id',
        sessionFile,
        endedAt: 150,
    });
    expect(completed?.recentToolCalls[0]).toMatchObject({ id: 'tool-1', state: 'failed' });
    expect(JSON.parse(JSON.stringify(completed))).toEqual(completed);
    expect(Object.isFrozen(completed)).toBe(true);

    store.apply('run', { type: 'failed', error: 'late failure' });
    store.apply('run', {
        type: 'runner_event',
        event: { type: 'text_delta', delta: 'late text' },
    });
    expect(store.get('run')).toEqual(completed);
    store.dispose();
});
