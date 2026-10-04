import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ModelView } from '@cheapai/api-client/models';
import type { ModelMappingView } from '@cheapai/api-client/mappings';
import { useSession } from '../../features/session/useSession';
import { adminModelsQueryKeys, modelDetailQueryOptions } from '../../features/admin-models/api';
import { invalidateAdminChannels } from '../../features/admin-channels/api';
import { ModelForm } from '../../features/admin-models/ModelForm';
import { MappingForm } from '../../features/admin-models/public';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { AsyncState } from '../../shared/patterns/AsyncState';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { Button } from '../../shared/ui/Button';

/** Creation has its own route; every public ID remains a valid detail route. */
export default function ModelDetailPage({ createMode = false }: { createMode?: boolean }) {
  const { client, user, epoch } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { id } = useParams();
  const actorId = user?.id ?? 'unknown-admin';
  const modelId = id ?? '';
  const [modelFeedback, setModelFeedback] = useState<string | null>(null);
  const [mappingFeedback, setMappingFeedback] = useState<string | null>(null);
  const modelQuery = useQuery({
    ...modelDetailQueryOptions({ client, actorId }, modelId),
    enabled: !createMode && modelId.length > 0,
  });

  async function handleModelSaved(model: ModelView) {
    setModelFeedback(
      createMode ? '模型已创建，详情已载入。' : `模型价格版本已更新至 v${model.priceVersion}。`,
    );
    queryClient.setQueryData(adminModelsQueryKeys.detail(actorId, model.publicModelId), model);
    await queryClient.invalidateQueries({ queryKey: adminModelsQueryKeys.lists(actorId) });
    if (createMode) {
      navigate(`/admin/models/${encodeURIComponent(model.publicModelId)}`, { replace: true });
    }
  }

  function handleMappingSaved(mapping: ModelMappingView) {
    void invalidateAdminChannels(queryClient, actorId, epoch);
    setMappingFeedback(
      `${mapping.channelId} · ${mapping.protocol} 映射已保存，configVersion v${mapping.configVersion}。`,
    );
  }

  if (!createMode && !id) {
    return (
      <section className="space-y-5">
        <PageHeader eyebrow="资源配置" heading="模型详情" description="模型 ID 不存在。" />
        <Button asChild variant="outline">
          <Link to="/admin/models">返回模型列表</Link>
        </Button>
      </section>
    );
  }

  if (!createMode && modelQuery.isPending && !modelQuery.data) {
    return (
      <section className="space-y-5">
        <PageHeader eyebrow="资源配置" heading="正在读取模型…" />
        <AsyncState status="loading" loadingLabel="正在读取模型价格与配置。" />
      </section>
    );
  }

  if (!createMode && modelQuery.isError && !modelQuery.data) {
    return (
      <section className="space-y-5">
        <PageHeader
          eyebrow="资源配置"
          heading="模型详情暂不可用"
          description="读取失败时不会显示旧输入作为当前服务端版本。"
        />
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
      <section className="space-y-5">
        <PageHeader
          eyebrow="资源配置"
          heading="找不到模型"
          description={`未能读取公开模型 ID：${modelId}`}
        />
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
        eyebrow="资源配置 · 模型目录"
        heading={createMode ? '新增公开模型' : (model?.publicModelId ?? modelId)}
        description={
          createMode
            ? '创建公开目录条目后，可以在同一详情页配置价格与渠道映射。'
            : '管理公开价格、准入条件和渠道上游映射。目录启用状态与渠道可用性分别配置。'
        }
        actions={
          <Button asChild variant="outline">
            <Link to="/admin/models">返回模型列表</Link>
          </Button>
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
          className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950"
        >
          {modelFeedback}
        </p>
      )}

      <section
        aria-labelledby="model-settings-heading"
        className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
      >
        <div className="mb-5">
          <h2 id="model-settings-heading" className="text-lg font-semibold">
            目录与价格
          </h2>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            价格使用每百万 Token 的十进制字符串保存；修改只提交变化字段并使用独立 priceVersion。
          </p>
        </div>
        <ModelForm
          key={createMode ? 'new-model' : model?.publicModelId}
          client={client}
          model={model}
          onSaved={handleModelSaved}
          onCancel={createMode ? () => navigate('/admin/models') : undefined}
        />
      </section>

      {model && (
        <section
          aria-labelledby="model-mappings-heading"
          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
        >
          <div className="mb-5">
            <h2 id="model-mappings-heading" className="text-lg font-semibold">
              渠道映射
            </h2>
            <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
              映射关联实际渠道和上游模型，并声明协议能力。它只表示配置存在，不代表渠道健康、已经探测或已成功转发。编辑使用
              configVersion，与价格版本完全独立。
            </p>
          </div>
          {mappingFeedback && (
            <p
              role="status"
              className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950"
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
