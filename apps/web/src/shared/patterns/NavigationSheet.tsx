import type { ComponentProps } from 'react';
import { Sheet } from '../ui/Sheet';

/** Navigation remains a side drawer; forms and detail sheets keep their own layout. */
export function NavigationSheet(props: Omit<ComponentProps<typeof Sheet>, 'side' | 'className'>) {
  return <Sheet {...props} side="left" className="app-navigation-sheet" />;
}
