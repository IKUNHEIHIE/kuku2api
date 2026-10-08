import { RefreshCw, Stethoscope, RotateCcw, ListOrdered, Plus, AlertCircle, Coins, QrCode, Smartphone, Gift } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUsers } from './users-provider'

export function UsersPrimaryButtons() {
  const {
    openAddDialog,
    openFreePointsDialog,
    refreshAccounts,
    runHealthCheck,
    runPointsCheck,
    resetCooldown,
    resequence,
    checkingHealth,
    checkingPoints,
    gap,
    adminEnabled,
  } = useUsers()

  const adminNotice = '服务端未开启管理端 (未配置 ADMIN_TOKEN)'

  return (
    <div className='flex flex-wrap items-center gap-2'>
      <Button
        variant='outline'
        size='sm'
        onClick={() => openFreePointsDialog()}
        disabled={!adminEnabled}
        title={!adminEnabled ? adminNotice : '管理每日免费积分领取与定时任务'}
        className='gap-1.5 border-amber-500/40 text-amber-700 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/40 font-semibold'
      >
        <Gift size={15} className='text-amber-500' />
        <span>免费积分</span>
      </Button>

      <Button
        variant='outline'
        size='sm'
        onClick={() => refreshAccounts()}
        className='gap-1.5'
      >
        <RefreshCw size={15} />
        <span>刷新状态</span>
      </Button>

      <Button
        variant='outline'
        size='sm'
        onClick={() => runPointsCheck()}
        disabled={checkingPoints}
        className='gap-1.5'
      >
        <Coins size={15} className={checkingPoints ? 'animate-spin text-emerald-500' : 'text-emerald-600 dark:text-emerald-400'} />
        <span>{checkingPoints ? '查积分中...' : '查询积分'}</span>
      </Button>

      <Button
        variant='outline'
        size='sm'
        onClick={() => runHealthCheck()}
        disabled={checkingHealth}
        className='gap-1.5'
      >
        <Stethoscope size={15} className={checkingHealth ? 'animate-spin text-primary' : ''} />
        <span>{checkingHealth ? '体检中...' : '全池体检'}</span>
      </Button>

      <Button
        variant='outline'
        size='sm'
        onClick={() => resetCooldown()}
        disabled={!adminEnabled}
        title={!adminEnabled ? adminNotice : '清空全部冷却'}
        className='gap-1.5'
      >
        <RotateCcw size={15} />
        <span>清空全部冷却</span>
      </Button>

      <Button
        variant={gap ? 'destructive' : 'outline'}
        size='sm'
        onClick={() => resequence()}
        disabled={!adminEnabled}
        title={!adminEnabled ? adminNotice : '一键重排序号'}
        className='gap-1.5'
      >
        {gap ? <AlertCircle size={15} /> : <ListOrdered size={15} />}
        <span>一键重排序号</span>
      </Button>

      <Button
        variant='outline'
        size='sm'
        onClick={() => openAddDialog('qr')}
        disabled={!adminEnabled}
        title={!adminEnabled ? adminNotice : '使用百度App扫码快速加号'}
        className='gap-1.5 border-blue-500/40 text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40'
      >
        <QrCode size={15} />
        <span>扫码加号</span>
      </Button>

      <Button
        variant='outline'
        size='sm'
        onClick={() => openAddDialog('sms')}
        disabled={!adminEnabled}
        title={!adminEnabled ? adminNotice : '使用手机验证码加号'}
        className='gap-1.5 border-emerald-500/40 text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/40'
      >
        <Smartphone size={15} />
        <span>短信加号</span>
      </Button>

      <Button
        size='sm'
        onClick={() => openAddDialog('manual')}
        disabled={!adminEnabled}
        title={!adminEnabled ? adminNotice : '添加账号 / 手动录入凭据'}
        className='gap-1.5'
      >
        <Plus size={16} />
        <span>添加账号</span>
      </Button>
    </div>
  )
}
