import { type ColumnDef } from '@tanstack/react-table'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { DataTableColumnHeader } from '@/components/data-table'
import { type Account } from '@/lib/kuku-api'
import { DataTableRowActions } from './data-table-row-actions'
import { AccountPointsCell } from './account-points-cell'
import { ShieldCheck, ShieldAlert, KeyRound, XCircle, Coins } from 'lucide-react'

export const usersColumns: ColumnDef<Account>[] = [
  {
    id: 'select',
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllPageRowsSelected() ||
          (table.getIsSomePageRowsSelected() && 'indeterminate')
        }
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label='Select all'
        className='translate-y-0.5'
      />
    ),
    meta: {
      className: cn('inset-s-0 z-10 rounded-tl-[inherit] max-md:sticky'),
    },
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        aria-label='Select row'
        className='translate-y-0.5'
      />
    ),
    enableSorting: false,
    enableHiding: false,
  },
  {
    accessorKey: 'id',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='账号 ID' />
    ),
    cell: ({ row }) => (
      <div className='font-mono font-medium ps-2'>{row.getValue('id')}</div>
    ),
    enableHiding: false,
  },
  {
    accessorKey: 'alias',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='别名 / 备注' />
    ),
    cell: ({ row }) => (
      <div className='font-medium'>{row.getValue('alias')}</div>
    ),
  },
  {
    accessorKey: 'priority',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='调度优先级' />
    ),
    cell: ({ row }) => {
      const p = row.original.priority
      return (
        <Badge variant={p === 0 ? 'default' : 'secondary'} className='font-mono'>
          #{p} {p === 0 && '(首选号)'}
        </Badge>
      )
    },
  },
  {
    id: 'balance',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='剩余积分 / 资产配额' />
    ),
    cell: ({ row }) => <AccountPointsCell accountId={row.original.id} />,
  },
  {
    id: 'status',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='状态' />
    ),
    cell: ({ row }) => {
      const a = row.original
      if (a.auth_dead) {
        return (
          <Badge variant='destructive' className='flex w-fit items-center gap-1 font-normal'>
            <ShieldAlert size={13} />
            凭据失效 (可换绑修复)
          </Badge>
        )
      }
      if (a.balance_dead) {
        const mins = Math.max(1, Math.ceil((a.balance_retry_in_ms ?? 0) / 60000))
        return (
          <Badge
            className='flex w-fit items-center gap-1 bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/30 font-normal'
            title='积分耗尽或新换出的 STOKEN 处于上游生效窗口中，X 分钟后将自动回轮换，切勿删号重扫'
          >
            <Coins size={13} />
            积分耗尽 ({mins}分钟后重试)
          </Badge>
        )
      }
      if (a.cooldown_remaining_ms > 0) {
        const secs = Math.ceil(a.cooldown_remaining_ms / 1000)
        return (
          <Badge className='flex w-fit items-center gap-1 bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/30 font-normal'>
            冷却中 ({secs}s)
          </Badge>
        )
      }
      if (a.disabled) {
        return (
          <Badge variant='outline' className='text-muted-foreground'>
            已停用
          </Badge>
        )
      }
      return (
        <Badge className='flex w-fit items-center gap-1 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 font-normal'>
          <ShieldCheck size={13} />
          正常运行
        </Badge>
      )
    },
  },
  {
    accessorKey: 'has_credential',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='凭据配置' />
    ),
    cell: ({ row }) => {
      const has = row.original.has_credential
      return has ? (
        <div className='flex items-center gap-1 text-xs text-muted-foreground'>
          <KeyRound size={14} className='text-emerald-600' /> 已注入凭据
        </div>
      ) : (
        <div className='flex items-center gap-1 text-xs text-destructive'>
          <XCircle size={14} /> 缺凭据
        </div>
      )
    },
  },
  {
    id: 'actions',
    cell: DataTableRowActions,
  },
]
