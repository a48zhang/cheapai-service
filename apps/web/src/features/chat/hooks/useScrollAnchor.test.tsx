import { describe, expect, it } from 'vitest';
import { act, renderHook } from '../../../test/render';
import { useScrollAnchor } from './useScrollAnchor';

describe('scrolling follows user intent', () => {
  it('reveals a newly submitted turn, then respects scrolling up during the same run', () => {
    const hook = renderHook(
      ({ followKey, contentVersion }) =>
        useScrollAnchor({ messageIds: ['old-question', 'old-answer'], followKey, contentVersion }),
      { initialProps: { followKey: null as string | null, contentVersion: 'initial' } },
    );
    const container = document.createElement('div');
    Object.defineProperties(container, {
      scrollHeight: { value: 2000 },
      clientHeight: { value: 400 },
    });
    hook.result.current.containerRef.current = container;
    container.scrollTop = 300;
    act(() => hook.result.current.onScroll());
    hook.rerender({ followKey: 'send-1', contentVersion: 'submitted' });
    expect(container.scrollTop).toBe(2000);
    expect(hook.result.current.showJumpToLatest).toBe(false);

    container.scrollTop = 300;
    act(() => hook.result.current.onScroll());
    hook.rerender({ followKey: 'send-1', contentVersion: 'new-token' });
    expect(container.scrollTop).toBe(300);
    expect(hook.result.current.showJumpToLatest).toBe(true);
  });
});
