'use client'

import { useState } from 'react'
import {
  ShieldAlert,
  ShieldCheck,
  KeyRound,
  Loader2,
  Server,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { PasswordInput } from '@/components/password-input'
import {
  getApiSettings,
  saveApiSettings,
  verifyAdminToken,
} from '@/lib/kuku-api'
import { toast } from 'sonner'

interface AdminAuthGateProps {
  onAuthenticated?: () => void
  unauthorizedReason?: string | null
}

export function AdminAuthGate({
  onAuthenticated,
  unauthorizedReason,
}: AdminAuthGateProps) {
  const currentSettings = getApiSettings()
  const [token, setToken] = useState('')
  const [baseUrl, setBaseUrl] = useState(
    currentSettings.baseUrl || 'http://127.0.0.1:8787'
  )
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [isVerifying, setIsVerifying] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(
    unauthorizedReason || null
  )

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) {
      e.preventDefault()
    }

    const trimmedToken = token.trim()
    if (!trimmedToken) {
      setErrorMessage('请输入管理员令牌 (ADMIN_TOKEN)')
      return
    }

    setIsVerifying(true)
    setErrorMessage(null)

    const cleanBaseUrl = baseUrl.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8787'
    const result = await verifyAdminToken(trimmedToken, cleanBaseUrl)

    setIsVerifying(false)

    if (result.ok) {
      saveApiSettings({
        baseUrl: cleanBaseUrl,
        apiKey: currentSettings.apiKey || '',
        adminToken: trimmedToken,
      })
      toast.success('管理员令牌验证成功', {
        description: '已成功接入 KuKu 运维控制台',
      })
      onAuthenticated?.()
    } else {
      const errMsg = result.message || '管理员令牌验证失败 (401)'
      setErrorMessage(errMsg)
      toast.error('鉴权失败', {
        description: errMsg,
      })
    }
  }

  return (
    <div className='relative min-h-screen w-full flex flex-col justify-center items-center bg-muted/30 px-4 py-8 selection:bg-primary selection:text-primary-foreground'>
      <div className='w-full max-w-md space-y-6'>
        {/* Header branding */}
        <div className='text-center space-y-2'>
          <div className='inline-flex items-center justify-center p-3 rounded-2xl bg-primary/10 text-primary border border-primary/20 shadow-xs mb-1'>
            {unauthorizedReason ? (
              <ShieldAlert className='size-8 text-amber-500' />
            ) : (
              <ShieldCheck className='size-8 text-primary' />
            )}
          </div>
          <h1 className='text-2xl font-bold tracking-tight'>
            KuKu 运维控制台鉴权
          </h1>
          <p className='text-xs text-muted-foreground max-w-xs mx-auto'>
            {unauthorizedReason
              ? '当前管理员令牌已失效或被服务端拒绝，请重新输入有效凭证。'
              : '当前浏览器尚未配置管理员凭证，请输入后端服务的 ADMIN_TOKEN 以解锁控制台。'}
          </p>
        </div>

        {/* Auth Card */}
        <div className='rounded-xl border bg-card p-6 shadow-sm space-y-5'>
          {errorMessage && (
            <Alert variant='destructive' className='py-2.5 px-3 text-xs'>
              <AlertCircle className='size-4' />
              <div className='ml-2'>
                <AlertTitle className='text-xs font-semibold'>鉴权提示</AlertTitle>
                <AlertDescription className='text-xs mt-0.5 break-all'>
                  {errorMessage}
                </AlertDescription>
              </div>
            </Alert>
          )}

          <form onSubmit={handleSubmit} className='space-y-4'>
            <div className='space-y-2'>
              <Label
                htmlFor='admin-token-input'
                className='text-xs font-semibold flex items-center gap-1.5'
              >
                <KeyRound size={14} className='text-primary' />
                <span>管理员令牌 (ADMIN_TOKEN)</span>
              </Label>
              <PasswordInput
                id='admin-token-input'
                value={token}
                onChange={(e) => {
                  setToken(e.target.value)
                  if (errorMessage) setErrorMessage(null)
                }}
                placeholder='请输入后端 ADMIN_TOKEN 凭证'
                className='font-mono text-xs'
                autoFocus
                disabled={isVerifying}
              />
              <p className='text-[11px] text-muted-foreground'>
                填写后端服务进程启动时配置的{' '}
                <code className='font-mono bg-muted px-1 py-0.5 rounded text-[10px]'>
                  ADMIN_TOKEN
                </code>
                。
              </p>
            </div>

            {/* Advanced toggle (Base URL) */}
            <div className='pt-1'>
              <button
                type='button'
                onClick={() => setShowAdvanced(!showAdvanced)}
                className='text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors'
              >
                <Server size={12} />
                <span>服务端地址配置</span>
                {showAdvanced ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>

              {showAdvanced && (
                <div className='mt-2.5 space-y-1.5 rounded-lg border bg-muted/40 p-3 animate-in fade-in-50 duration-150'>
                  <Label htmlFor='base-url-input' className='text-[11px] font-medium'>
                    服务端基准地址 (Base URL)
                  </Label>
                  <Input
                    id='base-url-input'
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder='http://127.0.0.1:8787'
                    className='font-mono text-xs h-8'
                    disabled={isVerifying}
                  />
                  <p className='text-[10px] text-muted-foreground'>
                    默认为 <code className='font-mono'>http://127.0.0.1:8787</code>
                  </p>
                </div>
              )}
            </div>

            <Button
              type='submit'
              className='w-full font-medium'
              disabled={isVerifying || !token.trim()}
            >
              {isVerifying ? (
                <>
                  <Loader2 className='size-4 animate-spin mr-2' />
                  正在校验管理员令牌...
                </>
              ) : (
                <>
                  <KeyRound className='size-4 mr-2' />
                  验证并进入控制台
                </>
              )}
            </Button>
          </form>
        </div>

        {/* Security tips footer */}
        <div className='text-center space-y-1 text-[11px] text-muted-foreground'>
          <p className='flex items-center justify-center gap-1'>
            <Sparkles size={12} className='text-primary' />
            <span>凭证仅保存在当前浏览器的本地存储中，不会上传第三方。</span>
          </p>
          <p>更换不同浏览器、隐身窗口或清除缓存时均需重新输入。</p>
        </div>
      </div>
    </div>
  )
}
