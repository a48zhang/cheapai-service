import { codexAuthentication, codexConfiguration, integrationBaseUrl } from './integration-model';

export interface AgentGuide {
  id: string;
  name: string;
  description: string;
  steps: readonly string[];
  blocks: readonly { title: string; code: string }[];
  documentation: string;
  verification: string;
}

export function agentGuides(origin: string): readonly AgentGuide[] {
  const root = origin.replace(/\/+$/u, '');
  const baseUrl = integrationBaseUrl(root);
  const model = 'YOUR_MODEL_ID';
  return [
    {
      id: 'codex',
      name: 'Codex',
      description: '在 Codex CLI 中使用 CheapAI 的 Responses 接口。',
      steps: [
        '安装 Codex CLI，在控制台选择支持工具调用的 Responses 模型。',
        '将配置合并到用户目录的 .codex/config.toml，替换 YOUR_MODEL_ID。Windows 使用用户目录下的 .codex\\config.toml。',
        '将完整密钥填入同目录的 auth.json。保存两个文件后启动 Codex，之后打开新终端仍会读取这些配置。',
      ],
      blocks: [
        { title: '~/.codex/config.toml', code: codexConfiguration(baseUrl, model) },
        { title: '~/.codex/auth.json', code: codexAuthentication() },
      ],
      documentation: 'https://developers.openai.com/codex/config-advanced/',
      verification: '在 Codex 中输入 /status，确认模型和提供方为你的配置，再发送一条短消息。',
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      description: '通过 Messages 接口接入 Claude Code CLI。',
      steps: [
        '安装 Claude Code，选择已授权且支持工具调用的 Claude 模型。',
        '将下方内容合并到用户目录的 .claude/settings.json；Windows 使用用户目录下的 .claude\\settings.json。',
        '替换 YOUR_API_KEY 和 YOUR_MODEL_ID，保存后重新打开 Claude Code。网关地址使用站点根地址，不加 /v1。',
      ],
      blocks: [
        {
          title: '~/.claude/settings.json',
          code: JSON.stringify(
            {
              model,
              env: {
                ANTHROPIC_BASE_URL: root,
                ANTHROPIC_AUTH_TOKEN: 'YOUR_API_KEY',
                ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
                ANTHROPIC_DEFAULT_SONNET_MODEL: model,
                ANTHROPIC_DEFAULT_OPUS_MODEL: model,
              },
            },
            null,
            2,
          ),
        },
      ],
      documentation: 'https://code.claude.com/docs/en/llm-gateway-connect',
      verification:
        '输入 /status，确认 Anthropic base URL 指向本站、凭据来自保存的配置，再发送一条短消息。',
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      description: '为 OpenCode 添加 CheapAI 自定义提供方。',
      steps: [
        '安装 OpenCode，在控制台选择支持工具调用的 Chat Completions 模型。',
        '将示例合并到用户目录的 .config/opencode/opencode.json，替换 YOUR_MODEL_ID 和 YOUR_API_KEY。',
        '保存后重新打开 OpenCode。此配置对当前用户的所有项目生效；若项目有 opencode.json，确认其中没有覆盖这些设置。',
      ],
      blocks: [
        {
          title: '~/.config/opencode/opencode.json',
          code: JSON.stringify(
            {
              $schema: 'https://opencode.ai/config.json',
              model: `cheapai/${model}`,
              provider: {
                cheapai: {
                  npm: '@ai-sdk/openai-compatible',
                  name: 'CheapAI',
                  options: { baseURL: baseUrl, apiKey: 'YOUR_API_KEY' },
                  models: { [model]: { name: model } },
                },
              },
            },
            null,
            2,
          ),
        },
      ],
      documentation: 'https://opencode.ai/docs/providers/#custom-provider',
      verification: '输入 /models，选择 CheapAI 下配置的模型，再发送一条短消息。',
    },
    {
      id: 'cline',
      name: 'Cline',
      description: '在 VS Code 的 Cline 扩展中配置 OpenAI 兼容接口。',
      steps: [
        '安装并打开 Cline，点击设置，选择 OpenAI Compatible 提供方。',
        '按示例填写 Base URL、完整 API Key 和控制台中的模型 ID；选择支持工具调用的 Chat Completions 模型。',
        '如果启用了 Plan / Act 独立模型配置，请分别为两种模式设置提供方和模型。保存后开启新任务。',
      ],
      blocks: [
        {
          title: 'Cline 设置项',
          code: `API Provider: OpenAI Compatible\nBase URL: ${baseUrl}\nAPI Key: YOUR_API_KEY\nModel ID: ${model}`,
        },
      ],
      documentation: 'https://docs.cline.bot/provider-config/openai-compatible',
      verification: '在新任务中发送一条短消息，确认能收到回复；可在本站「使用记录」核对这次调用。',
    },
  ];
}
