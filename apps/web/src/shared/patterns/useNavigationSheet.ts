import { useState } from 'react';
import { useLocation } from 'react-router-dom';

/** Close drawers on every route change, including browser back/forward. */
export function useNavigationSheet() {
  const { key } = useLocation();
  const [state, setState] = useState({ open: false, key });
  return [state.open && state.key === key, (open: boolean) => setState({ open, key })] as const;
}
