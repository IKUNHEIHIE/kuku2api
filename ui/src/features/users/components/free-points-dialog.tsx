'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Gift,
  RotateCw,
  Coins,
  CheckCircle2,
  Clock,
  Sparkles,
  Play,
  Calendar,
  MessageSquare,
  Loader2,
  Filter,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import {
  kukuApi,
  type AccountFreePointTasks,
  type AutoClaimResponse,
} from '@/lib/kuku-api'
import { useUsers } from './users-provider'

interface FreePointsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultAccountId?: string | null
}

export function FreePointsDialog({ open, onOpenChange, defaultAccountId }: FreePointsDialogProps) {
  const { refreshAccounts, runPointsCheck, setAutoClaimState } = useUsers()

  const [loading, setLoading] = useState(false)
  const [taskAccounts, setTaskAccounts] = useState<AccountFreePointTasks[]>([])
  const [autoClaim, setAutoClaim] = useState<AutoClaimResponse | null>(null)
  const [runChat, setRunChat] = useState<boolean>(false)
  const [claiming, setClaiming] = useState<string | null>(null)
  const [runningAutoClaim, setRunningAutoClaim] = useState(false)
  const [updatingAutoClaim, setUpdatingAutoClaim] = useState(false)
  const [userSelectedAccount, setUserSelectedAccount] = useState<string | null>(null)
  const selectedFilterAccount = userSelectedAccount ?? defaultAccountId ?? 'all'
  const [executionReport, setExecutionReport] = useState<{
    timestamp: string
    source: 'manual' | 'auto-claim'
    totalEarned: number
    accounts: Array<{
      id: string
      alias?: string
      ok: boolean
      points_earned: number
      message?: string
      notes?: string | string[]
      claimed?: Array<{ task_key?: string | null; task_type?: string | null; claimed_point?: number; claim_status?: string | null }>
      reported?: string[]
    }>
  } | null>(null)

  const loadData = useCallback(async () => {
    try {
      setLoading(true)
      const [tasksRes, autoClaimRes] = await Promise.all([
        kukuApi.getFreePointTasks().catch((err) => {
          toast.error('获取免费积分任务失败: ' + (err instanceof Error ? err.message : String(err)))
          return { accounts: [] }
        }),
        kukuApi.getAutoClaim().catch((err) => {
          toast.error('获取定时任务状态失败: ' + (err instanceof Error ? err.message : String(err)))
          return { configured: false, enabled: false, hour: 9 }
        }),
      ])
      setTaskAccounts(tasksRes.accounts || [])
      setAutoClaim(autoClaimRes)
      setAutoClaimState(autoClaimRes)
    } finally {
      setLoading(false)
    }
  }, [setAutoClaimState])

  useEffect(() => {
    if (open) {
      void loadData()
    }
  }, [open, loadData])

  // Handle toggling auto-claim enabled state
  const handleToggleAutoClaim = async (newEnabled: boolean) => {
    try {
      setUpdatingAutoClaim(true)
      const hour = autoClaim?.hour ?? 9
      const res = await kukuApi.configureAutoClaim({ enabled: newEnabled, hour })
      if (res.ok) {
        setAutoClaim((prev) => (prev ? { ...prev, ...res.auto_claim } : null))
        setAutoClaimState(res.auto_claim)
        toast.success(newEnabled ? '每日自动领取任务已开启' : '每日自动领取任务已关闭')
      }
    } catch (err: unknown) {
      toast.error('更新自动领取开关失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setUpdatingAutoClaim(false)
    }
  }

  // Handle updating hour
  const handleChangeHour = async (newHourStr: string) => {
    const hour = parseInt(newHourStr, 10)
    if (Number.isNaN(hour)) return
    try {
      setUpdatingAutoClaim(true)
      const enabled = autoClaim?.enabled ?? false
      const res = await kukuApi.configureAutoClaim({ enabled, hour })
      if (res.ok) {
        setAutoClaim((prev) => (prev ? { ...prev, ...res.auto_claim } : null))
        setAutoClaimState(res.auto_claim)
        toast.success(`执行时间已更新为每天 ${hour.toString().padStart(2, '0')}:00`)
      }
    } catch (err: unknown) {
      toast.error('更新执行时间失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setUpdatingAutoClaim(false)
    }
  }

  // Run auto-claim right now
  const handleRunAutoClaimNow = async () => {
    try {
      setRunningAutoClaim(true)
      const res = await kukuApi.runAutoClaim()
      if (res.ok && res.result) {
        const total = res.result.accounts.reduce((n, a) => n + (a.points_earned || 0), 0)
        const accountsReport = res.result.accounts.map((a) => ({
          id: a.id,
          ok: a.ok,
          points_earned: a.points_earned || 0,
          message: a.message,
          notes: a.notes,
          claimed: (a.claimed || []).map((c) => ({ task_key: c, claimed_point: 0 })),
        }))

        setExecutionReport({
          timestamp: new Date().toLocaleTimeString(),
          source: 'auto-claim',
          totalEarned: total,
          accounts: accountsReport,
        })

        const failedAccounts = accountsReport.filter((a) => !a.ok)
        if (failedAccounts.length > 0) {
          toast.warning(`定时任务执行完成：部分账号失败 (${failedAccounts.map((a) => a.id).join(', ')})，共获得 ${total} 积分`)
        } else if (total > 0) {
          toast.success(`定时任务执行成功！共获得 ${total} 积分`)
        } else {
          toast.info('定时任务执行完毕：各账号今日已无新增可领积分')
        }

        await Promise.all([loadData(), refreshAccounts(), runPointsCheck()])
      }
    } catch (err: unknown) {
      toast.error('执行每日任务失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setRunningAutoClaim(false)
    }
  }

  // Claim free points (supports single account or all, forceChat specifies whether to run minimal turn)
  const handleClaim = async (accountId?: string, forceChat?: boolean) => {
    const isChat = forceChat !== undefined ? forceChat : runChat
    const claimingKey = accountId ? (isChat ? `${accountId}-chat` : `${accountId}-base`) : 'all'
    try {
      setClaiming(claimingKey)
      const res = await kukuApi.claimFreePoints({
        id: accountId,
        chat: isChat,
      })
      if (res.ok) {
        const total = res.points_earned ?? 0
        const accountsReport = (res.accounts || []).map((a) => ({
          id: a.id,
          alias: a.alias,
          ok: a.ok,
          points_earned: a.points_earned ?? 0,
          message: a.message,
          notes: a.notes,
          claimed: a.claimed || [],
          reported: a.reported || [],
        }))

        setExecutionReport({
          timestamp: new Date().toLocaleTimeString(),
          source: 'manual',
          totalEarned: total,
          accounts: accountsReport,
        })

        const targetDesc = accountId ? `账号 ${accountId}` : '所有账号'
        const failedCount = accountsReport.filter((a) => !a.ok).length
        const chatFailed = isChat && accountsReport.some((a) => a.notes && String(a.notes).includes('CHAT') && String(a.notes).includes('失败'))

        if (failedCount > 0) {
          toast.warning(`${targetDesc} 领取完成：遇到部分异常，本次共获得 ${total} 积分，详见诊断说明`)
        } else if (chatFailed) {
          toast.warning(`${targetDesc} 基础任务已处理，但 CHAT 对话任务上报异常，本次共获得 ${total} 积分`)
        } else if (total > 0) {
          toast.success(`${targetDesc} 成功领取 ${total} 积分！`)
        } else {
          toast.info(`${targetDesc} 操作完成：今日已无新增可领积分（已领取过或未达标）`)
        }

        await Promise.all([loadData(), refreshAccounts(), runPointsCheck(accountId)])
      }
    } catch (err: unknown) {
      toast.error('领取积分失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setClaiming(null)
    }
  }

  // Calculate total claimable points across all accounts
  const totalClaimablePoints = taskAccounts.reduce((acc, a) => {
    const accountSum = (a.tasks || []).reduce((sum, t) => sum + (t.claimable_point > 0 ? t.claimable_point : 0), 0)
    return acc + accountSum
  }, 0)

  // Can single account claim in batch mode?
  const canAccountClaim = (a: AccountFreePointTasks) => {
    const hasClaimable = (a.tasks || []).some((t) => t.claimable_point > 0)
    const hasChatTask = runChat && (a.tasks || []).some((t) => (t.task_type === 'CHAT' || t.task_key === 'daily_chat') && t.task_status !== 'FINISHED')
    return hasClaimable || hasChatTask
  }

  const canClaimAny = taskAccounts.some((a) => canAccountClaim(a))

  const formatDateTime = (ts?: number | null) => {
    if (!ts) return '—'
    return new Date(ts).toLocaleString()
  }

  // Displayed accounts based on filter selector
  const displayedAccounts =
    selectedFilterAccount === 'all'
      ? taskAccounts
      : taskAccounts.filter((a) => a.id === selectedFilterAccount)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-3xl max-h-[90vh] overflow-y-auto'>
        <DialogHeader className='text-start'>
          <div className='flex items-center justify-between'>
            <DialogTitle className='flex items-center gap-2 text-xl font-bold'>
              <Gift className='size-5 text-amber-500' />
              <span>免费积分管理</span>
            </DialogTitle>
            <Button
              variant='ghost'
              size='sm'
              onClick={() => void loadData()}
              disabled={loading}
              className='h-8 gap-1.5 text-xs'
            >
              <RotateCw size={14} className={loading ? 'animate-spin' : ''} />
              <span>刷新任务</span>
            </Button>
          </div>
          <DialogDescription className='text-xs'>
            百度账号每日签到与对话免费额度（安全隔离不碰 passport）。支持对单号或全部账号分别进行对话任务与签到积分领取。
          </DialogDescription>
        </DialogHeader>

        <div className='space-y-5 py-2'>
          {/* Section 1: Auto Claim Scheduler */}
          <div className='rounded-lg border bg-card p-4 shadow-xs space-y-3.5'>
            <div className='flex flex-wrap items-center justify-between gap-2 border-b pb-3'>
              <div className='flex items-center gap-2'>
                <Calendar className='size-4 text-primary' />
                <span className='font-semibold text-sm'>每日自动领取定时器</span>
                <Badge
                  variant={autoClaim?.enabled ? 'default' : 'secondary'}
                  className='text-[10px]'
                >
                  {autoClaim?.enabled ? '已开启' : '已关闭'}
                </Badge>
              </div>

              <div className='flex items-center gap-2'>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => void handleRunAutoClaimNow()}
                  disabled={runningAutoClaim || loading}
                  className='h-8 text-xs gap-1.5'
                  title='立即执行一次每日领取任务'
                >
                  {runningAutoClaim ? (
                    <Loader2 size={13} className='animate-spin' />
                  ) : (
                    <Play size={13} className='text-emerald-500' />
                  )}
                  <span>立即执行一次</span>
                </Button>
              </div>
            </div>

            <div className='grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs'>
              {/* Left Column: Toggle & Hour */}
              <div className='space-y-3'>
                <div className='flex items-center justify-between gap-4'>
                  <div className='space-y-0.5'>
                    <Label className='text-xs font-semibold'>开启每日自动领取</Label>
                    <p className='text-[11px] text-muted-foreground'>
                      每天在指定整点自动为号池中各账号执行免费积分领取
                    </p>
                  </div>
                  <Switch
                    checked={autoClaim?.enabled ?? false}
                    onCheckedChange={(val) => void handleToggleAutoClaim(val)}
                    disabled={updatingAutoClaim || loading}
                  />
                </div>

                <div className='flex items-center justify-between gap-4'>
                  <div className='space-y-0.5'>
                    <Label className='text-xs font-semibold'>每日执行整点</Label>
                    <p className='text-[11px] text-muted-foreground'>
                      选择在哪个整点触发领取任务
                    </p>
                  </div>
                  <Select
                    value={String(autoClaim?.hour ?? 9)}
                    onValueChange={(val) => void handleChangeHour(val)}
                    disabled={updatingAutoClaim || loading}
                  >
                    <SelectTrigger className='w-28 h-8 text-xs'>
                      <SelectValue placeholder='选择小时' />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 24 }).map((_, h) => (
                        <SelectItem key={h} value={String(h)} className='text-xs font-mono'>
                          {h.toString().padStart(2, '0')}:00
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Right Column: Next Run & Last Result */}
              <div className='rounded-md border bg-muted/30 p-3 space-y-2 text-[11px]'>
                <div className='flex items-center justify-between'>
                  <span className='text-muted-foreground flex items-center gap-1'>
                    <Clock size={12} />
                    <span>下次预计执行时间:</span>
                  </span>
                  <span className='font-mono font-medium'>
                    {autoClaim?.enabled ? formatDateTime(autoClaim.next_run_at) : '未开启定时器'}
                  </span>
                </div>

                <div className='flex items-center justify-between'>
                  <span className='text-muted-foreground flex items-center gap-1'>
                    <CheckCircle2 size={12} />
                    <span>上次执行时间:</span>
                  </span>
                  <span className='font-mono font-medium'>
                    {formatDateTime(autoClaim?.last_run_at)}
                  </span>
                </div>

                {autoClaim?.last_result && (
                  <div className='pt-1 border-t border-border/50 text-muted-foreground'>
                    <span className='font-semibold text-foreground'>上次执行结果：</span>
                    <span className='font-mono'>耗时 {autoClaim.last_result.took_ms}ms</span>
                    <div className='mt-1 space-y-0.5'>
                      {autoClaim.last_result.accounts.map((acc) => (
                        <div key={acc.id} className='flex items-center justify-between font-mono'>
                          <span>{acc.id}:</span>
                          <span className='text-emerald-600 dark:text-emerald-400 font-semibold'>
                            +{acc.points_earned} pts ({acc.claimed.join(', ') || '已是最新'})
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Execution Report Panel */}
          {executionReport && (
            <div className='rounded-lg border bg-muted/30 p-3.5 space-y-2.5 text-xs animate-in fade-in-50'>
              <div className='flex items-center justify-between'>
                <div className='flex items-center gap-2 font-semibold'>
                  <Sparkles className='size-4 text-primary' />
                  <span>
                    本次{executionReport.source === 'auto-claim' ? '定时任务' : '手动领取'}执行诊断报告 ({executionReport.timestamp})
                  </span>
                </div>
                <Badge variant={executionReport.totalEarned > 0 ? 'default' : 'secondary'} className='text-[10px]'>
                  总计获得: +{executionReport.totalEarned} 积分
                </Badge>
              </div>

              <div className='space-y-2 pt-1'>
                {executionReport.accounts.map((acc) => (
                  <div key={acc.id} className='rounded-md border bg-card p-2.5 space-y-1.5'>
                    <div className='flex items-center justify-between'>
                      <div className='flex items-center gap-1.5 font-medium'>
                        <span className='font-mono'>{acc.alias || acc.id}</span>
                        {acc.ok ? (
                          <Badge variant='outline' className='text-[10px] text-emerald-600 border-emerald-500/30'>
                            执行成功
                          </Badge>
                        ) : (
                          <Badge variant='destructive' className='text-[10px]'>
                            异常
                          </Badge>
                        )}
                      </div>
                      <span className='font-mono font-semibold text-emerald-600 dark:text-emerald-400'>
                        +{acc.points_earned} 积分
                      </span>
                    </div>

                    {acc.message && (
                      <p className='text-[11px] text-destructive'>{acc.message}</p>
                    )}

                    {acc.notes && (
                      <p className='text-[11px] text-muted-foreground font-mono bg-muted/60 px-2 py-1 rounded break-all'>
                        诊断日志: {Array.isArray(acc.notes) ? acc.notes.join('; ') : String(acc.notes)}
                      </p>
                    )}

                    {acc.claimed && acc.claimed.length > 0 && (
                      <div className='flex flex-wrap gap-1 pt-0.5'>
                        {acc.claimed.map((c, i) => (
                          <span key={i} className='inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-primary/10 text-primary font-mono'>
                            {c.task_type || c.task_key}: {c.claimed_point ? `+${c.claimed_point}分` : c.claim_status || '已完成'}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Section 2: Manual Claim Controls (Batch All) */}
          <div className='flex flex-col gap-2.5 p-3.5 rounded-lg border bg-amber-500/5 border-amber-500/20'>
            <div className='flex flex-wrap items-center justify-between gap-3'>
              <div className='flex items-start gap-2.5 max-w-lg'>
                <Checkbox
                  id='chat-option'
                  checked={runChat}
                  onCheckedChange={(checked) => setRunChat(Boolean(checked))}
                  className='mt-1'
                />
                <div className='space-y-0.5'>
                  <Label htmlFor='chat-option' className='text-xs font-semibold cursor-pointer flex items-center gap-1.5'>
                    <MessageSquare size={13} className='text-amber-600 dark:text-amber-400' />
                    <span>全号池批量：完成一次对话再领 (chat: true)</span>
                  </Label>
                  <p className='text-[11px] text-muted-foreground leading-relaxed'>
                    ⚠️ 勾选后「一键领取所有账号」将自动为所有未完成日常对话的账号消耗一轮微型推理（仅花 ~0.01 积分）完成上游 <code className='font-mono font-semibold'>daily_chat</code> 任务，从而领取 <strong>50 免费积分</strong>。默认不勾选。
                  </p>
                </div>
              </div>

              <Button
                size='sm'
                onClick={() => void handleClaim()}
                disabled={claiming !== null || loading || !canClaimAny}
                className='gap-1.5 font-semibold text-xs shrink-0'
              >
                {claiming === 'all' ? (
                  <Loader2 size={14} className='animate-spin' />
                ) : (
                  <Sparkles size={14} />
                )}
                <span>一键领取所有账号积分 ({totalClaimablePoints} pts 可领)</span>
              </Button>
            </div>
            <div className='text-[11px] text-muted-foreground bg-muted/30 px-2.5 py-1.5 rounded border border-border/40'>
              💡 <strong>提示：</strong>若只想对某个<strong>单个账号</strong>执行对话任务或领取积分，请直接使用下方各账号卡片或任务列表中对应的专属操作按钮，不会影响其他账号。
            </div>
          </div>

          {/* Section 3: Accounts Task List & Single Account Controls */}
          <div className='space-y-3'>
            <div className='flex flex-wrap items-center justify-between gap-2 border-b pb-2.5'>
              <div className='flex items-center gap-2'>
                <Coins className='size-4 text-emerald-600 dark:text-emerald-400' />
                <span className='font-semibold text-sm'>账号任务详情与单号独立领取</span>
              </div>
              <div className='flex items-center gap-2'>
                <span className='text-xs text-muted-foreground flex items-center gap-1'>
                  <Filter size={12} />
                  <span>筛选展示账号:</span>
                </span>
                <Select
                  value={selectedFilterAccount}
                  onValueChange={(val) => setUserSelectedAccount(val)}
                >
                  <SelectTrigger className='h-8 w-44 text-xs font-mono'>
                    <SelectValue placeholder='全部账号' />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='all'>全部账号 ({taskAccounts.length})</SelectItem>
                    {taskAccounts.map((a) => (
                      <SelectItem key={a.id} value={a.id} className='text-xs font-mono'>
                        {a.alias ? `${a.alias} (${a.id})` : a.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {loading && taskAccounts.length === 0 && (
              <div className='flex flex-col items-center justify-center p-8 rounded-lg border bg-card text-muted-foreground gap-2'>
                <Loader2 className='size-6 animate-spin text-primary' />
                <span className='text-xs'>正在读取百度上游任务状态...</span>
              </div>
            )}

            {!loading && taskAccounts.length === 0 && (
              <div className='text-center p-8 rounded-lg border bg-card text-muted-foreground text-xs'>
                暂未获取到账号任务数据，请点击上方「刷新任务」或检查号池配置。
              </div>
            )}

            {!loading && displayedAccounts.map((account) => {
              const claimableSum = (account.tasks || []).reduce(
                (sum, t) => sum + (t.claimable_point > 0 ? t.claimable_point : 0),
                0
              )
              const chatTask = (account.tasks || []).find((t) => t.task_type === 'CHAT' || t.task_key === 'daily_chat')
              const isChatFinishedAndClaimed = chatTask
                ? (chatTask.task_status === 'FINISHED' && chatTask.claimable_point === 0)
                : false
              const isClaimingThisChat = claiming === `${account.id}-chat`
              const isClaimingThisBase = claiming === `${account.id}-base`

              return (
                <div key={account.id} className='rounded-lg border bg-card shadow-xs overflow-hidden'>
                  <div className='flex flex-wrap items-center justify-between gap-2 bg-muted/40 px-3.5 py-2.5 border-b'>
                    <div className='flex items-center gap-2'>
                      <span className='font-mono font-semibold text-xs'>{account.id}</span>
                      <span className='text-xs text-muted-foreground'>({account.alias || '无别名'})</span>
                      {account.ok ? (
                        <Badge variant='outline' className='text-[10px] border-emerald-500/40 text-emerald-600 dark:text-emerald-400'>
                          上游已连接
                        </Badge>
                      ) : (
                        <Badge variant='destructive' className='text-[10px]'>
                          {account.message || '获取失败'}
                        </Badge>
                      )}
                    </div>

                    <div className='flex flex-wrap items-center gap-2'>
                      <span className='text-xs font-mono text-muted-foreground mr-1'>
                        当前可领: <strong className='text-emerald-600 dark:text-emerald-400 font-semibold'>{claimableSum}</strong> pts
                      </span>

                      {/* 1. 对话任务专属单号按钮 */}
                      <Button
                        size='sm'
                        variant={isChatFinishedAndClaimed ? 'ghost' : 'default'}
                        onClick={() => void handleClaim(account.id, true)}
                        disabled={claiming !== null || isChatFinishedAndClaimed}
                        className={`h-7 text-xs gap-1.5 font-medium ${
                          isChatFinishedAndClaimed
                            ? 'text-muted-foreground'
                            : 'bg-amber-600 hover:bg-amber-700 text-white dark:bg-amber-600 dark:hover:bg-amber-700'
                        }`}
                        title={
                          isChatFinishedAndClaimed
                            ? '今日对话任务已完成且已领取'
                            : `仅对账号 ${account.id} 发送一轮微型对话，自动完成 daily_chat 并领取 50 积分`
                        }
                      >
                        {isClaimingThisChat ? (
                          <Loader2 size={12} className='animate-spin' />
                        ) : (
                          <MessageSquare size={12} />
                        )}
                        <span>{isChatFinishedAndClaimed ? '对话已领完' : '单号对话并领奖 (+50分)'}</span>
                      </Button>

                      {/* 2. 基础积分领取按钮 */}
                      {claimableSum > 0 && (
                        <Button
                          size='sm'
                          variant='outline'
                          onClick={() => void handleClaim(account.id, false)}
                          disabled={claiming !== null}
                          className='h-7 text-xs gap-1 border-emerald-500/30 text-emerald-600 dark:text-emerald-400'
                          title={`仅领取账号 ${account.id} 当前已满足条件的任务积分（不触发对话）`}
                        >
                          {isClaimingThisBase ? (
                            <Loader2 size={12} className='animate-spin' />
                          ) : (
                            <Gift size={12} />
                          )}
                          <span>领现有积分 ({claimableSum})</span>
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Tasks Table with Single-Task Action Column */}
                  <div className='overflow-x-auto'>
                    <Table>
                      <TableHeader>
                        <TableRow className='text-[11px]'>
                          <TableHead className='h-8'>任务名称</TableHead>
                          <TableHead className='h-8 w-[90px]'>类型</TableHead>
                          <TableHead className='h-8 w-[80px] text-right'>单次奖励</TableHead>
                          <TableHead className='h-8 w-[80px] text-right'>当前可领</TableHead>
                          <TableHead className='h-8 w-[100px] text-center'>上游进度状态</TableHead>
                          <TableHead className='h-8 w-[150px] text-right'>单项操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(account.tasks || []).length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={6} className='h-12 text-center text-xs text-muted-foreground'>
                              暂无可用任务
                            </TableCell>
                          </TableRow>
                        ) : (
                          (account.tasks || []).map((t, idx) => {
                            const isChatTask = t.task_type === 'CHAT' || t.task_key === 'daily_chat'
                            return (
                              <TableRow key={idx} className='text-xs hover:bg-muted/30'>
                                <TableCell className='font-medium py-2'>
                                  <div className='flex items-center gap-1.5'>
                                    <span>{t.task_name || t.task_key}</span>
                                    <span className='font-mono text-[10px] text-muted-foreground'>({t.task_key})</span>
                                  </div>
                                </TableCell>
                                <TableCell className='font-mono text-[11px] py-2'>
                                  {t.task_type}
                                </TableCell>
                                <TableCell className='text-right font-mono text-[11px] py-2'>
                                  {t.reward_point} pts
                                </TableCell>
                                <TableCell className='text-right font-mono py-2'>
                                  {t.claimable_point > 0 ? (
                                    <span className='font-bold text-emerald-600 dark:text-emerald-400'>
                                      +{t.claimable_point} pts
                                    </span>
                                  ) : (
                                    <span className='text-muted-foreground'>0</span>
                                  )}
                                </TableCell>
                                <TableCell className='text-center py-2'>
                                  <Badge
                                    variant={t.task_status === 'FINISHED' ? 'secondary' : 'outline'}
                                    className='text-[10px]'
                                  >
                                    {t.task_status}
                                  </Badge>
                                </TableCell>
                                <TableCell className='text-right py-2'>
                                  {isChatTask ? (
                                    t.claimable_point > 0 ? (
                                      <Button
                                        size='sm'
                                        variant='default'
                                        onClick={() => void handleClaim(account.id, false)}
                                        disabled={claiming !== null}
                                        className='h-6 text-[11px] px-2 gap-1 bg-emerald-600 hover:bg-emerald-700'
                                        title='直接领取已达标的 50 积分'
                                      >
                                        <Gift size={11} />
                                        <span>领取 50 分</span>
                                      </Button>
                                    ) : t.task_status !== 'FINISHED' ? (
                                      <Button
                                        size='sm'
                                        variant='outline'
                                        onClick={() => void handleClaim(account.id, true)}
                                        disabled={claiming !== null}
                                        className='h-6 text-[11px] px-2 gap-1 border-amber-500/40 text-amber-700 dark:text-amber-300 hover:bg-amber-500/10'
                                        title={`对此账号 (${account.id}) 发送对话并领奖`}
                                      >
                                        {isClaimingThisChat ? (
                                          <Loader2 size={11} className='animate-spin' />
                                        ) : (
                                          <MessageSquare size={11} />
                                        )}
                                        <span>发对话领 50 分</span>
                                      </Button>
                                    ) : (
                                      <span className='text-[11px] text-muted-foreground font-mono inline-flex items-center gap-1'>
                                        <CheckCircle2 size={12} className='text-emerald-500' />
                                        <span>今日已领完</span>
                                      </span>
                                    )
                                  ) : t.claimable_point > 0 ? (
                                    <Button
                                      size='sm'
                                      variant='outline'
                                      onClick={() => void handleClaim(account.id, false)}
                                      disabled={claiming !== null}
                                      className='h-6 text-[11px] px-2 gap-1 border-emerald-500/30 text-emerald-600 dark:text-emerald-400'
                                      title='领取该任务积分'
                                    >
                                      <Gift size={11} />
                                      <span>领取 +{t.claimable_point}</span>
                                    </Button>
                                  ) : (
                                    <span className='text-[11px] text-muted-foreground'>
                                      {t.task_status === 'FINISHED' ? '已达成' : '未满足'}
                                    </span>
                                  )}
                                </TableCell>
                              </TableRow>
                            )
                          })
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
