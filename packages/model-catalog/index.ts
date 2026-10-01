/** Official reference metadata checked 2026-09-10; channel access is configured separately. */
export interface BuiltinModel {
  id: string;
  provider: 'OpenAI' | 'Anthropic';
  contextWindow: number;
  maxOutputTokens: number;
  protocol: 'responses' | 'messages';
  prices: Record<string, string>;
  source: string;
  pricingNote: string;
}

const openai = (id: string, input: string, output: string, cacheRead: string, contextWindow = 400_000, cacheWrite?: string): BuiltinModel => ({
  id, provider: 'OpenAI', contextWindow, maxOutputTokens: 128_000, protocol: 'responses',
  prices: { input, output, cacheRead, ...(cacheWrite ? { cacheWrite } : {}) },
  source: `https://developers.openai.com/api/docs/models/${id === 'gpt-5.6' ? 'gpt-5.6-sol' : id}`,
  pricingNote: contextWindow > 400_000 ? '标准档参考价格；长上下文、服务档位及地区加价不自动计入本站售价。' : '标准档参考价格；服务档位及地区加价不自动计入本站售价。',
});
const claude = (id: string, input: string, output: string, cacheRead: string, cacheWrite5m: string, cacheWrite1h: string): BuiltinModel => ({
  id, provider: 'Anthropic', contextWindow: 1_000_000, maxOutputTokens: 128_000, protocol: 'messages',
  // Untagged cache creation uses the provider's default five-minute cache rate.
  prices: { input, output, cacheRead, cacheWrite: cacheWrite5m, cacheWrite5m, cacheWrite1h },
  source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  pricingNote: '标准档参考价格；Fast、Batch、地区加价不自动计入本站售价。',
});

export const BUILTIN_MODELS: readonly BuiltinModel[] = [
  openai('gpt-5', '1.25', '10', '0.125'),
  openai('gpt-5-mini', '0.25', '2', '0.025'),
  openai('gpt-5-nano', '0.05', '0.4', '0.005'),
  openai('gpt-5.1', '1.25', '10', '0.125'),
  openai('gpt-5.2', '1.75', '14', '0.175'),
  openai('gpt-5.3-codex', '1.75', '14', '0.175'),
  openai('gpt-5.4', '2.5', '15', '0.25', 1_050_000),
  openai('gpt-5.4-mini', '0.75', '4.5', '0.075'),
  openai('gpt-5.4-nano', '0.2', '1.25', '0.02'),
  openai('gpt-5.5', '5', '30', '0.5', 1_050_000),
  openai('gpt-5.6', '4', '20', '0.4', 1_050_000, '5'),
  openai('gpt-5.6-sol', '4', '20', '0.4', 1_050_000, '5'),
  openai('gpt-5.6-terra', '2', '12', '0.2', 1_050_000, '2.5'),
  openai('gpt-5.6-luna', '0.2', '1.2', '0.02', 1_050_000, '0.25'),
  openai('gpt-6-astra', '10', '50', '1', 1_050_000, '12.5'),
  claude('claude-sonnet-4-6', '3', '15', '0.3', '3.75', '6'),
  claude('claude-opus-4-6', '5', '25', '0.5', '6.25', '10'),
  claude('claude-opus-4-7', '5', '25', '0.5', '6.25', '10'),
  claude('claude-opus-4-8', '5', '25', '0.5', '6.25', '10'),
  claude('claude-sonnet-5', '2', '10', '0.2', '2.5', '4'),
  claude('claude-opus-5', '5', '25', '0.5', '6.25', '10'),
  claude('claude-fable-5', '10', '50', '1', '12.5', '20'),
  claude('claude-mythos-5', '10', '50', '1', '12.5', '20'),
];

export function builtinModel(id: string): BuiltinModel | undefined {
  return BUILTIN_MODELS.find(model => model.id === id);
}
