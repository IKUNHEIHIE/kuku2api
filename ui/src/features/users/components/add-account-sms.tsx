'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Smartphone,
  ShieldAlert,
  CheckCircle2,
  AlertCircle,
  Clock,
  RotateCw,
  Send,
  Loader2,
  KeyRound,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { toast } from 'sonner'
import { kukuApi } from '@/lib/kuku-api'
import { useUsers } from './users-provider'

interface AddAccountSmsProps {
  onSuccess?: () => void
}

type SmsStep = 'input_phone' | 'captcha_required' | 'input_code' | 'added' | 'failed'

export function AddAccountSms({ onSuccess }: AddAccountSmsProps) {
  const { refreshAccounts, accounts } = useUsers()

  const defaultPriority = accounts.length > 0
    ? Math.max(...accounts.map((a) => a.priority)) + 1
    : 0

  const [step, setStep] = useState<SmsStep>('input_phone')
  const [phone, setPhone] = useState('')
  const [alias, setAlias] = useState('')
  const [priority, setPriority] = useState<number>(defaultPriority)
  const [smsCode, setSmsCode] = useState('')
  const [captchaCode, setCaptchaCode] = useState('')

  const [loginId, setLoginId] = useState<string | null>(null)
  const [captchaBlobUrl, setCaptchaBlobUrl] = useState<string | null>(null)
  const [captchaPath, setCaptchaPath] = useState<string | null>(null)
  const [captchaVcode, setCaptchaVcode] = useState<{ vcodestr?: string; vcodesign?: string }>({})

  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isUnregistered, setIsUnregistered] = useState(false)
  const [accountId, setAccountId] = useState<string | null>(null)

  const [resendCooldown, setResendCooldown] = useState<number>(0)
  const [sessionTtl, setSessionTtl] = useState<number>(600) // 10 minutes
  const [sendCount, setSendCount] = useState<number>(0)

  const currentCaptchaBlobRef = useRef<string | null>(null)
  const resendTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const ttlTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const cleanupCaptchaBlob = useCallback(() => {
    if (currentCaptchaBlobRef.current) {
      URL.revokeObjectURL(currentCaptchaBlobRef.current)
      currentCaptchaBlobRef.current = null
    }
    setCaptchaBlobUrl(null)
  }, [])

  const loadCaptchaImage = useCallback(async (path: string) => {
    cleanupCaptchaBlob()
    try {
      const url = await kukuApi.getAdminBlobUrl(path)
      currentCaptchaBlobRef.current = url
      setCaptchaBlobUrl(url)
    } catch {
      toast.error('加载图形验证码失败')
    }
  }, [cleanupCaptchaBlob])

  const startResendCooldown = () => {
    setResendCooldown(60)
    if (resendTimerRef.current) clearInterval(resendTimerRef.current)
    resendTimerRef.current = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) {
          if (resendTimerRef.current) clearInterval(resendTimerRef.current)
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }

  const startSessionTtl = () => {
    setSessionTtl(600)
    if (ttlTimerRef.current) clearInterval(ttlTimerRef.current)
    ttlTimerRef.current = setInterval(() => {
      setSessionTtl((prev) => {
        if (prev <= 1) {
          if (ttlTimerRef.current) clearInterval(ttlTimerRef.current)
          toast.warning('短信会话已过期，请重新发起')
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }

  useEffect(() => {
    return () => {
      cleanupCaptchaBlob()
      if (resendTimerRef.current) clearInterval(resendTimerRef.current)
      if (ttlTimerRef.current) clearInterval(ttlTimerRef.current)
    }
  }, [cleanupCaptchaBlob])

  // Step 1: Send SMS code
  const handleSendSms = async () => {
    const cleanPhone = phone.trim()
    if (!cleanPhone || cleanPhone.length < 11) {
      toast.error('请输入正确的11位手机号码')
      return
    }

    setLoading(true)
    setErrorMessage(null)
    setIsUnregistered(false)

    try {
      const res = await kukuApi.startLoginSms({
        phone: cleanPhone,
        alias: alias.trim() || undefined,
        priority: Number.isFinite(priority) ? priority : defaultPriority,
      })

      setLoginId(res.login_id)
      setSendCount((prev) => prev + 1)

      if (res.state === 'sent') {
        setStep('input_code')
        startResendCooldown()
        startSessionTtl()
        toast.success('验证码已发送至手机，请查收')
      } else if (res.state === 'captcha_required') {
        setStep('captcha_required')
        const rawRes = res as unknown as Record<string, unknown>
        if (typeof rawRes.vcodestr === 'string') {
          setCaptchaVcode({
            vcodestr: rawRes.vcodestr,
            vcodesign: typeof rawRes.vcodesign === 'string' ? rawRes.vcodesign : undefined,
          })
        }
        if (res.captcha_path) {
          setCaptchaPath(res.captcha_path)
          void loadCaptchaImage(res.captcha_path)
        }
        toast.info('需要输入图形验证码')
      } else if (res.state === 'unregistered') {
        setIsUnregistered(true)
        setStep('input_phone')
      } else if (res.state === 'refused') {
        setErrorMessage(res.message || '发送被上游拒绝（可能由于发送过于频繁或风控限制）')
        setStep('input_phone')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMessage(msg)
      toast.error('发起短信登录失败: ' + msg)
    } finally {
      setLoading(false)
    }
  }

  // Step 1.5: Submit captcha to resend SMS
  const handleResendWithCaptcha = async () => {
    if (!loginId) return
    const cleanCaptcha = captchaCode.trim()
    if (!cleanCaptcha) {
      toast.error('请输入图形验证码')
      return
    }

    setLoading(true)
    setErrorMessage(null)

    try {
      const res = await kukuApi.resendLoginSms({
        login_id: loginId,
        captcha: {
          code: cleanCaptcha,
          vcodestr: captchaVcode.vcodestr,
          vcodesign: captchaVcode.vcodesign,
        },
      })

      if (res.state === 'sent') {
        setStep('input_code')
        setCaptchaCode('')
        setCaptchaVcode({})
        cleanupCaptchaBlob()
        startResendCooldown()
        startSessionTtl()
        setSendCount((prev) => prev + 1)
        toast.success('图形验证码校验通过，短信验证码已下发')
      } else if (res.state === 'captcha_required') {
        setCaptchaCode('')
        const rawRes = res as unknown as Record<string, unknown>
        if (typeof rawRes.vcodestr === 'string') {
          setCaptchaVcode({
            vcodestr: rawRes.vcodestr,
            vcodesign: typeof rawRes.vcodesign === 'string' ? rawRes.vcodesign : undefined,
          })
        }
        if (res.captcha_path) {
          setCaptchaPath(res.captcha_path)
          void loadCaptchaImage(res.captcha_path)
        }
        toast.error('图形验证码有误，已自动刷新，请重新输入')
      } else {
        setErrorMessage(res.message || '重发失败')
        toast.error(res.message || '重发失败')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error('图形验证码提交失败: ' + msg)
    } finally {
      setLoading(false)
    }
  }

  // Step 1.8: Resend SMS code within existing session
  const handleResendCode = async () => {
    if (!loginId) {
      await handleSendSms()
      return
    }

    setLoading(true)
    setErrorMessage(null)

    try {
      const res = await kukuApi.resendLoginSms({ login_id: loginId })

      if (res.state === 'sent') {
        startResendCooldown()
        startSessionTtl()
        setSendCount((prev) => prev + 1)
        toast.success('验证码已重新发送至手机，请查收')
      } else if (res.state === 'captcha_required') {
        setStep('captcha_required')
        const rawRes = res as unknown as Record<string, unknown>
        if (typeof rawRes.vcodestr === 'string') {
          setCaptchaVcode({
            vcodestr: rawRes.vcodestr,
            vcodesign: typeof rawRes.vcodesign === 'string' ? rawRes.vcodesign : undefined,
          })
        }
        if (res.captcha_path) {
          setCaptchaPath(res.captcha_path)
          void loadCaptchaImage(res.captcha_path)
        }
        toast.info('重发验证码需要输入图形验证码')
      } else {
        setErrorMessage(res.message || '重发失败')
        toast.error(res.message || '重发失败')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMessage(msg)
      toast.error('重发短信验证码失败: ' + msg)
    } finally {
      setLoading(false)
    }
  }

  // Step 2: Verify SMS code and add account
  const handleVerifySms = async () => {
    if (!loginId) return
    const cleanCode = smsCode.trim()
    if (!cleanCode) {
      toast.error('请输入6位短信验证码')
      return
    }

    setLoading(true)
    setErrorMessage(null)

    try {
      const res = await kukuApi.verifyLoginSms({
        login_id: loginId,
        code: cleanCode,
      })

      if (res.state === 'added') {
        setStep('added')
        const newAccId = res.account_id || null
        setAccountId(newAccId)
        if (newAccId && (alias.trim() || priority !== defaultPriority)) {
          try {
            await kukuApi.updateAccount(newAccId, {
              alias: alias.trim() || undefined,
              priority,
            })
          } catch {
            // best effort
          }
        }
        toast.success(`百度账号已成功入池！(账号 ID: ${newAccId || '新账号'})`)
        void refreshAccounts()
        onSuccess?.()
      } else if (res.state === 'captcha_required') {
        if (res.captcha_path) {
          setCaptchaPath(res.captcha_path)
          void loadCaptchaImage(res.captcha_path)
          setStep('captcha_required')
          toast.warning('登录需要完成图形验证码')
        }
      } else if (res.state === 'refused') {
        setErrorMessage(res.message || '登录被拒绝')
        toast.error('短信登录被拒绝: ' + (res.message || '未知原因'))
      } else {
        setErrorMessage(res.message || '验证码错误或已过期')
        toast.error('验证失败: ' + (res.message || '验证码错误'))
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMessage(msg)
      toast.error('验证短信失败: ' + msg)
    } finally {
      setLoading(false)
    }
  }

  const formatSessionTime = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  return (
    <div className='space-y-4 py-2'>
      {/* Notice */}
      <Alert className='border-emerald-500/30 bg-emerald-500/5 text-emerald-900 dark:text-emerald-200'>
        <Smartphone className='size-4 text-emerald-600 dark:text-emerald-400' />
        <AlertTitle className='text-xs font-semibold'>手机号验证码加号</AlertTitle>
        <AlertDescription className='text-xs text-muted-foreground'>
          库库官方登录页唯一开放的登录入口。后端将直接向百度下发验证码并自动完成换票入池，零积分探针验过即用。
        </AlertDescription>
      </Alert>

      {/* Unregistered Phone Special Warning */}
      {isUnregistered && (
        <Alert variant='destructive'>
          <AlertCircle className='size-4' />
          <AlertTitle className='text-xs font-bold'>该手机号未注册</AlertTitle>
          <AlertDescription className='text-xs'>
            百度账号系统中未查找到该手机号。请先使用百度App或前往 passport.baidu.com 完成注册后再次尝试。
          </AlertDescription>
        </Alert>
      )}

      {errorMessage && (
        <Alert variant='destructive'>
          <AlertCircle className='size-4' />
          <AlertDescription className='text-xs'>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {/* Step 1: Input Phone and Optional Config */}
      {step === 'input_phone' && (
        <div className='space-y-3 rounded-lg border bg-card p-4 shadow-xs'>
          <div className='space-y-1.5'>
            <Label className='text-xs font-semibold'>手机号码 (必填)</Label>
            <div className='flex gap-2'>
              <Input
                type='tel'
                maxLength={11}
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
                placeholder='例如: 13800138000'
                className='font-mono text-sm'
              />
            </div>
            <p className='text-[11px] text-muted-foreground'>
              仅用于接收一次性验证码，前端与服务端绝不持久化存储手机号。
            </p>
          </div>

          <div className='grid grid-cols-2 gap-3 text-xs pt-1'>
            <div className='space-y-1'>
              <Label className='text-xs'>账号别名 / 备注 (可选)</Label>
              <Input
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder='例如: 手机号二号'
                className='h-8 text-xs'
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
              />
            </div>
          </div>

          <div className='pt-2 flex justify-end'>
            <Button
              size='sm'
              onClick={() => void handleSendSms()}
              disabled={loading || phone.length < 11}
              className='gap-1.5'
            >
              {loading ? <Loader2 size={14} className='animate-spin' /> : <Send size={14} />}
              <span>发送验证码</span>
            </Button>
          </div>
        </div>
      )}

      {/* Step 1.5: Captcha Required Form */}
      {step === 'captcha_required' && (
        <div className='space-y-3 rounded-lg border bg-card p-4 shadow-xs'>
          <div className='flex items-center gap-2 text-amber-600 dark:text-amber-400'>
            <ShieldAlert size={16} />
            <span className='text-xs font-semibold'>上游触发安全防护，请输入图形验证码</span>
          </div>

          <div className='flex items-center gap-4 py-2'>
            <div className='relative h-12 w-36 overflow-hidden rounded-md border bg-white shadow-xs flex items-center justify-center'>
              {captchaBlobUrl ? (
                <img
                  src={captchaBlobUrl}
                  alt='图形验证码'
                  className='h-full w-full object-contain cursor-pointer'
                  onClick={() => captchaPath && void loadCaptchaImage(captchaPath)}
                  title='看不清？点击刷新图片'
                />
              ) : (
                <Loader2 size={16} className='animate-spin text-muted-foreground' />
              )}
            </div>

            <Button
              type='button'
              variant='outline'
              size='sm'
              onClick={() => captchaPath && void loadCaptchaImage(captchaPath)}
              className='h-8 gap-1 text-xs'
            >
              <RotateCw size={12} />
              <span>刷新图形码</span>
            </Button>
          </div>

          <div className='space-y-1.5'>
            <Label className='text-xs'>输入图形验证码中的字符</Label>
            <Input
              value={captchaCode}
              onChange={(e) => setCaptchaCode(e.target.value)}
              placeholder='输入图中字符'
              className='h-9 font-mono tracking-widest text-sm uppercase'
              maxLength={8}
            />
          </div>

          <div className='flex justify-between items-center pt-2'>
            <Button
              variant='ghost'
              size='sm'
              onClick={() => setStep('input_phone')}
              className='text-xs'
            >
              返回修改手机号
            </Button>
            <Button
              size='sm'
              onClick={() => void handleResendWithCaptcha()}
              disabled={loading || !captchaCode.trim()}
              className='gap-1.5'
            >
              {loading ? <Loader2 size={14} className='animate-spin' /> : <Send size={14} />}
              <span>确认并发送短信</span>
            </Button>
          </div>
        </div>
      )}

      {/* Step 2: Input SMS Code */}
      {step === 'input_code' && (
        <div className='space-y-3 rounded-lg border bg-card p-4 shadow-xs'>
          <div className='flex items-center justify-between text-xs text-muted-foreground pb-1 border-b'>
            <span>接收号码: <strong className='font-mono text-foreground'>{phone}</strong></span>
            <div className='flex items-center gap-1.5 font-mono text-[11px]'>
              <Clock size={12} />
              <span>会话有效期: {formatSessionTime(sessionTtl)}</span>
            </div>
          </div>

          <div className='space-y-2 py-1'>
            <Label className='text-xs font-semibold'>短信验证码 (6位数字)</Label>
            <Input
              type='text'
              maxLength={6}
              value={smsCode}
              onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, ''))}
              placeholder='输入6位短信验证码'
              className='font-mono text-lg tracking-widest text-center h-11'
              autoFocus
            />
          </div>

          <div className='flex items-center justify-between pt-2'>
            <Button
              type='button'
              variant='outline'
              size='sm'
              onClick={() => void handleResendCode()}
              disabled={loading || resendCooldown > 0 || sendCount >= 5}
              className='text-xs gap-1'
            >
              <RotateCw size={12} className={loading ? 'animate-spin' : ''} />
              <span>
                {resendCooldown > 0
                  ? `重新发送 (${resendCooldown}s)`
                  : sendCount >= 5
                    ? '重发次数超限'
                    : '重新发送验证码'}
              </span>
            </Button>

            <Button
              size='sm'
              onClick={() => void handleVerifySms()}
              disabled={loading || smsCode.length < 4}
              className='gap-1.5'
            >
              {loading ? <Loader2 size={14} className='animate-spin' /> : <KeyRound size={14} />}
              <span>提交并登录入池</span>
            </Button>
          </div>

          <div className='pt-1 text-[11px] text-muted-foreground flex justify-between'>
            <span>重发限制: 最大5次 (已发 {sendCount} 次)</span>
            <button
              type='button'
              onClick={() => setStep('input_phone')}
              className='text-primary hover:underline cursor-pointer'
            >
              更换手机号
            </button>
          </div>
        </div>
      )}

      {/* Success State */}
      {step === 'added' && (
        <div className='flex flex-col items-center gap-3 py-6 rounded-lg border bg-card text-emerald-600 dark:text-emerald-400 text-center'>
          <div className='rounded-full bg-emerald-500/10 p-3'>
            <CheckCircle2 size={32} />
          </div>
          <div className='space-y-1.5'>
            <p className='text-sm font-bold'>短信加号成功！</p>
            <p className='text-xs text-muted-foreground'>
              账号 ID: <code className='font-mono font-semibold text-foreground'>{accountId}</code>
            </p>
            <Badge variant='outline' className='border-emerald-500/40 text-emerald-600 dark:text-emerald-400 text-[11px] mt-1'>
              新凭据已通过上游探针校验并存入号池
            </Badge>
            <div className='mt-3 max-w-sm rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 text-start text-[11px] text-muted-foreground'>
              <span className='font-semibold text-foreground'>💡 上游生效窗口说明：</span>
              <p className='mt-0.5 leading-relaxed'>
                新换出凭据通常有几分钟的上游生效期，期间剩余积分可能短暂读 0 并等待生效，之后会自动恢复正常服务。请耐心等待生效，<strong>切勿删号重试</strong>。
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
