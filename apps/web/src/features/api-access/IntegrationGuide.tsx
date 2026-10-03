import { useState } from 'react';
import { Tabs } from '../../shared/ui/Tabs';
import { Button } from '../../shared/ui/Button';

const setup = `# 将密钥存入环境变量，避免写进代码或提交到版本库
read -s -p "cheapai API Key: " CHEAPAI_API_KEY; printf '\\n'
export CHEAPAI_API_KEY
export CHEAPAI_BASE_URL="https://your-cheapai-domain"`;

const examples = [
  {
    value: 'chat-completions',
    label: 'Chat Completions',
    endpoint: 'POST /v1/chat/completions',
    description: '适用于使用 messages 对话格式的客户端。',
    code: `curl "$CHEAPAI_BASE_URL/v1/chat/completions" \\
  -H "Authorization: Bearer $CHEAPAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "YOUR_MODEL_ID",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,
  },
  {
    value: 'responses',
    label: 'Responses',
    endpoint: 'POST /v1/responses',
    description: '适用于使用 input 字段的 Responses 客户端。',
    code: `curl "$CHEAPAI_BASE_URL/v1/responses" \\
  -H "Authorization: Bearer $CHEAPAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "YOUR_MODEL_ID",
    "input": "Hello"
  }'`,
  },
  {
    value: 'messages',
    label: 'Messages',
    endpoint: 'POST /v1/messages',
    description: '适用于使用 Messages 原生请求格式的客户端。',
    code: `curl "$CHEAPAI_BASE_URL/v1/messages" \\
  -H "Authorization: Bearer $CHEAPAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{
    "model": "YOUR_MODEL_ID",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,
  },
] as const;

export function IntegrationGuide() {
  const [copyMessage, setCopyMessage] = useState('');
  const tabs = examples.map(example => ({
    value: example.value,
    label: example.label,
    content: <section className="space-y-4 py-5" aria-label={`${example.label} 示例`}>
      <div><p className="font-medium text-[var(--color-foreground)]">{example.endpoint}</p>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">{example.description}</p></div>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">请求示例</h3>
        <Button variant="outline" size="sm" onClick={() => { void copy(example.code); }}>复制示例</Button>
      </div>
      <pre className="max-h-[32rem] overflow-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-4 text-xs leading-6"><code>{example.code}</code></pre>
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-[var(--color-muted-foreground)]">{copyMessage}</p>
    </section>,
  }));

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(`${setup}\n\n${value}`);
      setCopyMessage('环境变量设置和当前请求示例已复制。');
    } catch {
      setCopyMessage('无法自动复制，请手动复制示例。');
    }
  }

  return <section aria-labelledby="integration-guide-title" className="space-y-4">
    <div><h2 id="integration-guide-title" className="text-lg font-semibold">接入指南</h2>
      <p className="mt-1 text-sm leading-6 text-[var(--color-muted-foreground)]">先将密钥放入环境变量，再复制对应协议的请求。模型 ID 需在授权分组中可用。</p></div>
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-4">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">终端环境变量</p>
      <pre className="overflow-auto text-xs leading-6"><code>{setup}</code></pre>
    </div>
    <Tabs items={tabs} defaultValue="chat-completions" ariaLabel="API 协议" />
  </section>;
}
