import {
  initialChatState,
  isChatBusy,
  mergeMetaDetail,
  operationMatches,
  upsertChatMessage,
} from './state';
import type { ChatEvent, ChatFailure, ChatState } from './state';

export function chatReducer(state: ChatState = initialChatState, event: ChatEvent): ChatState {
  if (event.type === 'reset') return initialChatState;
  if (event.type === 'hydrate') {
    return { ...initialChatState, detail: event.detail };
  }

  if (event.type === 'begin') {
    if (isChatBusy(state.phase)) return state;
    if (
      state.phase === 'interrupted' &&
      (state.operationId !== event.operationId || state.operationKind !== event.operationKind)
    )
      return state;
    return {
      ...state,
      phase: event.needsConversation ? 'creating' : 'submitting',
      operationId: event.operationId,
      operationKind: event.operationKind,
      streamMessageId: null,
      streamText: '',
      billingStatus: null,
      failure: null,
    };
  }

  if (!operationMatches(state, event.operationId)) return state;

  switch (event.type) {
    case 'conversation-created':
      if (state.phase !== 'creating') return state;
      return {
        ...state,
        phase: 'submitting',
        detail: { conversation: event.conversation, messages: [] },
      };
    case 'submitting':
      if (state.phase === 'stopping' || state.phase === 'finalizing') return state;
      return { ...state, phase: 'submitting' };
    case 'meta':
      if (state.phase === 'stopping' || state.phase === 'finalizing') return state;
      return {
        ...state,
        phase: 'streaming',
        detail: mergeMetaDetail(state.detail, event.value),
        streamMessageId: event.value.assistantMessage.id,
        streamText: '',
      };
    case 'delta':
      if (state.phase === 'stopping' || state.phase === 'finalizing') return state;
      return { ...state, phase: 'streaming', streamText: state.streamText + event.text };
    case 'done': {
      const detail = state.detail;
      if (!detail)
        return {
          ...state,
          phase: 'finalizing',
          streamText: event.value.message.content,
          streamMessageId: event.value.message.id,
          billingStatus: event.value.billingStatus ?? null,
        };
      return {
        ...state,
        phase: 'finalizing',
        detail: {
          ...detail,
          messages: [...upsertChatMessage(detail.messages, event.value.message)],
        },
        streamMessageId: event.value.message.id,
        streamText: event.value.message.content,
        billingStatus: event.value.billingStatus ?? null,
      };
    }
    case 'stop-requested':
      if (
        state.phase === 'creating' ||
        state.phase === 'submitting' ||
        state.phase === 'streaming'
      ) {
        return { ...state, phase: 'stopping' };
      }
      return state;
    case 'finalizing':
      return { ...state, phase: 'finalizing' };
    case 'settled': {
      const failed = event.outcome === 'failed';
      const failure = failed
        ? (event.failure ??
          state.failure ??
          ({ kind: 'failed', message: '请求未能完成。' } satisfies ChatFailure))
        : null;
      return {
        ...state,
        phase: failed ? 'failed' : 'idle',
        detail: event.detail,
        operationId: null,
        operationKind: null,
        streamMessageId: null,
        streamText: '',
        billingStatus: null,
        failure,
      };
    }
    case 'failed':
      return {
        ...state,
        phase: 'failed',
        operationId: null,
        operationKind: null,
        streamMessageId: null,
        streamText: '',
        failure: event.failure,
      };
    case 'interrupted':
      return {
        ...state,
        phase: 'interrupted',
        failure: event.failure,
      };
  }
}
