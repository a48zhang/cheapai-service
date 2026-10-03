import { Component, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { AppRoutes } from './router';
import '../shared/styles/tokens.css';
import '../shared/styles/base.css';

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch() {
    // Keep request and credential contents out of client logging.
  }
  override render() {
    if (this.state.failed) return <main className="mx-auto max-w-lg p-8"><h1 className="text-2xl font-semibold">页面暂时无法显示</h1><p className="my-4">重新载入 cheapai 以恢复页面。</p><button type="button" onClick={() => window.location.reload()}>重新载入</button></main>;
    return this.props.children;
  }
}

export default function App() {
  return <AppErrorBoundary><BrowserRouter><AppRoutes /></BrowserRouter></AppErrorBoundary>;
}
