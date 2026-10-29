/**
 * Adapted from AI Elements Image, Copyright 2023 Vercel, Inc. (Apache-2.0).
 * Source: ca8be600bfd01b3131f9bf6134b51602a71f4374/packages/elements/src/image.tsx.
 * Changes: native image props, private same-origin asset URLs, no AI SDK type dependency.
 * See LICENSES/ai-elements-NOTICE.txt.
 */
import type { ImgHTMLAttributes } from 'react';

export type GeneratedImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  base64?: string;
  mediaType?: 'image/png' | 'image/jpeg' | 'image/webp';
};
export function GeneratedImage({ base64, mediaType = 'image/png', ...props }: GeneratedImageProps) {
  return (
    <img
      {...props}
      alt={props.alt}
      className={`h-auto max-w-full overflow-hidden rounded-md ${props.className ?? ''}`}
      src={base64 ? `data:${mediaType};base64,${base64}` : props.src}
    />
  );
}
