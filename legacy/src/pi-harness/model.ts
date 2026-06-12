/**
 * Construct a Pi ``Model`` object that points at our upstream LLM endpoint.
 *
 * We intentionally skip ``getModel()`` lookup because that uses a built-in
 * MODELS constant — we don't need an entry there. Pi's ``streamSimple``
 * works off the Model interface directly: any object with the right shape
 * + a matching API provider registered in ``api-registry`` will stream.
 *
 * On the first call we register the OpenAI-compatible provider so the
 * Model below resolves at runtime.
 */
import {
  type Model,
  registerBuiltInApiProviders,
} from "@earendil-works/pi-ai";

let providersRegistered = false;

function ensureProviders(): void {
  if (providersRegistered) return;
  registerBuiltInApiProviders();
  providersRegistered = true;
}

export interface BuildModelOptions {
  baseUrl: string;
  modelId: string;
  contextWindow?: number;
  maxTokens?: number;
  /** Override the provider attribution; usually irrelevant for self-hosted Hub. */
  provider?: string;
}

/**
 * Build a ``Model<"openai-completions">`` we can hand straight to AgentHarness.
 *
 * The Hub is OpenAI-compatible, so api="openai-completions" lets pi-ai's
 * existing provider apply all upstream fixes (z.ai thinking, Azure storage,
 * Moonshot thinking, Bedrock regions, etc.) for any model that ends up
 * downstream.
 */
export function buildHubModel(opts: BuildModelOptions): Model<"openai-completions"> {
  ensureProviders();
  return {
    id: opts.modelId,
    name: opts.modelId,
    api: "openai-completions",
    provider: (opts.provider ?? "aoh-hub") as Model<"openai-completions">["provider"],
    baseUrl: opts.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: opts.contextWindow ?? 200_000,
    maxTokens: opts.maxTokens ?? 4096,
  };
}
