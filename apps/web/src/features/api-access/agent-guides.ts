import { codexConfiguration, integrationBaseUrl } from './integration-model';

export type GuideShell = 'posix' | 'powershell';
export interface AgentGuide {
  id: string;
  name: string;
  description: string;
  steps: readonly string[];
  blocks: readonly { title: string; code: string }[];
  documentation: string;
  verification: string;
}

export function agentGuides(origin: string, shell: GuideShell): readonly AgentGuide[] {
  const root = origin.replace(/\/+$/u, '');
  const baseUrl = integrationBaseUrl(root);
  const model = 'YOUR_MODEL_ID';
  const env = (name: string, value: string) =>
    shell === 'powershell'
      ? `$env:${name} = '${value.replaceAll("'", "''")}'`
      : `export ${name}='${value.replaceAll("'", "'\"'\"'")}'`;
  const key = env('CHEAPAI_API_KEY', 'YOUR_API_KEY');
  return [
    {
      id: 'codex',
      name: 'Codex',
      description: '在 Codex CLI 中使用 CheapAI 的 Responses 接口。',
      steps: [
        '安装 Codex CLI，在控制台选择支持工具调用的 Responses 模型。',
        '将配置合并到 ~/.codex/config.toml；Windows 对应用户目录下的 .codex\\config.toml。替换 YOUR_MODEL_ID。',
        '将启动命令中的 YOUR_API_KEY 换成完整密钥，在项目目录的终端中运行。',
      ],
      blocks: [
        { title: '~/.codex/config.toml', code: codexConfiguration(baseUrl, model) },
        { title: '设置密钥并启动 Codex', code: `${key}\ncodex` },
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
        '替换命令中的 YOUR_API_KEY 和两处 YOUR_MODEL_ID。主模型和轻量任务先使用同一个已授权模型。',
        '在项目目录的同一终端运行命令。ANTHROPIC_BASE_URL 使用站点根地址，不加 /v1。',
      ],
      blocks: [
        {
          title: '设置连接并启动 Claude Code',
          code: [
            env('ANTHROPIC_BASE_URL', root),
            env('ANTHROPIC_AUTH_TOKEN', 'YOUR_API_KEY'),
            env('ANTHROPIC_MODEL', model),
            env('ANTHROPIC_DEFAULT_HAIKU_MODEL', model),
            'claude',
          ].join('\n'),
        },
      ],
      documentation: 'https://code.claude.com/docs/en/llm-gateway-connect',
      verification:
        '输入 /status，确认 Anthropic base URL 指向本站、Auth token 来自环境变量，再发送一条短消息。',
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      description: '为 OpenCode 添加 CheapAI 自定义提供方。',
      steps: [
        '安装 OpenCode，在控制台选择支持工具调用的 Chat Completions 模型。',
        '将示例配置合并到项目根目录的 opencode.json，替换所有 YOUR_MODEL_ID。',
        '替换启动命令中的 YOUR_API_KEY，在项目目录运行。配置从环境变量读取密钥。',
      ],
      blocks: [
        {
          title: 'opencode.json',
          code: JSON.stringify(
            {
              $schema: 'https://opencode.ai/config.json',
              model: `cheapai/${model}`,
              provider: {
                cheapai: {
                  npm: '@ai-sdk/openai-compatible',
                  name: 'CheapAI',
                  options: { baseURL: baseUrl, apiKey: '{env:CHEAPAI_API_KEY}' },
                  models: { [model]: { name: model } },
                },
              },
            },
            null,
            2,
          ),
        },
        { title: '设置密钥并启动 OpenCode', code: `${key}\nopencode` },
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
