import {
  Activity,
  Boxes,
  Cable,
  FileClock,
  KeyRound,
  Layers,
  MessageSquare,
  ReceiptText,
  Settings2,
  ShieldCheck,
  Ticket,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface NavigationItem {
  path: string;
  label: string;
  icon: LucideIcon;
}
export interface NavigationGroup {
  title: string;
  items: NavigationItem[];
}

export const personalNavigation: NavigationItem[] = [
  { path: '/chat', label: '对话', icon: MessageSquare },
  { path: '/keys', label: 'API 接入', icon: KeyRound },
  { path: '/billing', label: '费用', icon: ReceiptText },
  { path: '/requests', label: '请求记录', icon: Activity },
];

export const adminNavigation: NavigationGroup[] = [
  {
    title: '资源配置',
    items: [
      { path: '/admin/channels', label: '渠道', icon: Cable },
      { path: '/admin/models', label: '模型与价格', icon: Boxes },
      { path: '/admin/groups', label: '访问组', icon: Layers },
    ],
  },
  { title: '用户与授权', items: [{ path: '/admin/users', label: '用户', icon: Users }] },
  {
    title: '运行记录',
    items: [
      { path: '/admin/requests', label: '请求记录', icon: Activity },
      { path: '/admin/billing', label: '账单', icon: ReceiptText },
      { path: '/admin/audit', label: '审计', icon: FileClock },
    ],
  },
  {
    title: '系统设置',
    items: [
      { path: '/admin/registration/settings', label: '注册设置', icon: Settings2 },
      { path: '/admin/registration/codes', label: '邀请码', icon: Ticket },
    ],
  },
];

export const adminEntry: NavigationItem = {
  path: '/admin/channels',
  label: '管理控制台',
  icon: ShieldCheck,
};
