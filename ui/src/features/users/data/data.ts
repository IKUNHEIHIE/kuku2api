import { ShieldCheck, ShieldAlert, PauseCircle, Clock } from 'lucide-react'

export const accountStatuses = [
  {
    label: '正常可用',
    value: 'active',
    icon: ShieldCheck,
  },
  {
    label: '冷却中',
    value: 'cooldown',
    icon: Clock,
  },
  {
    label: '凭据失效',
    value: 'auth_dead',
    icon: ShieldAlert,
  },
  {
    label: '已停用',
    value: 'disabled',
    icon: PauseCircle,
  },
] as const

export const callTypes = new Map<string, string>([
  ['active', 'bg-emerald-100/40 text-emerald-800 dark:text-emerald-300 border-emerald-300'],
  ['cooldown', 'bg-amber-100/40 text-amber-800 dark:text-amber-300 border-amber-300'],
  ['auth_dead', 'bg-rose-100/40 text-rose-800 dark:text-rose-300 border-rose-300'],
  ['disabled', 'bg-neutral-100/40 text-neutral-600 dark:text-neutral-400 border-neutral-300'],
])

export const roles = [
  {
    label: '百度账号',
    value: 'account',
    icon: ShieldCheck,
  },
] as const
