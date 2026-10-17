import { Cpu } from 'lucide-react';
import { builtinModel } from '@cheapai/model-catalog';
import openai from './model-logos/openai.svg';
import anthropic from './model-logos/anthropic.svg';
import gemini from './model-logos/gemini.svg';
import deepseek from './model-logos/deepseek.svg';
import qwen from './model-logos/qwen.svg';
import meta from './model-logos/meta.svg';
import mistral from './model-logos/mistral.svg';
import xai from './model-logos/xai.svg';
import cohere from './model-logos/cohere.svg';
import './model-display.css';

const providers = [
  { match: /(?:^|\/)(?:gpt|chatgpt|o[134](?:-|$)|codex|openai)/iu, source: openai },
  { match: /(?:^|\/)(?:claude|anthropic)/iu, source: anthropic },
  { match: /(?:^|\/)(?:gemini|gemma|google)/iu, source: gemini },
  { match: /(?:^|\/)(?:deepseek)/iu, source: deepseek },
  { match: /(?:^|\/)(?:qwen|qwq|qvq|alibaba)/iu, source: qwen },
  { match: /(?:^|\/)(?:llama|meta-llama|meta\/)/iu, source: meta },
  { match: /(?:^|\/)(?:mistral|mixtral|codestral|pixtral|ministral|magistral)/iu, source: mistral },
  { match: /(?:^|\/)(?:grok|xai|x-ai)/iu, source: xai },
  { match: /(?:^|\/)(?:command|cohere)/iu, source: cohere },
];

/** Provider hints only affect decoration; custom identifiers remain untouched. */
export function ModelLogo({ modelId, className = '' }: { modelId: string; className?: string }) {
  const provider = builtinModel(modelId)?.provider;
  const source =
    provider === 'OpenAI'
      ? openai
      : provider === 'Anthropic'
        ? anthropic
        : providers.find(({ match }) => match.test(modelId))?.source;
  return (
    <span aria-hidden="true" className={`model-logo ${className}`}>
      {source ? (
        <span
          className="model-logo-glyph"
          style={{ maskImage: `url("${source}")`, WebkitMaskImage: `url("${source}")` }}
        />
      ) : (
        <Cpu size={18} />
      )}
    </span>
  );
}
