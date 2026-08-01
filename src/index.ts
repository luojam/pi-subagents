import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { SubagentManager } from './manager.ts';
import {
    conciseSnapshotStatus,
    renderSubagentCall,
    renderSubagentResult,
    renderSubagentWidget,
    type SubagentSharedRenderState,
} from './render.ts';

const WIDGET_KEY = 'subagent-run';

const SubagentParameters = Type.Object({
    task: Type.String({ description: 'The self-contained task to delegate', minLength: 1 }),
    cwd: Type.Optional(
        Type.String({
            description: 'Working directory, relative to the parent project by default.',
        })
    ),
});

interface ResolvedWorkingDirectory {
    cwd: string;
    inheritsParentTrust: boolean;
}

function isWithinDirectory(directory: string, target: string): boolean {
    const relativePath = relative(directory, target);
    return (
        relativePath === '' ||
        (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
    );
}

async function resolveWorkingDirectory(
    requested: string | undefined,
    ctx: ExtensionContext
): Promise<ResolvedWorkingDirectory> {
    const parentCwd = await realpath(ctx.cwd);
    const unresolved = requested ? resolve(parentCwd, requested.replace(/^@/, '')) : parentCwd;

    try {
        const cwd = await realpath(unresolved);
        if (!(await stat(cwd)).isDirectory()) throw new Error('not a directory');
        return {
            cwd,
            inheritsParentTrust: isWithinDirectory(parentCwd, cwd),
        };
    } catch (error) {
        throw new Error(
            `Invalid subagent cwd ${JSON.stringify(requested ?? ctx.cwd)}: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
}

export default function subagentExtension(pi: ExtensionAPI): void {
    const manager = new SubagentManager();
    let uiGeneration = 0;
    let unsubscribeWidget: (() => void) | undefined;

    pi.on('session_start', (_event, ctx) => {
        unsubscribeWidget?.();
        unsubscribeWidget = undefined;
        const generation = ++uiGeneration;
        if (ctx.mode !== 'tui') return;

        unsubscribeWidget = manager.subscribeRelevant(({ snapshot, queuedCount }) => {
            if (generation !== uiGeneration) return;
            if (!snapshot) {
                ctx.ui.setWidget(WIDGET_KEY, undefined);
                return;
            }
            ctx.ui.setWidget(
                WIDGET_KEY,
                (_tui, theme) => renderSubagentWidget(snapshot, queuedCount, theme),
                { placement: 'aboveEditor' }
            );
        });
    });

    pi.registerTool({
        name: 'subagent',
        label: 'Subagent',
        description: [
            'Delegate one task to an isolated, general-purpose in-process Pi AgentSession through the typed SDK.',
            'The subagent can inspect the codebase, run commands, and modify files.',
            'Calls run serially. Final model-visible output is capped at 2,000 lines or 50 KiB, whichever is reached first.',
        ].join(' '),
        promptSnippet: 'Delegate a self-contained task to a fully capable Pi subagent',
        promptGuidelines: [
            'Use subagent for a self-contained delegated task where an isolated context is useful.',
        ],
        parameters: SubagentParameters,

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const task = params.task.trim();
            if (!task) throw new Error('Subagent task must not be empty');
            if (!ctx.model)
                throw new Error('Cannot start a subagent without an active parent model');

            const { cwd, inheritsParentTrust } = await resolveWorkingDirectory(params.cwd, ctx);
            const thinkingLevel = ctx.thinkingLevel ?? pi.getThinkingLevel();
            const started = manager.startRun({
                task,
                cwd,
                model: ctx.model,
                modelRegistry: ctx.modelRegistry,
                thinkingLevel,
                projectTrusted: ctx.isProjectTrusted() && inheritsParentTrust,
                signal,
            });
            const unsubscribeRun = manager.subscribeRun(started.id, (snapshot) => {
                onUpdate?.({
                    content: [{ type: 'text', text: conciseSnapshotStatus(snapshot) }],
                    details: snapshot,
                });
            });

            try {
                const result = await started.result;
                return {
                    content: [{ type: 'text', text: result.text }],
                    details: result.details,
                    usage: result.usage,
                };
            } finally {
                unsubscribeRun();
            }
        },

        renderCall(args, theme, context) {
            return renderSubagentCall(
                args,
                theme,
                context.expanded,
                context.state as SubagentSharedRenderState
            );
        },

        renderResult(result, { expanded, isPartial }, theme, context) {
            return renderSubagentResult(
                result,
                expanded,
                theme,
                {
                    isPartial,
                    isError: context.isError,
                },
                context.state as SubagentSharedRenderState
            );
        },
    });

    pi.on('session_shutdown', async (_event, ctx) => {
        ++uiGeneration;
        unsubscribeWidget?.();
        unsubscribeWidget = undefined;
        if (ctx.mode === 'tui') ctx.ui.setWidget(WIDGET_KEY, undefined);
        await manager.shutdown();
    });
}
