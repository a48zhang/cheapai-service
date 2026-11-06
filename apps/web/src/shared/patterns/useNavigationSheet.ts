import { useState } from 'react';
import { useLocation } from 'react-router-dom';

/** Close on page changes; query normalization on the current page must not dismiss navigation. */
export function useNavigationSheet() {
  const { pathname: key } = useLocation();
  const [state, setState] = useState({ open: false, key });
  return [state.open && state.key === key, (open: boolean) => setState({ open, key })] as const;
}
