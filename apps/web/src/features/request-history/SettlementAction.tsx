import { useRef, useState } from 'react';
import type { RequestRecord } from '@cheapai/contracts/requests';
import { createSettlementsApi } from '@cheapai/api-client/settlements';
import { useSession } from '../session/public';
import { requestHistoryKeys } from './api';
import { Button } from '../../shared/ui/Button';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';

export function SettlementAction({ request }: { request: RequestRecord }) {
  const { client, user, queryClient } = useSession();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  if (request.billing_status !== 'settlement_pending' && !message) return null;
  return <section className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-5"><h2 className="font-semibold">结算恢复</h2><p className="text-sm">仅在用量和价格证据完整时，服务端才会补记消费账本。重复操作不会重复扣费。</p>
    {error != null && <ApiErrorNotice error={error} />}{message && <p role="status">{message}</p>}
    {!message && <Button variant="secondary" busy={busy} onClick={() => {
      if (lock.current) return; lock.current = true; setBusy(true); setError(null);
      void createSettlementsApi(client).retrySettlement(request.id).then(result => {
        setMessage(result.status === 'settled' ? '结算已完成。' : '此请求已经结算。');
        void queryClient.invalidateQueries({ queryKey: requestHistoryKeys.root(user!.id, 'admin') });
      }).catch(setError).finally(() => { lock.current = false; setBusy(false); });
    }}>重试结算</Button>}
  </section>;
}
