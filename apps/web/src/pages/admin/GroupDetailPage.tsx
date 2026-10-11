import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { GroupView } from '@cheapai/api-client/groups';
import { channelOptionsQueryOptions } from '../../shared/catalog/channel-options';
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
  const [editing, setEditing] = useState(false);
  const channels = useQuery(channelOptionsQueryOptions(client, actorId, epoch, !createMode));
  const [feedback, setFeedback] = useState<string | null>(null);
  const query = useQuery({
    ...groupDetailQueryOptions({ client, actorId }, groupId),
    enabled: !createMode && groupId.length > 0,
  });

  async function handleSaved(saved: GroupView) {
    await recordGroupSaved(queryClient, actorId, saved);
    setFeedback(createMode ? '访问组已创建。' : '访问组已保存。');
    setEditing(false);
    if (createMode) navigate(`/admin/groups/${encodeURIComponent(saved.id)}`, { replace: true });
  }

  if (!id) {
    return (
      <section className="space-y-6">
        <PageHeader heading="访问组详情" description="访问组 ID 不存在。" />
        <Button asChild variant="outline">
          <Link to="/admin/groups">返回访问组列表</Link>
        </Button>
      </section>
    );
  }

  if (!createMode && query.isPending && !query.data) {
    return (
      <section className="space-y-6">
        <PageHeader heading="正在读取访问组…" />
        <AsyncState status="loading" loadingLabel="正在读取组状态、倍率和渠道关联。" />
      </section>
    );
  }

  if (!createMode && query.isError && !query.data) {
    return (
      <section className="space-y-6">
        <PageHeader heading="访问组详情暂不可用" description={`读取访问组 ${groupId} 失败。`} />
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
      <section className="space-y-6">
        <PageHeader heading="找不到访问组" description={`未能读取访问组 ID：${groupId}`} />
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
        heading={createMode ? '创建访问组' : (group?.name ?? groupId)}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/admin/groups">返回访问组列表</Link>
            </Button>
            {group && !editing && <Button onClick={() => setEditing(true)}>编辑访问组</Button>}
          </>
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
          className="rounded-lg border border-[var(--color-success-line)] bg-[var(--color-success-soft)] p-3 text-sm text-[var(--color-success)]"
        >
          {feedback}
        </p>
      )}

      {group && !editing && (
        <div className="console-panel">
          <dl className="grid gap-5 sm:grid-cols-3">
            <div className="grid gap-1">
              <dt className="console-muted">状态</dt>
              <dd>
                <StatusBadge tone={group.status === 'active' ? 'success' : 'neutral'}>
                  {group.status === 'active' ? '已启用' : '已停用'}
                </StatusBadge>
              </dd>
            </div>
            <div className="grid gap-1">
              <dt className="console-muted">计费倍率</dt>
              <dd className="console-number">{group.billingMultiplier}×</dd>
            </div>
            <div className="grid gap-1">
              <dt className="console-label">关联渠道</dt>
              <dd className="console-value">{group.channelIds.length} 个渠道</dd>
            </div>
          </dl>
          <div className="mt-5 border-t border-[var(--color-border)] pt-4">
            <h2 className="font-medium">关联渠道</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {group.channelIds.map((channelId) => (
                <Link
                  className="rounded-md bg-[var(--color-muted)] px-3 py-2 text-[var(--color-primary)]"
                  key={channelId}
                  to={`/admin/channels/${encodeURIComponent(channelId)}`}
                >
                  {channels.data?.items.find((channel) => channel.id === channelId)?.name ??
                    channelId}
                </Link>
              ))}
              {group.channelIds.length === 0 && <p className="console-muted">暂无关联渠道</p>}
            </div>
            {channels.isError && (
              <ApiErrorNotice
                error={channels.error}
                onRetry={() => {
                  void channels.refetch();
                }}
              />
            )}
          </div>
          <details className="mt-5 border-t border-[var(--color-border)] pt-4">
            <summary className="cursor-pointer console-muted">技术信息</summary>
            <dl className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="console-label">访问组 ID</dt>
                <dd className="mt-1 break-all font-mono text-sm select-all">{group.id}</dd>
              </div>
              <div>
                <dt className="console-label">配置版本</dt>
                <dd className="mt-1 console-number">v{group.version}</dd>
              </div>
            </dl>
          </details>
        </div>
      )}

      {(createMode || editing) && (
        <section aria-labelledby="group-form-heading" className="console-panel">
          <div className="mb-5">
            <h2 id="group-form-heading" className="console-section-title">
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
            onCancel={() => (createMode ? navigate('/admin/groups') : setEditing(false))}
          />
        </section>
      )}
    </section>
  );
}

export default GroupDetailPage;
