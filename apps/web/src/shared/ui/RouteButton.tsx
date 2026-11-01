import { useNavigate, type To } from 'react-router-dom';
import { useProductEnvironment } from '../platform';
import { Button, type ButtonProps } from './Button';

export interface RouteButtonProps extends Omit<ButtonProps, 'asChild'> {
  to: To;
  replace?: boolean;
}

/** Button actions that change the current app page share routing and native semantics. */
export function RouteButton({
  to,
  replace,
  onClick,
  variant = 'outline',
  ...props
}: RouteButtonProps) {
  const navigate = useNavigate();
  const { openWorkspace } = useProductEnvironment();
  return (
    <Button
      {...props}
      variant={variant}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (to === '/chat' && openWorkspace) openWorkspace();
        else void navigate(to, { replace: replace ?? false });
      }}
    />
  );
}
