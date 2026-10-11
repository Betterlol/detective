import type { ModelConfig } from './provider.js';

// The workflow is evaluated on this model. Every role and resumed turn uses it.
export const modelPolicy = Object.freeze({ model: 'gpt-6-luna', reasoningEffort: 'high' as const });
export function fixedModelConfig(config: ModelConfig): ModelConfig {
  return { ...config, ...modelPolicy };
}
