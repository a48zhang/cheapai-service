import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center p-8"><p className="text-sm font-semibold text-[var(--primary)]">cheapai · 404</p><h1 className="mt-4 text-3xl font-semibold">找不到这个页面</h1><p className="my-5 text-[var(--muted)]">链接可能已失效，或页面已移动。</p><Link to="/" className="font-medium text-[var(--primary)]">返回首页</Link></main>;
}
