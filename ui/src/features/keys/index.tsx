'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  KeyRound,
  Plus,
  RefreshCw,
  Copy,
  Check,
  Trash2,
  ShieldCheck,
  AlertTriangle,
  Clock,
  Shield,
  Loader2,
  Eye,
  EyeOff,
} from 'lucide-react'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'
import { ConfigDrawer } from '@/components/config-drawer'
import { Search } from '@/components/search'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { toast } from 'sonner'
import {
  kukuApi,
  type ApiKeyItem,
  getApiSettings,
  saveApiSettings,
} from '@/lib/kuku-api'

export function Keys() {
  const [keys, setKeys] = useState<ApiKeyItem[]>([])
  const [isOpen, setIsOpen] = useState<boolean>(true)
  const [loading, setLoading] = useState<boolean>(true)
  const [createDialogOpen, setCreateDialogOpen] = useState<boolean>(false)
  const [newKeyLabel, setNewKeyLabel] = useState<string>('')
  const [createdSecret, setCreatedSecret] = useState<string | null>(null)
  const [creating, setCreating] = useState<boolean>(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const [showSecret, setShowSecret] = useState<boolean>(true)

  // Deletion confirmation
  const [deletingKey, setDeletingKey] = useState<ApiKeyItem | null>(null)
  const [isDeleting, setIsDeleting] = useState<boolean>(false)

  const fetchKeys = useCallback(async () => {
    try {
      setLoading(true)
      const res = await kukuApi.listKeys()
      setKeys(res.keys || [])
      setIsOpen(res.open)
    } catch (err: unknown) {
      toast.error('获取 API 密钥列表失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let ignore = false
    void (async () => {
      try {
        const res = await kukuApi.listKeys()
        if (!ignore) {
          setKeys(res.keys || [])
          setIsOpen(res.open)
        }
      } catch (err: unknown) {
        if (!ignore) {
          toast.error('获取 API 密钥列表失败: ' + (err instanceof Error ? err.message : String(err)))
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

  const copyToClipboard = async (text: string): Promise<boolean> => {
    if (!text) return false
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        // Fallback to legacy execCommand
      }
    }
    try {
      const textArea = document.createElement('textarea')
      textArea.value = text
      textArea.style.position = 'fixed'
      textArea.style.left = '-999999px'
      textArea.style.top = '-999999px'
      textArea.setAttribute('readonly', '')
      document.body.appendChild(textArea)
      textArea.focus()
      textArea.select()
      const success = document.execCommand('copy')
      textArea.remove()
      return success
    } catch {
      return false
    }
  }

  const handleCopySecret = async (secret: string) => {
    const success = await copyToClipboard(secret)
    if (success) {
      setCopiedKey('secret')
      toast.success('已完整复制 API 密钥 (Secret) 到剪贴板！', {
        description: `密钥共 ${secret.length} 字符，请妥善保管。`,
      })
      setTimeout(() => setCopiedKey(null), 2500)
    } else {
      toast.error('复制失败，请在输入框内全选手动复制')
    }
  }

  const handleCopyHint = async (hintText: string, id: string) => {
    const success = await copyToClipboard(hintText)
    if (success) {
      setCopiedKey(id)
      toast.info('已复制脱敏掩码 (Hint)', {
        description: '注意：这是脱敏后的掩码摘要（含省略号），并非完整 API 密钥。服务端出于安全不保存明文，完整密钥仅在创建时出现一次。',
        duration: 4000,
      })
      setTimeout(() => setCopiedKey(null), 2000)
    } else {
      toast.error('复制失败')
    }
  }

  const handleCreateKey = async () => {
    try {
      setCreating(true)
      const res = await kukuApi.createKey(newKeyLabel.trim() || undefined)
      if (res.ok && res.key) {
        const fullSecret = res.key.secret
        setCreatedSecret(fullSecret)
        setShowSecret(true)

        // 1. 自动同步绑定至本地控制台设置，管理后台无需手动配置
        const current = getApiSettings()
        saveApiSettings({ ...current, apiKey: fullSecret })

        // 2. 尝试自动复制完整密钥至系统剪贴板
        const copied = await copyToClipboard(fullSecret)
        if (copied) {
          setCopiedKey('secret')
          toast.success('API 密钥已成功生成并已自动复制到剪贴板！', {
            description: '已自动绑定为本控制台当前 API Key，管理后台无需额外填入密钥。',
            duration: 6000,
          })
          setTimeout(() => setCopiedKey(null), 3000)
        } else {
          toast.success('API 密钥已成功生成！', {
            description: '已自动绑定为本控制台当前 API Key，请点击按钮复制完整密钥。',
            duration: 6000,
          })
        }

        void fetchKeys()
      }
    } catch (err: unknown) {
      toast.error('生成密钥失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setCreating(false)
    }
  }

  const handleDeleteConfirm = async () => {
    if (!deletingKey) return
    try {
      setIsDeleting(true)
      const res = await kukuApi.deleteKey(deletingKey.id)
      setKeys(res.keys || [])
      setIsOpen(res.api_now_unauthenticated)

      if (res.api_now_unauthenticated) {
        toast.warning('密钥已吊销！注意：当前号池已无任何有效密钥，/v1/* 现已处于【无鉴权裸奔模式】！', {
          duration: 6000,
        })
      } else {
        toast.success(`密钥 ${deletingKey.label || deletingKey.hint} 已成功吊销`)
      }
      setDeletingKey(null)
    } catch (err: unknown) {
      toast.error('吊销密钥失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setIsDeleting(false)
    }
  }

  // Count active non-env keys
  const remainingRevocableKeys = keys.filter((k) => !k.from_env)
  const isRevokingLastKey = deletingKey && remainingRevocableKeys.length === 1 && keys.length === 1

  return (
    <>
      <Header fixed>
        <Search className='me-auto' />
        <ThemeSwitch />
        <ConfigDrawer />
      </Header>

      <Main className='flex flex-1 flex-col gap-4 sm:gap-6'>
        {/* Page Top Heading */}
        <div className='flex flex-wrap items-end justify-between gap-4'>
          <div>
            <div className='flex items-center gap-2'>
              <h2 className='text-2xl font-bold tracking-tight'>API 密钥管理</h2>
              <Badge variant={isOpen ? 'destructive' : 'default'} className='text-xs'>
                {isOpen ? 'API 开放 (无鉴权)' : '鉴权保护中'}
              </Badge>
            </div>
            <p className='text-sm text-muted-foreground mt-1'>
              管理用于调用 <code className='font-mono'>/v1/*</code> 模型推理端点的访问密钥（<code className='font-mono text-xs'>/pool/admin/keys</code>）。增删密钥在下一个请求立即生效。
            </p>
          </div>

          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size='sm'
              onClick={() => void fetchKeys()}
              disabled={loading}
              className='gap-1.5'
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              <span>刷新列表</span>
            </Button>
            <Button
              size='sm'
              onClick={() => {
                setNewKeyLabel('')
                setCreatedSecret(null)
                setCreateDialogOpen(true)
              }}
              className='gap-1.5'
            >
              <Plus size={16} />
              <span>生成新密钥</span>
            </Button>
          </div>
        </div>

        {/* ⚠️ Prominent API Open / Security Status Banner */}
        {isOpen ? (
          <Alert variant='destructive' className='border-amber-500/60 bg-amber-500/10 text-amber-950 dark:text-amber-200'>
            <AlertTriangle className='size-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5' />
            <div className='space-y-1'>
              <AlertTitle className='font-bold text-sm'>
                ⚠️ 警告：当前 API 处于完全开放模式 (未开启密钥鉴权)
              </AlertTitle>
              <AlertDescription className='text-xs leading-relaxed'>
                当前号池中未配置任何有效 API 密钥，服务端已进入<strong>本机自用模式</strong>。在此状态下，所有 <code className='font-mono font-semibold'>/v1/chat/completions</code> 与 <code className='font-mono font-semibold'>/v1/responses</code> 推理端点<strong>无需携带任何 API Key 即可自由调用</strong>。
                若该服务暴露在公共网络或共享环境中，存在被他人消耗额度的风险，请立即点击上方「生成新密钥」以启用安全鉴权！
              </AlertDescription>
            </div>
          </Alert>
        ) : (
          <Alert className='border-emerald-500/40 bg-emerald-500/10 text-emerald-950 dark:text-emerald-200'>
            <ShieldCheck className='size-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5' />
            <div className='space-y-1'>
              <AlertTitle className='font-semibold text-sm'>
                API 鉴权保护中 (安全)
              </AlertTitle>
              <AlertDescription className='text-xs'>
                当前已配置 <strong>{keys.length}</strong> 个有效密钥。所有调用方必须在请求头中携带合法 <code className='font-mono text-xs'>Authorization: Bearer sk-kuku-xxx</code> 或 <code className='font-mono text-xs'>x-api-key</code> 方可调用推理接口。管理端路由（/pool/admin/*）独立由 ADMIN_TOKEN 保护。
              </AlertDescription>
            </div>
          </Alert>
        )}

        {/* Keys Table Container */}
        <div className='rounded-lg border bg-card shadow-xs overflow-hidden'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className='w-[240px]'>密钥标识 (脱敏掩码)</TableHead>
                <TableHead>备注标识 (Label)</TableHead>
                <TableHead className='w-[160px]'>来源类型</TableHead>
                <TableHead className='w-[180px]'>创建时间</TableHead>
                <TableHead className='w-[100px] text-right'>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={5} className='h-32 text-center text-muted-foreground'>
                    <Loader2 className='size-5 animate-spin mx-auto mb-2 text-primary' />
                    <span className='text-xs'>正在加载密钥列表...</span>
                  </TableCell>
                </TableRow>
              )}

              {!loading && keys.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className='h-36 text-center text-muted-foreground'>
                    <div className='flex flex-col items-center justify-center gap-1.5'>
                      <KeyRound className='size-7 text-muted-foreground/60' />
                      <p className='text-sm font-medium text-foreground'>暂无任何 API 密钥</p>
                      <p className='text-xs text-muted-foreground'>
                        当前处于无鉴权自用模式。点击上方「生成新密钥」创建第一个访问令牌。
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              )}

              {!loading && keys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className='font-mono text-xs'>
                    <div className='flex items-center gap-1.5'>
                      <Badge variant='outline' className='font-mono font-medium text-[11px] bg-muted/50 border-muted-foreground/30'>
                        {key.hint}
                      </Badge>
                      <Button
                        variant='ghost'
                        size='icon'
                        onClick={() => void handleCopyHint(key.hint, `hint-${key.id}`)}
                        className='size-6 text-muted-foreground hover:text-foreground'
                        title='复制脱敏掩码 (注：非完整密钥)'
                      >
                        {copiedKey === `hint-${key.id}` ? (
                          <Check size={12} className='text-emerald-500' />
                        ) : (
                          <Copy size={12} />
                        )}
                      </Button>
                    </div>
                  </TableCell>

                  <TableCell className='text-xs font-medium'>
                    {key.label || <span className='text-muted-foreground italic'>无备注</span>}
                  </TableCell>

                  <TableCell>
                    {key.from_env ? (
                      <Badge variant='secondary' className='text-[11px] gap-1'>
                        <Shield size={11} />
                        <span>环境变量 (API_KEYS)</span>
                      </Badge>
                    ) : (
                      <Badge variant='outline' className='text-[11px] border-primary/30 text-primary'>
                        运行时动态生成
                      </Badge>
                    )}
                  </TableCell>

                  <TableCell className='text-xs text-muted-foreground font-mono'>
                    <div className='flex items-center gap-1'>
                      <Clock size={12} />
                      <span>{new Date(key.created_at).toLocaleString()}</span>
                    </div>
                  </TableCell>

                  <TableCell className='text-right'>
                    {key.from_env ? (
                      <Button
                        variant='ghost'
                        size='sm'
                        disabled
                        className='h-8 text-xs text-muted-foreground cursor-not-allowed opacity-50'
                        title='环境变量中配置的密钥删不掉（400），如需移除请修改后端环境变量 API_KEYS'
                      >
                        不可删除
                      </Button>
                    ) : (
                      <Button
                        variant='ghost'
                        size='sm'
                        onClick={() => setDeletingKey(key)}
                        className='h-8 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive gap-1'
                      >
                        <Trash2 size={13} />
                        <span>吊销</span>
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Main>

      {/* Create Key Dialog */}
      <Dialog
        open={createDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setCreatedSecret(null)
            setNewKeyLabel('')
          }
          setCreateDialogOpen(open)
        }}
      >
        <DialogContent className='sm:max-w-md'>
          <DialogHeader className='text-start'>
            <DialogTitle>{createdSecret ? 'API 密钥生成成功' : '生成新 API 密钥'}</DialogTitle>
            <DialogDescription>
              {createdSecret
                ? '此密钥仅在本次创建响应中完整出现，关闭窗口后将无法再次找回！'
                : '密钥用于调用 /v1/* 推理接口，生成后将持久化并在服务端立即生效。'}
            </DialogDescription>
          </DialogHeader>

          {!createdSecret ? (
            /* Input Label Form */
            <div className='space-y-4 py-2'>
              <div className='space-y-1.5'>
                <Label className='text-xs font-semibold'>备注标识 / 应用名称 (可选)</Label>
                <Input
                  value={newKeyLabel}
                  onChange={(e) => setNewKeyLabel(e.target.value)}
                  placeholder='例如: 开发调试、OpenWebUI、沉浸式翻译'
                  className='text-xs'
                  autoFocus
                />
                <p className='text-[11px] text-muted-foreground'>
                  用于区分不同客户端或调用方，后续可在密钥列表中查看。
                </p>
              </div>

              <DialogFooter className='gap-y-2 pt-2'>
                <Button
                  type='button'
                  variant='outline'
                  onClick={() => setCreateDialogOpen(false)}
                >
                  取消
                </Button>
                <Button
                  onClick={() => void handleCreateKey()}
                  disabled={creating}
                  className='gap-1.5'
                >
                  {creating ? <Loader2 size={14} className='animate-spin' /> : <KeyRound size={14} />}
                  <span>立即生成密钥</span>
                </Button>
              </DialogFooter>
            </div>
          ) : (
            /* One-Time Secret Display Mode */
            <div className='space-y-4 py-2'>
              <Alert className='border-emerald-500/80 bg-emerald-500/10 text-emerald-950 dark:text-emerald-200'>
                <ShieldCheck className='size-4 text-emerald-600 dark:text-emerald-400 shrink-0' />
                <AlertDescription className='text-xs font-semibold leading-relaxed'>
                  API 密钥生成成功！<strong>管理后台已自动绑定此密钥，本控制台无需再手动配置。</strong>如需在第三方客户端（如 NextChat、沉浸式翻译）中使用，请立即点击下方按钮复制并妥善保管！关闭此弹窗后将无法再次找回明文！
                </AlertDescription>
              </Alert>

              <div className='space-y-2'>
                <div className='flex items-center justify-between'>
                  <Label className='text-xs font-semibold'>完整 API Key (共 {createdSecret.length} 字符)</Label>
                  <span className='text-[11px] text-muted-foreground font-mono'>格式: sk-kuku-xxx</span>
                </div>
                <div className='relative flex items-center'>
                  <Input
                    value={createdSecret}
                    readOnly
                    type={showSecret ? 'text' : 'password'}
                    onFocus={(e) => e.target.select()}
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                    className='font-mono text-xs pr-10 bg-muted select-all'
                  />
                  <Button
                    type='button'
                    variant='ghost'
                    size='icon'
                    className='absolute right-1 size-7 text-muted-foreground hover:text-foreground'
                    onClick={() => setShowSecret(!showSecret)}
                    title={showSecret ? '隐藏明文' : '显示明文'}
                  >
                    {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                  </Button>
                </div>
                <p className='text-[11px] text-muted-foreground'>
                  提示：点击上方输入框可一键全选，或直接点击下方按钮一键复制完整密钥。
                </p>
              </div>

              <div className='flex flex-col gap-2 pt-2 border-t'>
                <Button
                  type='button'
                  size='default'
                  onClick={() => void handleCopySecret(createdSecret)}
                  className='w-full gap-2 font-semibold shadow-sm'
                >
                  {copiedKey === 'secret' ? <Check size={16} className='text-emerald-300' /> : <Copy size={16} />}
                  <span>{copiedKey === 'secret' ? '✓ 完整密钥已复制到剪贴板！' : '一键完整复制 API Key'}</span>
                </Button>

                <div className='flex justify-between items-center mt-1'>
                  <span className='text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1 font-medium'>
                    <Check size={13} />
                    <span>控制台已自动绑定</span>
                  </span>
                  <Button
                    type='button'
                    variant='outline'
                    onClick={() => setCreateDialogOpen(false)}
                    className='text-xs'
                  >
                    我已复制保管，关闭窗口
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete / Revoke Confirmation Dialog */}
      <ConfirmDialog
        open={Boolean(deletingKey)}
        onOpenChange={(open) => !open && setDeletingKey(null)}
        handleConfirm={() => void handleDeleteConfirm()}
        isLoading={isDeleting}
        destructive
        title={
          isRevokingLastKey
            ? '⚠️ 危险：即将吊销最后一个 API 密钥'
            : `确认吊销 API 密钥`
        }
        desc={
          isRevokingLastKey ? (
            <div className='space-y-2 text-xs leading-relaxed'>
              <p className='font-semibold text-destructive'>
                吊销密钥「{deletingKey?.label || deletingKey?.hint}」后，号池将不再包含任何有效 API Key！
              </p>
              <p>
                服务端将<strong>立即进入无鉴权开放模式</strong>，所有 <code className='font-mono text-destructive'>/v1/*</code> 推理接口将变为<strong>裸奔状态（任何人无需密钥即可直接调用）</strong>。
              </p>
              <p className='text-muted-foreground'>
                您确定要继续吊销此密钥并开放 API 吗？
              </p>
            </div>
          ) : (
            `您确定要吊销密钥「${deletingKey?.label || deletingKey?.hint}」吗？吊销后该密钥将在下一个请求立即失效，不可撤回。`
          )
        }
        confirmText={isRevokingLastKey ? '确认吊销并开放 API' : '确认吊销'}
        cancelBtnText='取消'
      />
    </>
  )
}
