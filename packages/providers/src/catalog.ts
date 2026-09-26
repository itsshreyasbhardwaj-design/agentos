import type { ModelInfo } from './types.js';

/**
 * Published list prices, in micro-USD per 1M tokens, recorded with the date they
 * were captured. Prices change: `AGENTOS_PRICING_FILE` can point at a JSON file
 * that overrides or extends this table, and cost is always reported as an
 * estimate derived from these numbers rather than from a provider invoice.
 */
export const PRICING_AS_OF = '2026-09-26';

function model(
  id: string,
  displayName: string,
  contextWindow: number,
  maxOutputTokens: number,
  inputPerM: number,
  outputPerM: number,
  extra: Partial<ModelInfo> = {},
): ModelInfo {
  return {
    id,
    displayName,
    contextWindow,
    maxOutputTokens,
    supportsTools: true,
    supportsJsonSchema: true,
    inputPricePerMTokens: inputPerM,
    outputPricePerMTokens: outputPerM,
    ...extra,
  };
}

export const OPENAI_MODELS: ModelInfo[] = [
  model('gpt-4o', 'GPT-4o', 128_000, 16_384, 2_500_000, 10_000_000),
  model('gpt-4o-mini', 'GPT-4o mini', 128_000, 16_384, 150_000, 600_000),
  model('gpt-4.1', 'GPT-4.1', 1_047_576, 32_768, 2_000_000, 8_000_000),
  model('gpt-4.1-mini', 'GPT-4.1 mini', 1_047_576, 32_768, 400_000, 1_600_000),
  model('o4-mini', 'o4-mini', 200_000, 100_000, 1_100_000, 4_400_000),
];

export const ANTHROPIC_MODELS: ModelInfo[] = [
  model('claude-opus-4-1', 'Claude Opus 4.1', 200_000, 32_000, 15_000_000, 75_000_000),
  model('claude-sonnet-4-5', 'Claude Sonnet 4.5', 200_000, 64_000, 3_000_000, 15_000_000),
  model('claude-haiku-4-5', 'Claude Haiku 4.5', 200_000, 64_000, 1_000_000, 5_000_000),
];

export const GEMINI_MODELS: ModelInfo[] = [
  model('gemini-2.5-pro', 'Gemini 2.5 Pro', 1_048_576, 65_536, 1_250_000, 10_000_000),
  model('gemini-2.5-flash', 'Gemini 2.5 Flash', 1_048_576, 65_536, 300_000, 2_500_000),
];

/** Local models cost nothing to run; the price fields stay at zero. */
export const LOCAL_MODELS: ModelInfo[] = [
  model('llama3.1:8b', 'Llama 3.1 8B (local)', 131_072, 8_192, 0, 0),
  model('qwen2.5:7b', 'Qwen 2.5 7B (local)', 131_072, 8_192, 0, 0),
  model('mistral:7b', 'Mistral 7B (local)', 32_768, 8_192, 0, 0, { supportsJsonSchema: false }),
];

export function catalogFor(provider: string): ModelInfo[] {
  switch (provider) {
    case 'openai':
      return OPENAI_MODELS;
    case 'anthropic':
      return ANTHROPIC_MODELS;
    case 'gemini':
      return GEMINI_MODELS;
    case 'ollama':
    case 'local':
      return LOCAL_MODELS;
    default:
      return [];
  }
}

/** Unknown models are priced at zero and flagged, never silently guessed. */
export function unknownModel(id: string): ModelInfo {
  return {
    id,
    displayName: `${id} (uncatalogued)`,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsJsonSchema: false,
    inputPricePerMTokens: 0,
    outputPricePerMTokens: 0,
  };
}
