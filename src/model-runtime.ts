import { type AuthResult, InMemoryCredentialStore, type Provider } from '@earendil-works/pi-ai';
import { type ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { SubagentModel } from './types.ts';

export interface InheritedModelRuntimeSetup {
    readonly modelRuntime: ModelRuntime;
    /** The child-owned proxy containing the parent's resolved auth snapshot. */
    readonly inheritedProvider: Provider;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Preserve a provider instance and its method receivers while replacing its auth snapshot. */
export function providerWithInheritedAuth(provider: Provider, auth: AuthResult): Provider {
    const inheritedAuth = {
        apiKey: {
            name: `Inherited ${provider.name} authentication`,
            check: async () => ({ type: 'api_key' as const, source: auth.source }),
            resolve: async () => auth,
        },
    };

    // Providers may be class instances, so spreading them can discard methods or
    // break private-field access. Do not inherit refreshModels: a refresh bound to
    // the parent provider could mutate the parent's dynamic model catalog.
    return new Proxy(provider, {
        get(target, property) {
            if (property === 'auth') return inheritedAuth;
            if (property === 'refreshModels') return undefined;
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

/** Create one credential- and model-catalog-isolated runtime from the parent's effective provider. */
export async function createInheritedModelRuntime(
    modelRegistry: ModelRegistry,
    model: SubagentModel
): Promise<InheritedModelRuntimeSetup> {
    const parentProvider = modelRegistry.getProvider(model.provider);
    if (!parentProvider) {
        throw new Error(
            `The parent provider for inherited subagent model ${model.provider}/${model.id} is no longer registered.`
        );
    }

    let auth: AuthResult | undefined;
    try {
        // Resolve once so credentials, base URL, headers, and provider-scoped env
        // all come from the same effective parent-auth snapshot.
        auth = await modelRegistry.getProviderAuth(model.provider);
    } catch (error) {
        throw new Error(
            `Unable to authenticate inherited subagent model ${model.provider}/${model.id}: ${errorMessage(error)}`
        );
    }
    if (!auth) {
        throw new Error(
            `The inherited parent model ${model.provider}/${model.id} is not authenticated. No fallback model was used.`
        );
    }

    const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
    });
    const inheritedProvider = providerWithInheritedAuth(parentProvider, auth);
    modelRuntime.registerNativeProvider(inheritedProvider);
    return { modelRuntime, inheritedProvider };
}
