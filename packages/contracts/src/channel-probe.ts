export const CHANNEL_PROBE_PROMPT = 'Reply OK.' as const;

export type ChannelProbeProtocol = 'chat' | 'responses' | 'messages';
export type ChannelProbeBody = Record<string, unknown>;

/** An editable example, with no platform output budget. Provider-required fields are supplied by the caller. */
export function createChannelProbeBody(
  protocol: ChannelProbeProtocol,
  upstreamModel: string,
  params?: Record<string, unknown>,
): ChannelProbeBody {
  const example = protocol === 'responses'
    ? { input: CHANNEL_PROBE_PROMPT, stream: false }
    : { messages: [{ role: 'user', content: CHANNEL_PROBE_PROMPT }], stream: false };
  return { ...(params ?? example), model: upstreamModel };
}
