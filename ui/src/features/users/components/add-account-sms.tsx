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
  QrCode,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  kukuApi,
  ApiError,
  type LoginSmsStartResponse,
  type LoginSmsVerifyResponse,
} from '@/lib/kuku-api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useUsers } from './users-provider'

function normalizePhoneNumber(raw: string): string {
  let cleaned = raw.trim()
  if (cleaned.startsWith('+86')) {
    cleaned = cleaned.slice(3)
  }
  let digits = cleaned.replace(/\D/g, '')
  if (digits.startsWith('86') && digits.length > 11) {
    digits = digits.slice(2)
  }
  return digits.slice(0, 11)
}

function formatUpstreamSmsError(msg: string): string {
  if (msg.includes('手机号格式错误') || msg.includes('invalid_phone')) {
    return '上游百度登录接口拒绝：提示“手机号格式错误”。此问题通常是由于百度 Passport 短信通道对大陆手机号存在国家代码兼容性或接口安全风控拦截所致。建议改用顶部的【百度App 扫码登录】加号，官方实测 100% 稳定可用且免填验证码。'
  }
  return msg
}

interface AddAccountSmsProps {
  onSuccess?: () => void
  onSwitchToQr?: () => void
}

type SmsStep =
  | 'input_phone'
  | 'captcha_required'
  | 'input_code'
  | 'added'
  | 'failed'

export function AddAccountSms({ onSuccess, onSwitchToQr }: AddAccountSmsProps) {
  const { refreshAccounts, accounts, setAddTab } = useUsers()

  const handleSwitchToQr = () => {
    if (onSwitchToQr) {
      onSwitchToQr()
    } else if (setAddTab) {
      setAddTab('qr')
    }
  }

  const defaultPriority =
    accounts.length > 0 ? Math.max(...accounts.map((a) => a.priority)) + 1 : 0

  const [step, setStep] = useState<SmsStep>('input_phone')
  const [phone, setPhone] = useState('')
  const [alias, setAlias] = useState('')
  const [priority, setPriority] = useState<number>(defaultPriority)
  const [smsCode, setSmsCode] = useState('')
  const [captchaCode, setCaptchaCode] = useState('')

  const [loginId, setLoginId] = useState<string | null>(null)
  const [captchaBlobUrl, setCaptchaBlobUrl] = useState<string | null>(null)
  const [captchaPath, setCaptchaPath] = useState<string | null>(null)

  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isUnregistered, setIsUnregistered] = useState(false)
  const [accountId, setAccountId] = useState<string | null>(null)

  const [resendCooldown, setResendCooldown] = useState<number>(0)
  const [sessionTtl, setSessionTtl] = useState<number>(600) // 10 minutes
  const [sendCount, setSendCount] = useState<number>(0)

  const [captchaStage, setCaptchaStage] = useState<'send' | 'verify'>('send')
  const [captchaImageError, setCaptchaImageError] = useState<string | null>(
    null
  )
  const [captchaImageLoading, setCaptchaImageLoading] = useState(false)
  const [slideRequired, setSlideRequired] = useState(false)
  const currentCaptchaBlobRef = useRef<string | null>(null)
  const captchaVersionRef = useRef(0)
  const attemptRef = useRef(0)
  const busyRef = useRef(false)
  const mountedRef = useRef(true)
  const sessionDeadlineRef = useRef(0)
  const retryDeadlineRef = useRef(0)

  const cleanupCaptchaBlob = useCallback(() => {
    captchaVersionRef.current += 1
    if (currentCaptchaBlobRef.current)
      URL.revokeObjectURL(currentCaptchaBlobRef.current)
    currentCaptchaBlobRef.current = null
    setCaptchaBlobUrl(null)
  }, [])

  const loadCaptchaImage = useCallback(
    async (path: string) => {
      cleanupCaptchaBlob()
      const version = captchaVersionRef.current
      setCaptchaImageError(null)
      setCaptchaImageLoading(true)
      try {
        const url = await kukuApi.getAdminBlobUrl(path)
        if (!mountedRef.current || version !== captchaVersionRef.current) {
          URL.revokeObjectURL(url)
          return
        }
        currentCaptchaBlobRef.current = url
        setCaptchaBlobUrl(url)
      } catch {
        if (mountedRef.current && version === captchaVersionRef.current)
          setCaptchaImageError('图形验证码加载失败，请点击刷新重试')
      } finally {
        if (mountedRef.current && version === captchaVersionRef.current)
          setCaptchaImageLoading(false)
      }
    },
    [cleanupCaptchaBlob]
  )

  useEffect(() => {
    mountedRef.current = true
    const timer = setInterval(() => {
      if (sessionDeadlineRef.current)
        setSessionTtl(
          Math.max(
            0,
            Math.ceil((sessionDeadlineRef.current - Date.now()) / 1000)
          )
        )
      if (retryDeadlineRef.current)
        setResendCooldown(
          Math.max(0, Math.ceil((retryDeadlineRef.current - Date.now()) / 1000))
        )
    }, 1000)
    return () => {
      mountedRef.current = false
      attemptRef.current += 1
      captchaVersionRef.current += 1
      clearInterval(timer)
      if (currentCaptchaBlobRef.current)
        URL.revokeObjectURL(currentCaptchaBlobRef.current)
      currentCaptchaBlobRef.current = null
    }
  }, [])

  const resetSession = () => {
    attemptRef.current += 1
    busyRef.current = false
    sessionDeadlineRef.current = 0
    retryDeadlineRef.current = 0
    setLoginId(null)
    setSmsCode('')
    setCaptchaCode('')
    setCaptchaPath(null)
    setCaptchaStage('send')
    setSlideRequired(false)
    setCaptchaImageError(null)
    setCaptchaImageLoading(false)
    setResendCooldown(0)
    setSessionTtl(600)
    setSendCount(0)
    setErrorMessage(null)
    setIsUnregistered(false)
    setAccountId(null)
    setLoading(false)
    cleanupCaptchaBlob()
    setStep('input_phone')
  }

  const syncTiming = (res: LoginSmsStartResponse | LoginSmsVerifyResponse) => {
    if (res.expires_in_ms !== undefined || !sessionDeadlineRef.current) {
      const remaining = res.expires_in_ms ?? 600_000
      sessionDeadlineRef.current = Date.now() + remaining
      setSessionTtl(Math.max(0, Math.ceil(remaining / 1000)))
    }
    if (res.retry_after_ms !== undefined || res.state === 'sent') {
      const remaining = res.retry_after_ms ?? 60_000
      retryDeadlineRef.current = Date.now() + remaining
      setResendCooldown(Math.max(0, Math.ceil(remaining / 1000)))
    }
    if (res.sends_remaining !== undefined) setSendCount(5 - res.sends_remaining)
    else if (res.state === 'sent') setSendCount((count) => count + 1)
  }

  const perform = async (operation: () => Promise<void>) => {
    if (busyRef.current) return
    const attempt = attemptRef.current
    busyRef.current = true
    setLoading(true)
    setErrorMessage(null)
    try {
      await operation()
    } catch (err) {
      if (!mountedRef.current || attempt !== attemptRef.current) return
      const rawMessage = err instanceof Error ? err.message : String(err)
      const message = formatUpstreamSmsError(rawMessage)
      setErrorMessage(message)
      if (err instanceof ApiError && err.code === 'login_session_expired') {
        sessionDeadlineRef.current = Date.now()
        setSessionTtl(0)
      }
      toast.error(message)
    } finally {
      if (mountedRef.current && attempt === attemptRef.current) {
        busyRef.current = false
        setLoading(false)
      }
    }
  }

  const showCaptcha = (res: LoginSmsStartResponse | LoginSmsVerifyResponse) => {
    setStep('captcha_required')
    setCaptchaCode('')
    setCaptchaStage(res.captcha_stage ?? ('slide' in res ? 'verify' : 'send'))
    setSlideRequired('slide' in res && res.slide === true)
    setCaptchaPath(res.captcha_path ?? null)
    cleanupCaptchaBlob()
    if ('slide' in res && res.slide === true) {
      setErrorMessage('上游要求滑块验证，请改用百度App扫码登录')
    } else if (res.captcha_path) {
      void loadCaptchaImage(res.captcha_path)
    } else {
      setErrorMessage(
        res.message || '上游未提供图形验证码，请重新发起或改用扫码登录'
      )
    }
  }

  const applySendResponse = (res: LoginSmsStartResponse) => {
    syncTiming(res)
    setLoginId(res.login_id)
    if (res.state === 'sent') {
      setStep('input_code')
      setSmsCode('')
      setCaptchaCode('')
      setCaptchaPath(null)
      cleanupCaptchaBlob()
      toast.success('验证码已发送至手机，请查收')
    } else if (res.state === 'captcha_required') {
      showCaptcha(res)
    } else {
      setIsUnregistered(res.state === 'unregistered')
      const fallbackMsg =
        res.state === 'unregistered'
          ? '该手机号未注册百度账号'
          : '短信发送被拒绝，请稍后重试'
      const rawMsg = res.message || fallbackMsg
      setErrorMessage(formatUpstreamSmsError(rawMsg))
      setStep('input_phone')
    }
  }

  const handleSendSms = async () => {
    if (busyRef.current) return
    if (!/^1[3-9]\d{9}$/.test(phone.trim())) {
      toast.error('请输入正确的11位中国大陆手机号')
      return
    }
    resetSession()
    const attempt = attemptRef.current
    await perform(async () => {
      const res = await kukuApi.startLoginSms({
        phone: phone.trim(),
        alias: alias.trim() || undefined,
        priority,
      })
      if (mountedRef.current && attempt === attemptRef.current)
        applySendResponse(res)
    })
  }

  const handleResendCode = async () => {
    if (!loginId || sessionTtl <= 0 || resendCooldown > 0 || sendCount >= 5)
      return
    const attempt = attemptRef.current
    await perform(async () => {
      const res = await kukuApi.resendLoginSms({ login_id: loginId })
      if (mountedRef.current && attempt === attemptRef.current)
        applySendResponse(res)
    })
  }

  const handleVerifySms = async (captcha?: string) => {
    if (!loginId || sessionTtl <= 0 || !/^\d{6}$/.test(smsCode)) return
    const attempt = attemptRef.current
    await perform(async () => {
      const res = await kukuApi.verifyLoginSms({
        login_id: loginId,
        code: smsCode,
        ...(captcha ? { captcha: { code: captcha.trim() } } : {}),
      })
      if (!mountedRef.current || attempt !== attemptRef.current) return
      syncTiming(res)
      if (res.state === 'added') {
        setAccountId(res.account_id ?? null)
        setStep('added')
        setSmsCode('')
        setCaptchaCode('')
        cleanupCaptchaBlob()
        sessionDeadlineRef.current = 0
        retryDeadlineRef.current = 0
        toast.success(res.refreshed_existing ? '账号登录凭据已更新，可用于自动续期' : '百度账号已成功入池')
        void refreshAccounts()
        onSuccess?.()
      } else if (res.state === 'captcha_required') {
        showCaptcha(res)
      } else {
        setErrorMessage(
          res.reason || res.message || '验证码错误或登录失败，请重试'
        )
        if (res.state === 'failed') setStep('failed')
      }
    })
  }

  const handleResendWithCaptcha = async () => {
    if (!loginId || !captchaCode.trim() || sessionTtl <= 0) return
    if (captchaStage === 'verify') {
      await handleVerifySms(captchaCode)
      return
    }
    const attempt = attemptRef.current
    await perform(async () => {
      const res = await kukuApi.resendLoginSms({
        login_id: loginId,
        captcha: { code: captchaCode.trim() },
      })
      if (mountedRef.current && attempt === attemptRef.current)
        applySendResponse(res)
    })
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
        <AlertTitle className='text-xs font-semibold'>
          手机号验证码加号
        </AlertTitle>
        <AlertDescription className='text-xs text-muted-foreground'>
          使用已有百度账号的手机号接收验证码，验证成功后自动加入号池。
        </AlertDescription>
      </Alert>

      {/* Unregistered Phone Special Warning */}
      {isUnregistered && (
        <Alert variant='destructive'>
          <AlertCircle className='size-4' />
          <AlertTitle className='text-xs font-bold'>该手机号未注册</AlertTitle>
          <AlertDescription className='text-xs'>
            百度账号系统中未查找到该手机号。请先使用百度App或前往
            passport.baidu.com 完成注册后再次尝试。
          </AlertDescription>
        </Alert>
      )}

      {errorMessage && (
        <Alert variant='destructive' className='text-xs'>
          <AlertCircle className='size-4' />
          <div className='flex-1 space-y-2'>
            <AlertDescription>{errorMessage}</AlertDescription>
            {errorMessage.includes('百度App 扫码') && (
              <Button
                type='button'
                size='sm'
                variant='outline'
                onClick={handleSwitchToQr}
                className='h-7 text-xs gap-1.5 mt-1 bg-background text-foreground'
              >
                <QrCode size={13} />
                <span>切换到百度App扫码登录</span>
              </Button>
            )}
          </div>
        </Alert>
      )}

      {loginId && sessionTtl <= 0 && step !== 'added' && (
        <Alert variant='destructive'>
          <Clock className='size-4' />
          <AlertTitle>短信会话已过期</AlertTitle>
          <AlertDescription>
            请重新发起登录，不会自动发送新的短信。
          </AlertDescription>
          <Button
            type='button'
            size='sm'
            variant='outline'
            onClick={resetSession}
            disabled={loading}
          >
            重新发起登录
          </Button>
        </Alert>
      )}

      {step === 'failed' && (
        <Button type='button' variant='outline' onClick={resetSession}>
          返回重新登录
        </Button>
      )}

      {/* Step 1: Input Phone and Optional Config */}
      {step === 'input_phone' && (
        <div className='space-y-3 rounded-lg border bg-card p-4 shadow-xs'>
          <div className='space-y-1.5'>
            <Label htmlFor='sms-phone' className='text-xs font-semibold'>
              手机号码 (必填)
            </Label>
            <div className='flex gap-2'>
              <Input
                id='sms-phone'
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
            <div className='flex items-center justify-between text-[11px]'>
              <p className='text-muted-foreground'>
                仅用于接收一次性验证码，前端与服务端绝不持久化存储手机号。
              </p>
              {phone.length > 0 && (
                <span
                  className={
                    phone.length === 11 && /^1[3-9]\d{9}$/.test(phone)
                      ? 'font-medium text-emerald-600 dark:text-emerald-400'
                      : phone.length === 11
                        ? 'font-medium text-destructive'
                        : 'text-muted-foreground'
                  }
                >
                  {phone.length === 11 && /^1[3-9]\d{9}$/.test(phone)
                    ? '✓ 格式有效'
                    : phone.length === 11
                      ? '号码开头有误(需以13~19开头)'
                      : `已输入 ${phone.length}/11 位`}
                </span>
              )}
            </div>
          </div>

          <div className='grid grid-cols-2 gap-3 pt-1 text-xs'>
            <div className='space-y-1'>
              <Label htmlFor='sms-alias' className='text-xs'>
                账号别名 / 备注 (可选)
              </Label>
              <Input
                id='sms-alias'
                disabled={loading}
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder='例如: 手机号二号'
                className='h-8 text-xs'
              />
            </div>
            <div className='space-y-1'>
              <Label htmlFor='sms-priority' className='text-xs'>
                调度优先级序号
              </Label>
              <Input
                id='sms-priority'
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
              onClick={() => void handleSendSms()}
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

      {/* Step 1.5: Captcha Required Form */}
      {step === 'captcha_required' && (
        <div className='space-y-3 rounded-lg border bg-card p-4 shadow-xs'>
          <div className='flex items-center gap-2 text-amber-600 dark:text-amber-400'>
            <ShieldAlert size={16} />
            <span className='text-xs font-semibold'>
              {slideRequired
                ? '上游要求滑块验证'
                : '上游触发安全防护，请输入图形验证码'}
            </span>
          </div>

          {slideRequired ? (
            <Button
              type='button'
              variant='outline'
              onClick={handleSwitchToQr}
            >
              改用百度App扫码登录
            </Button>
          ) : (
            <>
              <div className='flex items-center gap-4 py-2'>
                <div className='relative flex h-12 w-36 items-center justify-center overflow-hidden rounded-md border bg-white shadow-xs'>
                  {captchaBlobUrl ? (
                    <img
                      src={captchaBlobUrl}
                      alt='图形验证码'
                      className='h-full w-full cursor-pointer object-contain'
                      onClick={() =>
                        captchaPath && void loadCaptchaImage(captchaPath)
                      }
                      title='看不清？点击刷新图片'
                    />
                  ) : captchaImageLoading ? (
                    <Loader2
                      size={16}
                      className='animate-spin text-muted-foreground'
                    />
                  ) : (
                    <span className='px-2 text-xs text-destructive'>
                      图片不可用
                    </span>
                  )}
                </div>

                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={() =>
                    captchaPath && void loadCaptchaImage(captchaPath)
                  }
                  disabled={
                    loading ||
                    captchaImageLoading ||
                    !captchaPath ||
                    sessionTtl <= 0
                  }
                  className='h-8 gap-1 text-xs'
                >
                  <RotateCw size={12} />
                  <span>刷新图形码</span>
                </Button>
              </div>

              {captchaImageError && (
                <p role='alert' className='text-xs text-destructive'>
                  {captchaImageError}
                </p>
              )}

              <div className='space-y-1.5'>
                <Label htmlFor='sms-captcha' className='text-xs'>
                  输入图形验证码中的字符
                </Label>
                <Input
                  id='sms-captcha'
                  autoComplete='off'
                  value={captchaCode}
                  onChange={(e) => setCaptchaCode(e.target.value)}
                  placeholder='输入图中字符'
                  className='h-9 font-mono text-sm tracking-widest uppercase'
                  maxLength={8}
                />
              </div>
            </>
          )}

          <div className='flex items-center justify-between pt-2'>
            <Button
              variant='ghost'
              size='sm'
              onClick={resetSession}
              disabled={loading}
              className='text-xs'
            >
              返回修改手机号
            </Button>
            <Button
              size='sm'
              onClick={() => void handleResendWithCaptcha()}
              disabled={
                loading ||
                !captchaCode.trim() ||
                !captchaBlobUrl ||
                slideRequired ||
                sessionTtl <= 0
              }
              className='gap-1.5'
            >
              {loading ? (
                <Loader2 size={14} className='animate-spin' />
              ) : (
                <Send size={14} />
              )}
              <span>
                {captchaStage === 'verify'
                  ? '确认并完成登录'
                  : '确认并发送短信'}
              </span>
            </Button>
          </div>
        </div>
      )}

      {/* Step 2: Input SMS Code */}
      {step === 'input_code' && (
        <div className='space-y-3 rounded-lg border bg-card p-4 shadow-xs'>
          <div className='flex items-center justify-between border-b pb-1 text-xs text-muted-foreground'>
            <span>
              接收号码:{' '}
              <strong className='font-mono text-foreground'>{phone}</strong>
            </span>
            <div className='flex items-center gap-1.5 font-mono text-[11px]'>
              <Clock size={12} />
              <span>会话有效期: {formatSessionTime(sessionTtl)}</span>
            </div>
          </div>

          <div className='space-y-2 py-1'>
            <Label htmlFor='sms-code' className='text-xs font-semibold'>
              短信验证码 (6位数字)
            </Label>
            <Input
              id='sms-code'
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
              onClick={() => void handleResendCode()}
              disabled={
                loading ||
                resendCooldown > 0 ||
                sendCount >= 5 ||
                sessionTtl <= 0
              }
              className='gap-1 text-xs'
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
              disabled={loading || !/^\d{6}$/.test(smsCode) || sessionTtl <= 0}
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
            <span>发送限制: 每会话最多5次 (已发 {sendCount} 次)</span>
            <button
              type='button'
              onClick={resetSession}
              disabled={loading}
              className='cursor-pointer text-primary hover:underline'
            >
              更换手机号
            </button>
          </div>
        </div>
      )}

      {/* Success State */}
      {step === 'added' && (
        <div className='flex flex-col items-center gap-3 rounded-lg border bg-card py-6 text-center text-emerald-600 dark:text-emerald-400'>
          <div className='rounded-full bg-emerald-500/10 p-3'>
            <CheckCircle2 size={32} />
          </div>
          <div className='space-y-1.5'>
            <p className='text-sm font-bold'>短信加号成功！</p>
            <p className='text-xs text-muted-foreground'>
              账号 ID:{' '}
              <code className='font-mono font-semibold text-foreground'>
                {accountId}
              </code>
            </p>
            <Badge
              variant='outline'
              className='mt-1 border-emerald-500/40 text-[11px] text-emerald-600 dark:text-emerald-400'
            >
              新凭据已通过上游探针校验并存入号池
            </Badge>
            <div className='mt-3 max-w-sm rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 text-start text-[11px] text-muted-foreground'>
              <span className='font-semibold text-foreground'>
                💡 上游生效窗口说明：
              </span>
              <p className='mt-0.5 leading-relaxed'>
                新换出凭据通常有几分钟的上游生效期，期间剩余积分可能短暂读 0
                并等待生效，之后会自动恢复正常服务。请耐心等待生效，
                <strong>切勿删号重试</strong>。
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
