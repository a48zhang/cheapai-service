import { useId, useState, type FormEvent } from 'react'
import { Button, Menu, MenuItem, TextInput } from '../../components/ui/controls'
import type { ConversationListItem } from './session-store'

export interface SessionMenuProps {
  readonly session: Pick<ConversationListItem, 'sessionId' | 'title'>
  readonly onRename: (sessionId: ConversationListItem['sessionId'], title: string) => Promise<unknown>
}

/** Per-session actions backed by the real DSH rename operation. */
export function SessionMenu({ session, onRename }: SessionMenuProps) {
  const errorId = useId()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(session.title)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function saveRename(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const nextTitle = title.trim()
    if (nextTitle.length === 0) {
      setError('请输入会话标题。')
      return
    }
    setSaving(true)
    setError('')
    try {
      await onRename(session.sessionId, nextTitle)
      setTitle(nextTitle)
      setEditing(false)
    } catch (reason: unknown) {
      setError(reason instanceof Error && reason.message.length > 0
        ? reason.message
        : '重命名失败，请稍后重试。')
    } finally {
      setSaving(false)
    }
  }

  function cancelRename(): void {
    setTitle(session.title)
    setError('')
    setEditing(false)
  }

  return (
    <Menu label="更多">
      {editing ? (
        <form
          aria-describedby={error ? errorId : undefined}
          onSubmit={event => { void saveRename(event) }}
          style={{ display: 'grid', gap: 'var(--space-3)', minWidth: '14rem', padding: 'var(--space-2)' }}
        >
          <TextInput
            autoFocus
            label="会话标题"
            onChange={event => setTitle(event.currentTarget.value)}
            value={title}
          />
          {error && <p id={errorId} role="alert" style={{ margin: 0, color: 'var(--color-danger)', fontSize: 'var(--font-size-xs)' }}>{error}</p>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)' }}>
            <Button disabled={saving} onClick={cancelRename} variant="quiet">取消</Button>
            <Button disabled={saving} type="submit" variant="primary">{saving ? '保存中…' : '保存标题'}</Button>
          </div>
        </form>
      ) : (
        <>
          <MenuItem onClick={() => { setTitle(session.title); setError(''); setEditing(true) }}>
            重命名
          </MenuItem>
          <MenuItem aria-describedby={`${errorId}-delete-note`} disabled title="固定版本的 DSH 不提供会话删除">
            删除（当前不可用）
          </MenuItem>
          <p
            id={`${errorId}-delete-note`}
            style={{ maxWidth: '15rem', margin: '0 var(--space-2) var(--space-2)', color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-xs)' }}
          >
            当前固定版本的 DSH 没有删除接口，因此不会隐藏或移除会话。
          </p>
        </>
      )}
    </Menu>
  )
}
