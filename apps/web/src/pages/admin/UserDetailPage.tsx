import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  createAdminUsersFeatureApi,
  adminUsersQueryKeys,
  invalidateAdminUsers,
  userDetailQueryOptions,
} from '../../features/admin-users/api';
import { BalanceAdjustmentDialog } from '../../features/admin-users/BalanceAdjustmentDialog';
import { UserAccessPanel } from '../../features/admin-users/UserAccessPanel';
import { UserForm } from '../../features/admin-users/UserForm';
import { useSession } from '../../features/session/public';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { AsyncState } from '../../shared/patterns/AsyncState';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { formatDateTime } from '../../shared/lib/datetime';
import { formatUnitsToUsd } from '../../shared/lib/money';
import { Button } from '../../shared/ui/Button';
import { StatusBadge } from '../../shared/ui/StatusBadge';

function balance(value: string): string {
  try {
    return `${formatUnitsToUsd(value)} USD`;
  } catch {
    return '余额暂不可显示';
  }
}

export default function UserDetailPage() {
  const { client, user: actor, epoch, isAdmin } = useSession();
  const params = useParams();
  const userId = params.userId ?? params.id ?? '';
  const actorId = actor?.id ?? 'anonymous-admin';
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [balanceOpen, setBalanceOpen] = useState(false);
  const api = useMemo(() => createAdminUsersFeatureApi(client), [client]);
  const userQuery = useQuery({
    ...userDetailQueryOptions(api, actorId, epoch, userId),
    enabled: isAdmin && userId.length > 0,
  });
  const profile = userQuery.data;

  async function refreshUser() {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: adminUsersQueryKeys.detail(actorId, epoch, userId),
      }),
      invalidateAdminUsers(queryClient, actorId, epoch),
    ]);
    await userQuery.refetch();
  }

  if (!isAdmin)
    return (
      <section className="space-y-4">
        <PageHeader heading="用户资料" />
        <ApiErrorNotice error={new Error('此页面需要管理员权限。')} />
      </section>
    );
  if (userQuery.isPending && !profile)
    return (
      <section className="space-y-4">
        <PageHeader heading="用户资料" />
        <AsyncState status="loading" loadingLabel="正在读取用户资料…" />
      </section>
    );
  if (userQuery.isError && !profile)
    return (
      <section className="space-y-4">
        <PageHeader heading="用户资料" />
        <ApiErrorNotice
          error={userQuery.error}
          onRetry={() => {
            void userQuery.refetch();
          }}
        />
      </section>
    );
  if (!profile)
    return (
      <section className="space-y-4">
        <PageHeader heading="用户资料" />
        <AsyncState
          status="empty"
          heading="没有找到该用户"
          description="用户可能已删除，或当前链接不完整。"
        />
      </section>
    );

  return (
    <section className="space-y-5">
      <PageHeader
        eyebrow="用户与授权"
        heading={profile.email_normalized}
        description={`用户 ID：${profile.id}`}
        actions={
          <>
            <Button asChild variant="secondary">
              <Link to="/admin/users">返回用户列表</Link>
            </Button>
            <Button variant="outline" onClick={() => setEditOpen(true)}>
              编辑访问设置
            </Button>
            <Button onClick={() => setBalanceOpen(true)}>调整余额</Button>
          </>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.8fr)]">
        <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">账户资料</h2>
              <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
                安全字段来自管理用户详情接口。
              </p>
            </div>
            {profile.status === 'active' ? (
              <StatusBadge tone="success">启用</StatusBadge>
            ) : (
              <StatusBadge>停用</StatusBadge>
            )}
          </div>
          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-[var(--color-muted-foreground)]">邮箱</dt>
              <dd className="mt-1 break-all font-medium">{profile.email_normalized}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-muted-foreground)]">角色</dt>
              <dd className="mt-1">{profile.role === 'admin' ? '管理员' : '普通用户'}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-muted-foreground)]">余额</dt>
              <dd className="mt-1 font-mono tabular-nums">{balance(profile.balance_units)}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-muted-foreground)]">邮箱验证</dt>
              <dd className="mt-1">
                {profile.email_verified_at === null
                  ? '未验证'
                  : formatDateTime(profile.email_verified_at)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-muted-foreground)]">账户分组</dt>
              <dd className="mt-1">
                {profile.group_name}{' '}
                <span className="text-xs text-[var(--color-muted-foreground)]">
                  ({profile.group_status === 'active' ? '启用' : '停用'})
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-muted-foreground)]">创建时间</dt>
              <dd className="mt-1">{formatDateTime(profile.created_at)}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-muted-foreground)]">最近更新</dt>
              <dd className="mt-1">{formatDateTime(profile.updated_at)}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-muted-foreground)]">资料版本</dt>
              <dd className="mt-1">{profile.version}</dd>
            </div>
          </dl>
        </section>
        <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <h2 className="text-lg font-semibold">相关记录</h2>
          <p className="mt-1 text-sm leading-6 text-[var(--color-muted-foreground)]">
            下列管理页面使用服务端支持的用户筛选参数。
          </p>
          <div className="mt-4 grid gap-3">
            <Button asChild variant="outline" className="justify-start">
              <Link to={`/admin/requests?userId=${encodeURIComponent(profile.id)}`}>
                查看该用户的请求
              </Link>
            </Button>
            <Button asChild variant="outline" className="justify-start">
              <Link to={`/admin/billing?userId=${encodeURIComponent(profile.id)}`}>
                查看该用户的账单与余额记录
              </Link>
            </Button>
          </div>
        </section>
      </div>
      <UserAccessPanel
        user={profile}
        api={api}
        onEdit={() => setEditOpen(true)}
        onRevoked={() => {
          void invalidateAdminUsers(queryClient, actorId, epoch);
        }}
      />
      {userQuery.isFetching && (
        <p role="status" className="text-xs text-[var(--color-muted-foreground)]">
          正在更新资料…
        </p>
      )}
      {userQuery.isError && profile && (
        <ApiErrorNotice
          error={userQuery.error}
          onRetry={() => {
            void userQuery.refetch();
          }}
        />
      )}
      <UserForm
        open={editOpen}
        mode="edit"
        user={profile}
        api={api}
        actorId={actorId}
        epoch={epoch}
        onOpenChange={(open) => {
          setEditOpen(open);
          if (!open) void refreshUser();
        }}
        onSaved={() => {
          setEditOpen(false);
          void refreshUser();
        }}
      />
      <BalanceAdjustmentDialog
        open={balanceOpen}
        user={profile}
        api={api}
        actorId={actorId}
        epoch={epoch}
        onOpenChange={setBalanceOpen}
        onAdjusted={() => {
          void refreshUser();
        }}
      />
    </section>
  );
}
