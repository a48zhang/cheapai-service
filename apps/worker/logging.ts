/** Keep error details in the log message itself, independent of console serialization. */
export function logError(event: string, error: unknown, context: Record<string, unknown> = {}, level: 'error' | 'warn' = 'error'): void {
  const errors: unknown[] = [error];
  let current = error;
  while (current instanceof Error && current.cause !== undefined && !errors.includes(current.cause)) {
    current = current.cause;
    errors.push(current);
  }
  console[level]({
    ...context,
    event,
    errors: errors.map(value => value instanceof Error
      ? { name: value.name, message: value.message, stack: value.stack }
      : value),
  });
}
