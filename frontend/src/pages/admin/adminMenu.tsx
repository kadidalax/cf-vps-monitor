import React from 'react';
import {
  Activity,
  AtSign,
  Bell,
  Bolt,
  CalendarClock,
  Ellipsis,
  Globe,
  Globe2,
  MessageCircleMore,
  Palette,
  ScrollText,
  Server,
  TrendingUp,
  Unplug,
  User,
} from 'lucide-react';

export interface AdminMenuItem {
  path: string;
  label: string;
  icon: React.ReactNode;
  children?: AdminMenuItem[];
  external?: boolean;
}

export const adminMenuItems: AdminMenuItem[] = [
  { path: '/admin', label: '服务器', icon: <Server size={18} /> },
  { path: '/admin/websites', label: '网站', icon: <Globe2 size={18} /> },
  {
    path: '/admin/settings',
    label: '系统设置',
    icon: <Bolt size={18} />,
    children: [
      { path: '/admin/settings', label: '站点设置', icon: <Globe size={16} /> },
      { path: '/admin/settings/general', label: '通用设置', icon: <Ellipsis size={16} /> },
    ],
  },
  {
    path: '/admin/notifications',
    label: '通知管理',
    icon: <Bell size={18} />,
    children: [
      { path: '/admin/notifications/settings', label: '通知设置', icon: <MessageCircleMore size={16} /> },
      { path: '/admin/notifications/offline', label: '离线通知', icon: <Unplug size={16} /> },
      { path: '/admin/notifications/expiry', label: '到期通知', icon: <CalendarClock size={16} /> },
      { path: '/admin/notifications/load', label: '负载通知', icon: <TrendingUp size={16} /> },
    ],
  },
  { path: '/admin/ping', label: '延迟监测', icon: <Activity size={18} /> },
  { path: '/admin/themes', label: '主题管理', icon: <Palette size={18} /> },
  { path: '/admin/logs', label: '审计日志', icon: <ScrollText size={18} /> },
  { path: '/admin/account', label: '账户', icon: <User size={18} /> },
  { path: '/admin/about', label: '关于', icon: <AtSign size={18} /> },
];

export function isAdminMenuPathActive(itemPath: string, currentPath: string) {
  if (itemPath === '/admin/settings') return currentPath.startsWith('/admin/settings');
  if (itemPath === '/admin/notifications') {
    return currentPath.startsWith('/admin/notifications') ||
      currentPath.startsWith('/admin/notification');
  }
  if (itemPath === '/admin/themes') return currentPath.startsWith('/admin/themes');
  if (itemPath === '/admin') return currentPath === '/admin' || currentPath.startsWith('/admin/clients');
  return currentPath === itemPath;
}

export function isAdminChildPathActive(childPath: string, currentPath: string) {
  if (childPath === '/admin/settings') {
    return currentPath === childPath || currentPath === '/admin/settings/site';
  }

  if (childPath === '/admin/settings/general') {
    return currentPath === childPath || currentPath.startsWith(`${childPath}/`);
  }

  if (childPath === '/admin/notifications/settings') {
    return currentPath === childPath ||
      currentPath.startsWith(`${childPath}/`) ||
      currentPath === '/admin/settings/notification' ||
      currentPath.startsWith('/admin/settings/notification/');
  }

  if (childPath === '/admin/notifications/offline') {
    return currentPath === childPath ||
      currentPath.startsWith(`${childPath}/`) ||
      currentPath === '/admin/notification/offline' ||
      currentPath.startsWith('/admin/notification/offline/');
  }

  if (childPath === '/admin/notifications/load') {
    return currentPath === childPath ||
      currentPath.startsWith(`${childPath}/`) ||
      currentPath === '/admin/notification/load' ||
      currentPath.startsWith('/admin/notification/load/');
  }

  if (childPath === '/admin/notifications/expiry') {
    return currentPath === childPath ||
      currentPath.startsWith(`${childPath}/`) ||
      currentPath === '/admin/notification/expiry' ||
      currentPath.startsWith('/admin/notification/expiry/');
  }

  return currentPath === childPath || currentPath.startsWith(`${childPath}/`);
}

export function getAdminSectionTitle(pathname: string) {
  if (
    pathname.startsWith('/admin/notifications/settings') ||
    pathname.startsWith('/admin/settings/notification')
  ) return '通知设置';
  if (pathname.startsWith('/admin/settings/general')) return '通用设置';
  if (pathname.startsWith('/admin/settings')) return '站点设置';
  if (
    pathname.startsWith('/admin/notifications/offline') ||
    pathname.startsWith('/admin/notification/offline')
  ) return '离线通知';
  if (
    pathname.startsWith('/admin/notifications/load') ||
    pathname.startsWith('/admin/notification/load')
  ) return '负载通知';
  if (
    pathname.startsWith('/admin/notifications/expiry') ||
    pathname.startsWith('/admin/notification/expiry')
  ) return '到期通知';
  if (
    pathname.startsWith('/admin/notifications') ||
    pathname.startsWith('/admin/notification')
  ) return '通知管理';
  if (pathname.startsWith('/admin/ping')) return '延迟监测';
  if (pathname.startsWith('/admin/themes')) return '主题管理';
  if (pathname.startsWith('/admin/websites')) return '网站';
  if (pathname.startsWith('/admin/logs')) return '审计日志';
  if (pathname.startsWith('/admin/account')) return '账户设置';
  if (pathname.startsWith('/admin/about')) return '关于';
  if (pathname === '/admin' || pathname.startsWith('/admin/clients')) return '服务器';
  return '管理后台';
}
