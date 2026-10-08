'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Clock,
  Smartphone,
  ChevronDown,
  ChevronRight,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { toast } from 'sonner'
import { kukuApi, type LoginQrPollResponse } from '@/lib/kuku-api'
import { useUsers } from './users-provider'

interface AddAccountQrProps {
  onSuccess?: () => void
}

type QrSessionState = 'idle' | 'loading' | 'pending' | 'scanned' | 'confirmed' | 'added' | 'expired' | 'failed'

export function AddAccountQr({ onSuccess }: AddAccountQrProps) {
  const { refreshAccounts, accounts } = useUsers()

  const defaultPriority = accounts.length > 0
    ? Math.max(...accounts.map((a) => a.priority)) + 1
    : 0

  const [alias, setAlias] = useState('')
  const [priority, setPriority] = useState<number>(defaultPriority)
  const [state, setState] = useState<QrSessionState>('idle')
  const [loginId, setLoginId] = useState<string | null>(null)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  const [probe, setProbe] = useState<unknown>(null)
  const [showProbe, setShowProbe] = useState(false)
  const [accountId, setAccountId] = useState<string | null>(null)
  const [expiresInSeconds, setExpiresInSeconds] = useState<number>(240)

  const aliasRef = useRef(alias)
  const priorityRef = useRef(priority)

  useEffect(() => {
    aliasRef.current = alias
    priorityRef.current = priority
  }, [alias, priority])

  const isPollingRef = useRef(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const currentBlobUrlRef = useRef<string | null>(null)
  const isDestroyedRef = useRef(false)

  const cleanupBlob = useCallback(() => {
    if (currentBlobUrlRef.current) {
      URL.revokeObjectURL(currentBlobUrlRef.current)
      currentBlobUrlRef.current = null
    }
    setBlobUrl(null)
  }, [])

  const stopPolling = useCallback(() => {
    isPollingRef.current = false
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current)
      countdownTimerRef.current = null
    }
  }, [])

  const pollLoop = useCallback(
    async (currentLoginId: string) => {
      while (isPollingRef.current && !isDestroyedRef.current) {
        const controller = new AbortController()
        abortControllerRef.current = controller
        try {
          const pollRes: LoginQrPollResponse = await kukuApi.pollLoginQr(currentLoginId, {
            signal: controller.signal,
          })
          if (!isPollingRef.current || isDestroyedRef.current) break

          if (pollRes.probe !== undefined) {
            setProbe(pollRes.probe)
          }

          if (pollRes.state === 'scanned') {
            setState('scanned')
          } else if (pollRes.state === 'confirmed') {
            setState('confirmed')
          } else if (pollRes.state === 'added') {
            setState('added')
            const newAccId = pollRes.account_id || null
            setAccountId(newAccId)
            stopPolling()

            // If user customized alias or priority while QR was showing, apply it
            if (newAccId && (aliasRef.current.trim() || priorityRef.current !== defaultPriority)) {
              try {
                await kukuApi.updateAccount(newAccId, {
                  alias: aliasRef.current.trim() || undefined,
                  priority: priorityRef.current,
                })
              } catch {
                // best effort
              }
            }

            toast.success(`百度账号已成功入池！(账号 ID: ${newAccId || '新账号'})`)
            void refreshAccounts()
            onSuccess?.()
            break
          } else if (pollRes.state === 'expired') {
            setState('expired')
            stopPolling()
            break
          } else if (pollRes.state === 'failed') {
            setState('failed')
            setReason(pollRes.reason || '登录或验证失败')
            stopPolling()
            break
          }
        } catch (err: unknown) {
          if (err instanceof Error && err.name === 'AbortError') {
            break
          }
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('404')) {
            setState('expired')
            stopPolling()
            break
          }
        } finally {
          abortControllerRef.current = null
        }

        if (!isPollingRef.current || isDestroyedRef.current) break
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    },
    [stopPolling, refreshAccounts, onSuccess, defaultPriority]
  )

  const startSession = useCallback(async () => {
    stopPolling()
    cleanupBlob()
    setState('loading')
    setReason(null)
    setProbe(null)
    setAccountId(null)

    try {
      const res = await kukuApi.startLoginQr({
        alias: aliasRef.current.trim() || undefined,
        priority: Number.isFinite(priorityRef.current) ? priorityRef.current : defaultPriority,
      })

      if (isDestroyedRef.current) return

      setLoginId(res.login_id)
      const ttlSec = Math.floor((res.expires_in_ms || 240000) / 1000)
      setExpiresInSeconds(ttlSec)

      // Fetch QR image blob with admin token
      const imgUrl = await kukuApi.getAdminBlobUrl(res.image_path)
      if (isDestroyedRef.current) {
        URL.revokeObjectURL(imgUrl)
        return
      }

      currentBlobUrlRef.current = imgUrl
      setBlobUrl(imgUrl)
      setState('pending')

      // Start 1s countdown ticker
      countdownTimerRef.current = setInterval(() => {
        setExpiresInSeconds((prev) => {
          if (prev <= 1) {
            setState('expired')
            stopPolling()
            return 0
          }
          return prev - 1
        })
      }, 1000)

      isPollingRef.current = true
      void pollLoop(res.login_id)
    } catch (err: unknown) {
      if (isDestroyedRef.current) return
      setState('failed')
      setReason(err instanceof Error ? err.message : String(err))
      toast.error('申请登录二维码失败: ' + (err instanceof Error ? err.message : String(err)))
    }
  }, [defaultPriority, stopPolling, cleanupBlob, pollLoop])

  // Automatically start QR session once on mount
  useEffect(() => {
    isDestroyedRef.current = false
    let ignore = false

    void (async () => {
      try {
        const res = await kukuApi.startLoginQr({
          alias: aliasRef.current.trim() || undefined,
          priority: Number.isFinite(priorityRef.current) ? priorityRef.current : defaultPriority,
        })

        if (ignore || isDestroyedRef.current) return

        setLoginId(res.login_id)
        const ttlSec = Math.floor((res.expires_in_ms || 240000) / 1000)
        setExpiresInSeconds(ttlSec)

        const imgUrl = await kukuApi.getAdminBlobUrl(res.image_path)
        if (ignore || isDestroyedRef.current) {
          URL.revokeObjectURL(imgUrl)
          return
        }

        currentBlobUrlRef.current = imgUrl
        setBlobUrl(imgUrl)
        setState('pending')

        countdownTimerRef.current = setInterval(() => {
          setExpiresInSeconds((prev) => {
            if (prev <= 1) {
              setState('expired')
              stopPolling()
              return 0
            }
            return prev - 1
          })
        }, 1000)

        isPollingRef.current = true
        void pollLoop(res.login_id)
      } catch (err: unknown) {
        if (ignore || isDestroyedRef.current) return
        setState('failed')
        setReason(err instanceof Error ? err.message : String(err))
        toast.error('申请登录二维码失败: ' + (err instanceof Error ? err.message : String(err)))
      }
    })()

    return () => {
      ignore = true
      isDestroyedRef.current = true
      stopPolling()
      cleanupBlob()
    }
  }, [defaultPriority, stopPolling, cleanupBlob, pollLoop])

  const formatCountdown = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  return (
    <div className='space-y-4 py-2'>
      {/* Top Banner Notice */}
      <Alert className='border-blue-500/30 bg-blue-500/5 text-blue-900 dark:text-blue-200'>
        <Smartphone className='size-4 text-blue-600 dark:text-blue-400' />
        <AlertTitle className='text-xs font-semibold'>使用「百度App」扫码登录</AlertTitle>
        <AlertDescription className='text-xs text-muted-foreground'>
          库库官方登录页仅支持<strong className='text-foreground font-semibold'>百度App</strong>扫码授权（无微信/QQ扫码渠道）。扫码入池前已自动打通零积分探针校验。
        </AlertDescription>
      </Alert>

      {/* Optional alias & priority configuration */}
      <div className='grid grid-cols-2 gap-3 text-xs'>
        <div className='space-y-1'>
          <Label className='text-xs'>账号别名 / 备注 (可选)</Label>
          <Input
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder='例如: 我的主号'
            className='h-8 text-xs'
            disabled={state === 'scanned' || state === 'confirmed' || state === 'added'}
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-xs'>调度优先级序号</Label>
          <Input
            type='number'
            min={0}
            value={priority}
            onChange={(e) => setPriority(parseInt(e.target.value, 10) || 0)}
            className='h-8 text-xs'
            disabled={state === 'scanned' || state === 'confirmed' || state === 'added'}
          />
        </div>
      </div>

      {/* QR Code Presentation Box */}
      <div className='flex flex-col items-center justify-center rounded-lg border bg-card p-6 shadow-xs min-h-[260px] text-center'>
        {state === 'loading' && (
          <div className='flex flex-col items-center gap-2 py-8 text-muted-foreground'>
            <Loader2 className='size-8 animate-spin text-primary' />
            <p className='text-xs'>正在向上游请求百度App登录二维码...</p>
          </div>
        )}

        {(state === 'pending' || state === 'scanned' || state === 'confirmed') && (
          <div className='flex flex-col items-center space-y-3'>
            <div className='relative size-48 overflow-hidden rounded-md border bg-white p-2 shadow-inner'>
              {blobUrl ? (
                <img
                  src={blobUrl}
                  alt='百度App登录二维码'
                  className='size-full object-contain'
                />
              ) : (
                <div className='flex size-full items-center justify-center'>
                  <Loader2 className='size-6 animate-spin text-muted-foreground' />
                </div>
              )}

              {state === 'scanned' && (
                <div className='absolute inset-0 flex flex-col items-center justify-center bg-background/85 backdrop-blur-xs text-primary p-2'>
                  <Smartphone className='size-10 animate-bounce' />
                  <span className='mt-2 text-xs font-semibold'>已扫码</span>
                  <span className='text-[11px] text-muted-foreground text-center'>请在手机百度App上点击确认</span>
                </div>
              )}

              {state === 'confirmed' && (
                <div className='absolute inset-0 flex flex-col items-center justify-center bg-background/85 backdrop-blur-xs text-primary p-2'>
                  <Loader2 className='size-8 animate-spin' />
                  <span className='mt-2 text-xs font-semibold'>已在手机上确认</span>
                  <span className='text-[11px] text-muted-foreground text-center'>正在换取凭据并验证入池...</span>
                </div>
              )}
            </div>

            {state === 'pending' && (
              <div className='space-y-1'>
                <p className='text-xs font-medium'>请使用手机打开 <span className='text-primary font-semibold'>百度App</span> 扫一扫</p>
                <div className='flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground'>
                  <Clock size={12} />
                  <span>有效期倒计时:</span>
                  <span className='font-mono font-semibold text-foreground'>{formatCountdown(expiresInSeconds)}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {state === 'expired' && (
          <div className='flex flex-col items-center gap-3 py-6'>
            <div className='rounded-full bg-amber-500/10 p-3 text-amber-600'>
              <AlertCircle size={28} />
            </div>
            <div className='space-y-1'>
              <p className='text-sm font-semibold'>二维码已过期</p>
              <p className='text-xs text-muted-foreground'>安全时效（4分钟）已到，请刷新重新获取二维码</p>
            </div>
            <Button size='sm' onClick={() => void startSession()} className='gap-1.5'>
              <RefreshCw size={14} />
              <span>重新生成二维码</span>
            </Button>
          </div>
        )}

        {state === 'added' && (
          <div className='flex flex-col items-center gap-3 py-6 text-emerald-600 dark:text-emerald-400'>
            <div className='rounded-full bg-emerald-500/10 p-3'>
              <CheckCircle2 size={32} />
            </div>
            <div className='space-y-1.5 text-center'>
              <p className='text-sm font-bold'>加号成功！已加入号池</p>
              <p className='text-xs text-muted-foreground'>
                账号 ID: <code className='font-mono font-semibold text-foreground'>{accountId}</code>
              </p>
              <Badge variant='outline' className='border-emerald-500/40 text-emerald-600 dark:text-emerald-400 text-[11px] mt-1'>
                上游探针校验通过 (零积分)
              </Badge>
              <div className='mt-3 max-w-sm rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 text-start text-[11px] text-muted-foreground'>
                <span className='font-semibold text-foreground'>💡 上游生效窗口说明：</span>
                <p className='mt-0.5 leading-relaxed'>
                  新换出凭据通常有几分钟的上游生效期，期间剩余积分可能短暂读 0 并等待生效，之后会自动恢复正常服务。请耐心等待生效，<strong>切勿删号重扫</strong>。
                </p>
              </div>
            </div>
          </div>
        )}

        {state === 'failed' && (
          <div className='flex flex-col items-center gap-3 py-4 text-destructive w-full max-w-sm'>
            <div className='rounded-full bg-destructive/10 p-3'>
              <AlertCircle size={28} />
            </div>
            <div className='space-y-1 text-center'>
              <p className='text-sm font-semibold'>扫码加号失败</p>
              <p className='text-xs text-muted-foreground'>{reason || '未知错误'}</p>
            </div>
            <Button size='sm' variant='outline' onClick={() => void startSession()} className='gap-1.5'>
              <RefreshCw size={14} />
              <span>重试扫码</span>
            </Button>
          </div>
        )}

        {/* Upstream probe details toggle (useful for diagnosis) */}
        {probe !== null && (
          <div className='mt-4 w-full border-t pt-2 text-start'>
            <button
              type='button'
              onClick={() => setShowProbe(!showProbe)}
              className='flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer'
            >
              {showProbe ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span>上游联调探针原始载荷 (probe)</span>
            </button>
            {showProbe && (
              <pre className='mt-1 max-h-32 overflow-auto rounded bg-muted/60 p-2 font-mono text-[10px] text-muted-foreground'>
                {JSON.stringify(probe, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>

      {/* Bottom Action Footer */}
      {(state === 'pending' || state === 'scanned') && (
        <div className='flex justify-between items-center text-xs text-muted-foreground pt-1'>
          <span>会话: {loginId} | 轮询状态: 2秒/次 (幂等)</span>
          <Button
            variant='ghost'
            size='sm'
            onClick={() => void startSession()}
            className='h-7 gap-1 text-xs'
          >
            <RefreshCw size={12} />
            <span>刷新二维码</span>
          </Button>
        </div>
      )}
    </div>
  )
}
