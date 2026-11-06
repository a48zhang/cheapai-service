import { ApiClientError } from '@cheapai/api-client/errors';
import { Disclosure } from '../../shared/ui/Disclosure';
import { CopyButton } from '../../shared/ui/CopyButton';
import { RegistrationIdentityError } from './controller';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';

type AuthOperation = 'login' | 'register' | 'settings' | 'restore' | 'logout';

const fallback: Record<AuthOperation, string> = {
  login: '暂时无法登录，请稍后重试。',
  register: '暂时无法确认注册结果。请先尝试登录；如果账户尚未创建，再返回注册。',
  settings: '暂时无法读取注册信息，请重试。',
  restore: '暂时无法确认登录状态，请重新连接。',
  logout: '暂时无法确认退出结果，请重新退出。',
};

/** Keep the primary action readable while retaining the received diagnostics on demand. */
function errorDetails(error: unknown): string {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    lines.push(`${seen.size === 1 ? '错误信息' : '原因'}：${current.message}`);
    if (current instanceof ApiClientError) {
      if (current.status !== null) lines.push(`HTTP 状态码：${current.status}`);
      lines.push(`错误代码：${current.code}`);
      if (current.request_id) lines.push(`请求编号：${current.request_id}`);
      if (current.details !== undefined) {
        try {
          lines.push(`错误详情：${JSON.stringify(current.details, null, 2)}`);
        } catch {
          lines.push(`错误详情：${String(current.details)}`);
        }
      }
    }
    current = current.cause;
  }
  if (lines.length === 0) lines.push(String(error));
  return lines.join('\n');
}
export function AuthErrorNotice({
  error,
  operation,
  onRetry,
}: {
  error: unknown;
  operation: AuthOperation;
  onRetry?: (() => void) | undefined;
}) {
  if (!error) return null;
  let message = error instanceof RegistrationIdentityError ? error.message : fallback[operation];
  if (error instanceof ApiClientError) {
    if (error.code === 'rate_limited') message = '操作过于频繁，请稍后重试。';
    else if (operation === 'login' && error.code === 'unauthorized')
      message = '邮箱或密码不正确，请检查后重试。';
    else if (operation === 'login' && error.code === 'invalid_request')
      message = '请检查邮箱和密码后重试。';
    else if (operation === 'register' && error.code === 'invalid_request')
      message = '请检查填写的信息；如需邀请码或邮箱验证码，请确认其有效后重试。';
    else if (operation === 'register' && error.code === 'conflict')
      message = '未能完成注册。如果你已注册，请直接登录；否则请检查填写的信息后重试。';
    else if (error.code === 'forbidden')
      message =
        operation === 'register'
          ? '当前无法注册，请刷新页面后查看注册要求。'
          : '本次操作未获允许，请刷新页面后重试。';
  }
  const details = errorDetails(error);
  return (
    <div className="space-y-2">
      <ApiErrorNotice error={new Error(message)} onRetry={onRetry} />
      <Disclosure
        title={<>查看错误详情</>}
        className="text-sm text-[var(--color-muted-foreground)]"
      >
        <pre className="my-3 whitespace-pre-wrap break-words font-mono text-xs leading-6">
          {details}
        </pre>
        <CopyButton value={details} label="复制错误详情" />
      </Disclosure>
    </div>
  );
}
