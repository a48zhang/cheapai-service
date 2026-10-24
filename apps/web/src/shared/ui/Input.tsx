import type { InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Applies the same invalid state used by Field when an error is present. */
  invalid?: boolean;
}

/** Native input with shared sizing, focus, disabled, and error treatment. */
export function Input({
  className,
  style,
  invalid = false,
  'aria-invalid': ariaInvalid,
  disabled = false,
  ...props
}: InputProps) {
  const isInvalid =
    invalid || (ariaInvalid !== undefined && ariaInvalid !== false && ariaInvalid !== 'false');

  return (
    <input
      {...props}
      disabled={disabled}
      aria-invalid={isInvalid ? true : ariaInvalid}
      data-slot="input"
      className={`h-9 w-full min-w-0 rounded-md border border-input bg-transparent dark:bg-input/30 px-3 py-1 text-base shadow-xs outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 ${className ?? ''}`}
      style={style}
    />
  );
}
