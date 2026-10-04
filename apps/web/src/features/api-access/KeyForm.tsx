import { formatUsdPerMillionTokens } from '../../shared/lib/model-price';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { Button } from '../../shared/ui/Button';
import { Dialog } from '../../shared/ui/Dialog';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { useKeyForm } from './useKeyForm';
import type { KeyFormProps } from './useKeyForm';

export function KeyForm(props: KeyFormProps) {
  const { open, mode } = props;
  const {
    form,
    groupsQuery,
    groups,
    selectedGroup,
    current,
    notice,
    busy,
    reloadNeeded,
    createPhase,
    settled,
    fieldsDisabled,
    groupsError,
    close,
    submit,
    modifyAfterFailure,
    reloadCurrent,
  } = useKeyForm(props);
  const {
    register,
    formState: { errors },
  } = form;

  const footer = (
    <>
      {reloadNeeded && (
        <Button variant="secondary" busy={busy} onClick={() => void reloadCurrent()}>
          重新读取
        </Button>
      )}
      {mode === 'create' && createPhase === 'correctable' && (
        <Button variant="secondary" onClick={modifyAfterFailure}>
          修改参数
        </Button>
      )}
      <Button variant="outline" disabled={busy} onClick={() => close(false)}>
        {mode === 'create' && createPhase === 'created' ? '已保存，关闭密钥' : '关闭'}
      </Button>
      {mode === 'create' && !settled && createPhase !== 'correctable' && (
        <Button
          type="submit"
          form="key-form"
          busy={busy}
          disabled={groupsQuery.isLoading || groupsError !== '' || !selectedGroup}
        >
          {busy ? '正在确认…' : createPhase === 'unknown' ? '重试确认' : '创建 Key'}
        </Button>
      )}
      {mode === 'edit' && current?.status !== 'revoked' && (
        <Button
          type="submit"
          form="key-form"
          busy={busy}
          disabled={groupsQuery.isLoading || groupsError !== '' || reloadNeeded}
        >
          保存 Key
        </Button>
      )}
    </>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={mode === 'create' ? '创建 API Key' : '编辑 Key'}
      closeLabel={mode === 'create' ? '关闭创建 API Key' : '关闭编辑 Key'}
      closeButton={!busy}
      footer={footer}
    >
      {notice &&
        (typeof notice === 'string' ? (
          <p
            role="status"
            className="mb-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)] p-3 text-sm"
          >
            {notice}
          </p>
        ) : (
          <ApiErrorNotice error={notice} />
        ))}
      {mode === 'edit' && current?.status === 'revoked' && (
        <p className="mb-4 text-sm text-[var(--color-muted-foreground)]">此 Key 已撤销。</p>
      )}
      {mode === 'edit' && current && (
        <p className="mb-4">
          <code>{current.displayPrefix}…</code>
        </p>
      )}
      {mode === 'create' && createPhase === 'replayed' ? null : mode === 'create' &&
        createPhase === 'created' ? null : (
        <form
          id="key-form"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={fieldsDisabled} className="space-y-4 border-0 p-0">
            <Field label="名称" required error={errors.name?.message}>
              <Input autoComplete="off" maxLength={128} {...register('name')} />
            </Field>
            {groups.length === 1 && selectedGroup ? (
              <div className="grid gap-1.5">
                <p className="text-sm font-medium text-[var(--color-foreground)]">分组</p>
                <div className="min-h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-muted)] px-3 py-2 text-sm">
                  {selectedGroup.name}
                </div>
                <input type="hidden" {...register('groupId')} />
                {errors.groupId?.message && (
                  <p role="alert" className="text-xs text-[var(--color-destructive)]">
                    {errors.groupId.message}
                  </p>
                )}
              </div>
            ) : (
              <Field label="分组" required error={errors.groupId?.message}>
                <select
                  {...register('groupId')}
                  required
                  disabled={groupsQuery.isLoading || fieldsDisabled}
                  className="min-h-10 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <option value="" disabled>
                    选择分组
                  </option>
                  {mode === 'edit' &&
                    current &&
                    !groups.some((group) => group.id === current.groupId) && (
                      <option value={current.groupId} disabled>
                        {current.groupName}（授权已撤回）
                      </option>
                    )}
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {groupsQuery.isLoading && (
              <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
                正在读取可用分组…
              </p>
            )}
            {groupsError && (
              <div
                role="alert"
                className="flex items-center justify-between gap-3 text-sm text-[var(--color-destructive)]"
              >
                <span>{groupsError}</span>
                <Button variant="secondary" size="sm" onClick={() => void groupsQuery.refetch()}>
                  重试
                </Button>
              </div>
            )}
            {!groupsQuery.isLoading && !groupsError && groups.length === 0 && mode === 'create' && (
              <p className="text-sm text-[var(--color-muted-foreground)]">
                暂无可用分组，请联系管理员开放。
              </p>
            )}
            {selectedGroup && (
              <div className="rounded-lg bg-[var(--color-muted)] p-3 text-sm">
                <p className="font-medium">{selectedGroup.name} · 授权模型与价格</p>
                {selectedGroup.models.length === 0 ? (
                  <p className="mt-2 text-[var(--color-muted-foreground)]">该分组尚未配置模型</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {selectedGroup.models.map((model) => {
                      const prices = selectedGroup.modelPrices?.[model];
                      return (
                        <li
                          key={model}
                          className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"
                        >
                          <code>{model}</code>
                          <span className="text-xs text-[var(--color-muted-foreground)]">
                            输入{' '}
                            {formatUsdPerMillionTokens(
                              prices?.input,
                              selectedGroup.billingMultiplier,
                            )}
                            {' · '}输出{' '}
                            {formatUsdPerMillionTokens(
                              prices?.output,
                              selectedGroup.billingMultiplier,
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
            <Field label="到期时间（留空不过期）" error={errors.expiresAt?.message}>
              <Input type="datetime-local" {...register('expiresAt')} />
            </Field>
          </fieldset>
        </form>
      )}
    </Dialog>
  );
}
