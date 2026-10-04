import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type { Conversation } from '@cheapai/contracts/chat';
import { Sparkles } from 'lucide-react';
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
import { Input } from '../../shared/ui/Input';
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
  const ceiling = selection.selectedModel?.maxOutputTokens;
  const outputScope = `${userId}:${conversationId ?? ''}:${selection.selectedModel?.publicModelId ?? ''}:${ceiling ?? ''}`;
  const [output, setOutput] = useState({ scope: '', value: '' });
  const outputValue =
    output.scope === outputScope ? output.value : ceiling === undefined ? '' : String(ceiling);
  const [action, setAction] = useState<{
    kind: 'rename' | 'delete';
    conversation: Conversation;
  } | null>(null);
  const [title, setTitle] = useState('');
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

  const send = (content: string, maxOutputTokens?: number) => {
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
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
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
    if (!action || actionLock.current || (action.kind === 'rename' && !title.trim())) return;
    actionLock.current = true;
    setActionBusy(true);
    setActionError(null);
    try {
      if (action.kind === 'rename')
        await history.renameConversation(action.conversation, title.trim());
      else {
        await history.deleteConversation(action.conversation);
        if (conversationId === action.conversation.id) newConversation();
      }
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
      controls={
        authenticated ? (
          <ModelPicker selection={selection} disabled={chat.busy} />
        ) : (
          <span className="text-sm text-[var(--color-muted-foreground)]">新的对话</span>
        )
      }
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
          onRename={(conversation) => {
            setAction({ kind: 'rename', conversation });
            setTitle(conversation.title);
            setActionError(null);
          }}
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
              ...(outputValue ? { maxOutputTokens: Number(outputValue) } : {}),
            });
        }}
        emptyMessage={
          <div className="mx-auto flex max-w-xl flex-col items-center px-2 py-6 text-center sm:px-6 sm:py-16">
            <span className="mb-4 grid size-12 place-items-center rounded-2xl bg-indigo-50 text-indigo-600">
              <Sparkles size={26} />
            </span>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">今天想做些什么？</h1>
            <p className="mt-3 text-sm leading-6 text-[var(--color-muted-foreground)]">
              在一个工作台使用你需要的模型，开始新的想法。
            </p>
            <div className="mt-6 grid w-full gap-2 sm:grid-cols-2">
              {[
                '帮我整理一个清晰的开发计划',
                '解释这段代码的工作原理',
                '为我的想法写一份提纲',
                '帮我分析一个复杂问题',
              ].map((prompt) => (
                <Button
                  key={prompt}
                  variant="outline"
                  className="h-auto whitespace-normal p-3 text-left text-sm"
                  onClick={() => draft.setDraft(prompt)}
                >
                  {prompt}
                </Button>
              ))}
            </div>
            {!authenticated && (
              <p className="mt-6 text-xs text-[var(--color-muted-foreground)]">
                登录后开始对话，输入内容会为你保留。
              </p>
            )}
          </div>
        }
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
        busy={chat.busy}
        disabled={Boolean(disabledReason)}
        {...(disabledReason ? { disabledReason } : {})}
        maxOutputTokens={outputValue}
        {...(ceiling === undefined ? {} : { maxOutputTokensCeiling: ceiling })}
        onMaxOutputTokensChange={(value) => setOutput({ scope: outputScope, value })}
      />
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !actionBusy) setAction(null);
        }}
        title={action?.kind === 'rename' ? '重命名对话' : '删除对话'}
        description={
          action?.kind === 'delete'
            ? '删除后无法恢复此对话及其消息。'
            : '为这段对话设置一个便于查找的名称。'
        }
        footer={
          <>
            <Button variant="outline" disabled={actionBusy} onClick={() => setAction(null)}>
              取消
            </Button>
            <Button
              variant={action?.kind === 'delete' ? 'danger' : 'primary'}
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
        {action?.kind === 'rename' && (
          <label className="grid gap-2 text-sm">
            对话名称
            <Input
              value={title}
              maxLength={512}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
        )}
        {actionError != null && <ApiErrorNotice error={actionError} />}
      </Dialog>
    </ChatLayout>
  );
}
