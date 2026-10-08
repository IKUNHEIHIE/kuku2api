import {
  LayoutDashboard,
  ListTodo,
  Package,
  Users,
  MessagesSquare,
  Bot,
  Sliders,
  KeyRound,
  BarChart3,
  ScrollText,
} from 'lucide-react'
import { type SidebarData } from '../types'

export const sidebarData: SidebarData = {
  user: {
    name: 'Admin',
    email: 'admin@kuku2api.local',
    avatar: '/avatars/shadcn.jpg',
  },
  teams: [
    {
      name: 'kuku2api Console',
      logo: Bot,
      plan: '百度库库AI 反代管理端',
    },
  ],
  navGroups: [
    {
      title: '控制台 (Console)',
      items: [
        {
          title: '系统总览',
          url: '/',
          icon: LayoutDashboard,
        },
        {
          title: '号池管理',
          url: '/users',
          icon: Users,
        },
        {
          title: 'API 密钥',
          url: '/keys',
          icon: KeyRound,
        },
        {
          title: 'AI 对话',
          url: '/chats',
          icon: MessagesSquare,
        },
        {
          title: '对话历史',
          url: '/tasks',
          icon: ListTodo,
        },
        {
          title: '用量统计',
          url: '/stats',
          icon: BarChart3,
        },
        {
          title: '系统日志',
          url: '/logs',
          icon: ScrollText,
        },
        {
          title: '模型清单',
          url: '/apps',
          icon: Package,
        },
      ],
    },
    {
      title: '配置中心 (Configuration)',
      items: [
        {
          title: '系统设置',
          url: '/settings',
          icon: Sliders,
        },
      ],
    },
  ],
}
