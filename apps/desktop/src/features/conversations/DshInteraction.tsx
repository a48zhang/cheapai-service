import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import { markdownLabels } from './MessageBody'
import type { DshClient } from '../../adapters/dsh/client'
import type { ConversationSessionId } from './session-store'

// Remote events project Host Agent objects into client Context handles.
type AskUserQuestionRequestEvent = Parameters<TypertClientEventListener<'user-questions/request'>>[0]
type ApprovalRequestEvent = Parameters<TypertClientEventListener<'approval/request'>>[0]

type InteractionValue = AskUserQuestionAnswer | ApprovalOutcome
type RemoteEventNext<T> = () => Promise<T>

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (reason: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  }
}

type QuestionDraft = { readonly selected: readonly string[]; readonly custom: string }

interface PendingInteractionBase {
  readonly id: string
  readonly logicalKey: string
  readonly signal: AbortSignal | undefined
  readonly callId: Parameters<DshClient['remote']['userQuestions']['answer']>[1] | undefined
  readonly promise: Promise<InteractionValue>
  readonly settled: () => boolean
  readonly delegate: () => void
  readonly onAbort: () => void
  readonly dispose: () => void
  submitting: boolean
  error: string | undefined
}

interface PendingQuestionInteraction extends PendingInteractionBase {
  readonly kind: 'question'
  readonly request: AskUserQuestionRequestEvent
  readonly sessionId: ConversationSessionId | undefined
  continued: boolean
  deadline: number | undefined
  readonly answer: (value: AskUserQuestionAnswer) => boolean
  readonly answerContinued: (value: AskUserQuestionAnswer) => Promise<void>
  readonly timeout: () => void
}

interface PendingApprovalInteraction extends PendingInteractionBase {
  readonly kind: 'approval'
  readonly request: ApprovalRequestEvent
  readonly answer: (value: ApprovalOutcome) => boolean
}

type PendingInteraction = PendingQuestionInteraction | PendingApprovalInteraction

export interface DshInteractionProps {
  /** The pinned DSH Remote object; `$on` owns event delivery and `$events/result`. */
  readonly remote: DshClient['remote']
  /** Resolve a Remote Event owner Context to its DSH Session id for timed wait claims. */
  readonly sessionIdForOwner?: (owner: unknown) => ConversationSessionId | undefined
}

export interface DshInteractionHandle {
  /** Scroll to an active Remote Event correlated with this durable Tool call. */
  reveal(callId: string): boolean
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException('The DSH interaction was cancelled', 'AbortError')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Preserve DSH's public timed-question wire error without loading its Host package. */
function timedOutQuestion(): Error & { code: string } {
  const error = new Error('ask_user_question timed out before the user answered') as Error & { code: string }
  error.name = 'UserQuestionError'
  error.code = 'ASK_TIMED_OUT'
  return error
}

function localKey(kind: PendingInteraction['kind'], id: string): string {
  return `${kind}:${id}`
}

function questionLogicalKey(request: AskUserQuestionRequestEvent, id: string): string {
  const callId = request.wait?.callId
  return localKey('question', callId === undefined ? `unkeyed:${id}` : String(callId))
}

function approvalLogicalKey(request: ApprovalRequestEvent, id: string): string {
  return localKey('approval', request.callId === undefined ? `unkeyed:${id}` : String(request.callId))
}

function displayReason(request: ApprovalRequestEvent): string | undefined {
  const localized = request.displayReason
  if (localized !== undefined) {
    const locale = typeof document === 'undefined' ? 'en' : document.documentElement.lang
    const language = locale.toLowerCase().split('-')[0]
    const exact = localized[locale]
    if (exact !== undefined) return exact
    const matching = Object.entries(localized).find(([key]) => key.toLowerCase().split('-')[0] === language)?.[1]
    if (matching !== undefined) return matching
    if (localized.en !== undefined) return localized.en
  }
  return request.reason
}

function questionAnswer(
  request: AskUserQuestionRequestEvent,
  drafts: readonly QuestionDraft[],
): AskUserQuestionAnswer {
  return {
    answers: request.questions.map((question, index) => {
      const draft = drafts[index] ?? { selected: [], custom: '' }
      return {
        id: question.id,
        selected: [...draft.selected],
        ...(draft.custom.length === 0 ? {} : { custom: draft.custom }),
      }
    }),
  }
}

/**
 * Owner for DSH's real Remote Event waterfalls. Returning from `$on` is the
 * official `$events/result` reply path; no HTTP or app-specific approval RPC is
 * introduced here.
 */
export const DshInteraction = forwardRef<DshInteractionHandle, DshInteractionProps>(
  function DshInteraction({ remote, sessionIdForOwner }, ref) {
    const [pending, setPending] = useState<readonly PendingInteraction[]>([])
    const [drafts, setDrafts] = useState<Readonly<Record<string, readonly QuestionDraft[]>>>({})
    const [now, setNow] = useState(() => Date.now())
    const pendingRef = useRef(pending)
    const byLogicalKeyRef = useRef(new Map<string, PendingInteraction>())
    const sequenceRef = useRef(0)
    const disposedRef = useRef(false)
    const cardElementsRef = useRef(new Map<string, HTMLElement>())

    pendingRef.current = pending

    useImperativeHandle(ref, () => ({
      reveal(callId) {
        const card = pendingRef.current.find(item => item.callId === callId)
        if (card === undefined) return false
        const element = cardElementsRef.current.get(card.id)
        element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        return true
      },
    }), [])

    useEffect(() => {
      if (!pending.some(item => item.kind === 'question' && item.deadline !== undefined)) return
      const timer = window.setInterval(() => {
        const currentTime = Date.now()
        setNow(currentTime)
        for (const item of pendingRef.current) {
          if (item.kind === 'question' && !item.continued
            && item.deadline !== undefined && item.deadline <= currentTime) {
            item.timeout()
          }
        }
      }, 250)
      return () => window.clearInterval(timer)
    }, [pending])

    useEffect(() => {
      disposedRef.current = false
      const activeByKey = byLogicalKeyRef.current

      const add = (item: PendingInteraction): void => {
        if (disposedRef.current || item.settled()) return
        setPending(current => current.some(candidate => candidate.id === item.id)
          ? current
          : [...current, item])
      }

      const remove = (item: PendingInteraction): void => {
        setPending(current => current.filter(candidate => candidate.id !== item.id))
        setDrafts(current => {
          if (!Object.hasOwn(current, item.id)) return current
          const next = { ...current }
          delete next[item.id]
          return next
        })
        if (activeByKey.get(item.logicalKey) === item) activeByKey.delete(item.logicalKey)
        cardElementsRef.current.delete(item.id)
      }

      const createPending = <T extends InteractionValue>(options: {
        readonly id: string
        readonly logicalKey: string
        readonly kind: PendingInteraction['kind']
        readonly request: AskUserQuestionRequestEvent | ApprovalRequestEvent
        readonly next: RemoteEventNext<T>
        readonly signal: AbortSignal | undefined
        readonly sessionId?: ConversationSessionId | undefined
      }): { readonly item: PendingInteraction; readonly promise: Promise<T> } => {
        const result = deferred<T>()
        let isSettled = false
        const item = {
          id: options.id,
          logicalKey: options.logicalKey,
          kind: options.kind,
          request: options.request,
          signal: options.signal,
          ...(options.kind === 'question' ? { sessionId: options.sessionId, continued: false } : {}),
          callId: options.kind === 'question'
            ? (options.request as AskUserQuestionRequestEvent).wait?.callId
            : (options.request as ApprovalRequestEvent).callId,
          promise: result.promise as Promise<InteractionValue>,
          submitting: false,
          error: undefined,
          settled: () => isSettled,
          answer: (value: T): boolean => {
            if (isSettled || disposedRef.current || options.signal?.aborted
              || activeByKey.get(options.logicalKey) !== item) return false
            if ('deadline' in item && item.deadline !== undefined && item.deadline <= Date.now()) return false
            isSettled = true
            item.submitting = true
            item.error = undefined
            setPending(current => [...current])
            result.resolve(value)
            return true
          },
          timeout: (): void => {
            if (options.kind !== 'question') return
            const question = item as PendingQuestionInteraction
            if (isSettled || disposedRef.current
              || activeByKey.get(options.logicalKey) !== item) return
            isSettled = true
            question.continued = true
            question.deadline = undefined
            question.submitting = false
            question.error = undefined
            setPending(current => [...current])
            result.reject(timedOutQuestion())
          },
          answerContinued: async (value: AskUserQuestionAnswer): Promise<void> => {
            if (options.kind !== 'question') return
            const question = item as PendingQuestionInteraction
            if (question.continued !== true
              || question.sessionId === undefined || question.callId === undefined
              || item.submitting || disposedRef.current
              || activeByKey.get(options.logicalKey) !== item) return
            item.submitting = true
            item.error = undefined
            setPending(current => [...current])
            try {
              const response = await remote.userQuestions.answer(question.sessionId, question.callId, value)
              if (!response.ok) throw new Error(response.error.message)
              if (!response.value) throw new Error('这个问题已经不再等待回答')
              if (activeByKey.get(options.logicalKey) === item) remove(item)
            } catch (error: unknown) {
              if (activeByKey.get(options.logicalKey) === item) {
                item.submitting = false
                item.error = errorMessage(error)
                setPending(current => [...current])
              }
            }
          },
          delegate: (): void => {
            if (isSettled || options.signal?.aborted
              || activeByKey.get(options.logicalKey) !== item) return
            isSettled = true
            void Promise.resolve().then(options.next).then(result.resolve, result.reject)
          },
          onAbort: (): void => {
            if (isSettled) return
            isSettled = true
            result.reject(abortReason(options.signal))
            remove(item)
          },
          dispose: (): void => {
            options.signal?.removeEventListener('abort', item.onAbort)
          },
        } as PendingInteraction & {
          answer(value: T): boolean
          answerContinued(value: AskUserQuestionAnswer): Promise<void>
          timeout(): void
        }
        activeByKey.set(options.logicalKey, item)
        options.signal?.addEventListener('abort', item.onAbort, { once: true })
        if (options.signal?.aborted) item.onAbort()
        return { item, promise: result.promise }
      }

      const duplicate = (key: string): PendingInteraction | undefined => {
        const found = activeByKey.get(key)
        if (found === undefined) return undefined
        if (found.kind === 'question' && found.continued && !disposedRef.current) return found
        if (!found.settled() && !found.signal?.aborted) return found
        if (activeByKey.get(key) === found) activeByKey.delete(key)
        return undefined
      }

      const onQuestion = async function (
        this: unknown,
        request: AskUserQuestionRequestEvent,
        next: RemoteEventNext<AskUserQuestionAnswer>,
      ): Promise<AskUserQuestionAnswer> {
        sequenceRef.current += 1
        const id = `question-${String(sequenceRef.current)}`
        const logicalKey = questionLogicalKey(request, id)
        const prior = duplicate(logicalKey)
        if (prior !== undefined) {
          if (prior.kind === 'question' && prior.continued) return next()
          return prior.promise as Promise<AskUserQuestionAnswer>
        }

        const sessionId = sessionIdForOwner?.(this)

        const { item, promise } = createPending({
          id,
          logicalKey,
          kind: 'question',
          request,
          next,
          signal: request.signal,
          sessionId,
        })
        const question = item as PendingQuestionInteraction
        try {
          if (request.wait?.timed === true && request.wait.callId !== undefined) {
            if (sessionId !== undefined) {
              // Publish before the first claim frame arrives. The official UI
              // keeps the request visible while that business stream opens.
              add(question)
              const claimLifetime = new AbortController()
              const claimSignal = request.signal === undefined
                ? claimLifetime.signal
                : AbortSignal.any([claimLifetime.signal, request.signal])
              const claim = remote.userQuestions.attachWait(sessionId, request.wait.callId, claimSignal)
              let claimEnded: Promise<never> | undefined
              try {
                const iterator = claim[Symbol.asyncIterator]()
                const opening = await iterator.next()
                if (opening.done === true) return await next()
                question.deadline = Date.now() + opening.value.remainingMs
                setPending(current => [...current])
                if (request.signal?.aborted || question.settled()) return await promise
                claimEnded = (async () => {
                  await iterator.next()
                  throw new Error('The DSH foreground question wait ended')
                })()
                try {
                  return await Promise.race([promise, claimEnded])
                } catch (error: unknown) {
                  // The public DSH service turns this exact error code into a
                  // pending result, then the same question moves to the
                  // continued-answer Remote method.
                  if (question.continued) {
                    throw timedOutQuestion()
                  }
                  throw error
                }
              } finally {
                claimLifetime.abort()
                claim.dispose()
                if (claimEnded !== undefined) await Promise.allSettled([claimEnded])
              }
            }
          }
          add(question)
          return await promise
        } finally {
          question.dispose()
          if (!question.continued) remove(question)
        }
      }

      const onApproval = function (
        this: unknown,
        request: ApprovalRequestEvent,
        next: RemoteEventNext<ApprovalOutcome>,
      ): Promise<ApprovalOutcome> {
        sequenceRef.current += 1
        const id = `approval-${String(sequenceRef.current)}`
        const logicalKey = approvalLogicalKey(request, id)
        const prior = duplicate(logicalKey)
        if (prior !== undefined) return prior.promise as Promise<ApprovalOutcome>

        const { item, promise } = createPending({
          id,
          logicalKey,
          kind: 'approval',
          request,
          next,
          signal: request.signal,
        })
        add(item)
        return promise.finally(() => {
          item.dispose()
          remove(item)
        }) as Promise<ApprovalOutcome>
      }

      const stopQuestion = remote.$on('user-questions/request', onQuestion)
      const stopApproval = remote.$on('approval/request', onApproval)
      return () => {
        disposedRef.current = true
        stopQuestion()
        stopApproval()
        for (const item of activeByKey.values()) item.delegate()
        setPending([])
        activeByKey.clear()
      }
    }, [remote, sessionIdForOwner])

    function updateDraft(itemId: string, index: number, update: (draft: QuestionDraft) => QuestionDraft): void {
      setDrafts(current => {
        const items = [...(current[itemId] ?? [])]
        const before = items[index] ?? { selected: [], custom: '' }
        items[index] = update(before)
        return { ...current, [itemId]: items }
      })
    }

    function submitQuestion(event: FormEvent<HTMLFormElement>, item: PendingQuestionInteraction): void {
      event.preventDefault()
      const currentDrafts = drafts[item.id] ?? []
      const answer = questionAnswer(item.request, currentDrafts)
      if (item.continued) void item.answerContinued(answer)
      else item.answer(answer)
    }

    if (pending.length === 0) return null

    return (
      <section aria-label="DSH 待处理交互" className="dsh-interaction-list">
        {pending.map(item => (
          <article
            aria-label={item.kind === 'question' ? '待回答问题' : '待确认操作'}
            className="dsh-interaction"
            data-call-id={item.callId}
            id={`dsh-interaction-${item.id}`}
            key={item.id}
            ref={element => {
              if (element === null) cardElementsRef.current.delete(item.id)
              else cardElementsRef.current.set(item.id, element)
            }}
          >
            {item.kind === 'question' ? (
              <form onSubmit={event => submitQuestion(event, item)}>
            <header>
                  <strong>{item.continued
                    ? '问题仍待回答'
                    : item.request.questions.some(question => question.intent?.kind === 'plan-review')
                    ? '方案需要确认'
                    : '需要回答'}</strong>
                  {item.request.wait?.timed === true && !item.continued && item.deadline !== undefined && (
                    <span aria-live="polite" role="timer">
                      {Math.max(0, Math.ceil((item.deadline - now) / 1000))} 秒
                    </span>
                  )}
                </header>
                {item.request.questions.map((question, index) => {
                  const draft = drafts[item.id]?.[index] ?? { selected: [], custom: '' }
                  const inputName = `${item.id}-question-${String(index)}`
                  return (
                    <fieldset key={`${question.id}:${String(index)}`}>
                      <legend>{question.header ?? question.question}</legend>
                      {question.header !== undefined && <p>{question.question}</p>}
                      {question.detail !== undefined && <MarkdownText text={question.detail} labels={markdownLabels} />}
                      {(question.options ?? []).map(option => {
                        const checked = draft.selected.includes(option.label)
                        return (
                          <label key={option.label}>
                            <input
                              checked={checked}
                              name={inputName}
                              type={question.multiSelect === true ? 'checkbox' : 'radio'}
                              disabled={item.submitting || (item.signal?.aborted === true && !item.continued)}
                              onChange={() => updateDraft(item.id, index, current => {
                                if (question.multiSelect === true) {
                                  const selected = current.selected.includes(option.label)
                                    ? current.selected.filter(label => label !== option.label)
                                    : [...current.selected, option.label]
                                  return { ...current, selected }
                                }
                                return { selected: [option.label], custom: '' }
                              })}
                            />
                            <span>{option.label}</span>
                            {option.description !== undefined && <small>{option.description}</small>}
                          </label>
                        )
                      })}
                      <label>
                        <span>自定义回答</span>
                        <textarea
                          value={draft.custom}
                          disabled={item.submitting || (item.signal?.aborted === true && !item.continued)}
                          onChange={event => updateDraft(item.id, index, current => ({
                            selected: question.multiSelect === true || event.currentTarget.value.length === 0
                              ? current.selected
                              : [],
                            custom: event.currentTarget.value,
                          }))}
                        />
                      </label>
                    </fieldset>
                  )
                })}
                {item.error !== undefined && <p role="alert">{item.error}</p>}
                <button disabled={item.submitting || (item.signal?.aborted === true && !item.continued)} type="submit">
                  {item.submitting ? '正在提交…' : item.continued ? '发送回答' : '提交回答'}
                </button>
              </form>
            ) : (
              <div>
                <header><strong>操作需要确认</strong></header>
                <p>{item.request.toolName}</p>
                {displayReason(item.request) !== undefined && <p>{displayReason(item.request)}</p>}
                <button
                  disabled={item.submitting || item.signal?.aborted === true}
                  onClick={() => item.answer('allowed-once')}
                  type="button"
                >
                  允许一次
                </button>
                <button
                  disabled={item.submitting || item.signal?.aborted === true}
                  onClick={() => item.answer('rejected')}
                  type="button"
                >
                  拒绝
                </button>
              </div>
            )}
          </article>
        ))}
      </section>
    )
  },
)

export default DshInteraction
