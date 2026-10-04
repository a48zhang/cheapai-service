import { describe, expect, it } from 'vitest';
import { mergePageItems, nextPageCursor } from './pagination';

describe('cursor pages', () => {
  it('terminates empty cursors and repeated cursor cycles', () => {
    expect(nextPageCursor({ nextCursor: null }, [])).toBeUndefined();
    expect(nextPageCursor({ nextCursor: '' }, [])).toBeUndefined();
    expect(nextPageCursor({ nextCursor: 'a' }, [{ nextCursor: 'a' }])).toBe('a');
    expect(
      nextPageCursor({ nextCursor: 'a' }, [{ nextCursor: 'a' }, { nextCursor: 'a' }]),
    ).toBeUndefined();
    expect(
      nextPageCursor({ nextCursor: 'a' }, [
        { nextCursor: 'a' },
        { nextCursor: 'b' },
        { nextCursor: 'a' },
      ]),
    ).toBeUndefined();
  });

  it('lets an imperative pager report why a repeated cursor stopped', () => {
    const errors: Error[] = [];
    const next = nextPageCursor(
      { nextCursor: 'a' },
      [{ nextCursor: 'a' }, { nextCursor: 'b' }, { nextCursor: 'a' }],
      '请求',
      (error) => errors.push(error),
    );
    expect(next).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('请求返回了重复游标。');
  });

  it('keeps each resource once and protects newer versions across overlapping pages', () => {
    const pages = [
      {
        items: [
          { id: 'a', version: 3 },
          { id: 'b', version: 1 },
        ],
      },
      {
        items: [
          { id: 'a', version: 2 },
          { id: 'b', version: 4 },
        ],
      },
    ];
    expect(mergePageItems(pages, (next, current) => next.version - current.version)).toEqual([
      { id: 'a', version: 3 },
      { id: 'b', version: 4 },
    ]);
    expect(
      mergePageItems(
        [{ items: [{ publicModelId: 'm' }, { publicModelId: 'm' }] }],
        undefined,
        (model) => model.publicModelId,
      ),
    ).toHaveLength(1);
  });
});
