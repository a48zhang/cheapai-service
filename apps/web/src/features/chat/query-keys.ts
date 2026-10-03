export const chatQueryKeys = Object.freeze({
  root: (userId: string, epoch: number) => ['chat', userId, epoch] as const,
  models: (userId: string, epoch: number) => [...chatQueryKeys.root(userId, epoch), 'models'] as const,
  lists: (userId: string, epoch: number) => [...chatQueryKeys.root(userId, epoch), 'conversations'] as const,
  list: (userId: string, epoch: number) => [...chatQueryKeys.lists(userId, epoch), 'pages'] as const,
  detail: (userId: string, epoch: number, conversationId: string) =>
    [...chatQueryKeys.root(userId, epoch), 'conversation', conversationId] as const,
});
