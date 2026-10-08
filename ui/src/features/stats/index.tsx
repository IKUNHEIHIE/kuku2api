'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  BarChart3,
  RefreshCw,
  Filter,
  Calendar,
  Layers,
  Activity,
  Cpu,
  Coins,
  ShieldAlert,
  Info,
  Clock,
  Sparkles,
  RotateCcw,
} from 'lucide-react'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'
import { ConfigDrawer } from '@/components/config-drawer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { toast } from 'sonner'
import {
  kukuApi,
  type TokenStatsResponse,
  type TokenStatsParams,
  type Account,
  type ModelItem,
} from '@/lib/kuku-api'

export function StatsFeature() {
  const [stats, setStats] = useState<TokenStatsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [models, setModels] = useState<ModelItem[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])

  // Filters state
  const [filters, setFilters] = useState<TokenStatsParams>({
    from: '',
    to: '',
    model: '',
    account: '',
    source: undefined,
    status: undefined,
    group_by: 'day',
  })

  // Load models and accounts for filter selectors
  useEffect(() => {
    void kukuApi.getModels().then((res) => setModels(res.data || [])).catch(() => {})
    void kukuApi.getPoolState().then((res) => setAccounts(res.accounts || [])).catch(() => {})
  }, [])

  // Load stats
  const fetchStats = useCallback(
    async (showLoading = true) => {
      try {
        if (showLoading) setLoading(true)
        const res = await kukuApi.getTokenStats({
          from: filters.from || undefined,
          to: filters.to || undefined,
          model: filters.model || undefined,
          account: filters.account || undefined,
          source: filters.source || undefined,
          status: filters.status || undefined,
          group_by: filters.group_by || 'day',
        })
        setStats(res)
      } catch (err: unknown) {
        toast.error('获取 Token 用量统计失败: ' + (err instanceof Error ? err.message : String(err)))
      } finally {
        setLoading(false)
      }
    },
    [filters]
  )

  useEffect(() => {
    let ignore = false
    void (async () => {
      try {
        const res = await kukuApi.getTokenStats({
          from: filters.from || undefined,
          to: filters.to || undefined,
          model: filters.model || undefined,
          account: filters.account || undefined,
          source: filters.source || undefined,
          status: filters.status || undefined,
          group_by: filters.group_by || 'day',
        })
        if (!ignore) {
          setStats(res)
        }
      } catch (err: unknown) {
        if (!ignore) {
          toast.error('获取 Token 用量统计失败: ' + (err instanceof Error ? err.message : String(err)))
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
  }, [filters])

  const updateFilters = (updater: (prev: TokenStatsParams) => TokenStatsParams) => {
    setLoading(true)
    setFilters(updater)
  }

  const handleResetFilters = () => {
    updateFilters(() => ({
      from: '',
      to: '',
      model: '',
      account: '',
      source: undefined,
      status: undefined,
      group_by: 'day',
    }))
  }

  const formatNumber = (n?: number | null) => {
    if (n === undefined || n === null) return '0'
    return Number(n).toLocaleString()
  }

  return (
    <>
      <Header fixed>
        <div className='flex items-center gap-2'>
          <BarChart3 className='size-5 text-primary' />
          <h1 className='text-base font-semibold'>Token 用量统计</h1>
          <Badge variant='outline' className='text-[10px] font-mono'>
            UTC 时区
          </Badge>
        </div>
        <div className='ms-auto flex items-center space-x-2'>
          <Button
            variant='outline'
            size='sm'
            onClick={() => void fetchStats()}
            disabled={loading}
            className='h-8 text-xs gap-1.5'
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            <span>刷新</span>
          </Button>
          <ThemeSwitch />
          <ConfigDrawer />
        </div>
      </Header>

      <Main className='space-y-6'>
        {/* Filters Card */}
        <div className='rounded-lg border bg-card p-4 shadow-xs space-y-3.5'>
          <div className='flex items-center justify-between border-b pb-2.5'>
            <div className='flex items-center gap-1.5 font-semibold text-xs text-foreground'>
              <Filter size={14} className='text-primary' />
              <span>用量统计过滤筛选</span>
            </div>
            <Button
              variant='ghost'
              size='sm'
              onClick={handleResetFilters}
              className='h-7 text-xs text-muted-foreground gap-1'
            >
              <RotateCcw size={12} />
              <span>重置条件</span>
            </Button>
          </div>

          <div className='grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3 text-xs'>
            {/* From (UTC) */}
            <div className='space-y-1.5'>
              <Label className='text-[11px] font-medium flex items-center gap-1'>
                <Calendar size={12} className='text-muted-foreground' />
                <span>开始日期 (UTC)</span>
              </Label>
              <Input
                type='date'
                value={filters.from || ''}
                onChange={(e) => updateFilters((prev) => ({ ...prev, from: e.target.value }))}
                className='h-8 text-xs font-mono'
              />
            </div>

            {/* To (UTC) */}
            <div className='space-y-1.5'>
              <Label className='text-[11px] font-medium flex items-center gap-1'>
                <Calendar size={12} className='text-muted-foreground' />
                <span>结束日期 (UTC)</span>
              </Label>
              <Input
                type='date'
                value={filters.to || ''}
                onChange={(e) => updateFilters((prev) => ({ ...prev, to: e.target.value }))}
                className='h-8 text-xs font-mono'
              />
            </div>

            {/* Group By */}
            <div className='space-y-1.5'>
              <Label className='text-[11px] font-medium flex items-center gap-1'>
                <Layers size={12} className='text-muted-foreground' />
                <span>分组维度</span>
              </Label>
              <Select
                value={filters.group_by || 'day'}
                onValueChange={(val: 'day' | 'model' | 'account' | 'source') =>
                  updateFilters((prev) => ({ ...prev, group_by: val }))
                }
              >
                <SelectTrigger className='h-8 text-xs'>
                  <SelectValue placeholder='分组方式' />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='day'>按日期 (Day)</SelectItem>
                  <SelectItem value='model'>按模型 (Model)</SelectItem>
                  <SelectItem value='account'>按账号 (Account)</SelectItem>
                  <SelectItem value='source'>按来源 (Source)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Source */}
            <div className='space-y-1.5'>
              <Label className='text-[11px] font-medium'>请求来源</Label>
              <Select
                value={filters.source || 'all'}
                onValueChange={(val) =>
                  updateFilters((prev) => ({
                    ...prev,
                    source: val === 'all' ? undefined : (val as TokenStatsParams['source']),
                  }))
                }
              >
                <SelectTrigger className='h-8 text-xs'>
                  <SelectValue placeholder='全部来源' />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='all'>全部来源</SelectItem>
                  <SelectItem value='chat'>chat (Chat 对话)</SelectItem>
                  <SelectItem value='responses'>responses (Responses 接口)</SelectItem>
                  <SelectItem value='claim'>claim (挣对话奖励)</SelectItem>
                  <SelectItem value='legacy_response'>legacy_response (旧导入)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Status */}
            <div className='space-y-1.5'>
              <Label className='text-[11px] font-medium'>执行状态</Label>
              <Select
                value={filters.status || 'all'}
                onValueChange={(val) =>
                  updateFilters((prev) => ({
                    ...prev,
                    status: val === 'all' ? undefined : (val as TokenStatsParams['status']),
                  }))
                }
              >
                <SelectTrigger className='h-8 text-xs'>
                  <SelectValue placeholder='全部状态' />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='all'>全部状态</SelectItem>
                  <SelectItem value='completed'>completed (成功完成)</SelectItem>
                  <SelectItem value='failed'>failed (执行失败)</SelectItem>
                  <SelectItem value='cancelled'>cancelled (客户端取消/499)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Model */}
            <div className='space-y-1.5'>
              <Label className='text-[11px] font-medium'>指定模型</Label>
              <Select
                value={filters.model || 'all'}
                onValueChange={(val) =>
                  updateFilters((prev) => ({ ...prev, model: val === 'all' ? undefined : val }))
                }
              >
                <SelectTrigger className='h-8 text-xs font-mono truncate'>
                  <SelectValue placeholder='全部模型' />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='all'>全部模型</SelectItem>
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.id} className='font-mono text-xs'>
                      {m.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Account */}
            <div className='space-y-1.5'>
              <Label className='text-[11px] font-medium'>指定账号</Label>
              <Select
                value={filters.account || 'all'}
                onValueChange={(val) =>
                  updateFilters((prev) => ({ ...prev, account: val === 'all' ? undefined : val }))
                }
              >
                <SelectTrigger className='h-8 text-xs font-mono truncate'>
                  <SelectValue placeholder='全部账号' />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='all'>全部账号</SelectItem>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id} className='font-mono text-xs'>
                      {a.alias ? `${a.alias} (${a.id})` : a.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Truncated Alert */}
        {stats?.groups_truncated && (
          <Alert variant='destructive' className='py-2.5 text-xs'>
            <ShieldAlert className='size-4' />
            <AlertTitle className='font-semibold'>分组数量已达 1000 条上限</AlertTitle>
            <AlertDescription className='text-xs mt-0.5'>
              当前分组结果已被截断（顶部统计汇总仍基于全量数据），建议添加时间范围或筛选特定模型/账号以查看完整明细。
            </AlertDescription>
          </Alert>
        )}

        {/* Summary Metric Cards */}
        <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4'>
          {/* Card 1: Attempts */}
          <div className='rounded-lg border bg-card p-4 shadow-xs space-y-2'>
            <div className='flex items-center justify-between text-muted-foreground'>
              <span className='text-xs font-medium'>推理尝试总数 (Attempts)</span>
              <Activity className='size-4 text-primary' />
            </div>
            <div className='text-2xl font-bold font-mono'>
              {formatNumber(stats?.summary?.attempts)}
            </div>
            <div className='flex flex-wrap items-center gap-1.5 text-[11px] pt-1'>
              <span className='text-emerald-600 dark:text-emerald-400 font-medium'>
                {formatNumber(stats?.summary?.completed)} 成功
              </span>
              <span className='text-muted-foreground'>·</span>
              <span className='text-destructive font-medium'>
                {formatNumber(stats?.summary?.failed)} 失败
              </span>
              <span className='text-muted-foreground'>·</span>
              <span className='text-amber-600 dark:text-amber-400 font-medium'>
                {formatNumber(stats?.summary?.cancelled)} 取消
              </span>
            </div>
          </div>

          {/* Card 2: Total Tokens */}
          <div className='rounded-lg border bg-card p-4 shadow-xs space-y-2'>
            <div className='flex items-center justify-between text-muted-foreground'>
              <span className='text-xs font-medium'>上游报告总 Tokens</span>
              <Cpu className='size-4 text-indigo-500' />
            </div>
            <div className='text-2xl font-bold font-mono text-indigo-600 dark:text-indigo-400'>
              {formatNumber(stats?.summary?.total_tokens)}
            </div>
            <div className='text-[11px] text-muted-foreground font-mono'>
              输入: {formatNumber(stats?.summary?.prompt_tokens)} · 输出: {formatNumber(stats?.summary?.completion_tokens)}
            </div>
          </div>

          {/* Card 3: Reasoning & Cache */}
          <div className='rounded-lg border bg-card p-4 shadow-xs space-y-2'>
            <div className='flex items-center justify-between text-muted-foreground'>
              <span className='text-xs font-medium'>思考与缓存明细</span>
              <Sparkles className='size-4 text-purple-500' />
            </div>
            <div className='space-y-1 font-mono text-xs'>
              <div className='flex items-center justify-between'>
                <span className='text-muted-foreground'>思考推理:</span>
                <span className='font-semibold text-purple-600 dark:text-purple-400'>
                  {formatNumber(stats?.summary?.reasoning_tokens)}
                </span>
              </div>
              <div className='flex items-center justify-between'>
                <span className='text-muted-foreground'>缓存命中读取:</span>
                <span className='font-semibold text-emerald-600 dark:text-emerald-400'>
                  {formatNumber(stats?.summary?.cache_read_tokens)}
                </span>
              </div>
            </div>
            <div className='text-[10px] text-muted-foreground'>
              * 独立明细指标，不额外计入总 Tokens
            </div>
          </div>

          {/* Card 4: Points & Known Coverage */}
          <div className='rounded-lg border bg-card p-4 shadow-xs space-y-2'>
            <div className='flex items-center justify-between text-muted-foreground'>
              <span className='text-xs font-medium'>积分消耗与统计覆盖</span>
              <Coins className='size-4 text-amber-500' />
            </div>
            <div className='text-2xl font-bold font-mono text-amber-600 dark:text-amber-400'>
              {stats?.summary?.consume_points ? stats.summary.consume_points.toFixed(2) : '0.00'}
            </div>
            <div className='text-[11px] text-muted-foreground'>
              覆盖率: {stats?.summary?.usage_known_attempts ?? 0} / {stats?.summary?.attempts ?? 0} 次已知尝试
              {Boolean(stats?.summary?.partial_usage_attempts) && (
                <span className='block text-[10px] text-amber-600 dark:text-amber-400'>
                  含 {stats?.summary?.partial_usage_attempts} 次多轮上游事件 (取最后一次)
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Statistical Scope & Timezone Disclaimer */}
        <div className='rounded-lg border bg-muted/30 p-3.5 text-xs text-muted-foreground flex items-start gap-2.5'>
          <Info className='size-4 text-primary shrink-0 mt-0.5' />
          <div className='space-y-1 leading-relaxed text-[11px]'>
            <p>
              <strong>统计口径说明：</strong>数据均源自上游服务接口报告的单次推理用量事件（多调用对话取最后一次 MODEL_CALL_END）。<strong>本统计非精确计费账单</strong>，未知用量（unknown）不纳入汇总但不能解释为实际零消耗。
            </p>
            <p>
              <strong>时区与历史范围：</strong>每日时间桶按 <strong>UTC 零点 (00:00:00 UTC)</strong> 划分；SQLite 迁移前仅覆盖持久化保存的旧 Responses 记录，更早未归档的对话不包含在历史统计中。
            </p>
          </div>
        </div>

        {/* Groups Table */}
        <div className='rounded-lg border bg-card shadow-xs overflow-hidden'>
          <div className='p-3.5 border-b bg-muted/20 flex items-center justify-between'>
            <div className='font-semibold text-xs flex items-center gap-1.5'>
              <Layers size={14} className='text-primary' />
              <span>
                按 {filters.group_by === 'day' ? '日期 (UTC)' : filters.group_by === 'model' ? '模型 (Model)' : filters.group_by === 'account' ? '账号 (Account)' : '来源 (Source)'} 分组指标清单 ({stats?.groups?.length ?? 0} 项)
              </span>
            </div>
            {stats?.checked_at && (
              <span className='text-[11px] text-muted-foreground font-mono flex items-center gap-1'>
                <Clock size={11} />
                <span>统计时刻: {new Date(stats.checked_at).toLocaleTimeString()}</span>
              </span>
            )}
          </div>

          <div className='overflow-x-auto'>
            <Table>
              <TableHeader>
                <TableRow className='text-xs'>
                  <TableHead className='font-semibold'>分组标识 (Bucket)</TableHead>
                  <TableHead className='font-semibold text-right'>尝试数</TableHead>
                  <TableHead className='font-semibold text-right'>成功 / 失败</TableHead>
                  <TableHead className='font-semibold text-right'>输入 Tokens</TableHead>
                  <TableHead className='font-semibold text-right'>输出 Tokens</TableHead>
                  <TableHead className='font-semibold text-right'>总 Tokens</TableHead>
                  <TableHead className='font-semibold text-right'>思考 Tokens</TableHead>
                  <TableHead className='font-semibold text-right'>缓存读取</TableHead>
                  <TableHead className='font-semibold text-right'>消耗积分</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={9} className='text-center py-8 text-muted-foreground text-xs'>
                      正在加载统计数据...
                    </TableCell>
                  </TableRow>
                ) : !stats?.groups || stats.groups.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className='text-center py-8 text-muted-foreground text-xs'>
                      指定筛选范围内无用量数据
                    </TableCell>
                  </TableRow>
                ) : (
                  stats.groups.map((g, idx) => (
                    <TableRow key={idx} className='text-xs font-mono hover:bg-muted/40'>
                      <TableCell className='font-semibold text-foreground'>{g.bucket || '—'}</TableCell>
                      <TableCell className='text-right'>{formatNumber(g.attempts)}</TableCell>
                      <TableCell className='text-right'>
                        <span className='text-emerald-600 dark:text-emerald-400'>{g.completed}</span>
                        <span className='text-muted-foreground'> / </span>
                        <span className={g.failed > 0 ? 'text-destructive font-bold' : 'text-muted-foreground'}>{g.failed}</span>
                      </TableCell>
                      <TableCell className='text-right'>{formatNumber(g.prompt_tokens)}</TableCell>
                      <TableCell className='text-right'>{formatNumber(g.completion_tokens)}</TableCell>
                      <TableCell className='text-right font-bold text-indigo-600 dark:text-indigo-400'>
                        {formatNumber(g.total_tokens)}
                      </TableCell>
                      <TableCell className='text-right text-purple-600 dark:text-purple-400'>
                        {formatNumber(g.reasoning_tokens)}
                      </TableCell>
                      <TableCell className='text-right text-emerald-600 dark:text-emerald-400'>
                        {formatNumber(g.cache_read_tokens)}
                      </TableCell>
                      <TableCell className='text-right text-amber-600 dark:text-amber-400 font-semibold'>
                        {g.consume_points !== null ? g.consume_points.toFixed(2) : '0.00'}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </Main>
    </>
  )
}
