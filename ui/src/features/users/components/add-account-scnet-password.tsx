'use client'

import { useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Globe2,
  KeyRound,
  Loader2,
  Lock,
  User,
} from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, kukuApi } from '@/lib/kuku-api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useUsers } from './users-provider'

type Step = 'input' | 'captcha' | 'failed'

interface AddAccountScnetPasswordProps {
  onSuccess?: () => void
}

export function AddAccountScnetPassword({ onSuccess }: AddAccountScnetPasswordProps) {
  const { refreshAccounts, accounts } = useUsers()
  const defaultPriority =
    accounts.length > 0 ? Math.max(...accounts.map((a) => a.priority)) + 1 : 0

  const [step, setStep] = useState<Step>('input')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [alias, setAlias] = useState('')
  const [priority, setPriority] = useState<number>(defaultPriority)
  const [captcha, setCaptcha] = useState('')
  const [captchaImage, setCaptchaImage] = useState<string | null>(null)
  const [loginId, setLoginId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [accountId, setAccountId] = useState<string | null>(null)

  const reset = () => {
    setStep('input')
    setPassword('')
    setCaptcha('')
    setCaptchaImage(null)
    setLoginId(null)
    setErrorMessage(null)
    setAccountId(null)
  }

  const errorText = (err: unknown) =>
    err instanceof ApiError
      ? `${err.message}${err.code ? ` (${err.code})` : ''}`
      : err instanceof Error
        ? err.message
        : String(err)

  const handleLogin = async () => {
    if (!username.trim() || !password) return
    setLoading(true)
    setErrorMessage(null)
    try {
      const res = await kukuApi.startScnetLoginPassword({
        username: username.trim(),
        password,
        alias: alias.trim() || undefined,
        priority,
      })
      // Never keep the plaintext password in component state after it is sent.
      setPassword('')
      if (res.state === 'added') {
        setAccountId(res.account_id ?? null)
        toast.success(
          res.refreshed_existing
            ? '超算互联网账号凭据已更新'
            : '超算互联网账号已成功入池'
        )
        void refreshAccounts()
        onSuccess?.()
      } else if (res.state === 'captcha') {
        setLoginId(res.login_id ?? null)
        setCaptchaImage(res.captcha_image ?? null)
        setCaptcha('')
        setStep('captcha')
      } else {
        setErrorMessage(res.reason || '登录失败，请检查用户名与密码')
        setStep('failed')
      }
    } catch (err) {
      setPassword('')
      const message = errorText(err)
      setErrorMessage(message)
      setStep('failed')
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  const handleCaptcha = async () => {
    if (!loginId || !captcha.trim()) return
    setLoading(true)
    setErrorMessage(null)
    try {
      const res = await kukuApi.verifyScnetLoginPassword({
        login_id: loginId,
        captcha: captcha.trim(),
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
      const message = errorText(err)
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
          超算互联网（SCNet）账密加号
        </AlertTitle>
        <AlertDescription className='text-xs text-muted-foreground'>
          使用用户名与密码登录，密码在服务端加密后才发往超算，自动获取活动 Key，仅反代免费模型
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

      {step === 'input' && (
        <div className='space-y-3 rounded-lg border bg-card p-4 shadow-xs'>
          <div className='space-y-1.5'>
            <Label htmlFor='scnet-pw-username' className='text-xs font-semibold'>
              用户名 / 手机号 (必填)
            </Label>
            <div className='relative'>
              <User size={14} className='absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground' />
              <Input
                id='scnet-pw-username'
                autoComplete='username'
                disabled={loading}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder='例如: acivdbzsj5 或 13800138000'
                className='pl-8 font-mono text-sm'
              />
            </div>
          </div>

          <div className='space-y-1.5'>
            <Label htmlFor='scnet-pw-password' className='text-xs font-semibold'>
              登录密码 (必填)
            </Label>
            <div className='relative'>
              <Lock size={14} className='absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground' />
              <Input
                id='scnet-pw-password'
                type='password'
                autoComplete='current-password'
                disabled={loading}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder='输入超算互联网登录密码'
                className='pl-8 text-sm'
              />
            </div>
            <p className='text-[11px] text-muted-foreground'>
              密码仅在服务端 RSA 加密后发往超算，提交后立即清除输入框，不写入浏览器本地存储。
            </p>
          </div>

          <div className='grid grid-cols-2 gap-3 pt-1 text-xs'>
            <div className='space-y-1'>
              <Label htmlFor='scnet-pw-alias' className='text-xs'>
                账号别名 / 备注 (可选)
              </Label>
              <Input
                id='scnet-pw-alias'
                disabled={loading}
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder='例如: 超算主号'
                className='h-8 text-xs'
              />
            </div>
            <div className='space-y-1'>
              <Label htmlFor='scnet-pw-priority' className='text-xs'>
                调度优先级序号
              </Label>
              <Input
                id='scnet-pw-priority'
                disabled={loading}
                type='number'
                min={0}
                value={priority}
                onChange={(e) => setPriority(parseInt(e.target.value, 10) || 0)}
                className='h-8 text-xs'
              />
            </div>
          </div>

          <div className='flex justify-end pt-2'>
            <Button
              size='sm'
              onClick={() => void handleLogin()}
              disabled={loading || !username.trim() || !password}
              className='gap-1.5'
            >
              {loading ? (
                <Loader2 size={14} className='animate-spin' />
              ) : (
                <KeyRound size={14} />
              )}
              <span>登录并入池</span>
            </Button>
          </div>
        </div>
      )}

      {step === 'captcha' && (
        <div className='space-y-3 rounded-lg border bg-card p-4 shadow-xs'>
          <div className='flex items-center justify-between border-b pb-1 text-xs text-muted-foreground'>
            <span>
              登录账号:{' '}
              <strong className='font-mono text-foreground'>{username}</strong>
            </span>
            <span className='text-[11px]'>超算要求先完成图形验证</span>
          </div>

          <div className='space-y-2 py-1'>
            <Label htmlFor='scnet-pw-captcha' className='text-xs font-semibold'>
              图形验证码
            </Label>
            <div className='flex items-center gap-3'>
              {captchaImage && (
                <img
                  src={captchaImage}
                  alt='图形验证码'
                  className='h-11 w-28 rounded border object-contain'
                />
              )}
              <Input
                id='scnet-pw-captcha'
                autoComplete='off'
                maxLength={8}
                value={captcha}
                onChange={(e) => setCaptcha(e.target.value)}
                placeholder='输入图中字符'
                className='h-11 flex-1 font-mono text-sm tracking-widest'
                autoFocus
              />
            </div>
          </div>

          <div className='flex items-center justify-between pt-2'>
            <button
              type='button'
              onClick={reset}
              disabled={loading}
              className='cursor-pointer text-[11px] text-primary hover:underline'
            >
              更换账号
            </button>
            <Button
              size='sm'
              onClick={() => void handleCaptcha()}
              disabled={loading || !captcha.trim()}
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