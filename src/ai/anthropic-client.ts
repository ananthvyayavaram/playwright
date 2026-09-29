// Creates the Anthropic/LiteLLM AI client and resolves the active model.
// Supports both direct Anthropic API and LiteLLM proxy for enterprise setups.
import Anthropic from '@anthropic-ai/sdk';

export function createAnthropicClient(): Anthropic {
  const litellmBaseUrl = process.env.LITELLM_BASE_URL;
  const litellmApiKey  = process.env.LITELLM_API_KEY;

  if (litellmBaseUrl && litellmApiKey) {
    return new Anthropic({
      baseURL: litellmBaseUrl,
      apiKey:  '',
      defaultHeaders: { Authorization: `Bearer ${litellmApiKey}` },
    });
  }
  return new Anthropic();
}

export function resolveModel(requested?: string): string {
  if (process.env.LITELLM_BASE_URL && process.env.LITELLM_API_KEY) {
    return process.env.LITELLM_MODEL ?? requested ?? 'claude-sonnet-5';
  }
  return requested ?? 'claude-sonnet-5';
}

export function supportsThinking(model: string): boolean {
  const supported = ['claude-3-7', 'claude-opus-4', 'claude-opus-5', 'claude-sonnet-4', 'claude-sonnet-5', 'claude-fable'];
  return supported.some(prefix => model.startsWith(prefix));
}

export function assertAuthConfigured(): void {
  const hasLiteLLM   = !!(process.env.LITELLM_BASE_URL && process.env.LITELLM_API_KEY);
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  if (!hasLiteLLM && !hasAnthropic) {
    throw new Error(
      'No API credentials found. Set one of the following in your .env file:\n' +
      '  Anthropic direct: ANTHROPIC_API_KEY=sk-ant-...\n' +
      '  LiteLLM proxy:    LITELLM_BASE_URL + LITELLM_API_KEY',
    );
  }
}
