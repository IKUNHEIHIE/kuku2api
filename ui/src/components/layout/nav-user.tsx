import { useState, useEffect } from 'react'
import {
  ShieldCheck,
  AlertCircle,
  Coins,
  LogOut,
  ChevronsUpDown,
} from 'lucide-react'
import { toast } from 'sonner'
import useDialogState from '@/hooks/use-dialog-state'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { SignOutDialog } from '@/components/sign-out-dialog'
import { kukuApi, getApiSettings } from '@/lib/kuku-api'

type NavUserProps = {
  user: {
    name: string
    email: string
    avatar: string
  }
}

export function NavUser({ user }: NavUserProps) {
  const { isMobile } = useSidebar()
  const [open, setOpen] = useDialogState()
  const [backendHealthy, setBackendHealthy] = useState<boolean | null>(null)
  const [isChecking, setIsChecking] = useState(false)
  const settings = getApiSettings()

  useEffect(() => {
    let ignore = false
    kukuApi
      .getHealthz()
      .then((res: { ok: boolean }) => {
        if (!ignore) setBackendHealthy(res.ok)
      })
      .catch(() => {
        if (!ignore) setBackendHealthy(false)
      })
    return () => {
      ignore = true
    }
  }, [])

  const handleHealthProbe = async () => {
    setIsChecking(true)
    const startTime = Date.now()
    try {
      const res = await kukuApi.getHealthz()
      const latency = Date.now() - startTime
      setBackendHealthy(res.ok)
      if (res.ok) {
        toast.success(`后端服务在线 (${settings.baseUrl})`, {
          description: `探测正常，往返延时 ${latency}ms，号池反代就绪。`,
        })
      } else {
        toast.warning('后端服务返回异常状态', {
          description: JSON.stringify(res),
        })
      }
    } catch (err: unknown) {
      setBackendHealthy(false)
      const msg = err instanceof Error ? err.message : String(err)
      toast.error('后端连接失败', {
        description: `${settings.baseUrl} 无法访问: ${msg}`,
      })
    } finally {
      setIsChecking(false)
    }
  }

  const handleCheckPoints = async () => {
    try {
      const res = await kukuApi.getPoolPoints()
      toast.info('号池可用资产余额', {
        description: `全池可用 Token 积分: ${res.total_balance_points} (${res.accounts.length} 个账号)`,
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error('查询号池积分失败', {
        description: msg,
      })
    }
  }

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size='lg'
                className='data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground'
              >
                <div className='relative'>
                  <Avatar className='h-8 w-8 rounded-lg'>
                    <AvatarImage src={user.avatar} alt={user.name} />
                    <AvatarFallback className='rounded-lg bg-primary/10 text-primary font-bold text-xs'>
                      AD
                    </AvatarFallback>
                  </Avatar>
                  <span
                    className={`absolute bottom-0 right-0 size-2 rounded-full border-2 border-background ${
                      backendHealthy === true
                        ? 'bg-emerald-500'
                        : backendHealthy === false
                          ? 'bg-destructive'
                          : 'bg-muted-foreground'
                    }`}
                  />
                </div>
                <div className='grid flex-1 text-start text-sm leading-tight'>
                  <span className='truncate font-semibold'>{user.name || '系统管理员'}</span>
                  <span className='truncate text-xs text-muted-foreground'>
                    {user.email || 'admin@kuku2api.local'}
                  </span>
                </div>
                <ChevronsUpDown className='ms-auto size-4' />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className='w-(--radix-dropdown-menu-trigger-width) min-w-64 rounded-lg'
              side={isMobile ? 'bottom' : 'right'}
              align='end'
              sideOffset={4}
            >
              <DropdownMenuLabel className='p-2 font-normal'>
                <div className='flex items-center gap-2 text-start text-sm'>
                  <Avatar className='h-8 w-8 rounded-lg'>
                    <AvatarImage src={user.avatar} alt={user.name} />
                    <AvatarFallback className='rounded-lg bg-primary/10 text-primary font-bold text-xs'>
                      AD
                    </AvatarFallback>
                  </Avatar>
                  <div className='grid flex-1 text-start text-sm leading-tight'>
                    <div className='flex items-center justify-between gap-1'>
                      <span className='truncate font-semibold'>{user.name || '系统管理员'}</span>
                      <Badge
                        variant={backendHealthy ? 'secondary' : 'destructive'}
                        className='text-[10px] px-1 py-0 h-4 font-normal'
                      >
                        {backendHealthy ? '在线' : '离线'}
                      </Badge>
                    </div>
                    <span className='truncate text-xs font-mono text-muted-foreground'>
                      {settings.baseUrl}
                    </span>
                  </div>
                </div>
              </DropdownMenuLabel>

              <DropdownMenuSeparator />

              {/* 实时运维工具 */}
              <DropdownMenuGroup>
                <DropdownMenuItem
                  className='cursor-pointer flex items-center gap-2'
                  onClick={handleHealthProbe}
                  disabled={isChecking}
                >
                  {backendHealthy ? (
                    <ShieldCheck className='size-4 text-emerald-500' />
                  ) : (
                    <AlertCircle className='size-4 text-amber-500' />
                  )}
                  <span>探测后端健康状态</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  className='cursor-pointer flex items-center gap-2'
                  onClick={handleCheckPoints}
                >
                  <Coins className='size-4 text-amber-500' />
                  <span>查询全池剩余积分</span>
                </DropdownMenuItem>
              </DropdownMenuGroup>

              <DropdownMenuSeparator />

              {/* 凭据管理 */}
              <DropdownMenuItem
                variant='destructive'
                className='cursor-pointer flex items-center gap-2'
                onClick={() => setOpen(true)}
              >
                <LogOut className='size-4' />
                <span>清除令牌并退出</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <SignOutDialog open={!!open} onOpenChange={setOpen} />
    </>
  )
}
