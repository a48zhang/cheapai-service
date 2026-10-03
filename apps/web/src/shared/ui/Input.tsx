import type { CSSProperties, InputHTMLAttributes } from 'react'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Applies the same invalid state used by Field when an error is present. */
  invalid?: boolean
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
  const isInvalid = invalid || (ariaInvalid !== undefined && ariaInvalid !== false && ariaInvalid !== 'false')
  const inputStyle: CSSProperties = {
    borderColor: isInvalid ? 'var(--color-destructive)' : 'var(--color-border)',
    backgroundColor: disabled ? 'var(--color-muted)' : 'var(--color-surface)',
    color: 'var(--color-foreground)',
    ...style,
  }

  return (
    <input
      {...props}
      disabled={disabled}
      aria-invalid={isInvalid ? true : ariaInvalid}
      className={`block min-h-10 w-full rounded-md border px-3 py-2 text-sm outline-none transition-colors placeholder:text-[var(--color-muted-foreground)] focus-visible:border-[var(--color-ring)] focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-surface)] disabled:cursor-not-allowed disabled:opacity-60 ${className ?? ''}`}
      style={inputStyle}
    />
  )
}
