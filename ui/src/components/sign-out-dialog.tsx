import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { saveApiSettings } from '@/lib/kuku-api'
import { ConfirmDialog } from '@/components/confirm-dialog'

interface SignOutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SignOutDialog({ open, onOpenChange }: SignOutDialogProps) {
  const navigate = useNavigate()
  const { auth } = useAuthStore()

  const handleSignOut = () => {
    auth.reset()
    // Reset stored credentials to default clean state
    saveApiSettings({
      baseUrl: 'http://127.0.0.1:8787',
      apiKey: '',
      adminToken: '',
    })
    toast.success('已清空本地凭据与管理员令牌', {
      description: '已恢复初始连接状态',
    })
    navigate({
      to: '/',
      replace: true,
    })
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title='清除凭据并退出'
      desc='确定要清除本地浏览器中暂存的 API Key 与 Admin Token 吗？清除后管理端写操作将需要重新配置令牌。'
      confirmText='确认清除'
      cancelBtnText='取消'
      destructive
      handleConfirm={handleSignOut}
      className='sm:max-w-md'
    />
  )
}
