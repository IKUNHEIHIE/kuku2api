import React, { useState, useEffect, useCallback } from 'react'
import useDialogState from '@/hooks/use-dialog-state'
import {
  kukuApi,
  type Account,
  type AccountHealthResult,
  type AccountPointsResult,
  type AutoClaimState,
} from '@/lib/kuku-api'
import { toast } from 'sonner'

export type UsersDialogType = 'add' | 'edit' | 'delete' | 'resequence' | 'free-points'

export type UsersContextType = {
  open: UsersDialogType | null
  setOpen: (str: UsersDialogType | null) => void
  addTab: 'qr' | 'sms' | 'manual'
  setAddTab: React.Dispatch<React.SetStateAction<'qr' | 'sms' | 'manual'>>
  openAddDialog: (tab?: 'qr' | 'sms' | 'manual') => void
  openFreePointsDialog: (accountId?: string) => void
  selectedClaimAccountId: string | null
  setSelectedClaimAccountId: React.Dispatch<React.SetStateAction<string | null>>
  claimAccountPoints: (accountId: string, chat?: boolean) => Promise<boolean>
  currentRow: Account | null
  setCurrentRow: React.Dispatch<React.SetStateAction<Account | null>>
  accounts: Account[]
  loading: boolean
  checkingHealth: boolean
  healthResults: Record<string, AccountHealthResult>
  checkingPoints: boolean
  pointsResults: Record<string, AccountPointsResult>
  totalBalancePoints: number | null
  adminEnabled: boolean
  activeSessions: number
  apiOpen: boolean
  apiKeyCount: number
  autoClaimState: AutoClaimState | null
  setAutoClaimState: React.Dispatch<React.SetStateAction<AutoClaimState | null>>
  gap: boolean
  setGap: (gap: boolean) => void
  refreshAccounts: () => Promise<void>
  runHealthCheck: (accountId?: string) => Promise<void>
  runPointsCheck: (accountId?: string) => Promise<void>
  resetCooldown: (accountId?: string) => Promise<void>
  resequence: () => Promise<void>
  deleteAccount: (id: string) => Promise<void>
}

const UsersContext = React.createContext<UsersContextType | null>(null)

function detectPriorityGap(accountsList: Account[]): boolean {
  if (accountsList.length === 0) return false
  const sorted = [...accountsList].map((a) => a.priority).sort((a, b) => a - b)
  return sorted.some((p, index) => p !== index)
}

export function UsersProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useDialogState<UsersDialogType>(null)
  const [addTab, setAddTab] = useState<'qr' | 'sms' | 'manual'>('qr')
  const [currentRow, setCurrentRow] = useState<Account | null>(null)
  const [selectedClaimAccountId, setSelectedClaimAccountId] = useState<string | null>(null)

  const openAddDialog = useCallback((tab: 'qr' | 'sms' | 'manual' = 'qr') => {
    setCurrentRow(null)
    setAddTab(tab)
    setOpen('add')
  }, [setOpen])

  const openFreePointsDialog = useCallback((accountId?: string) => {
    setSelectedClaimAccountId(accountId || null)
    setOpen('free-points')
  }, [setOpen])

  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [checkingHealth, setCheckingHealth] = useState(false)
  const [healthResults, setHealthResults] = useState<Record<string, AccountHealthResult>>({})
  const [checkingPoints, setCheckingPoints] = useState(false)
  const [pointsResults, setPointsResults] = useState<Record<string, AccountPointsResult>>({})
  const [totalBalancePoints, setTotalBalancePoints] = useState<number | null>(null)
  const [adminEnabled, setAdminEnabled] = useState(false)
  const [activeSessions, setActiveSessions] = useState(0)
  const [apiOpen, setApiOpen] = useState(false)
  const [apiKeyCount, setApiKeyCount] = useState(0)
  const [autoClaimState, setAutoClaimState] = useState<AutoClaimState | null>(null)
  const [gap, setGap] = useState(false)

  const refreshAccounts = useCallback(async () => {
    try {
      setLoading(true)
      const [state, points] = await Promise.all([
        kukuApi.getPoolState(),
        kukuApi.getPoolPoints().catch(() => null),
      ])
      const accs = state.accounts || []
      setAccounts(accs)
      setAdminEnabled(state.admin_enabled)
      setActiveSessions(state.sessions || 0)
      setApiOpen(state.api_open ?? false)
      setApiKeyCount(state.api_key_count ?? 0)
      setAutoClaimState(state.auto_claim ?? null)
      setGap(detectPriorityGap(accs))
      if (points) {
        setTotalBalancePoints(points.total_balance_points)
        const pMap: Record<string, AccountPointsResult> = {}
        for (const item of points.accounts) {
          pMap[item.id] = item
        }
        setPointsResults(pMap)
      }
    } catch (err: unknown) {
      toast.error('拉取号池状态失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let ignore = false
    void (async () => {
      try {
        const [state, points] = await Promise.all([
          kukuApi.getPoolState(),
          kukuApi.getPoolPoints().catch(() => null),
        ])
        if (!ignore) {
          const accs = state.accounts || []
          setAccounts(accs)
          setAdminEnabled(state.admin_enabled)
          setActiveSessions(state.sessions || 0)
          setApiOpen(state.api_open ?? false)
          setApiKeyCount(state.api_key_count ?? 0)
          setAutoClaimState(state.auto_claim ?? null)
          setGap(detectPriorityGap(accs))
          if (points) {
            setTotalBalancePoints(points.total_balance_points)
            const pMap: Record<string, AccountPointsResult> = {}
            for (const item of points.accounts) {
              pMap[item.id] = item
            }
            setPointsResults(pMap)
          }
        }
      } catch (err: unknown) {
        if (!ignore) {
          toast.error('拉取号池状态失败: ' + (err instanceof Error ? err.message : String(err)))
        }
      } finally {
        if (!ignore) {
          setLoading(false)
        }
      }
    })()
    return () => {
      ignore = true
    }
  }, [])

  const runHealthCheck = async (accountId?: string) => {
    try {
      setCheckingHealth(true)
      const res = await kukuApi.getPoolHealth(accountId)
      setHealthResults((prev) => {
        const next = { ...prev }
        for (const item of res.accounts) {
          next[item.id] = item
        }
        return next
      })
      
      const allOk = res.accounts.every((a) => a.ok)
      if (allOk) {
        toast.success(accountId ? `账号 ${accountId} 体检通过，登录态有效` : '号池全量体检通过，所有账号登录态有效')
      } else {
        const dead = res.accounts.filter((a) => !a.ok)
        toast.error(`体检发现 ${dead.length} 个账号异常: ${dead.map((d) => d.id).join(', ')}`)
      }
      await refreshAccounts()
    } catch (err: unknown) {
      toast.error('体检请求失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setCheckingHealth(false)
    }
  }

  const runPointsCheck = useCallback(
    async (accountId?: string) => {
      try {
        setCheckingPoints(true)
        const res = await kukuApi.getPoolPoints(accountId)
        setPointsResults((prev) => {
          const next = { ...prev }
          for (const item of res.accounts) {
            next[item.id] = item
          }
          return next
        })
        if (!accountId) {
          setTotalBalancePoints(res.total_balance_points)
        }
        const dead = res.accounts.filter((a) => !a.ok)
        if (dead.length > 0) {
          toast.warning(
            `查询积分发现 ${dead.length} 个账号异常 (可能是凭据失效): ${dead.map((d) => d.id).join(', ')}`
          )
          await refreshAccounts()
        } else {
          toast.success(
            accountId
              ? `账号 ${accountId} 积分已刷新`
              : `全池积分查询完成，可用总积分: ${res.total_balance_points} pts`
          )
        }
      } catch (err: unknown) {
        toast.error('查询积分失败: ' + (err instanceof Error ? err.message : String(err)))
      } finally {
        setCheckingPoints(false)
      }
    },
    [refreshAccounts]
  )

  const resetCooldown = async (accountId?: string) => {
    try {
      const res = await kukuApi.resetCooldown(accountId)
      setAccounts(res.accounts || [])
      toast.success(accountId ? `已重置账号 ${accountId} 的冷却状态` : '已清空全池冷却状态')
      await refreshAccounts()
    } catch (err: unknown) {
      toast.error('重置冷却失败: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const resequence = async () => {
    try {
      const res = await kukuApi.resequenceAccounts()
      setAccounts(res.accounts || [])
      setGap(false)
      toast.success('序号重排完成，已连续紧凑压缩')
    } catch (err: unknown) {
      toast.error('序号重排失败: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const deleteAccount = async (id: string) => {
    try {
      const res = await kukuApi.deleteAccount(id)
      setAccounts(res.accounts || [])
      if (res.gap) {
        setGap(true)
        toast.warning(`账号 ${id} 已删除。检测到优先级序号存在空洞，建议顺手重排序号。`, {
          action: {
            label: '重排序号',
            onClick: () => {
              void resequence()
            },
          },
        })
      } else {
        toast.success(`账号 ${id} 已成功删除`)
      }
    } catch (err: unknown) {
      toast.error('删除账号失败: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const claimAccountPoints = useCallback(
    async (accountId: string, chat = false) => {
      try {
        const chatLabel = chat ? '（执行微型对话）' : ''
        toast.info(`正在为账号 ${accountId} 领取免费积分${chatLabel}...`)
        const res = await kukuApi.claimFreePoints({ id: accountId, chat })
        if (res.ok) {
          const earned = res.points_earned ?? 0
          const acct = res.accounts?.find((a) => a.id === accountId)
          if (acct?.ok) {
            toast.success(`账号 ${accountId} 领取成功！获得 +${earned} 积分`)
          } else if (earned > 0) {
            toast.warning(`账号 ${accountId} 获得 +${earned} 积分，部分任务未完成: ${acct?.notes ? String(acct.notes) : ''}`)
          } else {
            toast.info(`账号 ${accountId} 本次无新增可领积分: ${acct?.notes ? String(acct.notes) : '已达上限或未满足条件'}`)
          }
          await Promise.all([refreshAccounts(), runPointsCheck(accountId)])
          return true
        }
        return false
      } catch (err: unknown) {
        toast.error(`账号 ${accountId} 领取失败: ` + (err instanceof Error ? err.message : String(err)))
        return false
      }
    },
    [refreshAccounts, runPointsCheck]
  )

  return (
    <UsersContext
      value={{
        open,
        setOpen,
        addTab,
        setAddTab,
        openAddDialog,
        openFreePointsDialog,
        selectedClaimAccountId,
        setSelectedClaimAccountId,
        claimAccountPoints,
        currentRow,
        setCurrentRow,
        accounts,
        loading,
        checkingHealth,
        healthResults,
        checkingPoints,
        pointsResults,
        totalBalancePoints,
        adminEnabled,
        activeSessions,
        apiOpen,
        apiKeyCount,
        autoClaimState,
        setAutoClaimState,
        gap,
        setGap,
        refreshAccounts,
        runHealthCheck,
        runPointsCheck,
        resetCooldown,
        resequence,
        deleteAccount,
      }}
    >
      {children}
    </UsersContext>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export const useUsers = () => {
  const usersContext = React.useContext(UsersContext)
  if (!usersContext) {
    throw new Error('useUsers has to be used within <UsersContext>')
  }
  return usersContext
}
