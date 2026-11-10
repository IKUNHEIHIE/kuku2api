'use client'

import { useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Globe2,
  KeyRound,
  Loader2,
  RotateCw,
  Send,
  Smartphone,
} from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, kukuApi } from '@/lib/kuku-api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useUsers } from './users-provider'

function normalizePhoneNumber(raw: string): string {
  let cleaned = raw.trim()
  if (cleaned.startsWith('+86')) cleaned = cleaned.slice(3)
  let digits = cleaned.replace(/\D/g, '')
  if (digits.startsWith('86') && digits.length > 11) digits = digits.slice(2)
  return digits.slice(0, 11)
}

type Step = 'input_phone' | 'input_code' | 'failed'

interface AddAccountScnetProps {
  onSuccess?: () => void
}

export function AddAccountScnet({ onSuccess }: AddAccountScnetProps) {
  const { refreshAccounts, accounts } = useUsers()
  const defaultPriority =
    accounts.length > 0 ? Math.max(...accounts.map((a) => a.priority)) + 1 : 0

  const [step, setStep] = useState<Step>('input_phone')
  const [phone, setPhone] = useState('')
  const [alias, setAlias] = useState('')
  const [priority, setPriority] = useState<number>(defaultPriority)
  const [smsCode, setSmsCode] = useState('')
  const [loginId, setLoginId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [resendCooldown, setResendCooldown] = useState(0)
  const [accountId, setAccountId] = useState<string | null>(null)

  useEffect(() => {
    if (resendCooldown <= 0) return
    const timer = setInterval(
      () => setResendCooldown((n) => Math.max(0, n - 1)),
      1000
    )
    return () => clearInterval(timer)
  }, [resendCooldown])

  const reset = () => {
    setStep('input_phone')
    setSmsCode('')
    setLoginId(null)
    setErrorMessage(null)
    setAccountId(null)
    setResendCooldown(0)
  }

  const handleSend = async () => {
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      toast.error('请输入正确的11位中国大陆手机号')
      return
    }
    setLoading(true)
    setErrorMessage(null)
    try {
      const res = await kukuApi.startScnetLoginSms({
        phone,
        alias: alias.trim() || undefined,
        priority,
      })
      setLoginId(res.login_id)
      setStep('input_code')
      setSmsCode('')
      setResendCooldown(Math.ceil((res.retry_after_ms ?? 60_000) / 1000))
      toast.success('验证码已发送至手机，请查收')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setErrorMessage(message)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  const handleResend = async () => {
    if (!loginId) return
    setLoading(true)
    setErrorMessage(null)
    try {
      const res = await kukuApi.resendScnetLoginSms({ login_id: loginId })
      setResendCooldown(Math.ceil((res.retry_after_ms ?? 60_000) / 1000))
      toast.success('验证码已重新发送')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setErrorMessage(message)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  const handleVerify = async () => {
    if (!loginId || !/^\d{6}$/.test(smsCode)) return
    setLoading(true)
    setErrorMessage(null)
    try {
      const res = await kukuApi.verifyScnetLoginSms({
        login_id: loginId,
        code: smsCode,
      })
      if (res.state === 'added') {
        setAccountId(res.account_id ?? null)
        toast.success(
          res.refreshed_existing
            ? '超算互联网账号凭据已更新'
            : '超算互联网账号已成功入池'
        )
        void refreshAccounts()
        onSuccess?.()
      } else {
        setErrorMessage(res.reason || '验证码错误或登录失败，请重试')
        setStep('failed')
      }
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `${err.message}${err.code ? ` (${err.code})` : ''}`
          : err instanceof Error
            ? err.message
            : String(err)
      setErrorMessage(message)
      setStep('failed')
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className='space-y-4 py-2'>
      <Alert className='border-sky-500/30 bg-sky-500/5 text-sky-900 dark:text-sky-200'>
        <Globe2 className='size-4 text-sky-600 dark:text-sky-400' />
        <AlertTitle className='text-xs font-semibold'>
          超算互联网（SCNet）短信加号
        </AlertTitle>
        <AlertDescription className='text-xs text-muted-foreground'>
          使用手机号验证码登录，自动获取活动 Key，仅反代免费模型
          <code className='mx-1 font-mono'>SCNet-Max</code>
          ，不会消耗付费 Token。
        </AlertDescription>
      </Alert>

      {errorMessage && (
        <Alert variant='destructive' className='text-xs'>
          <AlertCircle className='size-4' />
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {step === 'failed' && (
        <Button type='button' variant='outline' onClick={reset}>
          返回重新登录
        </Button>
      )}

      {step === 'input_phone' && (
        <div className='space-y-3 rounded-lg border bg-card p-4 shadow-xs'>
          <div className='space-y-1.5'>
            <Label htmlFor='scnet-phone' className='text-xs font-semibold'>
              手机号码 (必填)
            </Label>
            <div className='flex gap-2'>
              <Input
                id='scnet-phone'
                type='tel'
                inputMode='tel'
                autoComplete='tel-national'
                disabled={loading}
                value={phone}
                onChange={(e) => setPhone(normalizePhoneNumber(e.target.value))}
                placeholder='例如: 13800138000'
                className='font-mono text-sm'
              />
            </div>
            <p className='text-[11px] text-muted-foreground'>
              仅用于接收一次性验证码；登录会话 10 分钟内有效。
            </p>
          </div>

          <div className='grid grid-cols-2 gap-3 pt-1 text-xs'>
            <div className='space-y-1'>
              <Label htmlFor='scnet-alias' className='text-xs'>
                账号别名 / 备注 (可选)
              </Label>
              <Input
                id='scnet-alias'
                disabled={loading}
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder='例如: 超算主号'
                className='h-8 text-xs'
              />
            </div>
            <div className='space-y-1'>
              <Label htmlFor='scnet-priority' className='text-xs'>
                调度优先级序号
              </Label>
              <Input
                id='scnet-priority'
                disabled={loading}
                type='number'
                min={0}
                value={priority}
                onChange={(e) =>
                  setPriority(parseInt(e.target.value, 10) || 0)
                }
                className='h-8 text-xs'
              />
            </div>
          </div>

          <div className='flex justify-end pt-2'>
            <Button
              size='sm'
              onClick={() => void handleSend()}
              disabled={loading || !/^1[3-9]\d{9}$/.test(phone)}
              className='gap-1.5'
            >
              {loading ? (
                <Loader2 size={14} className='animate-spin' />
              ) : (
                <Send size={14} />
              )}
              <span>发送验证码</span>
            </Button>
          </div>
        </div>
      )}

      {step === 'input_code' && (
        <div className='space-y-3 rounded-lg border bg-card p-4 shadow-xs'>
          <div className='flex items-center justify-between border-b pb-1 text-xs text-muted-foreground'>
            <span>
              接收号码:{' '}
              <strong className='font-mono text-foreground'>{phone}</strong>
            </span>
            <span className='flex items-center gap-1.5 font-mono text-[11px]'>
              <Smartphone size={12} />
              验证码 10 分钟内有效
            </span>
          </div>

          <div className='space-y-2 py-1'>
            <Label htmlFor='scnet-code' className='text-xs font-semibold'>
              短信验证码 (6位数字)
            </Label>
            <Input
              id='scnet-code'
              type='text'
              inputMode='numeric'
              autoComplete='one-time-code'
              maxLength={6}
              value={smsCode}
              onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, ''))}
              placeholder='输入6位短信验证码'
              className='h-11 text-center font-mono text-lg tracking-widest'
              autoFocus
            />
          </div>

          <div className='flex items-center justify-between pt-2'>
            <Button
              type='button'
              variant='outline'
              size='sm'
              onClick={() => void handleResend()}
              disabled={loading || resendCooldown > 0}
              className='gap-1 text-xs'
            >
              <RotateCw size={12} className={loading ? 'animate-spin' : ''} />
              <span>
                {resendCooldown > 0
                  ? `重新发送 (${resendCooldown}s)`
                  : '重新发送验证码'}
              </span>
            </Button>

            <Button
              size='sm'
              onClick={() => void handleVerify()}
              disabled={loading || !/^\d{6}$/.test(smsCode)}
              className='gap-1.5'
            >
              {loading ? (
                <Loader2 size={14} className='animate-spin' />
              ) : (
                <KeyRound size={14} />
              )}
              <span>提交并登录入池</span>
            </Button>
          </div>

          <div className='flex justify-between pt-1 text-[11px] text-muted-foreground'>
            <span>登录成功后自动获取活动 Key（免费额度）</span>
            <button
              type='button'
              onClick={reset}
              disabled={loading}
              className='cursor-pointer text-primary hover:underline'
            >
              更换手机号
            </button>
          </div>
        </div>
      )}

      {accountId && (
        <div className='flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-700 dark:text-emerald-300'>
          <CheckCircle2 size={16} />
          <span>
            账号 <code className='font-mono'>{accountId}</code> 已入池
          </span>
          <Badge
            variant='outline'
            className='border-emerald-500/40 text-[10px] text-emerald-600 dark:text-emerald-400'
          >
            SCNet
          </Badge>
        </div>
      )}
    </div>
  )
}