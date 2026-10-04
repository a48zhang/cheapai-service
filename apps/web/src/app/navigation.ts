export interface NavigationItem {
  path: string;
  label: string;
  icon: string;
}
export interface NavigationGroup {
  title: string;
  items: NavigationItem[];
}
export const personalNavigation: NavigationGroup[] = [
  {
    title: '工作区',
    items: [
      { path: '/', label: '聊天', icon: '◌' },
      { path: '/dashboard', label: '账户概览', icon: '▦' },
      { path: '/keys', label: 'API 接入', icon: '⌘' },
      { path: '/requests', label: '请求记录', icon: '≡' },
      { path: '/billing', label: '账单', icon: '▤' },
    ],
  },
];
export const adminNavigation: NavigationGroup[] = [
  {
    title: '资源配置',
    items: [
      { path: '/admin/channels', label: '渠道', icon: '⌘' },
      { path: '/admin/models', label: '模型与价格', icon: '◇' },
      { path: '/admin/groups', label: '访问组', icon: '▦' },
    ],
  },
  { title: '用户与授权', items: [{ path: '/admin/users', label: '用户', icon: '♧' }] },
  {
    title: '运行记录',
    items: [
      { path: '/admin/requests', label: '请求', icon: '≡' },
      { path: '/admin/billing', label: '账单', icon: '▤' },
      { path: '/admin/audit', label: '审计', icon: '◈' },
    ],
  },
  {
    title: '系统设置',
    items: [
      { path: '/admin/registration/settings', label: '注册策略', icon: '⚙' },
      { path: '/admin/registration/codes', label: '邀请码', icon: '⌗' },
    ],
  },
];
