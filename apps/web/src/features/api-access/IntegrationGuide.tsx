import { Select } from '../../shared/ui/Select';
import { useMemo, useState } from 'react';
import { Copy, FileCode2 } from 'lucide-react';
import type { KeyGroup, KeyMetadata } from '@cheapai/api-client/keys';
import { Button } from '../../shared/ui/Button';
import { Tabs } from '../../shared/ui/Tabs';
import {
  codexAuthentication,
  codexConfiguration,
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
    <section
      aria-label="API 地址"
      className="grid grid-cols-[1fr_auto] items-center gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:flex"
    >
      <h2 className="text-[16px] font-semibold">接口地址</h2>
      <code className="col-span-2 row-start-2 min-w-0 flex-1 break-all rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)] px-4 py-3 text-[15px]">
        {baseUrl}
      </code>
      <Button variant="outline" className="col-start-2 row-start-1" onClick={() => void copy()}>
        <Copy size={17} aria-hidden="true" />
        复制
      </Button>
      {copyMessage && (
        <span role="status" className="col-span-2 text-sm text-[var(--color-muted-foreground)]">
          {copyMessage}
        </span>
      )}
    </section>
  );
}

const selectStyle =
  'min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]';
const codeStyle =
  'max-h-[30rem] overflow-auto rounded-lg bg-[var(--color-muted)] p-4 text-sm leading-7 sm:p-5';

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
  const configuration = modelId ? codexConfiguration(baseUrl, modelId) : null;
  const authentication = codexAuthentication();

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyMessage('已复制');
    } catch {
      setCopyMessage('无法自动复制，请手动复制。');
    }
  }

  const state = groupsError ? (
    <div
      role="alert"
      className="flex items-center gap-3 text-[15px] text-[var(--color-destructive)]"
    >
      <span>{groupsError}</span>
      {onRetryGroups && (
        <Button variant="outline" size="sm" onClick={onRetryGroups}>
          重试
        </Button>
      )}
    </div>
  ) : groupsLoading ? (
    <p role="status" className="text-[15px] text-[var(--color-muted-foreground)]">
      正在读取可用模型…
    </p>
  ) : !modelId ? (
    <p className="text-[15px] text-[var(--color-muted-foreground)]">当前授权范围暂无可用模型。</p>
  ) : null;

  const modelControls = (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="min-w-0">
        <label htmlFor="integration-group" className="mb-2 block text-[15px] font-medium">
          {selectedKey ? '选用密钥' : '授权分组'}
        </label>
        {selectedKey ? (
          <p
            id="integration-group"
            className="min-h-11 break-words rounded-lg bg-[var(--color-muted)] px-3 py-2.5 text-[15px]"
          >
            {selectedKey.name} · {scope.group?.name ?? selectedKey.groupName}
          </p>
        ) : (
          <Select
            id="integration-group"
            aria-label="示例模型授权分组"
            value={availableGroupId}
            disabled={groupsLoading || !groups.length}
            onValueChange={(nextValue) => setGroupId(nextValue)}
            className={selectStyle}
            items={[
              ...(!groups.length ? [{ value: '', label: <>暂无可用分组</> }] : []),
              ...groups.map((group) => ({ value: group.id, label: <>{group.name}</> })),
            ]}
          />
        )}
      </div>
      <div className="min-w-0">
        <label htmlFor="integration-model" className="mb-2 block text-[15px] font-medium">
          模型
        </label>
        <Select
          id="integration-model"
          aria-label="API 示例模型"
          value={modelId}
          disabled={groupsLoading || !scope.models.length}
          onValueChange={(nextValue) => setSelectedModelId(nextValue)}
          className={selectStyle}
          items={[
            ...(!scope.models.length ? [{ value: '', label: <>暂无可用模型</> }] : []),
            ...scope.models.map((model) => ({ value: model, label: <>{model}</> })),
          ]}
        />
      </div>
    </div>
  );

  return (
    <section
      aria-labelledby="integration-guide-title"
      className="space-y-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:p-6"
    >
      <h2 id="integration-guide-title" className="text-xl font-semibold">
        快速接入
      </h2>
      {modelControls}
      <Tabs
        defaultValue="codex"
        ariaLabel="接入方式"
        contentClassName="pt-5"
        items={[
          {
            value: 'codex',
            label: '接入 Codex',
            content:
              state ??
              (configuration && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-2 text-[15px]">
                      <FileCode2 size={18} aria-hidden="true" />
                      <code>~/.codex/config.toml</code>
                    </span>
                    <Button variant="outline" size="sm" onClick={() => void copy(configuration)}>
                      <Copy size={16} aria-hidden="true" />
                      复制配置
                    </Button>
                  </div>
                  <pre className={codeStyle}>
                    <code>{configuration}</code>
                  </pre>
                  <p className="text-[15px] leading-7 text-[var(--color-muted-foreground)]">
                    将配置合并到用户目录的 .codex/config.toml，并将密钥写入同目录的
                    auth.json。保存后重新打开 Codex。
                  </p>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-2 text-[15px]">
                      <FileCode2 size={18} aria-hidden="true" />
                      <code>~/.codex/auth.json</code>
                    </span>
                    <Button variant="outline" size="sm" onClick={() => void copy(authentication)}>
                      <Copy size={16} aria-hidden="true" />
                      复制 auth.json
                    </Button>
                  </div>
                  <pre className={codeStyle}>
                    <code>{authentication}</code>
                  </pre>
                  <p className="text-sm leading-6 text-[var(--color-muted-foreground)]">
                    将 auth.json 中的 YOUR_API_KEY 换成完整密钥。Codex 使用 Responses
                    协议，请选择支持 Responses 的模型。
                  </p>
                </div>
              )),
          },
          {
            value: 'api',
            label: 'API 调用',
            content:
              state ??
              (example && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <Select
                      aria-label="调用协议"
                      value={protocol}
                      onValueChange={(nextValue) => setProtocol(nextValue as IntegrationProtocol)}
                      className={`${selectStyle} max-w-xs`}
                      items={[
                        ...integrationProtocolOptions.map((option) => ({
                          value: option.value,
                          label: <>{option.label}</>,
                        })),
                      ]}
                    />
                    <Button variant="outline" size="sm" onClick={() => void copy(example.code)}>
                      <Copy size={16} aria-hidden="true" />
                      复制示例
                    </Button>
                  </div>
                  <pre className={codeStyle}>
                    <code>{example.code}</code>
                  </pre>
                  <p className="text-sm leading-6 text-[var(--color-muted-foreground)]">
                    {example.description} 将 YOUR_API_KEY 换成完整密钥后运行。
                  </p>
                </div>
              )),
          },
        ]}
      />
      {copyMessage && (
        <p
          role="status"
          aria-live="polite"
          className="text-sm text-[var(--color-muted-foreground)]"
        >
          {copyMessage}
        </p>
      )}
    </section>
  );
}
