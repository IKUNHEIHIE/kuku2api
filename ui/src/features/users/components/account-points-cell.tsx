import { Badge } from '@/components/ui/badge'
import { Coins } from 'lucide-react'
import { useUsers } from './users-provider'

export function AccountPointsCell({ accountId }: { accountId: string }) {
  const { pointsResults, checkingPoints } = useUsers()
  const pt = pointsResults[accountId]

  if (!pt) {
    return (
      <span className='text-xs text-muted-foreground'>
        {checkingPoints ? '查询中...' : '未同步'}
      </span>
    )
  }

  if (!pt.ok) {
    return (
      <Badge
        variant='outline'
        className='text-destructive border-destructive/30 text-xs'
        title={pt.message || '查询失败'}
      >
        {pt.code ? `错误码 ${pt.code}` : '不可用'}
      </Badge>
    )
  }

  return (
    <div className='flex flex-col gap-0.5'>
      <div className='flex items-center gap-1.5'>
        <Badge className='bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 font-mono text-xs font-semibold'>
          <Coins size={12} className='mr-1' />
          {pt.balance_points ?? 0} pts
        </Badge>
        {pt.is_vip && (
          <Badge
            variant='secondary'
            className='text-[10px] bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
          >
            VIP
          </Badge>
        )}
      </div>
      <div className='text-[10px] text-muted-foreground'>
        时长: {pt.duration_points ?? 0}m · 任务: {pt.scheduled_task_points ?? 0}
      </div>
    </div>
  )
}
