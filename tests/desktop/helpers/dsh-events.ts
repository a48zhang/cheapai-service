import type {
  SessionEventLikeEntry,
  SessionJournalChange,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionHistoryRecord } from '@deepseek-ai/dsh-api-session-controller/types'

type DurableEntry = Extract<SessionEventLikeEntry, { readonly type: 'event' }>
type UserMessageEvent = Extract<DurableEntry['event'], { readonly type: 'user/message' }>

/** A real pinned Session journal user/message event, including its DSH brands. */
export function userMessageEntry(sequence: number, text: string): DurableEntry {
  const data: UserMessageEvent['data'] = {
    id: `fixture-message-${String(sequence)}` as UserMessageEvent['data']['id'],
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
  const event = {
    type: 'user/message',
    seq: sequence as UserMessageEvent['seq'],
    time: sequence * 1_000,
    data,
  } satisfies UserMessageEvent
  return { type: 'event', event }
}

/** Match SessionJournalChange.page.records' JSON wire shape from DSH's fixed stream. */
function historyRecords(entries: readonly SessionEventLikeEntry[]): readonly SessionHistoryRecord[] {
  return entries.flatMap(entry => {
    if (entry.type !== 'event') return []
    const serialized = JSON.stringify(entry)
    if (serialized === undefined) throw new TypeError('A DSH journal fixture must be JSON serializable')
    const record = JSON.parse(serialized) as SessionHistoryRecord
    return [record]
  })
}

export function replaceJournalChange(
  entries: readonly SessionEventLikeEntry[],
  hasMore = false,
): SessionJournalChange {
  return {
    type: 'replace',
    page: { records: historyRecords(entries), hasMore },
    entries,
    hasMore,
  }
}

export function prependJournalChange(
  entries: readonly SessionEventLikeEntry[],
  hasMore: boolean,
): SessionJournalChange {
  return {
    type: 'prepend',
    page: { records: historyRecords(entries), hasMore },
    entries,
    hasMore,
  }
}

export function appendJournalChange(entry: DurableEntry): SessionJournalChange {
  return { type: 'append', entry }
}
