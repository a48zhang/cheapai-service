import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiClientError } from '@cheapai/api-client/errors';
import { AuthErrorNotice } from './AuthErrorNotice';
import { RegistrationIdentityError } from './controller';

it('keeps the primary login explanation and exposes copyable received diagnostics', async () => {
  const user = userEvent.setup();
  const error = new ApiClientError('api', 'Verification code expired', {
    status: 400,
    code: 'invalid_request',
    request_id: 'request-expired-code',
    details: { field: 'emailCode', reason: 'expired' },
  });
  render(<AuthErrorNotice error={error} operation="register" />);
  expect(screen.getByRole('alert')).toHaveTextContent('请检查填写的信息');
  expect(screen.getByText(/Verification code expired/)).not.toBeVisible();
  await user.click(screen.getByText('查看错误详情'));
  const detail = screen.getByText(/Verification code expired/);
  expect(detail).toBeVisible();
  expect(detail).toHaveTextContent('HTTP 状态：400');
  expect(detail).toHaveTextContent('request-expired-code');
  expect(detail).toHaveTextContent('emailCode');
  expect(detail).toHaveTextContent('expired');
  await user.click(screen.getByRole('button', { name: '复制错误详情' }));
  expect(await navigator.clipboard.readText()).toBe(detail.textContent);
});

it('keeps the cause of failed identity verification after account creation', async () => {
  const user = userEvent.setup();
  const cause = new ApiClientError('http', '请求失败（HTTP 503）。', {
    status: 503,
    request_id: 'restore-failed',
  });
  const error = new RegistrationIdentityError(
    {
      status: 'created',
      session: 'created',
      user: {
        id: 'one',
        email_normalized: 'one@example.invalid',
      },
    },
    cause,
  );
  render(<AuthErrorNotice error={error} operation="register" />);
  expect(screen.getByRole('alert')).toHaveTextContent('账户已创建，请登录后继续。');
  await user.click(screen.getByText('查看错误详情'));
  expect(screen.getByText(/原因：请求失败/)).toHaveTextContent('HTTP 状态：503');
  expect(screen.getByText(/原因：请求失败/)).toHaveTextContent('restore-failed');
});
