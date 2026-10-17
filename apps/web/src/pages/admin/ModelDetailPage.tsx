import { ModelIdentity } from '../../shared/ui/ModelIdentity';
import { ModelPrice } from '../../shared/ui/ModelPrice';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ModelView } from '@cheapai/api-client/models';
import { useSession } from '../../features/session/useSession';
import { adminModelsQueryKeys, modelDetailQueryOptions } from '../../features/admin-models/api';
import { invalidateAdminChannels } from '../../features/admin-channels/api';
import { ModelForm } from '../../features/admin-models/ModelForm';
import { MappingForm } from '../../features/admin-models/public';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { AsyncState } from '../../shared/patterns/AsyncState';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { Button } from '../../shared/ui/Button';

/** Creation has its own route; every public ID remains a valid detail route. */
export default function ModelDetailPage({ createMode = false }: { createMode?: boolean }) {
  const { client, user, epoch } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { id } = useParams();
  const actorId = user?.id ?? 'unknown-admin';
  const modelId = id ?? '';
  const [editing, setEditing] = useState(false);
  const [modelFeedback, setModelFeedback] = useState<string | null>(null);
  const [mappingFeedback, setMappingFeedback] = useState<string | null>(null);
  const modelQuery = useQuery({
    ...modelDetailQueryOptions({ client, actorId }, modelId),
    enabled: !createMode && modelId.length > 0,
  });

  async function handleModelSaved(model: ModelView) {
    setModelFeedback(createMode ? '模型已创建。' : '模型已保存。');
    setEditing(false);
    queryClient.setQueryData(adminModelsQueryKeys.detail(actorId, model.publicModelId), model);
    await queryClient.invalidateQueries({ queryKey: adminModelsQueryKeys.lists(actorId) });
    if (createMode) {
      navigate(`/admin/models/${encodeURIComponent(model.publicModelId)}`, { replace: true });
    }
  }

  function handleMappingSaved() {
    void invalidateAdminChannels(queryClient, actorId, epoch);
    setMappingFeedback('渠道映射已保存。');
  }

  if (!createMode && !id) {
    return (
      <section className="space-y-6">
        <PageHeader heading="模型详情" description="模型 ID 不存在。" />
        <Button asChild variant="outline">
          <Link to="/admin/models">返回模型列表</Link>
        </Button>
      </section>
    );
  }

  if (!createMode && modelQuery.isPending && !modelQuery.data) {
    return (
      <section className="space-y-6">
        <PageHeader heading="正在读取模型…" />
        <AsyncState status="loading" loadingLabel="正在读取模型价格与配置。" />
      </section>
    );
  }

  if (!createMode && modelQuery.isError && !modelQuery.data) {
    return (
      <section className="space-y-6">
        <PageHeader heading="模型详情暂不可用" />
        <ApiErrorNotice
          error={modelQuery.error}
          onRetry={() => {
            void modelQuery.refetch();
          }}
        />
        <Button asChild variant="outline">
          <Link to="/admin/models">返回模型列表</Link>
        </Button>
      </section>
    );
  }

  if (!createMode && !modelQuery.data) {
    return (
      <section className="space-y-6">
        <PageHeader heading="找不到模型" description={`未能读取公开模型 ID：${modelId}`} />
        <AsyncState
          status="error"
          heading="模型详情不可用"
          description="此 ID 可能已删除，或当前账户没有读取权限。"
          onRetry={() => {
            void modelQuery.refetch();
          }}
          retryLabel="重新读取"
        />
        <Button asChild variant="outline">
          <Link to="/admin/models">返回模型列表</Link>
        </Button>
      </section>
    );
  }

  const model = createMode ? undefined : modelQuery.data;
  return (
    <section className="space-y-6">
      <PageHeader
        heading={
          createMode ? '新增公开模型' : <ModelIdentity modelId={model?.publicModelId ?? modelId} />
        }
        description={
          model && <ModelPrice input={model.sellPrices.input} output={model.sellPrices.output} />
        }
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/admin/models">返回模型列表</Link>
            </Button>
            {model && !editing && <Button onClick={() => setEditing(true)}>编辑模型</Button>}
          </>
        }
      />

      {modelQuery.isError && modelQuery.data && (
        <ApiErrorNotice
          error={modelQuery.error}
          onRetry={() => {
            void modelQuery.refetch();
          }}
        />
      )}
      {modelFeedback && (
        <p
          role="status"
          className="rounded-lg border border-[var(--color-success-line)] bg-[var(--color-success-soft)] p-3 text-sm text-[var(--color-success)]"
        >
          {modelFeedback}
        </p>
      )}

      {model && !editing ? (
        <section className="console-panel" aria-label="模型概览">
          <dl className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            <div>
              <dt className="console-muted">状态</dt>
              <dd className="mt-1">
                <StatusBadge tone={model.status === 'active' ? 'success' : 'neutral'}>
                  {model.status === 'active' ? '已启用' : '已停用'}
                </StatusBadge>
              </dd>
            </div>
            <div>
              <dt className="console-muted">输入价格 · USD / 百万 Token</dt>
              <dd className="mt-1 console-number">{model.sellPrices.input}</dd>
            </div>
            <div>
              <dt className="console-muted">输出价格 · USD / 百万 Token</dt>
              <dd className="mt-1 console-number">{model.sellPrices.output}</dd>
            </div>
          </dl>
          {Object.entries(model.sellPrices).some(
            ([bucket, rate]) => bucket !== 'input' && bucket !== 'output' && rate != null,
          ) && (
            <div className="mt-5 border-t border-[var(--color-border)] pt-4">
              <h2 className="font-medium">缓存与推理价格 · USD / 百万 Token</h2>
              <dl className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {Object.entries(model.sellPrices)
                  .filter(
                    ([bucket, rate]) => bucket !== 'input' && bucket !== 'output' && rate != null,
                  )
                  .map(([bucket, rate]) => (
                    <div key={bucket}>
                      <dt className="console-muted">
                        {{
                          cacheRead: '缓存读取',
                          cacheWrite: '缓存写入',
                          cacheWrite5m: '缓存写入（5 分钟）',
                          cacheWrite1h: '缓存写入（1 小时）',
                          reasoning: '推理 Token',
                        }[bucket] ?? bucket}
                      </dt>
                      <dd className="mt-1 console-number">{rate}</dd>
                    </div>
                  ))}
              </dl>
            </div>
          )}
          <details className="mt-5 border-t border-[var(--color-border)] pt-4">
            <summary className="cursor-pointer console-muted">技术信息</summary>
          </details>
        </section>
      ) : (
        <section aria-labelledby="model-settings-heading" className="console-panel">
          <h2 id="model-settings-heading" className="mb-5 console-section-title">
            {createMode ? '模型设置' : '编辑模型'}
          </h2>
          <ModelForm
            key={createMode ? 'new-model' : model?.publicModelId}
            client={client}
            model={model}
            onSaved={handleModelSaved}
            onCancel={() => (createMode ? navigate('/admin/models') : setEditing(false))}
          />
        </section>
      )}

      {model && (
        <section aria-labelledby="model-mappings-heading" className="console-panel">
          <div className="mb-5">
            <h2 id="model-mappings-heading" className="console-section-title">
              渠道映射
            </h2>
          </div>
          {mappingFeedback && (
            <p
              role="status"
              className="mb-4 rounded-lg border border-[var(--color-success-line)] bg-[var(--color-success-soft)] p-3 text-sm text-[var(--color-success)]"
            >
              {mappingFeedback}
            </p>
          )}
          <MappingForm
            client={client}
            actorId={actorId}
            sessionEpoch={epoch}
            publicModelId={model.publicModelId}
            onSaved={handleMappingSaved}
          />
        </section>
      )}
    </section>
  );
}
