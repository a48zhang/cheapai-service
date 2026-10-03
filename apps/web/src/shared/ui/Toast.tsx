import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type ToastInput = { title: string; description?: string; tone?: 'success' | 'error' | 'info' };
type ToastRecord = ToastInput & { id: number };
const ToastContext = createContext<{ toast: (input: ToastInput) => void }>({ toast: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastRecord[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const toast = useCallback((input: ToastInput) => {
    const id = ++nextId.current;
    setItems(old => [...old.slice(-3), { ...input, id }]);
    const timer = setTimeout(() => { setItems(old => old.filter(item => item.id !== id)); timers.current.delete(timer); }, 5000);
    timers.current.add(timer);
  }, []);
  useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current.clear(); }, []);
  return <ToastContext.Provider value={{ toast }}>{children}
    <div className="fixed bottom-5 right-5 z-[100] flex max-w-sm flex-col gap-2" aria-live="polite" aria-atomic="false">
      {items.map(item => <div key={item.id} role="status" className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-lg">
        <div className="flex items-start gap-4"><strong className={item.tone === 'error' ? 'text-[var(--destructive)]' : ''}>{item.title}</strong>
          <button type="button" aria-label="关闭通知" className="ml-auto" onClick={() => setItems(old => old.filter(x => x.id !== item.id))}>×</button>
        </div>{item.description && <p className="mt-1 text-sm text-[var(--muted)]">{item.description}</p>}
      </div>)}
    </div>
  </ToastContext.Provider>;
}
export const useToast = () => useContext(ToastContext);
