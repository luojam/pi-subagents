import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { openSubagentsModal } from './modal.ts';
import {
    conciseSnapshotStatus,
    renderSubagentCall,
    renderSubagentResult,
    renderSubagentWidget,
    SUBAGENT_TOGGLE_SHORTCUT,
    type SubagentSharedRenderState,
} from './render.ts';
import { SubagentService } from './service.ts';
import {
    type ConfiguredSubagentThinkingLevel,
    resolveDisplayedSubagentThinkingLevel,
    resolveSubagentThinkingConfiguration,
    resolveSubagentThinkingLevel,
} from './thinking.ts';
import type { SubagentRunSnapshot } from './types.ts';

const WIDGET_KEY = 'subagent-run';
const CONCURRENCY_FLAG = 'subagent-concurrency';
const THINKING_FLAG = 'subagent-thinking';
const DEFAULT_SUBAGENT_CONCURRENCY = 3;
const MAX_SUBAGENT_CONCURRENCY = 8;

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

function resolveConcurrency(value: boolean | string | undefined): number {
    const concurrency = Number(value ?? DEFAULT_SUBAGENT_CONCURRENCY);
    if (
        !Number.isInteger(concurrency) ||
        concurrency < 1 ||
        concurrency > MAX_SUBAGENT_CONCURRENCY
    ) {
        throw new Error(
            `--${CONCURRENCY_FLAG} must be an integer from 1 to ${MAX_SUBAGENT_CONCURRENCY}`
        );
    }
    return concurrency;
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
    pi.registerFlag(CONCURRENCY_FLAG, {
        description: `Maximum concurrent subagents (1-${MAX_SUBAGENT_CONCURRENCY})`,
        type: 'string',
        default: String(DEFAULT_SUBAGENT_CONCURRENCY),
    });
    pi.registerFlag(THINKING_FLAG, {
        description: 'Subagent thinking level (inherit, low, medium, or high)',
        type: 'string',
        default: 'inherit',
    });

    let configuredThinkingLevel: ConfiguredSubagentThinkingLevel = 'inherit';
    let service: SubagentService | undefined;
    let serviceInitializationError: unknown;
    let uiGeneration = 0;
    let unsubscribeWidget: (() => void) | undefined;
    let refreshWidget: (() => void) | undefined;

    pi.on('session_start', (_event, ctx) => {
        unsubscribeWidget?.();
        unsubscribeWidget = undefined;
        refreshWidget = undefined;
        serviceInitializationError = undefined;
        try {
            const concurrency = resolveConcurrency(pi.getFlag(CONCURRENCY_FLAG));
            configuredThinkingLevel = resolveSubagentThinkingConfiguration(
                pi.getFlag(THINKING_FLAG)
            );
            service = new SubagentService({ concurrency });
        } catch (error) {
            service = undefined;
            serviceInitializationError = error;
            pi.setActiveTools(pi.getActiveTools().filter((name) => name !== 'subagent'));
            throw error;
        }

        const generation = ++uiGeneration;
        if (ctx.mode !== 'tui') return;

        let latestActiveRuns: readonly SubagentRunSnapshot[] = [];
        let latestQueuedCount = 0;
        const publishWidget = () => {
            if (generation !== uiGeneration) return;
            ctx.ui.setWidget(
                WIDGET_KEY,
                (_tui, theme) =>
                    renderSubagentWidget(
                        latestActiveRuns,
                        latestQueuedCount,
                        pi.getActiveTools().includes('subagent'),
                        ctx.model
                            ? resolveDisplayedSubagentThinkingLevel(
                                  configuredThinkingLevel,
                                  ctx.model,
                                  ctx.thinkingLevel ?? pi.getThinkingLevel()
                              )
                            : configuredThinkingLevel,
                        theme
                    ),
                { placement: 'aboveEditor' }
            );
        };
        refreshWidget = publishWidget;
        unsubscribeWidget = service.subscribeActivity(({ activeRuns, queuedCount }) => {
            latestActiveRuns = activeRuns;
            latestQueuedCount = queuedCount;
            publishWidget();
        });
    });

    pi.on('thinking_level_select', () => refreshWidget?.());
    pi.on('model_select', () => refreshWidget?.());

    pi.registerCommand('subagents', {
        description: 'Open subagent management',
        handler: async (_args, ctx) => {
            if (ctx.mode !== 'tui') return;
            await openSubagentsModal(ctx, service);
        },
    });

    pi.registerShortcut(SUBAGENT_TOGGLE_SHORTCUT, {
        description: 'Enable or disable the subagent tool',
        handler: () => {
            const activeTools = pi.getActiveTools();
            if (!service) {
                pi.setActiveTools(activeTools.filter((name) => name !== 'subagent'));
                return;
            }
            pi.setActiveTools(
                activeTools.includes('subagent')
                    ? activeTools.filter((name) => name !== 'subagent')
                    : [...activeTools, 'subagent']
            );
            refreshWidget?.();
        },
    });

    pi.registerTool({
        name: 'subagent',
        label: 'Subagent',
        description:
            'Delegate a task to a general-purpose subagent that has access to all the same tools and capabilities as the parent, excluding spawning subagents. Independent sibling subagent calls can execute concurrently.',
        promptSnippet: 'Delegate a self-contained task to a fully capable Pi subagent',
        promptGuidelines: [
            'Use subagent for a self-contained delegated task where an isolated context is useful.',
            'Emit independent subagent calls together in one turn; wait for their results and use a later turn for dependent tasks.',
            'Favor parallel subagent calls for independent research, exploration, review, tests, or work in disjoint modules.',
            'Do not parallelize subagent calls that may write the same files or contend for shared mutable resources.',
        ],
        parameters: SubagentParameters,
        executionMode: 'parallel',

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const currentService = service;
            if (!currentService) {
                if (serviceInitializationError instanceof Error) {
                    throw serviceInitializationError;
                }
                throw new Error('Subagent service is not initialized');
            }
            const task = params.task.trim();
            if (!task) throw new Error('Subagent task must not be empty');
            if (!ctx.model)
                throw new Error('Cannot start a subagent without an active parent model');

            const { cwd, inheritsParentTrust } = await resolveWorkingDirectory(params.cwd, ctx);
            const thinkingLevel = resolveSubagentThinkingLevel(
                configuredThinkingLevel,
                ctx.model,
                ctx.thinkingLevel ?? pi.getThinkingLevel()
            );
            const started = currentService.start({
                task,
                cwd,
                model: ctx.model,
                modelRegistry: ctx.modelRegistry,
                thinkingLevel,
                projectTrusted: ctx.isProjectTrusted() && inheritsParentTrust,
                signal,
            });
            const unsubscribeRun = currentService.subscribeRun(started.id, (snapshot) => {
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
        refreshWidget = undefined;
        if (ctx.mode === 'tui') ctx.ui.setWidget(WIDGET_KEY, undefined);
        const currentService = service;
        service = undefined;
        await currentService?.shutdown();
    });
}
