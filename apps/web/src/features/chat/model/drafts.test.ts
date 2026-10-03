import { describe, expect, it } from 'vitest';
import { createChatDraftStore } from './drafts';
import { act, renderHook } from '@testing-library/react';
import { useDraft, type DraftIdentity } from '../hooks/useDraft';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } as Storage;
}
describe('chat draft ownership', () => {
  it('recovers the expired owner in the hook, hides content on account change, and clears logout', () => {
    const saved = storage();
    const { result, rerender } = renderHook(({ identity }: { identity: DraftIdentity }) => useDraft({ identity, conversationId: null, storage: saved }), { initialProps: { identity: { status: 'authenticated', userId: 'one' } as DraftIdentity } });
    act(() => result.current.setDraft('private A'));
    expect(createChatDraftStore(saved).read({ userId: 'one', conversationId: null })).toBe('private A');
    rerender({ identity: { status: 'anonymous', userId: null, expiredUserId: 'one' } });
    rerender({ identity: { status: 'authenticated', userId: 'one' } });
    expect(result.current.draft).toBe('private A');
    rerender({ identity: { status: 'authenticated', userId: 'two' } });
    expect(result.current.draft).toBe('');
    act(() => result.current.preservePending('old operation A', 'one'));
    expect(result.current.draft).toBe('');
    act(() => result.current.setDraft('private B'));
    rerender({ identity: { status: 'anonymous', userId: null } });
    expect(createChatDraftStore(saved).read({ userId: 'two', conversationId: null })).toBeNull();
  });
  it('saves exact content immediately and isolates users and conversations', () => {
    const store = createChatDraftStore(storage()); const owner = { userId: 'one', conversationId: 'chat-a' };
    store.write(owner, '  unsent\ntext  '); expect(store.read(owner)).toBe('  unsent\ntext  ');
    expect(store.read({ ...owner, userId: 'two' })).toBeNull(); expect(store.read({ ...owner, conversationId: 'chat-b' })).toBeNull();
    // Expiry does not erase the owner's persisted draft. Explicit logout removes it.
    expect(store.read(owner)).toBe('  unsent\ntext  '); store.remove(owner); expect(store.read(owner)).toBeNull();
  });
  it('claims anonymous content once without overwriting an existing owner draft', () => {
    const store = createChatDraftStore(storage()); const anonymous = { userId: null, conversationId: null };
    store.write(anonymous, 'anonymous'); expect(store.claimAnonymous('one', null)).toBe('anonymous'); expect(store.read(anonymous)).toBeNull();
    expect(store.read({ userId: 'two', conversationId: null })).toBeNull();
    store.write(anonymous, 'new'); expect(store.claimAnonymous('one', null)).toBe('anonymous');
  });
  it('handles denied storage without blocking editing', () => {
    const store = createChatDraftStore({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } } as unknown as Storage);
    const owner = { userId: 'one', conversationId: null };
    expect(store.write(owner, 'still composing')).toBe(false); expect(store.read(owner)).toBeNull(); expect(() => store.remove(owner)).not.toThrow();
  });
});
