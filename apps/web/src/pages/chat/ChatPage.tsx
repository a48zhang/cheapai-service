import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
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
  const draft = useDraft({
    identity: { status, userId: user?.id ?? null, expiredUserId: expiry?.userId ?? null },
    conversationId,
  });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const history = useHistory({ context });
  const chat = useChatController({
    context,
    conversationId,
    onConversationCreated: (createdId) =>
      navigate(`/chat/${encodeURIComponent(createdId)}`, { replace: true }),
    onDraftRestore: (content, owner) => {
      if (!draftRef.current.draft) draftRef.current.preservePending(content, owner);
    },
  });
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
    draft.setDraft('');
    void chat
      .send({
        content,
        groupId: selection.selection.groupId,
        modelId: selection.selection.modelId,
      })
      .then((result) => {
        if (result === 'busy' || result === 'superseded')
          draftRef.current.preservePending(content, userId);
      });
  };
  const newConversation = () => {
    chat.controller.resetConversation();
    navigate('/');
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
      : chat.state.phase === 'interrupted'
        ? '请先确认上一次操作的结果。'
        : authenticated && conversationId && (chat.loading || !detail)
          ? '正在读取会话…'
          : authenticated && selection.error
            ? '模型读取失败，请重试。'
            : authenticated && !selection.available
              ? (selection.unavailableReason ?? '暂无可用模型。')
              : undefined;
  return (
    <ChatLayout
      sidebar={(close, mobile) => (
        <ConversationSidebar
          conversations={history.conversations}
          activeId={conversationId}
          loading={authenticated && history.loading}
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
      <MessageList
        detail={detail}
        messages={detail?.messages ?? []}
        streamMessageId={chat.state.streamMessageId}
        streamText={chat.state.streamText}
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
        emptyMessage="有什么想聊的？"
      />
      <div className="px-4 pb-2">
        <ChatNotice
          state={chat.state}
          onRetry={() => {
            void chat.retry();
          }}
          onReload={() => {
            if (conversationId) void chat.reload();
            else void history.retry();
          }}
        />
      </div>
      <Composer
        value={draft.draft}
        onChange={draft.setDraft}
        onSend={send}
        onStop={() => {
          void chat.stop();
        }}
        modelPicker={
          authenticated ? <ModelPicker selection={selection} disabled={chat.busy} /> : null
        }
        sendLabel={authenticated ? '发送' : '登录后发送'}
        busy={chat.busy}
        disabled={Boolean(disabledReason)}
        {...(disabledReason ? { disabledReason } : {})}
      />
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
