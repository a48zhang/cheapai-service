import { Slot, Slottable } from '@radix-ui/react-slot';
import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode } from 'react';

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

// shadcn/ui new-york-v4 button styles, mapped to the existing public variants.
const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-[var(--color-primary-foreground)] hover:bg-primary/90',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  outline:
    'border border-input bg-background shadow-xs hover:bg-secondary hover:text-accent-foreground dark:bg-input/30 dark:hover:bg-input/50',
  ghost: 'hover:bg-secondary hover:text-accent-foreground dark:hover:bg-secondary/50',
  danger:
    'bg-destructive text-[var(--color-danger-foreground)] hover:bg-destructive/90 focus-visible:ring-destructive/20',
};
const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-3',
  md: 'h-9 px-4 py-2',
  lg: 'h-10 px-6',
  icon: 'size-9',
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
  const sharedClassName = `inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 ${variantClasses[variant]} ${sizeClasses[size]} ${className ?? ''}`;
  const sharedStyle = style;
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
        data-slot="button"
        data-variant={variant}
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
      data-slot="button"
      data-variant={variant}
      data-busy={busy ? '' : undefined}
      onClick={handleClick}
      className={sharedClassName}
      style={sharedStyle}
    >
      {content}
    </button>
  );
}
