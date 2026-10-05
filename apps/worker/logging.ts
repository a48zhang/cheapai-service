/** Pass native errors (including their causes) to Workers Logs with their stacks. */
export function logError(event: string, error: unknown, context: Record<string, unknown> = {}): void {
  const errors: unknown[] = [error];
  let current = error;
  while (current instanceof Error && current.cause !== undefined && !errors.includes(current.cause)) {
    current = current.cause;
    errors.push(current);
  }
  console.error(event, context, ...errors);
}
