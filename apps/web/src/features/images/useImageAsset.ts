import { useEffect, useState } from 'react';
import { imageContentUrl } from '@cheapai/api-client/images';
import { useProductEnvironment } from '../../shared/platform';

/** Native credentials stay in the host; only the authenticated image bytes enter the view. */
export function useImageAsset(id: string, enabled: boolean, attempt: number) {
  const { fetchAsset } = useProductEnvironment();
  const [asset, setAsset] = useState<{
    id: string;
    attempt: number;
    url: string | null;
    error: boolean;
  }>();
  useEffect(() => {
    if (!fetchAsset || !enabled) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void fetchAsset(imageContentUrl(id), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Image unavailable');
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setAsset({ id, attempt, url: objectUrl, error: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setAsset({ id, attempt, url: null, error: true });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, enabled, attempt, fetchAsset]);
  if (!fetchAsset) return { url: `${imageContentUrl(id)}?v=${attempt}`, error: false };
  return asset?.id === id && asset.attempt === attempt ? asset : { url: null, error: false };
}
