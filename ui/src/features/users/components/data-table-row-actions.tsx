import { DotsHorizontalIcon } from '@radix-ui/react-icons'
import { type Row } from '@tanstack/react-table'
import { Trash2, UserPen, Stethoscope, RotateCcw, Coins, MessageSquare, Gift } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { type Account } from '@/lib/kuku-api'
import { useUsers } from './users-provider'

type DataTableRowActionsProps = {
  row: Row<Account>
}

export function DataTableRowActions({ row }: DataTableRowActionsProps) {
  const {
    setOpen,
    setCurrentRow,
    runHealthCheck,
    runPointsCheck,
    resetCooldown,
    adminEnabled,
    openFreePointsDialog,
    claimAccountPoints,
  } = useUsers()
  const account = row.original
  const adminNotice = '服务端未开启管理端 (未配置 ADMIN_TOKEN)'

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant='ghost'
            className='flex h-8 w-8 p-0 data-[state=open]:bg-muted'
          >
            <DotsHorizontalIcon className='h-4 w-4' />
            <span className='sr-only'>Open menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end' className='w-48'>
          <DropdownMenuItem
            onClick={() => {
              runPointsCheck(account.id)
            }}
          >
            查询剩余积分
            <DropdownMenuShortcut>
              <Coins size={16} />
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              runHealthCheck(account.id)
            }}
          >
            单号体检
            <DropdownMenuShortcut>
              <Stethoscope size={16} />
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!adminEnabled}
            title={!adminEnabled ? adminNotice : undefined}
            onClick={() => {
              if (adminEnabled) resetCooldown(account.id)
            }}
          >
            清除冷却/复位
            <DropdownMenuShortcut>
              <RotateCcw size={16} />
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!adminEnabled}
            title={!adminEnabled ? adminNotice : undefined}
            onClick={() => {
              if (adminEnabled) {
                setCurrentRow(account)
                setOpen('edit')
              }
            }}
          >
            {account.auth_dead ? '换绑凭据 (修复)' : '编辑设置 / 换凭据'}
            <DropdownMenuShortcut>
              <UserPen size={16} />
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!adminEnabled}
            title={!adminEnabled ? adminNotice : undefined}
            onClick={() => {
              if (adminEnabled) {
                void claimAccountPoints(account.id, true)
              }
            }}
          >
            单号对话领奖 (+50分)
            <DropdownMenuShortcut>
              <MessageSquare size={16} />
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!adminEnabled}
            title={!adminEnabled ? adminNotice : undefined}
            onClick={() => {
              if (adminEnabled) {
                openFreePointsDialog(account.id)
              }
            }}
          >
            免费积分任务详情
            <DropdownMenuShortcut>
              <Gift size={16} />
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!adminEnabled}
            title={!adminEnabled ? adminNotice : undefined}
            onClick={() => {
              if (adminEnabled) {
                setCurrentRow(account)
                setOpen('delete')
              }
            }}
            className='text-red-500!'
          >
            删除账号
            <DropdownMenuShortcut>
              <Trash2 size={16} />
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
