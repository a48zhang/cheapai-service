import { describe, expect, inject, it } from 'vitest';
import { acceptRegenerate, acceptSend, attachRequest, checkpoint, finalize, getConversationWithMessages, readContext, selectMessageVersion, TERMINAL_REQUEST_SETTLE_GRACE_MS } from '../../apps/worker/chat/messages';
import { createConversation, deleteConversation } from '../../apps/worker/chat/repository';
import { resetTestDatabase, testEnv } from '../helpers/database';

const clock = 1_000;

async function seed() {
  await testEnv.DB.prepare(`INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES
    ('chat-test-group','Chat test group','active',1,0,0)`).run();
  await testEnv.DB.prepare(`INSERT INTO models(public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at)
    VALUES('chat-test-model','active','{"input":"1","output":"2"}',1,0,64,0,0)`).run();
  await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at,version)
    VALUES('chat-test-user','chat-test@example.invalid','hash','user','active','chat-test-group',100,2,60,'bootstrap',0,0,1),
      ('chat-other-user','chat-other@example.invalid','hash','user','active','chat-test-group',100,2,60,'bootstrap',0,0,1)`).run();
  const requestColumns = (await testEnv.DB.prepare("PRAGMA table_info(requests)").all<{ name: string }>()).results.map(row => row.name);
  if (!requestColumns.includes('group_id')) await testEnv.DB.prepare("ALTER TABLE requests ADD COLUMN group_id TEXT").run();
  if (!requestColumns.includes('source')) await testEnv.DB.prepare("ALTER TABLE requests ADD COLUMN source TEXT NOT NULL DEFAULT 'api'").run();
}

describe('0022 web chat storage state machine', () => {
  it('creates, idempotently accepts, checkpoints, finalizes and selects versions', async () => {
    await seed();
    const conversation = await createConversation(testEnv.DB, 'chat-test-user', { now: clock });
    const first = await acceptSend(testEnv.DB, { userId: 'chat-test-user', conversationId: conversation.id,
      operationId: 'chat-op-1', conversationVersion: conversation.version, groupId: 'chat-test-group', modelId: 'chat-test-model', content: 'hello', now: clock,
      userMessageId: 'chat-user-message-1', assistantMessageId: 'chat-assistant-message-1' });
    expect(first.replayed).toBe(false);
    expect(first.conversation.version).toBe(2);
    expect(first.userMessage?.turnIndex).toBe(1);
    expect(first.assistantMessage.status).toBe('generating');
    await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
      VALUES('chat-test-channel','Chat test channel','https://fixture.invalid','{"algorithm":"A256GCM","format_version":1,"key_version":"v1","nonce":"n","ciphertext":"c"}','v1','disabled',1,1,1,1,0,0)`).run();
    await testEnv.DB.prepare(`INSERT INTO api_keys(id,user_id,kind,key_hash,display_prefix,name,status,expires_at,allowed_models_json,created_at,updated_at,version,creation_operation_id,creation_fingerprint,group_id)
      VALUES('chat-test-key','chat-test-user','web_chat',NULL,NULL,'Web chat','active',NULL,NULL,0,0,1,NULL,NULL,NULL)`).run();
    await testEnv.DB.prepare(`INSERT INTO requests(id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,group_id,source,created_at,updated_at)
      VALUES('chat-test-request','chat-test-user','chat-test-key','chat-test-channel','chat-test-model','upstream','chat','chat','{}','chat-test-group','web_chat',0,0)`).run();
    await expect(attachRequest(testEnv.DB, { userId: 'chat-test-user', messageId: first.assistantMessage.id, requestId: 'chat-test-request', now: clock + 1 })).resolves.toMatchObject({ requestId: 'chat-test-request' });

    const replay = await acceptSend(testEnv.DB, { userId: 'chat-test-user', conversationId: conversation.id,
      operationId: 'chat-op-1', conversationVersion: 1, groupId: 'chat-test-group', modelId: 'chat-test-model', content: 'hello', now: clock });
    expect(replay.replayed).toBe(true);
    expect(replay.assistantMessage.id).toBe(first.assistantMessage.id);

    await checkpoint(testEnv.DB, { userId: 'chat-test-user', messageId: first.assistantMessage.id, content: 'hel', now: clock + 1 });
    await testEnv.DB.prepare("UPDATE requests SET execution_status='succeeded',finished_at=?,updated_at=? WHERE id=?")
      .bind(clock + 2, clock + 2, 'chat-test-request').run();
    // A GET immediately after request termination must leave the row generating
    // so the stream bridge can persist its final buffered answer.
    const duringTail = await getConversationWithMessages(testEnv.DB, 'chat-test-user', conversation.id, clock + 3);
    expect(duringTail?.messages.find(message => message.id === first.assistantMessage.id)).toMatchObject({ status: 'generating', content: 'hel' });
    const completed = await finalize(testEnv.DB, { userId: 'chat-test-user', messageId: first.assistantMessage.id, content: 'hello there', status: 'completed', now: clock + 2 });
    expect(completed.status).toBe('completed');
    expect(completed.content).toBe('hello there');
    const afterTail = await getConversationWithMessages(testEnv.DB, 'chat-test-user', conversation.id, clock + 2 + TERMINAL_REQUEST_SETTLE_GRACE_MS + 1);
    expect(afterTail?.messages.find(message => message.id === first.assistantMessage.id)).toMatchObject({ status: 'completed', content: 'hello there' });

    const regenerated = await acceptRegenerate(testEnv.DB, { userId: 'chat-test-user', conversationId: conversation.id,
      operationId: 'chat-op-2', conversationVersion: 2, groupId: 'chat-test-group', modelId: 'chat-test-model', now: clock + 3,
      assistantMessageId: 'chat-assistant-message-2' });
    expect(regenerated.assistantMessage.variant).toBe(2);
    expect(regenerated.assistantMessage.selected).toBe(false);
    await finalize(testEnv.DB, { userId: 'chat-test-user', messageId: regenerated.assistantMessage.id, content: 'new answer', status: 'completed', now: clock + 4 });

    const selected = await selectMessageVersion(testEnv.DB, { userId: 'chat-test-user', conversationId: conversation.id,
      messageId: first.assistantMessage.id, conversationVersion: 3, now: clock + 5 });
    expect(selected.conversation.version).toBe(4);
    const context = await readContext(testEnv.DB, 'chat-test-user', conversation.id);
    expect(context.map(message => message.content)).toEqual(['hello', 'hello there']);
  });

  it('protects ownership, the one-generation lock, and late writes after deletion', async () => {
    await seed();
    const conversation = await createConversation(testEnv.DB, 'chat-test-user', { now: clock });
    const started = await acceptSend(testEnv.DB, { userId: 'chat-test-user', conversationId: conversation.id,
      operationId: 'chat-op-lock', conversationVersion: 1, groupId: 'chat-test-group', modelId: 'chat-test-model', content: 'pending', now: clock });
    await expect(acceptSend(testEnv.DB, { userId: 'chat-test-user', conversationId: conversation.id,
      operationId: 'chat-op-other', conversationVersion: 1, groupId: 'chat-test-group', modelId: 'chat-test-model', content: 'duplicate', now: clock })).rejects.toMatchObject({ code: 'conflict' });
    await expect(deleteConversation(testEnv.DB, 'chat-other-user', conversation.id, 1)).rejects.toMatchObject({ code: 'not_found' });
    await expect(deleteConversation(testEnv.DB, 'chat-test-user', conversation.id, 2)).rejects.toMatchObject({ code: 'conflict' });
    await finalize(testEnv.DB, { userId: 'chat-test-user', messageId: started.assistantMessage.id, content: '', status: 'failed', now: clock + 1 });
    const afterFailure = await testEnv.DB.prepare('SELECT id,user_id,version,(SELECT count(*) FROM chat_messages WHERE conversation_id=? AND status=\'generating\') AS generating,NOT EXISTS (SELECT 1 FROM chat_messages WHERE conversation_id=? AND role=\'assistant\' AND status=\'generating\') AS clear FROM chat_conversations WHERE id=?').bind(conversation.id, conversation.id, conversation.id).first<{ id: string; user_id: string; version: number; generating: number; clear: number }>();
    expect(afterFailure).toMatchObject({ version: 2, generating: 0, clear: 1 });
    await expect(deleteConversation(testEnv.DB, 'chat-test-user', conversation.id, 2)).resolves.toBe(true);
    await expect(checkpoint(testEnv.DB, { userId: 'chat-test-user', messageId: started.assistantMessage.id, content: 'late', now: clock + 2 }))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(await getConversationWithMessages(testEnv.DB, 'chat-test-user', conversation.id)).toBeNull();

    const orphanConversation = await createConversation(testEnv.DB, 'chat-test-user', { now: clock });
    const orphan = await acceptSend(testEnv.DB, { userId: 'chat-test-user', conversationId: orphanConversation.id,
      operationId: 'chat-orphan', conversationVersion: 1, groupId: 'chat-test-group', modelId: 'chat-test-model', content: 'orphan', now: clock });
    const recovered = await getConversationWithMessages(testEnv.DB, 'chat-test-user', orphanConversation.id, clock + 5 * 60 * 1000 + 1);
    expect(recovered?.messages.find(message => message.id === orphan.assistantMessage.id)?.status).toBe('failed');
  });

  it('keeps the two-table schema and rejects malformed state through the database constraints', async () => {
    await seed();
    const tables = await testEnv.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'chat_%' ORDER BY name").all<{ name: string }>();
    expect(tables.results.map(row => row.name)).toEqual(['chat_conversations', 'chat_messages']);
    await testEnv.DB.prepare(`INSERT INTO chat_conversations(id,user_id,title,version,created_at,updated_at)
      VALUES('bad-chat','chat-test-user','',1,0,0)`).run();
    await testEnv.DB.prepare(`INSERT INTO chat_messages(id,conversation_id,turn_index,role,content,status,variant,selected,created_at,updated_at)
      VALUES('bad-message','bad-chat',1,'assistant','x','generating',1,1,0,0)`).run();
    await expect(testEnv.DB.prepare(`INSERT INTO chat_messages(id,conversation_id,turn_index,role,content,status,variant,selected,created_at,updated_at)
      VALUES('bad-message-2','bad-chat',2,'assistant','x','generating',1,1,0,0)`).run()).rejects.toThrow();
    await testEnv.DB.prepare('DELETE FROM chat_conversations WHERE id=?').bind('bad-chat').run();
  });
});
