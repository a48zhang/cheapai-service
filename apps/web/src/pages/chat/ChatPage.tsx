import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { Conversation } from '@cheapai/contracts/chat';
import { useSession } from '../../features/session/useSession';
import { useDraft } from '../../features/chat/hooks/useDraft';
import { useHistory } from '../../features/chat/hooks/useHistory';
import { useModelSelection } from '../../features/chat/hooks/useModelSelection';
import { useChatController } from '../../features/chat/hooks/useChatController';
import { isChatBusy } from '../../features/chat/model/state';
import { ConversationSidebar } from '../../features/chat/components/ConversationSidebar';
import { ModelPicker } from '../../features/chat/components/ModelPicker';
import { MessageList } from '../../features/chat/components/MessageList';
import { Composer } from '../../features/chat/components/Composer';
import { ChatNotice } from '../../features/chat/components/ChatNotice';
import { ChatLayout } from '../../features/chat/components/ChatLayout';
import { Button } from '../../shared/ui/Button';
import { Dialog } from '../../shared/ui/Dialog';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';

export default function ChatPage() {
  const { id } = useParams();
  const conversationId = id ?? null;
  const navigate = useNavigate();
  const location = useLocation();
  const { status, user, epoch, expiry, session, client } = useSession();
  const authenticated = status === 'authenticated';
  const userId = authenticated ? (user?.id ?? '') : '';
  const context = useMemo(
    () => ({
      client,
      userId,
      epoch,
      captureIdentity: session.requestIdentity,
      onUnauthorized: (identity: { userId: string; epoch: number }) => session.expire(identity),
    }),
    [client, userId, epoch, session],
  );
  const draftRef = useRef<ReturnType<typeof useDraft> | null>(null);
  const history = useHistory({ context, sessionStatus: status });
  const chat = useChatController({
    context,
    conversationId,
    onConversationCreated: (createdId) =>
      navigate(`/chat/${encodeURIComponent(createdId)}`, { replace: true }),
    onDraftRestore: (content, owner) => {
      if (draftRef.current && !draftRef.current.draft)
        draftRef.current.preservePending(content, owner);
    },
  });
  const draft = useDraft({
    identity: { status, userId: user?.id ?? null, expiredUserId: expiry?.userId ?? null },
    conversationId: chat.draftConversationId,
    continuingNewConversation: chat.continuingNewConversation,
  });
  draftRef.current = draft;
  const detail = chat.state.detail;
  const selection = useModelSelection({
    context,
    conversationId,
    ...(detail
      ? {
          conversationSelection: {
            groupId: detail.conversation.groupId,
            modelId: detail.conversation.modelId,
          },
        }
      : {}),
  });
  const [action, setAction] = useState<{
    kind: 'delete';
    conversation: Conversation;
  } | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const actionLock = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const returnTo = encodeURIComponent(location.pathname + location.search);
    if (status === 'anonymous' && (expiry || conversationId))
      navigate(`/login?returnTo=${returnTo}`, { replace: true });
    if (status === 'unavailable')
      navigate(`/session-unavailable?returnTo=${returnTo}`, { replace: true });
  }, [status, expiry, conversationId, location.pathname, location.search, navigate]);
  useEffect(() => {
    setAction(null);
    setActionError(null);
  }, [userId, epoch]);

  const send = (content: string) => {
    if (!authenticated) {
      navigate(`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }
    const current = chat.controller.getSnapshot();
    if (
      isChatBusy(current.phase) ||
      current.phase === 'interrupted' ||
      !selection.available ||
      !selection.selection?.groupId ||
      !selection.selection.modelId
    )
      return;
    void chat.send(
      {
        content,
        groupId: selection.selection.groupId,
        modelId: selection.selection.modelId,
      },
      () => draft.setDraft(''),
    );
  };
  const newConversation = () => {
    chat.controller.resetConversation();
    navigate('/chat');
  };
  const submitAction = async () => {
    if (!action || actionLock.current) return;
    actionLock.current = true;
    setActionBusy(true);
    setActionError(null);
    try {
      await history.deleteConversation(action.conversation);
      if (conversationId === action.conversation.id) newConversation();
      setAction(null);
    } catch (error) {
      setActionError(error);
    } finally {
      actionLock.current = false;
      setActionBusy(false);
    }
  };
  const disabledReason =
    status === 'unknown'
      ? '正在确认身份…'
      : authenticated && chat.view === 'opening'
        ? '正在读取会话…'
        : authenticated && chat.view === 'error'
          ? '会话读取失败，请重试。'
          : undefined;
  const newChat = chat.view === 'welcome';
  return (
    <ChatLayout
      onNew={newConversation}
      sidebar={(close, mobile) => (
        <ConversationSidebar
          conversations={history.conversations}
          activeId={conversationId}
          view={history.view}
          loadingMore={history.loadingMore}
          hasMore={history.hasMore}
          mobileOpen={mobile}
          error={authenticated ? history.errorMessage : null}
          onNew={() => {
            newConversation();
            close();
          }}
          onSelect={(conversation) => {
            navigate(`/chat/${encodeURIComponent(conversation.id)}`);
            close();
          }}
          onRename={(conversation, title) =>
            history.renameConversation(conversation, title).then(() => undefined)
          }
          onDelete={(conversation) => {
            setAction({ kind: 'delete', conversation });
            setActionError(null);
          }}
          onLoadMore={() => {
            void history.loadMore();
          }}
          onRetry={() => {
            void history.retry();
          }}
          onClose={close}
        />
      )}
    >
      <div className={`chat-stage${newChat ? ' is-new' : ''}`}>
        {chat.error && authenticated && (
          <div className="p-4">
            <ApiErrorNotice
              error={chat.error}
              onRetry={() => {
                if (conversationId) void chat.reload();
                else void history.retry();
              }}
            />
          </div>
        )}
        {newChat && (
          <div className="chat-welcome">
            <h1>有什么想聊的？</h1>
          </div>
        )}
        <MessageList
          className="chat-timeline"
          detail={detail}
          messages={detail?.messages ?? []}
          streamMessageId={chat.state.streamMessageId}
          streamText={chat.state.streamText}
          submission={chat.state.submission}
          phase={chat.state.phase}
          unsent={chat.state.unsent}
          onRetrySubmission={(submission) => {
            if (selection.available && selection.selection?.groupId && selection.selection.modelId)
              void chat.send({
                content: submission.content,
                groupId: selection.selection.groupId,
                modelId: selection.selection.modelId,
                retrySubmissionId: submission.operationId,
              });
          }}
          retryDisabled={
            chat.busy ||
            chat.state.phase === 'interrupted' ||
            chat.state.failure?.code === 'conversation_creation_unknown' ||
            !selection.available
          }
          busy={chat.busy}
          loading={authenticated && chat.loading}
          {...(!selection.available && selection.unavailableReason
            ? { regenerateDisabledReason: selection.unavailableReason }
            : {})}
          onSelectVersion={(messageId) => {
            void chat.controller.selectVersion(messageId);
          }}
          onRegenerate={() => {
            if (selection.selection?.groupId && selection.selection.modelId && selection.available)
              void chat.controller.regenerate({
                groupId: selection.selection.groupId,
                modelId: selection.selection.modelId,
              });
          }}
          emptyMessage={chat.view === 'error' ? null : '在下方输入消息，继续这段对话。'}
        />
        {chat.state.failure && (
          <div className="chat-notice-area">
            <ChatNotice
              state={chat.state}
              onRestart={() => chat.controller.resetConversation(true)}
              onRetry={() => {
                void chat.retry();
              }}
              onReload={() => {
                if (conversationId) void chat.reload();
                else void history.retry();
              }}
            />
          </div>
        )}
        <Composer
          textareaRef={composerRef}
          value={draft.draft}
          onChange={draft.setDraft}
          onSend={send}
          onStop={() => {
            void chat.stop();
          }}
          modelPicker={
            authenticated ? (
              <ModelPicker selection={selection} disabled={chat.busy} />
            ) : (
              <Link
                className="rounded-md px-2 py-1 text-sm font-medium text-[var(--color-foreground)] underline underline-offset-4"
                to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`}
              >
                登录后发送
              </Link>
            )
          }
          sendLabel={authenticated ? '发送' : '登录后发送'}
          busy={chat.busy}
          stopping={chat.state.phase === 'stopping' || chat.state.phase === 'finalizing'}
          disabled={
            Boolean(disabledReason) ||
            chat.state.phase === 'interrupted' ||
            chat.state.failure?.code === 'conversation_creation_unknown' ||
            (authenticated && (Boolean(selection.error) || !selection.available))
          }
          {...(disabledReason ? { disabledReason } : {})}
        />
      </div>
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !actionBusy) setAction(null);
        }}
        title="删除对话"
        description="删除后无法恢复此对话及其消息。"
        footer={
          <>
            <Button variant="outline" disabled={actionBusy} onClick={() => setAction(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              busy={actionBusy}
              onClick={() => {
                void submitAction();
              }}
            >
              确认
            </Button>
          </>
        }
      >
        {actionError != null && <ApiErrorNotice error={actionError} />}
      </Dialog>
    </ChatLayout>
  );
}
