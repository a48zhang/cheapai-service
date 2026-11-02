import { RouteButton } from '../shared/ui/RouteButton';
import { useProductEnvironment } from '../shared/platform';

export default function NotFoundPage() {
  const { kind } = useProductEnvironment();
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center p-8">
      <p className="text-sm font-semibold text-[var(--color-primary)]">CheapAI · 404</p>
      <h1 className="mt-4 text-3xl font-semibold">找不到这个页面</h1>
      <p className="my-5 text-[var(--color-muted-foreground)]">链接可能已失效，或页面已移动。</p>
      <RouteButton
        className="self-start"
        variant="primary"
        to={kind === 'desktop' ? '/models' : '/'}
      >
        {kind === 'desktop' ? '模型目录' : '返回首页'}
      </RouteButton>
    </main>
  );
}
