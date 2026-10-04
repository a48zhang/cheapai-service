import { useEffect, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from 'react'
import { Button } from '../../components/ui/controls'
import {
  composerSelectionKey,
  getComposerModelOptions,
} from './composer-controller'
import type {
  ComposerController,
  ComposerCreatedSessionTarget,
  ComposerSessionCreationContext,
} from './composer-controller'
import type { ConversationSessionId } from './session-store'

export interface ComposerProps {
  readonly controller: ComposerController
  /** Host creates a Session only after its workspace flow has succeeded; null means no Session was created. */
  readonly onCreateSession?: () => Promise<ConversationSessionId | null>
}

/** Session-scoped prompt input backed by the typed DSH Session Remote. */
export function Composer({ controller, onCreateSession }: ComposerProps) {
  const [creatingSession, setCreatingSession] = useState(false)
  const [creationError, setCreationError] = useState('')
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  useEffect(() => {
    setCreationError('')
  }, [snapshot.connectionEpoch, snapshot.scope?.accountId, snapshot.scope?.workspaceDirectory,
    snapshot.scope?.connectionGeneration, snapshot.sessionId])
  const options = snapshot.catalog === null ? [] : getComposerModelOptions(snapshot.catalog)
  const selectedKey = composerSelectionKey(snapshot.selectedModel, snapshot.catalog)
  const selectedAvailable = options.some(option => option.key === selectedKey)
  const canEdit = snapshot.connectionReady && snapshot.projectionReady
  const canSend = canEdit && (snapshot.sessionId !== null || onCreateSession !== undefined)
    && snapshot.catalogStatus === 'ready' && options.length > 0
    && snapshot.draft.trim().length > 0
    && !snapshot.running && !snapshot.sending && !snapshot.selectingModel && !creatingSession
  const canStop = canEdit && snapshot.sessionId !== null && snapshot.running
    && !snapshot.stopping

  async function submitPrompt(): Promise<void> {
    if (!canSend) return
    if (snapshot.sessionId !== null) {
      await controller.send()
      return
    }
    if (onCreateSession === undefined) return
    const draft = snapshot.draft
    const creation = controller.captureSessionCreationContext()
    if (creation === null) return
    setCreatingSession(true)
    setCreationError('')
    try {
      const sessionId = await onCreateSession()
      if (sessionId === null) {
        preserveDraftAfterUncreatedSession(controller, creation, draft)
        setCreationError('尚未创建会话；草稿已保留。请先选择工作目录，再次发送。')
        return
      }
      const expectedTarget: ComposerCreatedSessionTarget = { ...creation, sessionId }
      await controller.send(draft, expectedTarget)
      const afterCreation = controller.getSnapshot()
      if (afterCreation.connectionEpoch !== creation.epoch
        || afterCreation.sessionId !== sessionId
        || afterCreation.scope?.accountId !== creation.scope.accountId
        || afterCreation.scope?.workspaceDirectory !== creation.scope.workspaceDirectory
        || afterCreation.scope?.connectionGeneration !== creation.scope.connectionGeneration) {
        setCreationError('账号、工作目录或连接已变化；草稿未发送。请在当前会话确认后重试。')
      }
    } catch {
      preserveDraftAfterUncreatedSession(controller, creation, draft)
      setCreationError('无法创建会话；草稿已保留。请检查工作目录后重试。')
    } finally {
      setCreatingSession(false)
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (snapshot.running) {
      if (canStop) void controller.stop()
    } else if (canSend) {
      void submitPrompt()
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing
      || event.nativeEvent.keyCode === 229 || snapshot.running
      || (snapshot.sessionId === null && onCreateSession === undefined)) return
    event.preventDefault()
    if (canSend) void submitPrompt()
  }

  const selectModel = (key: string): void => {
    const option = options.find(candidate => candidate.key === key)
    if (option !== undefined) void controller.selectModel(option.selection)
  }

  return (
    <section aria-label="消息输入" style={{ display: 'grid', gap: 'var(--space-3)', padding: 'var(--space-4)', borderTop: '1px solid var(--color-border)', background: 'var(--color-surface)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
        <label htmlFor="conversation-model" style={{ color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-sm)' }}>模型</label>
        <select
          aria-label="选择模型"
          disabled={!canEdit || snapshot.sessionId === null || snapshot.catalogStatus !== 'ready'
            || options.length === 0 || snapshot.selectionStatus === 'loading'
            || snapshot.running || snapshot.selectingModel}
          id="conversation-model"
          onChange={event => selectModel(event.currentTarget.value)}
          style={{ minWidth: 'min(100%, 15rem)', maxWidth: '100%', padding: 'var(--space-2)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface)', color: 'var(--color-ink)' }}
          value={selectedAvailable ? selectedKey : ''}
        >
          <option disabled value="">
            {snapshot.catalogStatus === 'loading' ? '正在读取模型…' : options.length === 0 ? '暂无可用模型' : '选择模型'}
          </option>
          {options.map(option => (
            <option key={option.key} value={option.key}>{option.label}</option>
          ))}
        </select>
        {snapshot.selectingModel && (
          <span role="status" style={{ color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-xs)' }}>
            正在应用模型…
          </span>
        )}
        {snapshot.connectionReady && (snapshot.catalogStatus === 'error'
          || (snapshot.connectionReady && snapshot.catalogStatus === 'ready' && options.length === 0)) && (
          <Button onClick={() => { void controller.reloadModelCatalog() }} variant="quiet">
            重新读取模型
          </Button>
        )}
      </div>

      {snapshot.sessionId === null && snapshot.connectionReady && (
        <p role="status" style={{ margin: 0, color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-sm)' }}>
          草稿已暂存；选择或创建会话后即可发送。
        </p>
      )}
      {snapshot.connectionReady && snapshot.catalogStatus === 'ready' && options.length === 0 && (
        <p role="status" style={{ margin: 0, color: 'var(--color-danger)', fontSize: 'var(--font-size-sm)' }}>
          当前没有可用模型，无法发送。请检查 DSH 模型配置。
        </p>
      )}
      {snapshot.sessionId !== null && snapshot.selectedModel !== null && !selectedAvailable && options.length > 0 && (
        <p role="status" style={{ margin: 0, color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-xs)' }}>
          当前会话所选模型暂不可用，请从列表中选择一个可用模型。
        </p>
      )}

      <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <label htmlFor="conversation-composer" style={{ color: 'var(--color-ink-muted)', fontSize: 'var(--font-size-sm)' }}>
          消息
        </label>
        <textarea
          aria-label="输入消息"
          id="conversation-composer"
          onChange={event => controller.setDraft(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
          rows={4}
          style={{ width: '100%', minHeight: '6rem', resize: 'vertical', padding: 'var(--space-3)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', background: 'var(--color-surface)', color: 'var(--color-ink)' }}
          value={snapshot.draft}
          disabled={!canEdit || creatingSession}
        />
        {(snapshot.error || creationError) && <p role="alert" style={{ margin: 0, color: 'var(--color-danger)', fontSize: 'var(--font-size-sm)' }}>{creationError || snapshot.error}</p>}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
          <span style={{ color: 'var(--color-ink-subtle)', fontSize: 'var(--font-size-xs)' }}>
            {snapshot.running ? '任务由 DSH 管理；停止后状态将随会话投影更新。' : 'Enter 发送，Shift+Enter 换行。'}
          </span>
          {snapshot.running ? (
            <Button disabled={!canStop} type="submit" variant="secondary">
              {snapshot.stopping ? '停止中…' : '停止'}
            </Button>
          ) : (
            <Button disabled={!canSend} type="submit" variant="primary">
              {creatingSession ? '正在创建会话…' : snapshot.sending ? '发送中…'
                : snapshot.sessionId === null
                  ? onCreateSession === undefined ? '选择会话后发送' : '创建会话并发送'
                  : '发送'}
            </Button>
          )}
        </div>
      </form>
    </section>
  )
}

function preserveDraftAfterUncreatedSession(
  controller: ComposerController,
  creation: ComposerSessionCreationContext,
  draft: string,
): void {
  const current = controller.getSnapshot()
  if (current.scope?.accountId === creation.scope.accountId
    && current.connectionEpoch === creation.epoch
    && current.sessionId === null && current.draft.length === 0) {
    controller.setDraft(draft)
  }
}
