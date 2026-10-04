import { useMemo, useState } from 'react';
import type { KeyGroup, KeyMetadata } from '@cheapai/api-client/keys';
import { Button } from '../../shared/ui/Button';
import {
  integrationExample,
  integrationModelScope,
  integrationProtocolOptions,
} from './integration-model';
import type { IntegrationProtocol } from './integration-model';

export interface IntegrationGuideProps {
  readonly baseUrl: string;
  readonly groups: readonly KeyGroup[];
  readonly selectedKey: KeyMetadata | null;
  readonly groupsLoading?: boolean;
  readonly groupsError?: string | null;
  readonly onRetryGroups?: () => void;
}

export function ApiBaseUrl({ baseUrl }: { readonly baseUrl: string }) {
  const [copyMessage, setCopyMessage] = useState('');

  async function copy() {
    try {
      await navigator.clipboard.writeText(baseUrl);
      setCopyMessage('已复制');
    } catch {
      setCopyMessage('无法自动复制，请手动复制。');
    }
  }

  return (
    <section aria-label="API 地址" className="rounded-xl border border-[var(--color-border)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Base URL</h2>
          <code className="mt-1 block break-all text-sm text-[var(--color-muted-foreground)]">
            {baseUrl}
          </code>
        </div>
        <Button variant="outline" size="sm" onClick={() => void copy()}>
          复制
        </Button>
      </div>
      <p
        role="status"
        aria-live="polite"
        className="min-h-5 text-sm text-[var(--color-muted-foreground)]"
      >
        {copyMessage}
      </p>
    </section>
  );
}

export function IntegrationGuide({
  baseUrl,
  groups,
  selectedKey,
  groupsLoading = false,
  groupsError = null,
  onRetryGroups,
}: IntegrationGuideProps) {
  const [groupId, setGroupId] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [protocol, setProtocol] = useState<IntegrationProtocol>('chat-completions');
  const [copyMessage, setCopyMessage] = useState('');
  const availableGroupId = groups.some((group) => group.id === groupId)
    ? groupId
    : (groups[0]?.id ?? '');
  const scope = useMemo(
    () => integrationModelScope(groups, selectedKey, availableGroupId),
    [groups, selectedKey, availableGroupId],
  );
  const modelId = scope.models.includes(selectedModelId)
    ? selectedModelId
    : (scope.models[0] ?? '');
  const example = modelId ? integrationExample(protocol, baseUrl, modelId) : null;
  const setup = `# 将 API Key 存入环境变量，避免写进代码或提交到版本库
read -s -p "cheapai API Key: " CHEAPAI_API_KEY; printf '\\n'
export CHEAPAI_API_KEY
export CHEAPAI_BASE_URL="${baseUrl}"`;

  async function copy(value: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyMessage(successMessage);
    } catch {
      setCopyMessage('无法自动复制，请手动复制。');
    }
  }

  return (
    <section aria-labelledby="integration-guide-title" className="space-y-5">
      <div>
        <h2 id="integration-guide-title" className="text-lg font-semibold">
          调用示例
        </h2>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-1.5 text-sm font-medium">授权模型范围</p>
          {selectedKey ? (
            <p className="min-h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-muted)] px-3 py-2 text-sm">
              {selectedKey.name} · {scope.group?.name ?? selectedKey.groupName}
            </p>
          ) : groups.length > 1 ? (
            <select
              aria-label="示例模型授权分组"
              value={availableGroupId}
              onChange={(event) => setGroupId(event.currentTarget.value)}
              className="min-h-10 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
            >
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="min-h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-muted)] px-3 py-2 text-sm">
              {scope.group?.name ?? '暂无可用分组'}
            </p>
          )}
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium">模型</p>
          {scope.models.length > 1 ? (
            <select
              aria-label="API 示例模型"
              value={modelId}
              onChange={(event) => setSelectedModelId(event.currentTarget.value)}
              className="min-h-10 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
            >
              {scope.models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          ) : (
            <p className="min-h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-muted)] px-3 py-2 text-sm">
              {modelId || '暂无可用模型'}
            </p>
          )}
        </div>
      </div>

      <div>
        <label htmlFor="integration-protocol" className="mb-1.5 block text-sm font-medium">
          调用协议
        </label>
        <select
          id="integration-protocol"
          value={protocol}
          onChange={(event) => setProtocol(event.currentTarget.value as IntegrationProtocol)}
          className="min-h-10 w-full max-w-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
        >
          {integrationProtocolOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {groupsError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-sm text-[var(--color-destructive)]"
        >
          <span>{groupsError}</span>
          {onRetryGroups && (
            <Button variant="secondary" size="sm" onClick={onRetryGroups}>
              重试
            </Button>
          )}
        </div>
      ) : groupsLoading ? (
        <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
          正在读取授权模型…
        </p>
      ) : example === null ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">暂无可用模型</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-medium">{example.endpoint}</h3>
              <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
                {example.description}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copy(`${setup}\n\n${example.code}`, '已复制')}
            >
              复制示例
            </Button>
          </div>
          <pre className="max-h-[32rem] overflow-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-muted)] p-4 text-xs leading-6">
            <code>{example.code}</code>
          </pre>
          <details className="text-sm">
            <summary className="cursor-pointer text-[var(--color-muted-foreground)]">
              查看环境变量设置
            </summary>
            <pre className="mt-2 overflow-auto rounded-lg bg-[var(--color-muted)] p-3 text-xs leading-6">
              <code>{setup}</code>
            </pre>
          </details>
        </div>
      )}
      <p
        role="status"
        aria-live="polite"
        className="min-h-5 text-sm text-[var(--color-muted-foreground)]"
      >
        {copyMessage}
      </p>
    </section>
  );
}
