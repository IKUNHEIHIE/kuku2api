'use client'

import { useState, useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import {
  Server,
  Key,
  Shield,
  Activity,
  CheckCircle2,
  XCircle,
  Save,
  RotateCcw,
  ExternalLink,
  Database,
  Clock,
  Sliders,
  AlertTriangle,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { toast } from 'sonner'
import {
  getApiSettings,
  saveApiSettings,
  sanitizeHeaderValue,
  kukuApi,
  type ApiSettings,
  type AdminSettingsResponse,
  type PatchSettingsPayload,
} from '@/lib/kuku-api'

interface TestStatus {
  healthz: { tested: boolean; ok: boolean; message: string }
  poolState: { tested: boolean; ok: boolean; message: string }
  models: { tested: boolean; ok: boolean; message: string }
  adminToken: { tested: boolean; ok: boolean; message: string }
}

export function ProfileForm() {
  // 1. 本机连接配置 (Client Settings)
  const [settings, setSettings] = useState<ApiSettings>(getApiSettings())
  const [isTesting, setIsTesting] = useState(false)
  const [testResults, setTestResults] = useState<TestStatus | null>(null)

  // 2. 服务端数据库设置 (Server Settings from SQLite)
  const [serverSettingsData, setServerSettingsData] = useState<AdminSettingsResponse | null>(null)
  const [loadingServerSettings, setLoadingServerSettings] = useState(true)
  const [savingServerSettings, setSavingServerSettings] = useState(false)
  const [serverForm, setServerForm] = useState({
    site_name: 'kuku2api',
    log_retention_days: '30',
    conversation_retention_days: '0',
  })
  const [confirmRetentionOpen, setConfirmRetentionOpen] = useState(false)
  const [pendingPatchPayload, setPendingPatchPayload] = useState<PatchSettingsPayload | null>(null)

  // Fetch server settings from GET /pool/admin/settings
  const loadServerSettings = async (showLoading = true) => {
    try {
      if (showLoading) setLoadingServerSettings(true)
      const res = await kukuApi.getServerSettings()
      setServerSettingsData(res)
      setServerForm({
        site_name: res.settings?.site_name ?? 'kuku2api',
        log_retention_days: String(res.settings?.log_retention_days ?? 30),
        conversation_retention_days: String(res.settings?.conversation_retention_days ?? 0),
      })
    } catch (err: unknown) {
      toast.error('获取服务端系统设置失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setLoadingServerSettings(false)
    }
  }

  useEffect(() => {
    let ignore = false
    void (async () => {
      try {
        const res = await kukuApi.getServerSettings()
        if (!ignore) {
          setServerSettingsData(res)
          setServerForm({
            site_name: res.settings?.site_name ?? 'kuku2api',
            log_retention_days: String(res.settings?.log_retention_days ?? 30),
            conversation_retention_days: String(res.settings?.conversation_retention_days ?? 0),
          })
        }
      } catch (err: unknown) {
        if (!ignore) {
          toast.error('获取服务端系统设置失败: ' + (err instanceof Error ? err.message : String(err)))
        }
      } finally {
        if (!ignore) {
          setLoadingServerSettings(false)
        }
      }
    })()
    return () => {
      ignore = true
    }
  }, [])

  // Client settings handlers
  const handleSaveClientSettings = () => {
    const cleanAdmin = sanitizeHeaderValue(settings.adminToken)
    const cleanKey = sanitizeHeaderValue(settings.apiKey)
    const cleanBase = settings.baseUrl.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8787'
    const clean = { baseUrl: cleanBase, apiKey: cleanKey, adminToken: cleanAdmin }
    setSettings(clean)
    saveApiSettings(clean)
    toast.success('本机配置已成功保存到当前浏览器')
  }

  const handleResetClientSettings = () => {
    const defaults = {
      baseUrl: 'http://127.0.0.1:8787',
      apiKey: '',
      adminToken: '',
    }
    setSettings(defaults)
    saveApiSettings(defaults)
    toast.info('已重置为初始配置')
  }

  const handleTestConnection = async () => {
    setIsTesting(true)
    const cleanAdmin = sanitizeHeaderValue(settings.adminToken)
    const cleanKey = sanitizeHeaderValue(settings.apiKey)
    const cleanBase = settings.baseUrl.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8787'
    const clean = { baseUrl: cleanBase, apiKey: cleanKey, adminToken: cleanAdmin }
    setSettings(clean)
    saveApiSettings(clean)

    const results: TestStatus = {
      healthz: { tested: false, ok: false, message: '' },
      poolState: { tested: false, ok: false, message: '' },
      models: { tested: false, ok: false, message: '' },
      adminToken: { tested: false, ok: false, message: '' },
    }

    // 1. Test /healthz
    try {
      const h = await kukuApi.getHealthz()
      results.healthz = {
        tested: true,
        ok: h.ok === true,
        message: h.ok ? '服务进程在线' : '返回异常',
      }
    } catch (e: unknown) {
      results.healthz = { tested: true, ok: false, message: e instanceof Error ? e.message : String(e) }
    }

    // 2. Test /pool/state
    try {
      const state = await kukuApi.getPoolState()
      results.poolState = {
        tested: true,
        ok: true,
        message: `号池已就绪 (${state.accounts?.length ?? 0} 个账号, admin=${state.admin_enabled})`,
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e)
      results.poolState = {
        tested: true,
        ok: false,
        message: errMsg.includes('bad api key')
          ? '号池已开启鉴权，可前往「密钥管理」页一键生成并自动绑定密钥'
          : errMsg,
      }
    }

    // 3. Test /v1/models
    try {
      const m = await kukuApi.getModels()
      results.models = {
        tested: true,
        ok: true,
        message: `获取到 ${m.data?.length ?? 0} 个推理模型`,
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e)
      results.models = {
        tested: true,
        ok: false,
        message: errMsg.includes('bad api key')
          ? '号池已开启鉴权，可前往「密钥管理」页一键生成并自动绑定密钥'
          : errMsg,
      }
    }

    // 4. Test admin auth via GET /pool/admin/keys
    try {
      const cleanBase = settings.baseUrl.trim().replace(/\/+$/, '')
      const cleanAdmin = sanitizeHeaderValue(settings.adminToken)
      const res = await fetch(`${cleanBase}/pool/admin/keys`, {
        method: 'GET',
        headers: {
          'content-type': 'application/json',
          'Authorization': `Bearer ${cleanAdmin}`,
          'x-admin-token': cleanAdmin,
        },
      })
      if (res.ok) {
        results.adminToken = {
          tested: true,
          ok: true,
          message: '管理端令牌鉴权成功',
        }
      } else {
        const errJson = await res.json().catch(() => ({}))
        results.adminToken = {
          tested: true,
          ok: false,
          message: errJson?.error?.message || `HTTP ${res.status}`,
        }
      }
    } catch (e: unknown) {
      results.adminToken = { tested: true, ok: false, message: e instanceof Error ? e.message : String(e) }
    }

    setTestResults(results)
    setIsTesting(false)

    if (results.healthz.ok && results.adminToken.ok) {
      toast.success('连通性测试全绿，所有服务与管理权限正常！')
    } else {
      toast.warning('部分测试未通过，请检查服务地址与令牌')
    }
  }

  // Server settings submit
  const handleServerSettingsSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!serverSettingsData) return

    const trimmedSiteName = serverForm.site_name.trim()
    if (!trimmedSiteName || trimmedSiteName.length > 80) {
      toast.error('站点名称必须在 1 到 80 个字符之间')
      return
    }

    const logDays = parseInt(serverForm.log_retention_days, 10)
    if (Number.isNaN(logDays) || logDays < 0 || logDays > 3650) {
      toast.error('日志保留天数必须在 0 到 3650 之间的整数（0 为长期保留）')
      return
    }

    const convDays = parseInt(serverForm.conversation_retention_days, 10)
    if (Number.isNaN(convDays) || convDays < 0 || convDays > 3650) {
      toast.error('对话保留天数必须在 0 到 3650 之间的整数（0 为长期保留）')
      return
    }

    // Build diff payload with ONLY changed direct fields
    const patchPayload: PatchSettingsPayload = {}
    if (trimmedSiteName !== serverSettingsData.settings.site_name) {
      patchPayload.site_name = trimmedSiteName
    }
    if (logDays !== serverSettingsData.settings.log_retention_days) {
      patchPayload.log_retention_days = logDays
    }
    if (convDays !== serverSettingsData.settings.conversation_retention_days) {
      patchPayload.conversation_retention_days = convDays
    }

    if (Object.keys(patchPayload).length === 0) {
      toast.info('配置未作任何修改')
      return
    }

    // If retention policy changed, require explicit user confirmation
    const retentionChanged =
      patchPayload.log_retention_days !== undefined ||
      patchPayload.conversation_retention_days !== undefined

    if (retentionChanged) {
      setPendingPatchPayload(patchPayload)
      setConfirmRetentionOpen(true)
      return
    }

    await executePatchServerSettings(patchPayload)
  }

  const executePatchServerSettings = async (payload: PatchSettingsPayload) => {
    try {
      setSavingServerSettings(true)
      const res = await kukuApi.patchServerSettings(payload)
      setServerSettingsData(res)
      setServerForm({
        site_name: res.settings?.site_name ?? 'kuku2api',
        log_retention_days: String(res.settings?.log_retention_days ?? 30),
        conversation_retention_days: String(res.settings?.conversation_retention_days ?? 0),
      })
      toast.success('服务器设置已成功保存并应用')
    } catch (err: unknown) {
      toast.error('保存服务器设置失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSavingServerSettings(false)
      setPendingPatchPayload(null)
    }
  }

  return (
    <div className='space-y-6 max-w-4xl'>
      <Tabs defaultValue='client' className='w-full space-y-4'>
        <TabsList className='grid w-full grid-cols-2 max-w-md'>
          <TabsTrigger value='client' className='gap-2 text-xs'>
            <Sliders size={14} />
            <span>本机连接配置</span>
          </TabsTrigger>
          <TabsTrigger value='server' className='gap-2 text-xs'>
            <Server size={14} />
            <span>服务器全局设置</span>
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: 本机连接配置 (Client Settings) */}
        <TabsContent value='client' className='space-y-6'>
          <Alert className='py-3 text-xs border-primary/20 bg-primary/5'>
            <Shield className='size-4 text-primary' />
            <AlertTitle className='font-semibold'>本机专属凭据保护说明</AlertTitle>
            <AlertDescription className='text-muted-foreground mt-0.5 leading-relaxed'>
              本界面的服务端地址、管理员令牌与外部 API Key 仅保存在<strong>当前浏览器的本地存储 (Local Storage)</strong>，绝不会通过后端 settings 接口上传或泄露。更换新设备或无痕模式时需重新输入。
            </AlertDescription>
          </Alert>

          <div className='space-y-4 rounded-lg border p-4 shadow-xs bg-card'>
            <div className='space-y-2'>
              <Label className='flex items-center gap-1.5 text-xs font-semibold'>
                <Server size={14} className='text-primary' />
                <span>服务端基准地址 (Base URL)</span>
              </Label>
              <Input
                value={settings.baseUrl}
                onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })}
                placeholder='例如: http://127.0.0.1:8787'
                className='font-mono text-xs'
              />
              <p className='text-[11px] text-muted-foreground'>
                后端服务监听的地址与端口，默认为 <code className='font-mono'>http://127.0.0.1:8787</code>。
              </p>
            </div>

            <div className='space-y-2'>
              <Label className='flex items-center gap-1.5 text-xs font-semibold'>
                <Shield size={14} className='text-primary' />
                <span>管理端令牌 (ADMIN_TOKEN)</span>
                <span className='text-[11px] font-normal text-muted-foreground'>(控制台最高凭据)</span>
              </Label>
              <Input
                value={settings.adminToken}
                onChange={(e) => setSettings({ ...settings, adminToken: e.target.value })}
                placeholder='请输入后端服务的 ADMIN_TOKEN'
                type='password'
                className='font-mono text-xs'
              />
              <p className='text-[11px] text-muted-foreground'>
                用于号池运维（加号、改号、删号、重置冷却、积分、日志、统计）及控制台鉴权。请填写后端进程启动时终端显示或环境变量配置的 <code className='font-mono'>ADMIN_TOKEN</code>。
              </p>
            </div>

            <div className='space-y-2'>
              <div className='flex items-center justify-between'>
                <Label className='flex items-center gap-1.5 text-xs font-semibold'>
                  <Key size={14} className='text-primary' />
                  <span>外部调用 API Key (API_KEYS)</span>
                  <span className='text-[11px] font-normal text-muted-foreground'>(可选 / 外部程序调用)</span>
                </Label>
                <Link
                  to='/keys'
                  className='text-[11px] text-primary hover:underline flex items-center gap-1 font-medium'
                >
                  <span>前往密钥管理页</span>
                  <ExternalLink size={11} />
                </Link>
              </div>
              <Input
                value={settings.apiKey}
                onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                placeholder='外部第三方客户端接入使用的 API Key'
                type='password'
                className='font-mono text-xs'
              />
              <p className='text-[11px] text-muted-foreground'>
                管理后台自身已自动透过 ADMIN_TOKEN 免密免 Key 调试，本字段仅在您需要模拟第三方普通客户端鉴权时选填。
              </p>
            </div>

            <div className='flex flex-wrap items-center gap-3 pt-2'>
              <Button onClick={handleSaveClientSettings} size='sm' className='gap-1.5 text-xs font-medium'>
                <Save size={13} />
                <span>保存本机配置</span>
              </Button>
              <Button
                onClick={handleTestConnection}
                variant='outline'
                size='sm'
                disabled={isTesting}
                className='gap-1.5 text-xs'
              >
                <Activity size={13} className={isTesting ? 'animate-spin' : 'text-primary'} />
                <span>{isTesting ? '正在探测连通性...' : '一键测试全部服务连通性'}</span>
              </Button>
              <Button
                onClick={handleResetClientSettings}
                variant='ghost'
                size='sm'
                className='gap-1.5 text-xs text-muted-foreground'
              >
                <RotateCcw size={13} />
                <span>恢复默认</span>
              </Button>
            </div>
          </div>

          {/* Test results diagnostic panel */}
          {testResults && (
            <div className='rounded-lg border p-4 shadow-xs bg-card space-y-3 animate-in fade-in-50'>
              <h3 className='text-xs font-semibold text-foreground flex items-center gap-1.5'>
                <Activity size={14} className='text-primary' />
                <span>服务连通性诊断报告</span>
              </h3>
              <div className='grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs'>
                <div className='flex items-start gap-2 p-2.5 rounded-md border bg-muted/40'>
                  {testResults.healthz.ok ? (
                    <CheckCircle2 size={16} className='text-emerald-500 shrink-0 mt-0.5' />
                  ) : (
                    <XCircle size={16} className='text-destructive shrink-0 mt-0.5' />
                  )}
                  <div className='space-y-0.5'>
                    <div className='font-semibold'>/healthz 探针</div>
                    <div className='text-muted-foreground text-[11px]'>{testResults.healthz.message}</div>
                  </div>
                </div>

                <div className='flex items-start gap-2 p-2.5 rounded-md border bg-muted/40'>
                  {testResults.poolState.ok ? (
                    <CheckCircle2 size={16} className='text-emerald-500 shrink-0 mt-0.5' />
                  ) : (
                    <XCircle size={16} className='text-destructive shrink-0 mt-0.5' />
                  )}
                  <div className='space-y-0.5'>
                    <div className='font-semibold'>/pool/state 号池</div>
                    <div className='text-muted-foreground text-[11px]'>{testResults.poolState.message}</div>
                  </div>
                </div>

                <div className='flex items-start gap-2 p-2.5 rounded-md border bg-muted/40'>
                  {testResults.models.ok ? (
                    <CheckCircle2 size={16} className='text-emerald-500 shrink-0 mt-0.5' />
                  ) : (
                    <XCircle size={16} className='text-destructive shrink-0 mt-0.5' />
                  )}
                  <div className='space-y-0.5'>
                    <div className='font-semibold'>/v1/models 模型列表</div>
                    <div className='text-muted-foreground text-[11px]'>{testResults.models.message}</div>
                  </div>
                </div>

                <div className='flex items-start gap-2 p-2.5 rounded-md border bg-muted/40'>
                  {testResults.adminToken.ok ? (
                    <CheckCircle2 size={16} className='text-emerald-500 shrink-0 mt-0.5' />
                  ) : (
                    <XCircle size={16} className='text-destructive shrink-0 mt-0.5' />
                  )}
                  <div className='space-y-0.5'>
                    <div className='font-semibold'>ADMIN_TOKEN 管理鉴权</div>
                    <div className='text-muted-foreground text-[11px]'>{testResults.adminToken.message}</div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </TabsContent>

        {/* Tab 2: 服务器全局设置 (Server Settings from SQLite) */}
        <TabsContent value='server' className='space-y-6'>
          {/* Storage & Environment Overview */}
          <div className='grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs'>
            <div className='rounded-lg border bg-card p-3.5 space-y-1.5'>
              <div className='flex items-center justify-between'>
                <span className='font-semibold flex items-center gap-1.5'>
                  <Database className='size-4 text-primary' />
                  <span>后端存储引擎</span>
                </span>
                <Badge variant='outline' className='text-[10px] font-mono'>
                  {serverSettingsData?.storage?.engine?.toUpperCase() ?? 'SQLITE'} (v{serverSettingsData?.storage?.schema_version ?? 1})
                </Badge>
              </div>
              <p className='text-[11px] text-muted-foreground leading-relaxed'>
                采用 Node 内置 SQLite 数据库（WAL 模式与事务隔离），数据已由 JSON 升级持久化。
              </p>
            </div>

            <div className='rounded-lg border bg-card p-3.5 space-y-1.5'>
              <div className='flex items-center justify-between'>
                <span className='font-semibold flex items-center gap-1.5'>
                  <Clock className='size-4 text-amber-500' />
                  <span>自动领取定时器</span>
                </span>
                <Badge
                  variant={serverSettingsData?.auto_claim?.enabled ? 'default' : 'secondary'}
                  className='text-[10px]'
                >
                  {serverSettingsData?.auto_claim?.enabled ? '运行中' : '未开启'}
                </Badge>
              </div>
              <p className='text-[11px] text-muted-foreground leading-relaxed'>
                每日定时执行整点: {serverSettingsData?.auto_claim?.hour ? `${serverSettingsData.auto_claim.hour}:00` : '09:00'}（在「免费积分」面板独立管理）。
              </p>
            </div>
          </div>

          {/* Server Settings Form */}
          <form onSubmit={handleServerSettingsSubmit} className='space-y-4 rounded-lg border p-4 shadow-xs bg-card'>
            <div className='space-y-2'>
              <Label htmlFor='site_name' className='text-xs font-semibold'>
                站点名称 (site_name)
              </Label>
              <Input
                id='site_name'
                value={serverForm.site_name}
                onChange={(e) => setServerForm({ ...serverForm, site_name: e.target.value })}
                placeholder='例如: kuku2api'
                maxLength={80}
                className='font-mono text-xs'
                disabled={loadingServerSettings || savingServerSettings}
              />
              <p className='text-[11px] text-muted-foreground'>
                服务展示名称，长度为 1 到 80 个字符。
              </p>
            </div>

            <div className='grid grid-cols-1 sm:grid-cols-2 gap-4'>
              <div className='space-y-2'>
                <Label htmlFor='log_retention' className='text-xs font-semibold'>
                  系统日志保留天数 (log_retention_days)
                </Label>
                <Input
                  id='log_retention'
                  type='number'
                  min={0}
                  max={3650}
                  value={serverForm.log_retention_days}
                  onChange={(e) => setServerForm({ ...serverForm, log_retention_days: e.target.value })}
                  className='font-mono text-xs'
                  disabled={loadingServerSettings || savingServerSettings}
                />
                <p className='text-[11px] text-muted-foreground'>
                  保留 0 ~ 3650 天，<strong>0 表示长期永久保留</strong>。
                </p>
              </div>

              <div className='space-y-2'>
                <Label htmlFor='conversation_retention' className='text-xs font-semibold'>
                  对话记录保留天数 (conversation_retention_days)
                </Label>
                <Input
                  id='conversation_retention'
                  type='number'
                  min={0}
                  max={3650}
                  value={serverForm.conversation_retention_days}
                  onChange={(e) => setServerForm({ ...serverForm, conversation_retention_days: e.target.value })}
                  className='font-mono text-xs'
                  disabled={loadingServerSettings || savingServerSettings}
                />
                <p className='text-[11px] text-muted-foreground'>
                  保留 0 ~ 3650 天，<strong>0 表示长期永久保留</strong>。
                </p>
              </div>
            </div>

            <div className='p-3 rounded-lg border bg-amber-500/10 border-amber-500/20 text-xs space-y-1 text-amber-900 dark:text-amber-200'>
              <div className='flex items-center gap-1.5 font-semibold'>
                <AlertTriangle size={14} className='text-amber-500' />
                <span>保留策略修改影响提示</span>
              </div>
              <p className='text-[11px] text-muted-foreground leading-relaxed'>
                调整保留天数后，服务端将<strong>立即清理过期日志与对话记录正文</strong>，并同步移除过期 Responses 映射（可能影响旧对话的续接）。全池累计 Token 用量及积分统计不受清理影响。
              </p>
            </div>

            <div className='flex items-center gap-3 pt-2'>
              <Button
                type='submit'
                size='sm'
                disabled={loadingServerSettings || savingServerSettings}
                className='gap-1.5 text-xs'
              >
                {savingServerSettings ? (
                  <Loader2 size={13} className='animate-spin' />
                ) : (
                  <Save size={13} />
                )}
                <span>保存服务器设置</span>
              </Button>
              <Button
                type='button'
                variant='outline'
                size='sm'
                onClick={() => void loadServerSettings()}
                disabled={loadingServerSettings || savingServerSettings}
                className='gap-1.5 text-xs'
              >
                <RotateCcw size={13} className={loadingServerSettings ? 'animate-spin' : ''} />
                <span>重新读取</span>
              </Button>
            </div>
          </form>
        </TabsContent>
      </Tabs>

      {/* Retention Policy Confirmation Dialog */}
      <ConfirmDialog
        open={confirmRetentionOpen}
        onOpenChange={setConfirmRetentionOpen}
        title='确认更新服务器数据保留策略？'
        desc='修改保留天数后，服务端将立即从 SQLite 数据库中永久清理超期日志和对话正文，并清理旧 Responses 映射，可能导致旧对话无法续接（累计 Token 用量统计不受影响）。确认保存并立即清理吗？'
        confirmText='确认更新并清理'
        cancelBtnText='取消'
        destructive
        handleConfirm={() => {
          if (pendingPatchPayload) {
            void executePatchServerSettings(pendingPatchPayload)
          }
        }}
      />
    </div>
  )
}
