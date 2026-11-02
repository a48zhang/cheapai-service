import { Button, type ButtonProps } from './Button';

/** Explicit actions that open a separate page, such as checking an uncertain save. */
export function NewTabButton({
  href,
  onClick,
  variant = 'outline',
  ...props
}: Omit<ButtonProps, 'asChild'> & { href: string }) {
  return (
    <Button
      {...props}
      variant={variant}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) window.open(href, '_blank', 'noopener,noreferrer');
      }}
    />
  );
}
