import { Slot, Slottable } from '@radix-ui/react-slot';
import type { ButtonHTMLAttributes, CSSProperties, MouseEventHandler, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Renders the single child as the interactive element, for example an anchor. */
  asChild?: boolean;
  /** Keeps the control unavailable while an operation is in progress. */
  busy?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Optional leading or trailing content, such as an icon. */
  children: ReactNode;
}

const variantStyles: Record<ButtonVariant, CSSProperties> = {
  primary: {
    backgroundColor: 'var(--color-primary)',
    borderColor: 'var(--color-primary)',
    color: 'var(--color-primary-foreground)',
  },
  secondary: {
    backgroundColor: 'var(--color-muted)',
    borderColor: 'var(--color-border)',
    color: 'var(--color-foreground)',
  },
  outline: {
    backgroundColor: 'var(--color-surface)',
    borderColor: 'var(--color-border)',
    color: 'var(--color-foreground)',
  },
  ghost: {
    backgroundColor: 'transparent',
    borderColor: 'transparent',
    color: 'var(--color-foreground)',
  },
  danger: {
    backgroundColor: 'var(--color-destructive)',
    borderColor: 'var(--color-destructive)',
    color: 'var(--color-danger-foreground)',
  },
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'min-h-8 px-3 text-sm',
  md: 'min-h-10 px-4 text-sm',
  lg: 'min-h-11 px-5 text-base',
  icon: 'size-10 p-0',
};

/** Shared button with explicit intent, sizing, and asynchronous busy state. */
export function Button({
  asChild = false,
  busy = false,
  disabled = false,
  variant = 'primary',
  size = 'md',
  type = 'button',
  className,
  style,
  onClick,
  children,
  ...props
}: ButtonProps) {
  const unavailable = disabled || busy;
  const handleClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    if (unavailable) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onClick?.(event);
  };
  const handleSlotClick: MouseEventHandler<HTMLElement> = (event) => {
    if (unavailable) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onClick?.(event as unknown as Parameters<NonNullable<typeof onClick>>[0]);
  };
  const sharedClassName = `inline-flex items-center justify-center gap-2 rounded-md border font-medium outline-none transition-colors hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] disabled:pointer-events-none disabled:opacity-50 ${sizeClasses[size]} ${className ?? ''}`;
  const sharedStyle = {
    ...variantStyles[variant],
    ...(unavailable ? { opacity: 0.55 } : {}),
    ...style,
  };
  const content = (
    <>
      {busy && (
        <span
          aria-hidden="true"
          className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
        />
      )}
      {children}
    </>
  );

  if (asChild) {
    return (
      <Slot
        {...props}
        aria-disabled={unavailable ? true : props['aria-disabled']}
        aria-busy={busy || undefined}
        data-busy={busy ? '' : undefined}
        onClick={handleSlotClick}
        className={sharedClassName}
        style={sharedStyle}
      >
        {busy && (
          <span
            aria-hidden="true"
            className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
          />
        )}
        <Slottable>{children}</Slottable>
      </Slot>
    );
  }

  return (
    <button
      {...props}
      type={type}
      disabled={unavailable}
      aria-disabled={props['aria-disabled']}
      aria-busy={busy || undefined}
      data-busy={busy ? '' : undefined}
      onClick={handleClick}
      className={sharedClassName}
      style={sharedStyle}
    >
      {content}
    </button>
  );
}
