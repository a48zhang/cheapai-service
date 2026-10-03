import type { ReactNode } from 'react';
import { ConsoleLayout } from './ConsoleLayout';
export function AdminLayout({ children }: { children?: ReactNode }) { return <ConsoleLayout mode="admin">{children}</ConsoleLayout>; }
