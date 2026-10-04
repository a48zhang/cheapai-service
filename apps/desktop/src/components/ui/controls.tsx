import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
}

export function Button({
  children,
  className,
  type = 'button',
  variant = 'secondary',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={['ui-button', className].filter(Boolean).join(' ')}
      data-variant={variant}
      type={type}
    >
      {children}
    </button>
  );
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly error?: string;
  readonly label: string;
}

export function TextInput({
  'aria-describedby': ariaDescribedBy,
  className,
  error,
  id,
  label,
  ...props
}: TextInputProps) {
  const generatedId = useId();
  const inputId = id ?? `desktop-input-${generatedId}`;
  const errorId = `${inputId}-error`;
  const describedBy = [ariaDescribedBy, error ? errorId : undefined].filter(Boolean).join(' ') || undefined;

  return (
    <label className="ui-field" htmlFor={inputId}>
      <span className="ui-field-label">{label}</span>
      <input
        {...props}
        aria-describedby={describedBy}
        aria-invalid={error ? true : props['aria-invalid']}
        className={['ui-input', className].filter(Boolean).join(' ')}
        id={inputId}
      />
      {error && <span className="ui-field-error" id={errorId}>{error}</span>}
    </label>
  );
}

export function Menu({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) {
  return (
    <details className="ui-menu">
      <summary className="ui-menu-trigger">{label}</summary>
      <div className="ui-menu-panel">{children}</div>
    </details>
  );
}

export type MenuItemProps = ButtonHTMLAttributes<HTMLButtonElement>;

export function MenuItem({ className, type = 'button', ...props }: MenuItemProps) {
  return (
    <button
      {...props}
      className={['ui-button', 'ui-menu-item', className].filter(Boolean).join(' ')}
      type={type}
    />
  );
}
