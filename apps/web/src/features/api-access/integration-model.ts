import type { KeyGroup, KeyMetadata } from '@cheapai/api-client/keys';

export type IntegrationProtocol = 'chat-completions' | 'responses' | 'messages';

export const integrationProtocolOptions: readonly {
  readonly value: IntegrationProtocol;
  readonly label: string;
  readonly path: string;
  readonly description: string;
}[] = [
  {
    value: 'chat-completions',
    label: 'Chat Completions',
    path: 'chat/completions',
    description: '适用于使用 messages 对话格式的客户端。',
  },
  {
    value: 'responses',
    label: 'Responses',
    path: 'responses',
    description: '适用于使用 input 字段的 Responses 客户端。',
  },
  {
    value: 'messages',
    label: 'Messages',
    path: 'messages',
    description: '适用于使用 Messages 原生请求格式的客户端。',
  },
];

export function integrationBaseUrl(origin: string): string {
  return `${origin.replace(/\/+$/u, '')}/v1`;
}

export function integrationModelScope(
  groups: readonly KeyGroup[],
  selectedKey: KeyMetadata | null,
  selectedGroupId: string,
): { readonly group: KeyGroup | null; readonly models: readonly string[] } {
  const groupId = selectedKey?.groupId ?? selectedGroupId;
  const group = groups.find((candidate) => candidate.id === groupId) ?? null;
  if (group === null) return { group: null, models: [] };
  if (selectedKey === null || selectedKey.allowedModels === null) {
    return { group, models: group.models };
  }
  const allowed = new Set(selectedKey.allowedModels);
  return { group, models: group.models.filter((model) => allowed.has(model)) };
}

export function integrationExample(
  protocol: IntegrationProtocol,
  baseUrl: string,
  modelId: string,
): { readonly endpoint: string; readonly description: string; readonly code: string } {
  const definition = integrationProtocolOptions.find((option) => option.value === protocol);
  if (definition === undefined) throw new TypeError('Unsupported API protocol.');

  const url = `${baseUrl}/${definition.path}`;
  const payload =
    protocol === 'chat-completions'
      ? `{
    "model": "${modelId}",
    "messages": [{"role": "user", "content": "Hello"}]
  }`
      : protocol === 'responses'
        ? `{
    "model": "${modelId}",
    "input": "Hello"
  }`
        : `{
    "model": "${modelId}",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "Hello"}]
  }`;
  const messagesHeaders =
    protocol === 'messages' ? '  -H "anthropic-version: 2023-06-01" \\\n' : '';
  const code = `curl "${url}" \\
  -H "Authorization: Bearer $CHEAPAI_API_KEY" \\
  -H "Content-Type: application/json" \\
${messagesHeaders}  -d '${payload}'`;

  return {
    endpoint: `POST /v1/${definition.path}`,
    description: definition.description,
    code,
  };
}
