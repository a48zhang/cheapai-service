import * as SelectPrimitive from '@radix-ui/react-select';
import * as Popover from '@radix-ui/react-popover';
import {
  useState,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

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
  const describedBy =
    [ariaDescribedBy, error ? errorId : undefined].filter(Boolean).join(' ') || undefined;

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
      {error && (
        <span className="ui-field-error" id={errorId}>
          {error}
        </span>
      )}
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
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button className="ui-menu-trigger" variant="quiet">
          {label}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="ui-menu-panel" sideOffset={6} align="end">
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
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

export function Select({
  items,
  value,
  onValueChange,
  placeholder = '请选择',
  ...props
}: {
  items: readonly { value: string; label: string; disabled?: boolean }[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  'aria-label'?: string;
  style?: import('react').CSSProperties;
}) {
  const empty = useId();
  const hasEmpty = items.some((item) => item.value === '');
  return (
    <SelectPrimitive.Root
      value={hasEmpty && value === '' ? empty : value}
      onValueChange={(next) => onValueChange(next === empty ? '' : next)}
      disabled={props.disabled ?? false}
    >
      <SelectPrimitive.Trigger {...props} className="ui-input ui-select-trigger">
        <span className="ui-select-value">
          <SelectPrimitive.Value placeholder={placeholder} />
        </span>
        <SelectPrimitive.Icon aria-hidden>⌄</SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content className="ui-select-content" position="popper" sideOffset={4}>
          <SelectPrimitive.Viewport>
            {items.map((item) => (
              <SelectPrimitive.Item
                key={item.value}
                value={item.value === '' ? empty : item.value}
                disabled={item.disabled ?? false}
                className="ui-select-item"
              >
                <SelectPrimitive.ItemText>{item.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator aria-hidden>✓</SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function Disclosure({ title, children }: { title: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div>
      <Button
        data-disclosure-trigger
        aria-expanded={open}
        aria-controls={id}
        variant="quiet"
        onClick={() => setOpen(!open)}
      >
        {title}
        <span aria-hidden>{open ? '⌃' : '⌄'}</span>
      </Button>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
