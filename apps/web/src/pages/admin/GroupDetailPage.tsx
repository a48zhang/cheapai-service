import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { GroupView } from '@cheapai/api-client/groups';
import { useSession } from '../../features/session/useSession';
import { groupDetailQueryOptions, recordGroupSaved } from '../../features/admin-groups/api';
import { GroupForm } from '../../features/admin-groups/GroupForm';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { AsyncState } from '../../shared/patterns/AsyncState';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { Button } from '../../shared/ui/Button';
import { StatusBadge } from '../../shared/ui/StatusBadge';

/** Creates groups at /new and provides refreshable, conflict-aware deep-linked details. */
export function GroupDetailPage() {
  const { client, user, epoch } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { id } = useParams();
  const actorId = user?.id ?? 'unknown-admin';
  const createMode = id === 'new';
  const groupId = id ?? '';
  const [feedback, setFeedback] = useState<string | null>(null);
  const query = useQuery({
    ...groupDetailQueryOptions({ client, actorId }, groupId),
    enabled: !createMode && groupId.length > 0,
  });

  async function handleSaved(saved: GroupView) {
    await recordGroupSaved(queryClient, actorId, saved);
    setFeedback(createMode ? '访问组已创建。' : `访问组配置已保存到 v${saved.version}。`);
    if (createMode) navigate(`/admin/groups/${encodeURIComponent(saved.id)}`, { replace: true });
  }

  if (!id) {
    return (
      <section className="space-y-5">
        <PageHeader eyebrow="资源配置" heading="访问组详情" description="访问组 ID 不存在。" />
        <Button asChild variant="outline">
          <Link to="/admin/groups">返回访问组列表</Link>
        </Button>
      </section>
    );
  }

  if (!createMode && query.isPending && !query.data) {
    return (
      <section className="space-y-5">
        <PageHeader eyebrow="资源配置" heading="正在读取访问组…" />
        <AsyncState status="loading" loadingLabel="正在读取组状态、倍率和渠道关联。" />
      </section>
    );
  }

  if (!createMode && query.isError && !query.data) {
    return (
      <section className="space-y-5">
        <PageHeader
          eyebrow="资源配置"
          heading="访问组详情暂不可用"
          description={`读取访问组 ${groupId} 失败。`}
        />
        <ApiErrorNotice
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
        <Button asChild variant="outline">
          <Link to="/admin/groups">返回访问组列表</Link>
        </Button>
      </section>
    );
  }

  if (!createMode && !query.data) {
    return (
      <section className="space-y-5">
        <PageHeader
          eyebrow="资源配置"
          heading="找不到访问组"
          description={`未能读取访问组 ID：${groupId}`}
        />
        <AsyncState
          status="error"
          heading="访问组不可用"
          description="此 ID 可能已删除，或当前账户没有读取权限。"
          onRetry={() => {
            void query.refetch();
          }}
          retryLabel="重新读取"
        />
        <Button asChild variant="outline">
          <Link to="/admin/groups">返回访问组列表</Link>
        </Button>
      </section>
    );
  }

  const group = createMode ? undefined : query.data;
  return (
    <section className="space-y-6">
      <PageHeader
        eyebrow="资源配置 · 访问控制"
        heading={createMode ? '创建访问组' : (group?.name ?? groupId)}
        actions={
          <Button asChild variant="outline">
            <Link to="/admin/groups">返回访问组列表</Link>
          </Button>
        }
      />

      {query.isError && query.data && (
        <ApiErrorNotice
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}
      {feedback && (
        <p
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950"
        >
          {feedback}
        </p>
      )}

      {group && (
        <dl className="grid gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:grid-cols-4">
          <div className="grid gap-1">
            <dt className="text-xs text-[var(--color-muted-foreground)]">访问组 ID</dt>
            <dd className="break-all font-mono text-sm">{group.id}</dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-xs text-[var(--color-muted-foreground)]">状态</dt>
            <dd>
              <StatusBadge tone={group.status === 'active' ? 'success' : 'neutral'}>
                {group.status === 'active' ? '已启用' : '已停用'}
              </StatusBadge>
            </dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-xs text-[var(--color-muted-foreground)]">计费倍率</dt>
            <dd className="font-mono tabular-nums">{group.billingMultiplier}×</dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-xs text-[var(--color-muted-foreground)]">配置版本</dt>
            <dd className="font-mono">v{group.version}</dd>
          </div>
        </dl>
      )}

      <section
        aria-labelledby="group-form-heading"
        className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
      >
        <div className="mb-5">
          <h2 id="group-form-heading" className="text-lg font-semibold">
            {createMode ? '访问组设置' : '编辑访问组'}
          </h2>
        </div>
        <GroupForm
          key={createMode ? 'new-group' : group?.id}
          client={client}
          actorId={actorId}
          sessionEpoch={epoch}
          group={group}
          onSaved={handleSaved}
          onCancel={createMode ? () => navigate('/admin/groups') : undefined}
        />
      </section>
    </section>
  );
}

export default GroupDetailPage;
