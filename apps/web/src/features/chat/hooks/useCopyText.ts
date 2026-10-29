import { useEffect, useState } from 'react';

/** Copy the visible snapshot, and never label newly streamed text as already copied. */
export function useCopyText(text: string) {
  const [result, setResult] = useState<{
    text: string;
    status: 'copied' | 'failed';
  } | null>(null);

  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), 2000);
    return () => clearTimeout(timer);
  }, [result]);

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable');
      await navigator.clipboard.writeText(text);
      setResult({ text, status: 'copied' });
    } catch {
      setResult({ text, status: 'failed' });
    }
  };

  return { copy, copyState: result?.text === text ? result.status : 'idle' };
}
