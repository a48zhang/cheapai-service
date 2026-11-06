import { useEffect, useRef, useState } from 'react';
import type { RequestHistoryScope } from './api';
import type { RequestFilters } from './filters';
import { collectRequestExport, downloadRequestExport } from './export';
import { useSession } from '../session/public';
import { Button } from '../../shared/ui/Button';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';

export function RequestExport({
  filters,
  scope,
}: {
  filters: RequestFilters;
  scope: RequestHistoryScope;
}) {
  const { client, user, epoch } = useSession();
  // Changing account, applied filters or scope cancels the previous export.
  return (
    <ExportAction
      key={JSON.stringify([user?.id, epoch, scope, filters])}
      filters={filters}
      scope={scope}
      client={client}
      userId={user?.id}
    />
  );
}

function ExportAction({
  client,
  userId,
  scope,
  filters,
}: {
  client: ReturnType<typeof useSession>['client'];
  userId: string | undefined;
  scope: RequestHistoryScope;
  filters: RequestFilters;
}) {
  const controller = useRef<AbortController | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  async function run() {
    if (!userId || controller.current) return;
    const task = new AbortController();
    controller.current = task;
    setCount(0);
    setError(null);
    setNotice('');
    try {
      const rows = await collectRequestExport(
        { client, userId, scope },
        filters,
        task.signal,
        setCount,
      );
      task.signal.throwIfAborted();
      if (rows.length) downloadRequestExport(rows);
      setNotice(rows.length ? `已导出 ${rows.length} 条记录。` : '没有符合筛选条件的记录。');
    } catch (cause) {
      if (!task.signal.aborted) setError(cause);
    } finally {
      if (controller.current === task) controller.current = null;
      if (!task.signal.aborted) setCount(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          disabled={!userId}
          busy={count !== null}
          onClick={() => void run()}
        >
          {count === null ? '导出全部筛选结果（CSV）' : `正在读取 ${count} 条…`}
        </Button>
        {count !== null && (
          <Button
            variant="ghost"
            onClick={() => {
              controller.current?.abort();
              controller.current = null;
              setCount(null);
              setNotice('已取消导出。');
            }}
          >
            取消导出
          </Button>
        )}
      </div>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {error != null && <ApiErrorNotice error={error} onRetry={() => void run()} />}
    </div>
  );
}
