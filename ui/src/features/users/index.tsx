import { getRouteApi, Link } from '@tanstack/react-router'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import { UsersDialogs } from './components/users-dialogs'
import { UsersPrimaryButtons } from './components/users-primary-buttons'
import { UsersProvider, useUsers } from './components/users-provider'
import { UsersTable } from './components/users-table'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { AlertCircle, AlertTriangle, Activity, Users as UsersIcon, CheckCircle2, Clock, Coins, Gift } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

const route = getRouteApi('/_authenticated/users/')

function UsersContent({
  search,
  navigate,
}: {
  search: Record<string, unknown>
  navigate: ReturnType<typeof route.useNavigate>
}) {
  const {
    accounts,
    adminEnabled,
    activeSessions,
    totalBalancePoints,
    apiOpen,
    gap,
    resequence,
    autoClaimState,
    openFreePointsDialog,
  } = useUsers()

  const activeCount = accounts.filter(
    (a) => !a.disabled && !a.auth_dead && !a.balance_dead && a.cooldown_remaining_ms === 0
  ).length
  const coolingCount = accounts.filter((a) => a.cooldown_remaining_ms > 0).length
  const deadCount = accounts.filter((a) => a.auth_dead).length
  const balanceDeadCount = accounts.filter((a) => a.balance_dead).length
  const allBalanceDead = accounts.length > 0 && accounts.every((a) => a.balance_dead)

  return (
    <>
      <Header fixed>
        <Search className='me-auto' />
        <ThemeSwitch />
        <ConfigDrawer />
      </Header>

      <Main className='flex flex-1 flex-col gap-4 sm:gap-6'>
        {apiOpen && (
          <Alert variant='destructive' className='flex flex-wrap items-center justify-between border-amber-500/60 bg-amber-500/10 text-amber-950 dark:text-amber-200'>
            <div className='flex items-center gap-2'>
              <AlertTriangle className='size-5 text-amber-600 dark:text-amber-400 shrink-0' />
              <div>
                <AlertTitle className='font-bold text-sm'>
                  ⚠️ 警告：当前 API 处于完全开放模式 (未开启密钥鉴权)
                </AlertTitle>
                <AlertDescription className='text-xs leading-relaxed'>
                  当前号池中未配置任何有效 API 密钥，/v1/* 推理接口允许任何客户端免密调用。请及时前往「API 密钥」生成访问令牌以启用鉴权保护。
                </AlertDescription>
              </div>
            </div>
            <Button
              size='sm'
              variant='outline'
              asChild
              className='border-amber-600 bg-background text-amber-800 hover:bg-amber-100 dark:hover:bg-amber-950 mt-2 sm:mt-0'
            >
              <Link to='/keys'>前往配置 API 密钥</Link>
            </Button>
          </Alert>
        )}

        {gap && (
          <Alert variant='destructive' className='flex items-center justify-between border-amber-500/50 bg-amber-500/10 text-amber-900 dark:text-amber-200'>
            <div className='flex items-center gap-2'>
              <AlertCircle className='size-5 text-amber-600 dark:text-amber-400' />
              <div>
                <AlertTitle className='font-semibold'>优先级序号存在空洞</AlertTitle>
                <AlertDescription className='text-xs'>
                  此前删号操作留下了非连续的序号，建议进行一键重排以保证 0..N-1 连续紧凑。
                </AlertDescription>
              </div>
            </div>
            <Button
              size='sm'
              variant='outline'
              onClick={() => resequence()}
              disabled={!adminEnabled}
              title={!adminEnabled ? '服务端未开启管理端 (未配置 ADMIN_TOKEN)' : '一键重排序号'}
              className='border-amber-600 bg-background text-amber-700 hover:bg-amber-100 dark:hover:bg-amber-950'
            >
              一键重排序号
            </Button>
          </Alert>
        )}

        {allBalanceDead && (
          <Alert variant='destructive' className='flex flex-wrap items-center justify-between border-amber-500/80 bg-amber-500/15 text-amber-950 dark:text-amber-200'>
            <div className='flex items-center gap-2'>
              <Coins className='size-5 text-amber-600 dark:text-amber-400 shrink-0' />
              <div>
                <AlertTitle className='font-bold text-sm'>
                  ⚠️ 提示：所有账号积分均已耗尽 (等待自动重试中)
                </AlertTitle>
                <AlertDescription className='text-xs leading-relaxed'>
                  当前号池内所有账号均已触发积分不足窗口（推理接口将返回 402 insufficient_balance）。新号换出 STOKEN 也可能在几分钟生效期内处于该状态。账号将在窗口结束后自动重试轮换，切勿删号重扫；您也可前往【免费积分】领取每日额度。
                </AlertDescription>
              </div>
            </div>
            <Button
              size='sm'
              variant='outline'
              onClick={() => openFreePointsDialog()}
              disabled={!adminEnabled}
              className='border-amber-600 bg-background text-amber-800 hover:bg-amber-100 dark:hover:bg-amber-950 mt-2 sm:mt-0 gap-1.5'
            >
              <Gift size={14} className='text-amber-500' />
              <span>前往领取免费积分</span>
            </Button>
          </Alert>
        )}

        <div className='flex flex-wrap items-end justify-between gap-4'>
          <div>
            <div className='flex items-center gap-2'>
              <h2 className='text-2xl font-bold tracking-tight'>号池管理</h2>
              <Badge variant={adminEnabled ? 'default' : 'secondary'} className='text-xs'>
                {adminEnabled ? '管理端已启用' : '管理端未配置'}
              </Badge>
            </div>
            <p className='text-sm text-muted-foreground mt-1'>
              管理百度账号池，维护凭据、体检状态与优先级队列（序号越小越优先调度，先榨干最小序号档）。
            </p>
          </div>
          <UsersPrimaryButtons />
        </div>

        {/* Quick summary stats chips */}
        <div className='flex flex-wrap items-center gap-3 text-xs'>
          <div className='flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-muted-foreground shadow-xs'>
            <UsersIcon size={14} className='text-primary' />
            <span>账号总数:</span>
            <span className='font-semibold text-foreground'>{accounts.length}</span>
          </div>

          <div className='flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-muted-foreground shadow-xs'>
            <CheckCircle2 size={14} className='text-emerald-500' />
            <span>正常可用:</span>
            <span className='font-semibold text-emerald-600 dark:text-emerald-400'>{activeCount}</span>
          </div>

          {coolingCount > 0 && (
            <div className='flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-amber-700 dark:text-amber-400'>
              <Clock size={14} />
              <span>冷却中:</span>
              <span className='font-semibold'>{coolingCount}</span>
            </div>
          )}

          {balanceDeadCount > 0 && (
            <div className='flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-amber-800 dark:text-amber-300 shadow-xs'>
              <Coins size={14} className='text-amber-600 dark:text-amber-400' />
              <span>积分耗尽 (自动等待重试):</span>
              <span className='font-semibold'>{balanceDeadCount}</span>
            </div>
          )}

          {deadCount > 0 && (
            <div className='flex items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-destructive'>
              <AlertCircle size={14} />
              <span>登录失效 (Auth Dead):</span>
              <span className='font-semibold'>{deadCount}</span>
            </div>
          )}

          {totalBalancePoints !== null && (
            <div className='flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-emerald-700 dark:text-emerald-400 shadow-xs'>
              <Coins size={14} />
              <span>号池可用总积分:</span>
              <span className='font-mono font-semibold'>{totalBalancePoints} pts</span>
            </div>
          )}

          {/* Auto Claim State badge (from /pool/state) */}
          <div
            onClick={() => {
              if (adminEnabled) {
                openFreePointsDialog()
              }
            }}
            className={`flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-muted-foreground shadow-xs transition-colors ${
              adminEnabled ? 'cursor-pointer hover:border-primary/50' : 'cursor-default opacity-80'
            }`}
            title={adminEnabled ? '点击打开免费积分管理面板' : '服务端未开启管理端 (未配置 ADMIN_TOKEN)'}
          >
            <Gift size={14} className={autoClaimState?.enabled ? 'text-amber-500' : 'text-muted-foreground'} />
            <span>每日自动领积分:</span>
            <span className={`font-semibold ${autoClaimState?.enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
              {autoClaimState?.enabled
                ? `开启 (${(autoClaimState.hour ?? 9).toString().padStart(2, '0')}:00${autoClaimState.next_run_at ? ` · 下次 ${new Date(autoClaimState.next_run_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''})`
                : '关闭'}
            </span>
          </div>

          <div className='flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-muted-foreground shadow-xs'>
            <Activity size={14} className='text-blue-500' />
            <span>持久化会话数:</span>
            <span className='font-semibold text-foreground'>{activeSessions}</span>
          </div>
        </div>

        <UsersTable data={accounts} search={search} navigate={navigate} />
      </Main>

      <UsersDialogs />
    </>
  )
}

export function Users() {
  const search = route.useSearch()
  const navigate = route.useNavigate()

  return (
    <UsersProvider>
      <UsersContent search={search} navigate={navigate} />
    </UsersProvider>
  )
}
