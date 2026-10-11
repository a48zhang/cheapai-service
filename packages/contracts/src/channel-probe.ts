export const CHANNEL_PROBE_MAX_OUTPUT_TOKENS = 16 as const;
export const CHANNEL_PROBE_PROMPT = 'Reply OK.' as const;

export type ChannelProbeProtocol = 'chat' | 'responses' | 'messages';

export interface ChatChannelProbeBody {
  readonly model: string;
  readonly messages: readonly [
    { readonly role: 'user'; readonly content: typeof CHANNEL_PROBE_PROMPT },
  ];
  readonly max_tokens: number;
  readonly stream: false;
}

export interface ResponsesChannelProbeBody {
  readonly model: string;
  readonly input: typeof CHANNEL_PROBE_PROMPT;
  readonly max_output_tokens: number;
  readonly stream: false;
}

export interface MessagesChannelProbeBody {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly [
    { readonly role: 'user'; readonly content: typeof CHANNEL_PROBE_PROMPT },
  ];
  readonly stream: false;
}

export type ChannelProbeBody =
  ChatChannelProbeBody | ResponsesChannelProbeBody | MessagesChannelProbeBody;

function assertOutputLimit(maxOutputTokens: number): void {
  if (
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > CHANNEL_PROBE_MAX_OUTPUT_TOKENS
  ) {
    throw new RangeError(
      `maxOutputTokens must be an integer from 1 to ${CHANNEL_PROBE_MAX_OUTPUT_TOKENS}`,
    );
  }
}

/** Fixed OpenAI chat-completions probe body; the caller supplies the resolved upstream model and capped output. */
export function createChatChannelProbeBody(
  upstreamModel: string,
  maxOutputTokens: number,
): ChatChannelProbeBody {
  assertOutputLimit(maxOutputTokens);
  return {
    model: upstreamModel,
    messages: [{ role: 'user', content: CHANNEL_PROBE_PROMPT }],
    max_tokens: maxOutputTokens,
    stream: false,
  };
}

/** Fixed OpenAI Responses probe body; the caller supplies the resolved upstream model and capped output. */
export function createResponsesChannelProbeBody(
  upstreamModel: string,
  maxOutputTokens: number,
): ResponsesChannelProbeBody {
  assertOutputLimit(maxOutputTokens);
  return {
    model: upstreamModel,
    input: CHANNEL_PROBE_PROMPT,
    max_output_tokens: maxOutputTokens,
    stream: false,
  };
}

/** Fixed Anthropic Messages probe body; the caller supplies the resolved upstream model and capped output. */
export function createMessagesChannelProbeBody(
  upstreamModel: string,
  maxOutputTokens: number,
): MessagesChannelProbeBody {
  assertOutputLimit(maxOutputTokens);
  return {
    model: upstreamModel,
    max_tokens: maxOutputTokens,
    messages: [{ role: 'user', content: CHANNEL_PROBE_PROMPT }],
    stream: false,
  };
}

/** Selects one fixed protocol template without choosing a target URL or request headers. */
export function createChannelProbeBody(
  protocol: ChannelProbeProtocol,
  upstreamModel: string,
  maxOutputTokens: number,
): ChannelProbeBody {
  switch (protocol) {
    case 'chat':
      return createChatChannelProbeBody(upstreamModel, maxOutputTokens);
    case 'responses':
      return createResponsesChannelProbeBody(upstreamModel, maxOutputTokens);
    case 'messages':
      return createMessagesChannelProbeBody(upstreamModel, maxOutputTokens);
  }
}
