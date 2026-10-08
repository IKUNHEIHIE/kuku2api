'use client'

import { AlertTriangle } from 'lucide-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { type Account } from '@/lib/kuku-api'
import { useUsers } from './users-provider'

type UserDeleteDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentRow: Account
}

export function UsersDeleteDialog({
  open,
  onOpenChange,
  currentRow,
}: UserDeleteDialogProps) {
  const { deleteAccount } = useUsers()

  const handleDelete = async () => {
    await deleteAccount(currentRow.id)
    onOpenChange(false)
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      handleConfirm={handleDelete}
      title={
        <span className='text-destructive flex items-center gap-1.5'>
          <AlertTriangle
            className='inline-block stroke-destructive'
            size={18}
          />{' '}
          删除账号 {currentRow.id}
        </span>
      }
      desc={
        <div className='space-y-2 text-sm text-muted-foreground'>
          <p>
            确定要从号池中移除账号 <strong className='text-foreground'>{currentRow.alias || currentRow.id}</strong> 吗？
          </p>
          <p className='text-xs text-amber-600 dark:text-amber-400'>
            注意：删号可能导致优先级序号产生空洞。删除后若产生空洞，可点击提示重新紧凑排序号。
          </p>
        </div>
      }
      confirmText='确认删除'
      destructive
    />
  )
}
