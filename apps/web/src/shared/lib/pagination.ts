export interface CursorPage {
  readonly nextCursor: string | null;
}

/**
 * Returns a non-empty next cursor, ending pagination on a repeated cursor.
 * The optional handler lets imperative pagers surface a useful error while
 * query frameworks can treat the repeated cursor as the end of the result.
 */
export function nextPageCursor(
  last: CursorPage,
  pages: readonly CursorPage[],
  description = '分页',
  onRepeated?: (error: Error) => void,
): string | undefined {
  const cursor = last.nextCursor;
  if (cursor === null || cursor.length === 0) return undefined;

  if (pages.slice(0, -1).some((page) => page.nextCursor === cursor)) {
    onRepeated?.(new Error(`${description}返回了重复游标。`));
    return undefined;
  }

  return cursor;
}

/**
 * Merges pages by item ID. Later pages win by default. When a comparator is
 * supplied, a positive result means the candidate should replace the current
 * item, which lets versioned resources keep their newest value.
 */
export function mergePageItems<T extends { id: string }>(
  pages: readonly { readonly items: readonly T[] }[] | undefined,
  compare?: (candidate: T, current: T) => number,
): T[];
export function mergePageItems<T>(
  pages: readonly { readonly items: readonly T[] }[] | undefined,
  compare: ((candidate: T, current: T) => number) | undefined,
  getId: (item: T) => string,
): T[];
export function mergePageItems<T>(
  pages: readonly { readonly items: readonly T[] }[] | undefined,
  compare?: (candidate: T, current: T) => number,
  getId: (item: T) => string = (item) => (item as { id: string }).id,
): T[] {
  const itemsById = new Map<string, T>();

  for (const page of pages ?? []) {
    for (const candidate of page.items) {
      const id = getId(candidate);
      const current = itemsById.get(id);
      if (current === undefined || compare === undefined || compare(candidate, current) > 0) {
        itemsById.set(id, candidate);
      }
    }
  }

  return [...itemsById.values()];
}
