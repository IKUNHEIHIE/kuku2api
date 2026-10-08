'use client'

import { useState, useEffect, useCallback } from 'react'
import { Link } from '@tanstack/react-router'
import {
  Activity,
  Users,
  Bot,
  Database,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  ArrowRight,
  RefreshCw,
  Sliders,
  ShieldCheck,
  Radio,
  Coins,
} from 'lucide-react'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'
import { ConfigDrawer } from '@/components/config-drawer'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import {
  kukuApi,
  type Account,
  getApiSettings,
} from '@/lib/kuku-api'

export function Dashboard() {
  const [healthOk, setHealthOk] = useState<boolean | null>(null)
  const [pingMs, setPingMs] = useState<number | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [sessionsCount, setSessionsCount] = useState<number>(0)
  const [totalBalancePoints, setTotalBalancePoints] = useState<number | null>(null)
  const [adminEnabled, setAdminEnabled] = useState<boolean>(false)
  const [modelsCount, setModelsCount] = useState<number>(0)
  const [loading, setLoading] = useState<boolean>(true)

  const settings = getApiSettings()

  const loadData = useCallback(async () => {
    try {
      setLoading(true)
      const start = performance.now()
      const [h, pool, models, points] = await Promise.all([
        kukuApi.getHealthz().catch(() => null),
        kukuApi.getPoolState().catch(() => null),
        kukuApi.getModels().catch(() => null),
        kukuApi.getPoolPoints().catch(() => null),
      ])
      const latency = Math.round(performance.now() - start)
      setPingMs(latency)

      setHealthOk(h?.ok ?? false)
      if (pool) {
        setAccounts(pool.accounts || [])
        setSessionsCount(pool.sessions || 0)
        setAdminEnabled(pool.admin_enabled)
      }
      if (models) {
        setModelsCount(models.data?.length || 0)
      }
      if (points) {
        setTotalBalancePoints(points.total_balance_points)
      }
    } catch (err: unknown) {
      toast.error('获取系统概览数据失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let ignore = false
    void (async () => {
      try {
        const start = performance.now()
        const [h, pool, models, points] = await Promise.all([
          kukuApi.getHealthz().catch(() => null),
          kukuApi.getPoolState().catch(() => null),
          kukuApi.getModels().catch(() => null),
          kukuApi.getPoolPoints().catch(() => null),
        ])
        if (!ignore) {
          const latency = Math.round(performance.now() - start)
          setPingMs(latency)
          setHealthOk(h?.ok ?? false)
          if (pool) {
            setAccounts(pool.accounts || [])
            setSessionsCount(pool.sessions || 0)
            setAdminEnabled(pool.admin_enabled)
          }
          if (models) {
            setModelsCount(models.data?.length || 0)
          }
          if (points) {
            setTotalBalancePoints(points.total_balance_points)
          }
        }
      } catch (err: unknown) {
        if (!ignore) {
          toast.error('获取系统概览数据失败: ' + (err instanceof Error ? err.message : String(err)))
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

  const activeAccounts = accounts.filter(
    (a) => !a.disabled && !a.auth_dead && a.cooldown_remaining_ms === 0
  )
  const coolingAccounts = accounts.filter((a) => a.cooldown_remaining_ms > 0)
  const deadAccounts = accounts.filter((a) => a.auth_dead)

  return (
    <>
      <Header fixed>
        <div className='flex items-center gap-2'>
          <Radio className='size-5 text-emerald-500 animate-pulse' />
          <h1 className='text-base font-semibold'>kuku2api 控制台总览</h1>
        </div>
        <div className='ms-auto flex items-center gap-2'>
          <ThemeSwitch />
          <ConfigDrawer />
        </div>
      </Header>

      <Main className='flex flex-1 flex-col gap-6 p-4 md:p-6'>
        {/* Top Header */}
        <div className='flex flex-wrap items-center justify-between gap-4'>
          <div>
            <div className='flex items-center gap-2'>
              <h2 className='text-2xl font-bold tracking-tight'>系统运行状态</h2>
              <Badge
                variant={healthOk ? 'default' : 'destructive'}
                className='text-xs flex items-center gap-1'
              >
                {healthOk ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                {healthOk ? `服务健康 (${pingMs}ms)` : '服务未响应'}
              </Badge>
            </div>
            <p className='text-sm text-muted-foreground mt-1'>
              后端基址: <span className='font-mono text-foreground'>{settings.baseUrl || 'http://127.0.0.1:8787'}</span>
              {' · '}
              OpenAI Responses API & Chat Completions 协议反代
            </p>
          </div>

          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size='sm'
              onClick={loadData}
              className='gap-1.5'
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              <span>刷新指标</span>
            </Button>
            <Button size='sm' asChild className='gap-1.5'>
              <Link to='/chats'>
                <Bot size={15} />
                <span>立即提问</span>
              </Link>
            </Button>
          </div>
        </div>

        {/* Stats Grid */}
        <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-5'>
          {/* Card 1: Account Pool */}
          <Card>
            <CardHeader className='flex flex-row items-center justify-between pb-2'>
              <CardTitle className='text-sm font-medium'>号池可用状态</CardTitle>
              <Users className='size-4 text-muted-foreground' />
            </CardHeader>
            <CardContent>
              <div className='text-2xl font-bold'>
                {activeAccounts.length} / {accounts.length}
              </div>
              <p className='text-xs text-muted-foreground mt-1'>
                {coolingAccounts.length > 0 && (
                  <span className='text-amber-600 dark:text-amber-400'>
                    {coolingAccounts.length} 个冷却中 ·{' '}
                  </span>
                )}
                {deadAccounts.length > 0 && (
                  <span className='text-destructive'>
                    {deadAccounts.length} 个失效 ·{' '}
                  </span>
                )}
                <span>就绪账号参与调度</span>
              </p>
            </CardContent>
          </Card>

          {/* Card 2: Total Balance Points */}
          <Card>
            <CardHeader className='flex flex-row items-center justify-between pb-2'>
              <CardTitle className='text-sm font-medium'>号池剩余总积分</CardTitle>
              <Coins className='size-4 text-emerald-500' />
            </CardHeader>
            <CardContent>
              <div className='text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400'>
                {totalBalancePoints !== null ? `${totalBalancePoints} pts` : '—'}
              </div>
              <p className='text-xs text-muted-foreground mt-1'>
                真上游只读账本 · 仅 token 桶抵扣推理
              </p>
            </CardContent>
          </Card>

          {/* Card 3: Active Sessions */}
          <Card>
            <CardHeader className='flex flex-row items-center justify-between pb-2'>
              <CardTitle className='text-sm font-medium'>持久化会话数</CardTitle>
              <Activity className='size-4 text-muted-foreground' />
            </CardHeader>
            <CardContent>
              <div className='text-2xl font-bold'>{sessionsCount}</div>
              <p className='text-xs text-muted-foreground mt-1'>
                落盘至 sessions.json，跨重启不失忆
              </p>
            </CardContent>
          </Card>

          {/* Card 4: Models */}
          <Card>
            <CardHeader className='flex flex-row items-center justify-between pb-2'>
              <CardTitle className='text-sm font-medium'>支持模型总数</CardTitle>
              <Bot className='size-4 text-muted-foreground' />
            </CardHeader>
            <CardContent>
              <div className='text-2xl font-bold'>{modelsCount}</div>
              <p className='text-xs text-muted-foreground mt-1'>
                推荐最低倍率: <strong className='text-foreground'>GLM-5.3-Flash (0.07x)</strong>
              </p>
            </CardContent>
          </Card>

          {/* Card 5: Admin State */}
          <Card>
            <CardHeader className='flex flex-row items-center justify-between pb-2'>
              <CardTitle className='text-sm font-medium'>管理端鉴权</CardTitle>
              <ShieldCheck className='size-4 text-muted-foreground' />
            </CardHeader>
            <CardContent>
              <div className='text-2xl font-bold flex items-center gap-2'>
                {adminEnabled ? (
                  <span className='text-emerald-600 dark:text-emerald-400'>已开启</span>
                ) : (
                  <span className='text-muted-foreground'>只读模式</span>
                )}
              </div>
              <p className='text-xs text-muted-foreground mt-1'>
                {adminEnabled ? '号池写操作与体检均可用' : '未提供 ADMIN_TOKEN，写操作受限'}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Quick feature links */}
        <div className='grid gap-4 md:grid-cols-2 lg:grid-cols-4'>
          <Card className='hover:border-primary/40 transition group'>
            <CardHeader>
              <CardTitle className='text-base flex items-center gap-2'>
                <Users className='size-4 text-primary' />
                <span>号池管理</span>
              </CardTitle>
              <CardDescription className='text-xs'>
                录入新号、零成本体检、调整优先级队列与清空冷却。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant='ghost' size='sm' className='w-full justify-between text-xs group-hover:text-primary'>
                <Link to='/users'>
                  <span>进入号池管理</span>
                  <ArrowRight size={14} />
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card className='hover:border-primary/40 transition group'>
            <CardHeader>
              <CardTitle className='text-base flex items-center gap-2'>
                <Bot className='size-4 text-primary' />
                <span>AI 对话调试</span>
              </CardTitle>
              <CardDescription className='text-xs'>
                流式 SSE 推理、折叠深度思考过程、实时查看扣除积分。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant='ghost' size='sm' className='w-full justify-between text-xs group-hover:text-primary'>
                <Link to='/chats'>
                  <span>开始对话</span>
                  <ArrowRight size={14} />
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card className='hover:border-primary/40 transition group'>
            <CardHeader>
              <CardTitle className='text-base flex items-center gap-2'>
                <Database className='size-4 text-primary' />
                <span>账本与响应记录</span>
              </CardTitle>
              <CardDescription className='text-xs'>
                游标回查 /v1/responses 历史、查看真实 Token 账单明细。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant='ghost' size='sm' className='w-full justify-between text-xs group-hover:text-primary'>
                <Link to='/tasks'>
                  <span>查看账本记录</span>
                  <ArrowRight size={14} />
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card className='hover:border-primary/40 transition group'>
            <CardHeader>
              <CardTitle className='text-base flex items-center gap-2'>
                <Sliders className='size-4 text-primary' />
                <span>系统设置</span>
              </CardTitle>
              <CardDescription className='text-xs'>
                配置服务地址、API Key 与管理端 ADMIN_TOKEN 凭证。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant='ghost' size='sm' className='w-full justify-between text-xs group-hover:text-primary'>
                <Link to='/settings'>
                  <span>前往设置</span>
                  <ArrowRight size={14} />
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Architecture & Billing Guidance Note */}
        <Card className='border-muted bg-muted/20'>
          <CardHeader className='pb-2'>
            <CardTitle className='text-sm flex items-center gap-2'>
              <Sparkles size={16} className='text-primary' />
              <span>kuku2api 概念与计费口径特别说明</span>
            </CardTitle>
          </CardHeader>
          <CardContent className='text-xs text-muted-foreground space-y-2 leading-relaxed'>
            <p>
              • <strong>实扣积分 (consume_points)</strong> 是本项目<strong>唯一可信的成本口径</strong>。上游 <code className='font-mono'>prompt_tokens</code> 包含大量系统提示词且走高比例缓存读，请勿使用通用 token 计算公式反推费用。
            </p>
            <p>
              • <strong>优先级调度 (priority)</strong>：整数越小越优先（语义是"先榨干最小序号那一档"，非轮转调度）。发现序号不连续时可随时在号池管理页面执行一键重排。
            </p>
            <p>
              • <strong>凭据安全机制</strong>：添加账号时提交的 <code className='font-mono'>BDUSS/STOKEN</code> 仅用于服务端写盘，前端提交后立即清空内存，不回显亦不保存在任何本地存储中。
            </p>
          </CardContent>
        </Card>
      </Main>
    </>
  )
}
