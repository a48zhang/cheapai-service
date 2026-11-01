import { Button } from './Button';

/** Focus content without changing BrowserRouter or HashRouter locations. */
export function SkipToContent({ target, className }: { target: string; className?: string }) {
  return (
    <Button
      variant="outline"
      className={
        className ??
        'sr-only focus:not-sr-only focus:fixed focus:z-[70] focus:bg-[var(--color-surface)] focus:p-4'
      }
      onClick={() => document.getElementById(target)?.focus()}
    >
      跳到主要内容
    </Button>
  );
}
