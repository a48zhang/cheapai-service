import { useLayoutEffect, useRef, useState } from 'react';
import { createAdminRegistrationApi } from '@cheapai/api-client/registration-admin';
import type { CodeBatch } from '@cheapai/contracts/registration-admin';
import { useSession } from '../session/public';
import { createCodeIntent, executeCodeIntent, canChangeCodeIntent, type CodeIntent } from './code-operation';
import { Dialog } from '../../shared/ui/Dialog';
import { Button } from '../../shared/ui/Button';
import { Input } from '../../shared/ui/Input';
import { Field } from '../../shared/ui/Field';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';

export function CodeBatchDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (value: boolean) => void; onCreated: () => void }) {
  const { client, user, epoch } = useSession();
  const [quantity, setQuantity] = useState('1');
  const [expires, setExpires] = useState('');
  const [intent, setIntent] = useState<CodeIntent | null>(null);
  const [result, setResult] = useState<CodeBatch | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const busyRef = useRef(false);
  const generation = useRef(0);
  useLayoutEffect(() => {
    generation.current++; setResult(null); setError(null); setCopyStatus(''); setBusy(false); busyRef.current = false;
    const counter = generation;
    return () => { counter.current++; };
  }, [open, user?.id, epoch]);
  useLayoutEffect(() => { setIntent(null); }, [user?.id, epoch]);
  const submit = async () => {
    if (busyRef.current || !user) return;
    let current = intent;
    if (!current) {
      const amount = Number(quantity);
      const deadline = new Date(expires).getTime();
      if (!Number.isInteger(amount) || amount < 1 || amount > 100 || !Number.isSafeInteger(deadline) || deadline <= Date.now()) { setError(new Error('数量须为 1–100，有效期须晚于当前时间。')); return; }
      current = createCodeIntent({ quantity: amount, expiresAt: deadline }); setIntent(current);
    }
    busyRef.current = true; setBusy(true); setError(null);
    const ticket = generation.current;
    try {
      const response = await executeCodeIntent(createAdminRegistrationApi(client), current);
      if (ticket !== generation.current) return;
      setResult(response); setIntent(null); onCreated();
    } catch (failure) {
      if (ticket !== generation.current) return;
      setError(failure); if (canChangeCodeIntent(failure)) setIntent(null);
    } finally { if (ticket === generation.current) { busyRef.current = false; setBusy(false); } }
  };
  return <Dialog open={open} onOpenChange={onOpenChange} title="生成邀请码" description="邀请码仅赋予注册资格，不增加账户余额。" closeLabel="关闭" footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>关闭</Button>{!result && <Button busy={busy} onClick={() => void submit()}>{intent ? '重试同一批次' : '生成邀请码'}</Button>}</>}>
    <div className="space-y-4 p-6">
      {result ? <>
        <p role="status">{result.replayed ? '已恢复原批次。明文无法再次返回。' : '请立即保存，关闭后无法再次查看完整邀请码。'}</p>
        <ul className="max-h-64 space-y-2 overflow-auto">{result.codes.map(code => <li key={code.id}><code className="break-all text-sm">{'token' in code ? code.token : code.displayPrefix}</code></li>)}</ul>
        {!result.replayed && <Button variant="secondary" onClick={() => void navigator.clipboard.writeText(result.codes.map(code => code.token).join('\n')).then(() => setCopyStatus('已复制')).catch(() => setCopyStatus('无法复制，请手动保存'))}>复制邀请码</Button>}
        {copyStatus && <p role="status">{copyStatus}</p>}
      </> : <><Field label="数量"><Input type="number" min={1} max={100} value={quantity} onChange={event => setQuantity(event.target.value)} disabled={busy || !!intent} /></Field><Field label="有效期"><Input type="datetime-local" value={expires} onChange={event => setExpires(event.target.value)} disabled={busy || !!intent} /></Field>{intent && <p className="text-sm text-amber-800">此前结果尚未确认，重试将恢复相同批次。</p>}</>}
      {error != null && <ApiErrorNotice error={error} />}
    </div>
  </Dialog>;
}
