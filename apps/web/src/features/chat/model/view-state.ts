import type { RuntimeSessionSnapshot } from '../../../shared/api/runtime';
import type { ChatState } from './state';

export type HistoryView = 'preparing' | 'guest' | 'loading' | 'empty' | 'ready' | 'error';

/** A disabled query is neither a successful empty response nor a loading guest history. */
export function historyView(input: {
  sessionStatus: RuntimeSessionSnapshot['status'];
  hasData: boolean;
  hasItems: boolean;
  hasError: boolean;
}): HistoryView {
  if (input.sessionStatus === 'anonymous') return 'guest';
  if (input.sessionStatus !== 'authenticated') return 'preparing';
  if (input.hasItems) return 'ready';
  if (input.hasError) return 'error';
  return input.hasData ? 'empty' : 'loading';
}

export type ConversationView = 'welcome' | 'opening' | 'error' | 'active';

/** Visible content takes precedence over the status of a background detail request. */
export function conversationView(
  conversationId: string | null,
  state: ChatState,
  error: unknown,
): ConversationView {
  if (state.detail || state.submission || state.unsent.length) return 'active';
  if (conversationId) return error ? 'error' : 'opening';
  return 'welcome';
}
