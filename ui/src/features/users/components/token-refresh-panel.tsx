import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { kukuApi, type TokenRefreshState } from '@/lib/kuku-api'
import { Button } from '@/components/ui/button'
import { useUsers } from './users-provider'

export function TokenRefreshPanel() {
  const { adminEnabled, refreshAccountStatus } = useUsers()
  const [state, setState] = useState<TokenRefreshState | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const revision = useRef(0)
  useEffect(() => {
    if (!adminEnabled) return
    mounted.current = true
    let ignore = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const version = revision.current
      try {
        const [result] = await Promise.all([
          kukuApi.getTokenRefresh(),
          refreshAccountStatus(),
        ])
        if (!ignore && version === revision.current) {
          setState(result.token_refresh)
          setError('')
        }
      } catch (err) {
        if (!ignore && version === revision.current)
          setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!ignore)
          timer = setTimeout(() => {
            void poll()
          }, 15_000)
      }
    }
    void poll()
    return () => {
      ignore = true
      mounted.current = false
      clearTimeout(timer)
    }
  }, [adminEnabled, refreshAccountStatus])

  const update = async (config: {
    enabled?: boolean
    interval_hours?: number
  }) => {
    if (pending) return
    revision.current++
    setPending(true)
    try {
      const result = await kukuApi.configureTokenRefresh(config)
      if (mounted.current) {
        setState(result.token_refresh)
        setError('')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      revision.current++
      if (mounted.current) setPending(false)
    }
  }
  const refresh = async () => {
    if (pending) return
    setPending(true)
    try {
      const result = await kukuApi.refreshAccountTokens()
      const failed = result.result.accounts.filter((a) => !a.ok).length
      const renewed = result.result.accounts.filter((a) => a.refreshed).length
      if (failed)
        toast.warning(
          `刷新完成：${renewed} 个账号已续期，${failed} 个账号需稍后重试或重新登录`
        )
      else
        toast.success(
          `刷新完成：${renewed} 个账号已续期，其余账号已检测登录状态`
        )
      await refreshAccountStatus()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      if (mounted.current) setPending(false)
    }
  }
  if (!adminEnabled) return null
  return (
    <section
      className='space-y-3 rounded-lg border p-4'
      aria-label='账号 Token 自动续期'
    >
      <div className='flex flex-wrap items-center gap-4'>
        <h2 className='font-semibold'>账号 Token 自动续期</h2>
        <label className='flex items-center gap-2 text-sm'>
          <input
            type='checkbox'
            checked={state?.enabled ?? false}
            disabled={!state || pending}
            onChange={(e) => void update({ enabled: e.target.checked })}
          />
          定时刷新
        </label>
        <label className='flex items-center gap-2 text-sm'>
          刷新周期
          <select
            className='rounded border bg-background p-1'
            value={state?.interval_hours ?? 6}
            disabled={!state || pending}
            onChange={(e) =>
              void update({ interval_hours: Number(e.target.value) })
            }
          >
            {[...new Set([1, 6, 12, 24, state?.interval_hours ?? 6])]
              .sort((a, b) => a - b)
              .map((hours) => (
                <option key={hours} value={hours}>
                  {hours} 小时
                </option>
              ))}
          </select>
        </label>
        <Button
          size='sm'
          variant='outline'
          disabled={!state || pending || state.running}
          onClick={() => void refresh()}
        >
          {pending || state?.running ? '正在依次刷新…' : '立即刷新全部'}
        </Button>
      </div>
      <p className='text-xs text-muted-foreground'>
        账号依次处理，间隔 15
        秒；正在对话或领取积分的账号稍后再试。续期不会发送模型对话。缺少 PTOKEN
        的旧账号只检测登录状态，重新扫码或短信登录可补齐自动续期凭据。
      </p>
      <p className='text-xs text-muted-foreground'>
        上次任务：
        {state?.last_run_at
          ? new Date(state.last_run_at).toLocaleString()
          : '尚未运行'}
        。上游未提供明确到期时间时，账号列表会显示检测与刷新时间。
      </p>
      {error && (
        <p role='status' className='text-xs text-destructive'>
          {error}
        </p>
      )}
    </section>
  )
}
