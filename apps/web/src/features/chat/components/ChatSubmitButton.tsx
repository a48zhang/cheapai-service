/**
 * Adapted from Vercel AI Elements PromptInputSubmit (Apache-2.0).
 * Copyright 2023 Vercel, Inc.
 * Source: ca8be600bfd01b3131f9bf6134b51602a71f4374,
 * packages/elements/src/prompt-input.tsx, PromptInputSubmit.
 * Changes: existing Button API, local lifecycle, Chinese labels, and explicit
 * stopping/confirmation states. See LICENSES/ai-elements-NOTICE.txt.
 */
import { ArrowUp, CircleAlert, LoaderCircle, Square } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import type { ChatPresentation } from '../model/presentation';

export function ChatSubmitButton({
  presentation,
  canSend,
  sendLabel,
  shortcutHint = 'Enter；Shift+Enter 换行',
  onStop,
}: {
  presentation: ChatPresentation['submit'];
  canSend: boolean;
  sendLabel: string;
  shortcutHint?: string;
  onStop: () => void;
}) {
  const isGenerating = presentation.action === 'stop';
  const isSubmit = presentation.action === 'send';
  const label = isSubmit ? sendLabel : presentation.label;
  const Icon = presentation.animated
    ? LoaderCircle
    : isGenerating
      ? Square
      : isSubmit
        ? ArrowUp
        : CircleAlert;

  return (
    <Button
      aria-label={label}
      className="chat-send"
      disabled={presentation.action === 'wait' || (isSubmit && !canSend)}
      onClick={(event) => {
        if (isGenerating) {
          event.preventDefault();
          onStop();
        }
      }}
      size="icon"
      title={isSubmit ? `${label}（${shortcutHint}）` : label}
      type={isSubmit ? 'submit' : 'button'}
      variant={isSubmit ? 'primary' : 'outline'}
    >
      <Icon
        aria-hidden="true"
        className={presentation.animated ? 'animate-spin motion-reduce:animate-none' : undefined}
        size={16}
      />
    </Button>
  );
}
