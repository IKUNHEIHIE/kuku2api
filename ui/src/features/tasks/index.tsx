'use client'

import { useState, useEffect, useCallback } from 'react'
import { Link } from '@tanstack/react-router'
import {
  RefreshCw,
  Eye,
  Coins,
  Cpu,
  Clock,
  Layers,
  FileText,
  ChevronLeft,
  ChevronRight,
  Database,
  X,
  Globe,
  Copy,
  Check,
  Bot,
  Filter,
  AlertTriangle,
  AlertCircle,
  Info,
  Sparkles,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'
import { ConfigDrawer } from '@/components/config-drawer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import {
  kukuApi,
  ApiError,
  type ConversationItem,
  type ConversationDetail,
  type ConversationsParams,
  type AccountSessionsResult,
  type Account,
  type ModelItem,
} from '@/lib/kuku-api'

function formatDateTime(timestamp: number | null | undefined): string {
  if (!timestamp) return '—'
  // SQLite 毫秒 (> 1e11) vs 旧 OpenAI Responses 秒 (< 1e11)
  const ms = timestamp < 1e11 ? timestamp * 1000 : timestamp
  return new Date(ms).toLocaleString()
}

function renderMessageContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object') {
          const anyItem = item as Record<string, unknown>
          if (typeof anyItem.text === 'string') return anyItem.text
          return JSON.stringify(item)
        }
        return String(item)
      })
      .join('\n')
  }
  if (typeof content === 'object') {
    const anyContent = content as Record<string, unknown>
    if (typeof anyContent.text === 'string') return anyContent.text
    return JSON.stringify(content, null, 2)
  }
  return String(content)
}

export function Tasks() {
  const [activeTab, setActiveTab] = useState<'conversations' | 'upstream'>('conversations')

  // Conversations state (GET /pool/admin/conversations)
  const [conversations, setConversations] = useState<ConversationItem[]>([])
  const [total, setTotal] = useState<number>(0)
  const [loading, setLoading] = useState<boolean>(true)
  const [limit, setLimit] = useState<number>(20)
  const [offset, setOffset] = useState<number>(0)

  // Filters state
  const [source, setSource] = useState<string>('all')
  const [status, setStatus] = useState<string>('all')
  const [selectedModel, setSelectedModel] = useState<string>('all')
  const [selectedAccount, setSelectedAccount] = useState<string>('all')
  const [sessionKeyInput, setSessionKeyInput] = useState<string>('')
  const [fromDate, setFromDate] = useState<string>('')
  const [toDate, setToDate] = useState<string>('')

  // Detail Modal state (GET /pool/admin/conversations/:id)
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [conversationDetail, setConversationDetail] = useState<ConversationDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState<boolean>(false)
  const [isDetailOpen, setIsDetailOpen] = useState<boolean>(false)
  const [showRawJson, setShowRawJson] = useState<boolean>(false)
  const [copiedText, setCopiedText] = useState<string | null>(null)

  // Options for filter selects
  const [availableModels, setAvailableModels] = useState<ModelItem[]>([])
  const [availableAccounts, setAvailableAccounts] = useState<Account[]>([])

  // Upstream sessions state (GET /pool/sessions)
  const [upstreamAccounts, setUpstreamAccounts] = useState<AccountSessionsResult[]>([])
  const [upstreamLoading, setUpstreamLoading] = useState<boolean>(false)
  const [upstreamOffset, setUpstreamOffset] = useState<number>(0)
  const upstreamSize = 20
  const [selectedUpstreamAccount, setSelectedUpstreamAccount] = useState<string>('all')
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null)

  // Fetch filter options (models & accounts)
  useEffect(() => {
    void kukuApi
      .getModels()
      .then((res) => {
        if (res?.data) setAvailableModels(res.data)
      })
      .catch(() => {})

    void kukuApi
      .getPoolState()
      .then((state) => {
        if (state?.accounts) setAvailableAccounts(state.accounts)
      })
      .catch(() => {})
  }, [])

  // Fetch conversations
  const fetchConversations = useCallback(
    async (currentOffset = offset, currentLimit = limit, showLoading = true) => {
      try {
        if (showLoading) setLoading(true)
        const params: ConversationsParams = {
          limit: currentLimit,
          offset: currentOffset,
          source: source !== 'all' ? (source as ConversationsParams['source']) : undefined,
          status: status !== 'all' ? (status as ConversationsParams['status']) : undefined,
          model: selectedModel !== 'all' ? selectedModel : undefined,
          account: selectedAccount !== 'all' ? selectedAccount : undefined,
          session_key: sessionKeyInput.trim() || undefined,
          from: fromDate || undefined,
          to: toDate || undefined,
        }
        const res = await kukuApi.getConversations(params)
        setConversations(res.data || [])
        setTotal(res.total || 0)
      } catch (err: unknown) {
        if (err instanceof ApiError && err.status === 401) {
          toast.error('管理员令牌无效，请前往系统设置配置有效令牌')
        } else if (err instanceof ApiError && err.status === 400) {
          toast.error('查询参数错误: ' + err.message)
        } else {
          toast.error('获取对话记录失败: ' + (err instanceof Error ? err.message : String(err)))
        }
      } finally {
        setLoading(false)
      }
    },
    [offset, limit, source, status, selectedModel, selectedAccount, sessionKeyInput, fromDate, toDate]
  )

  useEffect(() => {
    let ignore = false
    void (async () => {
      try {
        setLoading(true)
        const params: ConversationsParams = {
          limit,
          offset,
          source: source !== 'all' ? (source as ConversationsParams['source']) : undefined,
          status: status !== 'all' ? (status as ConversationsParams['status']) : undefined,
          model: selectedModel !== 'all' ? selectedModel : undefined,
          account: selectedAccount !== 'all' ? selectedAccount : undefined,
          session_key: sessionKeyInput.trim() || undefined,
          from: fromDate || undefined,
          to: toDate || undefined,
        }
        const res = await kukuApi.getConversations(params)
        if (!ignore) {
          setConversations(res.data || [])
          setTotal(res.total || 0)
        }
      } catch (err: unknown) {
        if (!ignore) {
          if (err instanceof ApiError && err.status === 401) {
            toast.error('管理员令牌无效，请前往系统设置配置有效令牌')
          } else if (err instanceof ApiError && err.status === 400) {
            toast.error('查询参数错误: ' + err.message)
          } else {
            toast.error('获取对话记录失败: ' + (err instanceof Error ? err.message : String(err)))
          }
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
  }, [offset, limit, source, status, selectedModel, selectedAccount, sessionKeyInput, fromDate, toDate])

  // Reset pagination when filter criteria change
  const handleApplyFilter = () => {
    setOffset(0)
    void fetchConversations(0, limit)
  }

  const handleResetFilter = () => {
    setSource('all')
    setStatus('all')
    setSelectedModel('all')
    setSelectedAccount('all')
    setSessionKeyInput('')
    setFromDate('')
    setToDate('')
    setOffset(0)
  }

  // Fetch conversation detail
  const handleViewDetail = async (item: ConversationItem) => {
    setSelectedConversationId(item.id)
    setIsDetailOpen(true)
    setConversationDetail(null)
    setDetailLoading(true)
    setShowRawJson(false)
    try {
      const res = await kukuApi.getConversationDetail(item.id)
      setConversationDetail(res.data)
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        toast.error('记录不存在或已被自动清理')
      } else if (err instanceof ApiError && err.status === 401) {
        toast.error('管理员鉴权失败，请检查管理令牌')
      } else {
        toast.error('加载对话详情失败: ' + (err instanceof Error ? err.message : String(err)))
      }
      // Fallback: minimal item
      setConversationDetail(item as ConversationDetail)
    } finally {
      setDetailLoading(false)
    }
  }

  // Upstream sessions fetching
  const fetchUpstreamSessions = useCallback(
    async (account?: string, off?: number, sz?: number) => {
      const acct = account ?? selectedUpstreamAccount
      const o = off ?? upstreamOffset
      const s = sz ?? upstreamSize
      try {
        setUpstreamLoading(true)
        const res = await kukuApi.getPoolSessions({
          account: acct !== 'all' ? acct : undefined,
          offset: o,
          size: s,
        })
        setUpstreamAccounts(res.accounts || [])
      } catch (err: unknown) {
        toast.error('获取上游会话列表失败: ' + (err instanceof Error ? err.message : String(err)))
      } finally {
        setUpstreamLoading(false)
      }
    },
    [selectedUpstreamAccount, upstreamOffset, upstreamSize]
  )

  const handleCopy = (text: string, label: string) => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopiedText(label)
          toast.success(`已复制 ${label} 到剪贴板`)
          setTimeout(() => setCopiedText(null), 2000)
        })
        .catch(() => {
          toast.error('复制失败，请手动选取复制')
        })
    }
  }

  const handleCopySessionId = (id: string) => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard
        .writeText(id)
        .then(() => {
          setCopiedSessionId(id)
          toast.success('已复制 Session ID 到剪贴板')
          setTimeout(() => setCopiedSessionId(null), 2000)
        })
        .catch(() => {
          toast.error('复制失败，请手动选取复制')
        })
    }
  }

  // Pagination helpers
  const totalPages = Math.max(1, Math.ceil(total / limit))
  const currentPage = Math.floor(offset / limit) + 1

  const getSourceBadge = (src: string) => {
    switch (src) {
      case 'chat':
        return <Badge variant='default' className='text-[10px] bg-blue-600 hover:bg-blue-600'>Chat 对话</Badge>
      case 'responses':
        return <Badge variant='secondary' className='text-[10px] bg-purple-500/20 text-purple-700 dark:text-purple-300'>Responses</Badge>
      case 'claim':
        return <Badge variant='outline' className='text-[10px] text-amber-600 border-amber-500/30'>每日领奖</Badge>
      case 'legacy_response':
        return <Badge variant='outline' className='text-[10px] text-muted-foreground border-border'>旧账本导入</Badge>
      default:
        return <Badge variant='outline' className='text-[10px]'>{src}</Badge>
    }
  }

  const getStatusBadge = (st: string) => {
    switch (st) {
      case 'completed':
        return <Badge variant='outline' className='text-[10px] text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10'>成功</Badge>
      case 'failed':
        return <Badge variant='destructive' className='text-[10px]'>失败</Badge>
      case 'cancelled':
        return <Badge variant='outline' className='text-[10px] text-orange-600 dark:text-orange-400 border-orange-500/30 bg-orange-500/10'>已取消 (499)</Badge>
      default:
        return <Badge variant='outline' className='text-[10px]'>{st}</Badge>
    }
  }

  // Continuation reply ID resolver
  const getResponsesContinuationId = (detail: ConversationDetail) => {
    if (detail.reply_id) return detail.reply_id
    if (detail.id.startsWith('legacy-')) return detail.id.replace('legacy-', '')
    return null
  }

  return (
    <>
      <Header fixed>
        <div className='flex items-center gap-2'>
          <Database className='size-5 text-primary' />
          <h1 className='text-base font-semibold'>对话历史与上游会话</h1>
          <Badge variant='outline' className='text-xs font-mono'>
            {activeTab === 'conversations' ? 'GET /pool/admin/conversations' : 'GET /pool/sessions'}
          </Badge>
        </div>
        <div className='ms-auto flex items-center gap-2'>
          <ThemeSwitch />
          <ConfigDrawer />
        </div>
      </Header>

      <Main className='flex flex-1 flex-col gap-4 sm:gap-6 p-4 md:p-6'>
        <div className='flex flex-wrap items-end justify-between gap-4'>
          <div>
            <h2 className='text-2xl font-bold tracking-tight'>对话历史与会话审计</h2>
            <p className='text-sm text-muted-foreground mt-1'>
              查询 SQLite 持久化全来源对话记录（Chat / Responses / 任务 / 导入账本）或检索百度账号云端真实会话。
            </p>
          </div>
        </div>

        <Tabs
          value={activeTab}
          onValueChange={(val) => {
            const tab = val as 'conversations' | 'upstream'
            setActiveTab(tab)
            if (tab === 'upstream' && upstreamAccounts.length === 0) {
              void fetchUpstreamSessions(selectedUpstreamAccount, 0, upstreamSize)
            }
          }}
          className='w-full'
        >
          <TabsList className='mb-2'>
            <TabsTrigger value='conversations' className='gap-1.5'>
              <Database size={14} />
              <span>全来源对话历史 (Conversations)</span>
            </TabsTrigger>
            <TabsTrigger value='upstream' className='gap-1.5'>
              <Globe size={14} />
              <span>上游云端会话 (Upstream Sessions)</span>
            </TabsTrigger>
          </TabsList>

          {/* TAB 1: CONVERSATIONS */}
          <TabsContent value='conversations' className='space-y-4'>
            {/* Filter Toolbar */}
            <div className='p-4 rounded-lg border bg-card/60 shadow-xs space-y-3'>
              <div className='flex items-center justify-between gap-2 border-b pb-2'>
                <div className='flex items-center gap-1.5 text-xs font-medium text-foreground'>
                  <Filter size={14} className='text-primary' />
                  <span>多维检索与过滤</span>
                </div>
                <div className='flex items-center gap-2'>
                  <Button
                    variant='ghost'
                    size='sm'
                    onClick={handleResetFilter}
                    className='h-7 text-xs text-muted-foreground hover:text-foreground'
                  >
                    重置筛选
                  </Button>
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={handleApplyFilter}
                    className='gap-1.5 h-7 text-xs'
                  >
                    <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                    <span>刷新数据</span>
                  </Button>
                </div>
              </div>

              <div className='grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3'>
                {/* Source Filter */}
                <div className='space-y-1'>
                  <label className='text-[11px] font-medium text-muted-foreground'>来源类型</label>
                  <Select
                    value={source}
                    onValueChange={(v) => {
                      setSource(v)
                      setOffset(0)
                    }}
                  >
                    <SelectTrigger className='h-8 text-xs font-mono'>
                      <SelectValue placeholder='全部来源' />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='all'>全部来源</SelectItem>
                      <SelectItem value='chat'>chat (AI 对话)</SelectItem>
                      <SelectItem value='responses'>responses</SelectItem>
                      <SelectItem value='claim'>claim (领奖对话)</SelectItem>
                      <SelectItem value='legacy_response'>legacy_response (旧账本)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Status Filter */}
                <div className='space-y-1'>
                  <label className='text-[11px] font-medium text-muted-foreground'>运行状态</label>
                  <Select
                    value={status}
                    onValueChange={(v) => {
                      setStatus(v)
                      setOffset(0)
                    }}
                  >
                    <SelectTrigger className='h-8 text-xs font-mono'>
                      <SelectValue placeholder='全部状态' />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='all'>全部状态</SelectItem>
                      <SelectItem value='completed'>completed (成功)</SelectItem>
                      <SelectItem value='failed'>failed (失败)</SelectItem>
                      <SelectItem value='cancelled'>cancelled (已取消)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Model Filter */}
                <div className='space-y-1'>
                  <label className='text-[11px] font-medium text-muted-foreground'>模型型号</label>
                  <Select
                    value={selectedModel}
                    onValueChange={(v) => {
                      setSelectedModel(v)
                      setOffset(0)
                    }}
                  >
                    <SelectTrigger className='h-8 text-xs font-mono'>
                      <SelectValue placeholder='全部模型' />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='all'>全部模型</SelectItem>
                      {availableModels.map((m) => (
                        <SelectItem key={m.id} value={m.id} className='text-xs font-mono'>
                          {m.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Account Filter */}
                <div className='space-y-1'>
                  <label className='text-[11px] font-medium text-muted-foreground'>服务账号</label>
                  <Select
                    value={selectedAccount}
                    onValueChange={(v) => {
                      setSelectedAccount(v)
                      setOffset(0)
                    }}
                  >
                    <SelectTrigger className='h-8 text-xs font-mono'>
                      <SelectValue placeholder='全部账号' />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='all'>全部账号</SelectItem>
                      {availableAccounts.map((a) => (
                        <SelectItem key={a.id} value={a.id} className='text-xs font-mono'>
                          {a.alias || a.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Session Key Filter */}
                <div className='space-y-1 col-span-2 sm:col-span-2'>
                  <label className='text-[11px] font-medium text-muted-foreground'>Session Key (精确过滤)</label>
                  <div className='relative'>
                    <Input
                      value={sessionKeyInput}
                      onChange={(e) => setSessionKeyInput(e.target.value)}
                      placeholder='输入客户端 session_key...'
                      className='h-8 text-xs font-mono pr-7'
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleApplyFilter()
                      }}
                    />
                    {sessionKeyInput && (
                      <button
                        type='button'
                        onClick={() => {
                          setSessionKeyInput('')
                          setOffset(0)
                        }}
                        className='absolute right-2 top-2 text-muted-foreground hover:text-foreground'
                      >
                        <X size={13} />
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Date Filters & Limit */}
              <div className='flex flex-wrap items-center gap-3 pt-1 text-xs'>
                <div className='flex items-center gap-1.5'>
                  <span className='text-muted-foreground'>时间范围 (UTC):</span>
                  <Input
                    type='date'
                    value={fromDate}
                    onChange={(e) => {
                      setFromDate(e.target.value)
                      setOffset(0)
                    }}
                    className='h-7 w-32 text-[11px]'
                  />
                  <span className='text-muted-foreground'>至</span>
                  <Input
                    type='date'
                    value={toDate}
                    onChange={(e) => {
                      setToDate(e.target.value)
                      setOffset(0)
                    }}
                    className='h-7 w-32 text-[11px]'
                  />
                </div>

                <div className='ms-auto flex items-center gap-2'>
                  <span className='text-muted-foreground'>每页行数:</span>
                  <Select
                    value={String(limit)}
                    onValueChange={(v) => {
                      setLimit(Number(v))
                      setOffset(0)
                    }}
                  >
                    <SelectTrigger className='h-7 w-20 text-xs font-mono'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='10'>10</SelectItem>
                      <SelectItem value='20'>20</SelectItem>
                      <SelectItem value='50'>50</SelectItem>
                      <SelectItem value='100'>100</SelectItem>
                      <SelectItem value='200'>200</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            {/* Conversations Table */}
            <div className='rounded-md border bg-card overflow-hidden shadow-xs'>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className='w-48 font-mono'>记录 ID / 时间</TableHead>
                    <TableHead className='w-28'>来源</TableHead>
                    <TableHead className='w-44'>调用模型</TableHead>
                    <TableHead className='w-28'>服务账号</TableHead>
                    <TableHead className='w-28'>状态</TableHead>
                    <TableHead className='w-40 font-mono text-right'>Tokens (总/入/出)</TableHead>
                    <TableHead className='w-28 text-right'>积分消耗</TableHead>
                    <TableHead className='w-20 text-right'>耗时</TableHead>
                    <TableHead className='text-right w-16'>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && conversations.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className='h-32 text-center text-muted-foreground'>
                        正在加载对话历史记录...
                      </TableCell>
                    </TableRow>
                  ) : conversations.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className='h-32 text-center text-muted-foreground'>
                        无符合条件的对话历史记录
                      </TableCell>
                    </TableRow>
                  ) : (
                    conversations.map((item) => (
                      <TableRow key={item.id} className='hover:bg-muted/40'>
                        <TableCell className='font-mono text-xs'>
                          <div className='font-medium text-foreground truncate max-w-[180px]' title={item.id}>
                            {item.id}
                          </div>
                          <div className='text-[11px] text-muted-foreground flex items-center gap-1.5 mt-0.5'>
                            <span>{formatDateTime(item.created_at)}</span>
                            {item.content_stored === 0 && (
                              <Badge variant='outline' className='text-[9px] px-1 py-0 h-4 border-amber-500/40 text-amber-600 dark:text-amber-400'>
                                store:false
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>{getSourceBadge(item.source)}</TableCell>
                        <TableCell className='font-mono text-xs'>
                          <span className='truncate block max-w-[160px]' title={item.model}>
                            {item.model}
                          </span>
                        </TableCell>
                        <TableCell className='text-xs'>
                          <Badge variant='outline' className='font-mono text-[11px]'>
                            {item.account || '—'}
                          </Badge>
                        </TableCell>
                        <TableCell>{getStatusBadge(item.status)}</TableCell>
                        <TableCell className='text-right font-mono text-xs'>
                          <span className='font-semibold'>{item.total_tokens?.toLocaleString() ?? 0}</span>
                          <span className='text-[10px] text-muted-foreground block'>
                            ({item.prompt_tokens?.toLocaleString() ?? 0} / {item.completion_tokens?.toLocaleString() ?? 0})
                          </span>
                        </TableCell>
                        <TableCell className='text-right text-xs'>
                          {item.consume_points !== null ? (
                            <span className='font-mono font-medium text-emerald-600 dark:text-emerald-400'>
                              {item.consume_points} pts
                            </span>
                          ) : (
                            <span className='text-muted-foreground text-[11px]'>未知积分</span>
                          )}
                        </TableCell>
                        <TableCell className='text-right font-mono text-xs text-muted-foreground'>
                          {item.duration_ms !== null && item.duration_ms !== undefined
                            ? `${item.duration_ms}ms`
                            : '—'}
                        </TableCell>
                        <TableCell className='text-right'>
                          <Button
                            variant='ghost'
                            size='icon'
                            className='size-7'
                            title='查看对话详情'
                            onClick={() => void handleViewDetail(item)}
                          >
                            <Eye size={14} />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Pagination Controls */}
            <div className='flex flex-wrap items-center justify-between text-xs text-muted-foreground pt-1 gap-2'>
              <div>
                共 <span className='font-semibold text-foreground'>{total}</span> 条记录
                {' · 当前第 '}
                <span className='font-semibold text-foreground'>{currentPage}</span>
                {' / '}
                <span>{totalPages}</span>
                {' 页'}
                {total > 0 && (
                  <span className='ms-2 text-muted-foreground'>
                    (显示 {offset + 1} - {Math.min(offset + limit, total)})
                  </span>
                )}
              </div>
              <div className='flex items-center gap-2'>
                <Button
                  variant='outline'
                  size='sm'
                  disabled={offset === 0 || loading}
                  onClick={() => setOffset(0)}
                  className='h-8 text-xs'
                >
                  首页
                </Button>
                <Button
                  variant='outline'
                  size='sm'
                  disabled={offset === 0 || loading}
                  onClick={() => setOffset(Math.max(0, offset - limit))}
                  className='h-8 text-xs gap-1'
                >
                  <ChevronLeft size={14} />
                  <span>上一页</span>
                </Button>
                <Button
                  variant='outline'
                  size='sm'
                  disabled={offset + limit >= total || loading}
                  onClick={() => setOffset(offset + limit)}
                  className='h-8 text-xs gap-1'
                >
                  <span>下一页</span>
                  <ChevronRight size={14} />
                </Button>
                <Button
                  variant='outline'
                  size='sm'
                  disabled={offset + limit >= total || loading}
                  onClick={() => setOffset((totalPages - 1) * limit)}
                  className='h-8 text-xs'
                >
                  末页
                </Button>
              </div>
            </div>
          </TabsContent>

          {/* TAB 2: UPSTREAM SESSIONS */}
          <TabsContent value='upstream' className='space-y-4'>
            <div className='flex flex-wrap items-center justify-between gap-2'>
              <div className='text-xs text-muted-foreground'>
                直接调取百度上游账号云端会话列表与产物元数据（调用接口：GET /pool/sessions）。
              </div>

              <div className='flex flex-wrap items-center gap-2'>
                <div className='flex items-center gap-1.5'>
                  <span className='text-xs text-muted-foreground'>指定服务账号:</span>
                  <Select
                    value={selectedUpstreamAccount}
                    onValueChange={(val) => {
                      setSelectedUpstreamAccount(val)
                      setUpstreamOffset(0)
                      void fetchUpstreamSessions(val, 0, upstreamSize)
                    }}
                  >
                    <SelectTrigger className='h-8 w-36 text-xs font-mono'>
                      <SelectValue placeholder='全部账号' />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='all'>全部账号</SelectItem>
                      {availableAccounts.map((a) => (
                        <SelectItem key={a.id} value={a.id} className='text-xs font-mono'>
                          {a.alias || a.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => void fetchUpstreamSessions(selectedUpstreamAccount, upstreamOffset, upstreamSize)}
                  className='gap-1.5 h-8 text-xs'
                >
                  <RefreshCw size={14} className={upstreamLoading ? 'animate-spin' : ''} />
                  <span>刷新上游会话</span>
                </Button>
              </div>
            </div>

            {/* Upstream Sessions Table */}
            <div className='rounded-md border bg-card overflow-hidden shadow-xs'>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className='w-48 font-mono'>上游 Session ID</TableHead>
                    <TableHead className='w-32'>所属账号</TableHead>
                    <TableHead>会话标题</TableHead>
                    <TableHead className='w-28'>产物统计</TableHead>
                    <TableHead className='w-36'>更新时间</TableHead>
                    <TableHead className='text-right w-20'>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {upstreamLoading && upstreamAccounts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className='h-32 text-center text-muted-foreground'>
                        正在调取上游云端会话...
                      </TableCell>
                    </TableRow>
                  ) : upstreamAccounts.length === 0 ||
                    upstreamAccounts.every((a) => !a.sessions || a.sessions.length === 0) ? (
                    <TableRow>
                      <TableCell colSpan={6} className='h-32 text-center text-muted-foreground'>
                        暂无上游云端会话记录
                      </TableCell>
                    </TableRow>
                  ) : (
                    upstreamAccounts.flatMap((acct) =>
                      (acct.sessions || []).map((sess) => (
                        <TableRow key={`${acct.id}-${sess.session_id}`} className='hover:bg-muted/40'>
                          <TableCell className='font-mono text-xs truncate max-w-[200px]' title={sess.session_id}>
                            {sess.session_id}
                          </TableCell>
                          <TableCell className='text-xs'>
                            <Badge variant='outline' className='font-mono text-[11px]'>
                              {acct.alias || acct.id}
                            </Badge>
                          </TableCell>
                          <TableCell className='text-xs max-w-sm truncate' title={sess.title}>
                            {sess.title || '（未命名会话）'}
                          </TableCell>
                          <TableCell className='text-xs'>
                            {sess.artifact_count > 0 ? (
                              <Badge variant='secondary' className='text-xs'>
                                {sess.artifact_count} 个产物
                              </Badge>
                            ) : (
                              <span className='text-muted-foreground'>0</span>
                            )}
                          </TableCell>
                          <TableCell className='text-xs text-muted-foreground'>
                            {sess.mtime ? new Date(sess.mtime * 1000).toLocaleString() : '—'}
                          </TableCell>
                          <TableCell className='text-right'>
                            <div className='flex items-center justify-end gap-1'>
                              <Button
                                variant='ghost'
                                size='icon'
                                className='size-7'
                                title='复制 Session ID'
                                onClick={() => handleCopySessionId(sess.session_id)}
                              >
                                {copiedSessionId === sess.session_id ? (
                                  <Check size={14} className='text-emerald-500' />
                                ) : (
                                  <Copy size={14} />
                                )}
                              </Button>
                              {sess.created_by_this_pool && (
                                <Button
                                  variant='ghost'
                                  size='icon'
                                  className='size-7 text-primary'
                                  title='前往 AI 对话'
                                  asChild
                                >
                                  <Link to='/chats'>
                                    <Bot size={14} />
                                  </Link>
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Upstream pagination */}
            <div className='flex items-center justify-between text-xs text-muted-foreground pt-1'>
              <div>
                共 {upstreamAccounts.reduce((s, a) => s + (a.total || 0), 0)} 条上游会话
                {' · 当前偏移: '}
                <span className='font-mono'>{upstreamOffset}</span>
              </div>
              <div className='flex items-center gap-2'>
                <Button
                  variant='outline'
                  size='sm'
                  disabled={upstreamOffset === 0 || upstreamLoading}
                  onClick={() => {
                    const newOffset = Math.max(0, upstreamOffset - upstreamSize)
                    setUpstreamOffset(newOffset)
                    void fetchUpstreamSessions(selectedUpstreamAccount, newOffset, upstreamSize)
                  }}
                  className='h-8 text-xs gap-1'
                >
                  <ChevronLeft size={14} />
                  <span>上一页</span>
                </Button>
                <Button
                  variant='outline'
                  size='sm'
                  disabled={
                    upstreamLoading ||
                    upstreamAccounts.every((a) => (a.total || 0) <= upstreamOffset + upstreamSize)
                  }
                  onClick={() => {
                    const newOffset = upstreamOffset + upstreamSize
                    setUpstreamOffset(newOffset)
                    void fetchUpstreamSessions(selectedUpstreamAccount, newOffset, upstreamSize)
                  }}
                  className='h-8 text-xs gap-1'
                >
                  <span>下一页</span>
                  <ChevronRight size={14} />
                </Button>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </Main>

      {/* DETAIL DIALOG */}
      <Dialog open={isDetailOpen} onOpenChange={setIsDetailOpen}>
        <DialogContent className='sm:max-w-3xl max-h-[90vh] flex flex-col p-6'>
          <DialogHeader>
            <div className='flex items-center justify-between pr-6'>
              <DialogTitle className='font-mono text-base flex items-center gap-2'>
                <FileText size={18} className='text-primary' />
                <span>对话详情: {selectedConversationId}</span>
              </DialogTitle>
            </div>
            <DialogDescription className='text-xs'>
              记录创建时间: {conversationDetail ? formatDateTime(conversationDetail.created_at) : '—'}
            </DialogDescription>
          </DialogHeader>

          {detailLoading ? (
            <div className='h-48 flex items-center justify-center text-xs text-muted-foreground'>
              <RefreshCw size={18} className='animate-spin mr-2 text-primary' />
              <span>正在调取完整对话正文与用量明细...</span>
            </div>
          ) : conversationDetail ? (
            <div className='space-y-4 overflow-y-auto pr-2 text-xs'>
              {/* Status and Store Banners */}
              <div className='flex flex-wrap items-center gap-2'>
                {getSourceBadge(conversationDetail.source)}
                {getStatusBadge(conversationDetail.status)}
                {conversationDetail.content_stored === 0 ? (
                  <Badge variant='outline' className='text-[10px] border-amber-500/40 text-amber-600 dark:text-amber-400'>
                    store:false 未存储正文
                  </Badge>
                ) : (
                  <Badge variant='outline' className='text-[10px] border-emerald-500/40 text-emerald-600 dark:text-emerald-400'>
                    正文已持久化
                  </Badge>
                )}
                {conversationDetail.error_code && (
                  <Badge variant='destructive' className='text-[10px]'>
                    错误码: {conversationDetail.error_code}
                  </Badge>
                )}
              </div>

              {conversationDetail.content_stored === 0 && (
                <div className='p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 text-xs flex items-start gap-2'>
                  <AlertTriangle size={16} className='shrink-0 mt-0.5' />
                  <div>
                    <div className='font-semibold'>启用 store:false 说明</div>
                    <div>
                      此对话请求标记了 `store:false`，服务端仅保存用量与续接元数据，未持久化对话正文与思考过程。对应 Responses 的 GET 接口返回 404，但仍可通过真实 Response ID 续接。
                    </div>
                  </div>
                </div>
              )}

              {conversationDetail.status === 'cancelled' && (
                <div className='p-3 rounded-lg border border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300 text-xs flex items-start gap-2'>
                  <AlertCircle size={16} className='shrink-0 mt-0.5' />
                  <div>
                    <div className='font-semibold'>客户端断开连接 (内部 499)</div>
                    <div>
                      客户端在生成完成前关闭了连接。记录仅代表客户端中断前已观测到的用量，上游可能继续计费。
                    </div>
                  </div>
                </div>
              )}

              {/* Quick Info Grid */}
              <div className='grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono'>
                <div className='p-2.5 rounded border bg-muted/40 space-y-1'>
                  <div className='text-muted-foreground flex items-center gap-1'>
                    <Layers size={13} /> 模型
                  </div>
                  <div className='font-semibold text-foreground truncate' title={conversationDetail.model}>
                    {conversationDetail.model}
                  </div>
                </div>

                <div className='p-2.5 rounded border bg-muted/40 space-y-1'>
                  <div className='text-muted-foreground flex items-center gap-1'>
                    <Cpu size={13} /> 服务账号
                  </div>
                  <div className='font-semibold text-foreground'>{conversationDetail.account || '—'}</div>
                </div>

                <div className='p-2.5 rounded border bg-muted/40 space-y-1'>
                  <div className='text-muted-foreground flex items-center gap-1'>
                    <Coins size={13} /> 消耗积分
                  </div>
                  <div className='font-semibold text-emerald-600 dark:text-emerald-400'>
                    {conversationDetail.consume_points !== null
                      ? `${conversationDetail.consume_points} pts`
                      : '未知积分'}
                  </div>
                </div>

                <div className='p-2.5 rounded border bg-muted/40 space-y-1'>
                  <div className='text-muted-foreground flex items-center gap-1'>
                    <Clock size={13} /> 耗时
                  </div>
                  <div className='font-semibold text-foreground'>
                    {conversationDetail.duration_ms !== null && conversationDetail.duration_ms !== undefined
                      ? `${conversationDetail.duration_ms} ms`
                      : '—'}
                  </div>
                </div>
              </div>

              {/* Tokens breakdown */}
              <div className='p-3 rounded-lg border bg-muted/20 space-y-2'>
                <div className='flex items-center justify-between'>
                  <div className='font-semibold text-foreground flex items-center gap-1.5'>
                    <Coins size={14} className='text-primary' />
                    <span>Token 统计明细 (口径: {conversationDetail.usage_scope})</span>
                  </div>
                  {conversationDetail.think_mode && (
                    <Badge variant='outline' className='text-[10px] font-mono'>
                      思考档位: {conversationDetail.think_mode}
                    </Badge>
                  )}
                </div>
                <div className='grid grid-cols-2 sm:grid-cols-5 gap-2 font-mono text-xs'>
                  <div className='p-2 rounded bg-background border'>
                    <span className='text-muted-foreground block text-[10px]'>输入 Tokens</span>
                    <span className='font-semibold'>{conversationDetail.prompt_tokens?.toLocaleString() ?? 0}</span>
                  </div>
                  <div className='p-2 rounded bg-background border'>
                    <span className='text-muted-foreground block text-[10px]'>输出 Tokens</span>
                    <span className='font-semibold'>{conversationDetail.completion_tokens?.toLocaleString() ?? 0}</span>
                  </div>
                  <div className='p-2 rounded bg-background border'>
                    <span className='text-muted-foreground block text-[10px]'>总计 Tokens</span>
                    <span className='font-semibold'>{conversationDetail.total_tokens?.toLocaleString() ?? 0}</span>
                  </div>
                  <div className='p-2 rounded bg-background border'>
                    <span className='text-muted-foreground block text-[10px]'>思考 Tokens</span>
                    <span className='font-semibold'>{conversationDetail.reasoning_tokens?.toLocaleString() ?? 0}</span>
                  </div>
                  <div className='p-2 rounded bg-background border'>
                    <span className='text-muted-foreground block text-[10px]'>缓存命中 Tokens</span>
                    <span className='font-semibold'>{conversationDetail.cache_read_tokens?.toLocaleString() ?? 0}</span>
                  </div>
                </div>
              </div>

              {/* Multiple Usage Events Table (if any) */}
              {conversationDetail.usage_events && conversationDetail.usage_events.length > 1 && (
                <div className='space-y-1.5 p-3 rounded-lg border bg-muted/10'>
                  <div className='flex items-center justify-between'>
                    <span className='font-semibold text-foreground text-xs'>多调用事件记录 (共 {conversationDetail.usage_events.length} 次上游调用)</span>
                    <span className='text-[11px] text-muted-foreground'>总览指标遵循当前契约取最后一次调用</span>
                  </div>
                  <div className='border rounded overflow-hidden'>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className='w-16 text-[10px]'>调用序</TableHead>
                          <TableHead className='text-[10px] text-right'>输入</TableHead>
                          <TableHead className='text-[10px] text-right'>输出</TableHead>
                          <TableHead className='text-[10px] text-right'>思考</TableHead>
                          <TableHead className='text-[10px] text-right'>缓存</TableHead>
                          <TableHead className='text-[10px] text-right'>总计</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {conversationDetail.usage_events.map((evt, idx) => (
                          <TableRow key={idx} className='text-[11px] font-mono'>
                            <TableCell>#{idx + 1}</TableCell>
                            <TableCell className='text-right'>{evt.prompt_tokens}</TableCell>
                            <TableCell className='text-right'>{evt.completion_tokens}</TableCell>
                            <TableCell className='text-right'>{evt.reasoning_tokens}</TableCell>
                            <TableCell className='text-right'>{evt.cache_read_tokens}</TableCell>
                            <TableCell className='text-right font-semibold'>{evt.total_tokens}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}

              {/* Messages (Request Chat History) */}
              <div className='space-y-1.5'>
                <div className='font-semibold text-foreground flex items-center justify-between'>
                  <span>请求消息 (Request Messages):</span>
                  {conversationDetail.messages && (
                    <span className='text-muted-foreground text-[11px] font-normal'>
                      共 {conversationDetail.messages.length} 条消息
                    </span>
                  )}
                </div>
                {conversationDetail.messages === null || conversationDetail.messages === undefined ? (
                  <div className='p-3 rounded border bg-muted/20 text-muted-foreground text-xs italic'>
                    未存储原始请求消息（旧 Responses 导入记录或 store:false 请求未持久化消息列表）
                  </div>
                ) : conversationDetail.messages.length === 0 ? (
                  <div className='p-3 rounded border bg-muted/20 text-muted-foreground text-xs italic'>
                    消息数组为空
                  </div>
                ) : (
                  <div className='space-y-2 max-h-56 overflow-y-auto pr-1'>
                    {conversationDetail.messages.map((msg, idx) => (
                      <div
                        key={idx}
                        className={`p-2.5 rounded-lg border text-xs leading-relaxed ${
                          msg.role === 'user'
                            ? 'bg-blue-500/10 border-blue-500/20'
                            : msg.role === 'assistant'
                            ? 'bg-emerald-500/10 border-emerald-500/20'
                            : 'bg-muted/40 border-muted'
                        }`}
                      >
                        <div className='flex items-center justify-between mb-1 text-[11px] font-medium'>
                          <Badge variant='outline' className='text-[10px] capitalize px-1 py-0 h-4'>
                            {msg.role}
                          </Badge>
                          <span className='text-muted-foreground text-[10px]'>#{idx + 1}</span>
                        </div>
                        <div className='whitespace-pre-wrap font-sans break-words'>
                          {renderMessageContent(msg.content)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Reasoning Text (Thinking Process) */}
              {conversationDetail.reasoning_text && (
                <div className='space-y-1.5'>
                  <div className='font-semibold text-foreground flex items-center gap-1.5 text-purple-600 dark:text-purple-400'>
                    <Sparkles size={14} />
                    <span>思考过程 (Reasoning Content):</span>
                    <span className='text-muted-foreground text-[11px] font-normal font-mono'>
                      ({conversationDetail.reasoning_tokens ?? 0} tokens)
                    </span>
                  </div>
                  <div className='p-3 rounded-lg border border-purple-500/20 bg-purple-500/5 font-mono text-xs whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto'>
                    {conversationDetail.reasoning_text}
                  </div>
                </div>
              )}

              {/* Output Text */}
              <div className='space-y-1.5'>
                <div className='font-semibold text-foreground flex items-center justify-between'>
                  <span>输出文本 (Output Content):</span>
                  {conversationDetail.output_text && (
                    <Button
                      variant='ghost'
                      size='sm'
                      className='h-6 text-[11px] gap-1'
                      onClick={() => handleCopy(conversationDetail.output_text || '', '输出文本')}
                    >
                      {copiedText === '输出文本' ? <Check size={12} className='text-emerald-500' /> : <Copy size={12} />}
                      <span>复制</span>
                    </Button>
                  )}
                </div>
                {conversationDetail.content_stored === 0 ? (
                  <div className='p-3 rounded border bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs italic'>
                    已启用 store:false：正文未持久化存储。
                  </div>
                ) : conversationDetail.output_text ? (
                  <div className='p-3 rounded-lg border bg-background font-mono text-xs whitespace-pre-wrap leading-relaxed max-h-56 overflow-y-auto'>
                    {conversationDetail.output_text}
                  </div>
                ) : (
                  <div className='p-3 rounded border bg-muted/20 text-muted-foreground text-xs italic'>
                    无输出文本内容
                  </div>
                )}
              </div>

              {/* Session Continuation Card */}
              <div className='p-3 rounded-lg border bg-blue-500/10 border-blue-500/20 space-y-2 text-xs'>
                <div className='flex items-center gap-1.5 font-semibold text-blue-700 dark:text-blue-300'>
                  <Info size={14} />
                  <span>多轮对话接续指引 (契约说明)</span>
                </div>
                <div className='text-muted-foreground text-[11px] leading-relaxed space-y-1'>
                  <div>
                    • <strong className='text-foreground'>记录 ID 边界：</strong>当前历史记录 ID (<code className='font-mono'>{conversationDetail.id}</code>) 是 SQLite 数据库主键，<span className='text-amber-600 dark:text-amber-400 font-semibold'>不是 OpenAI response ID</span>，绝不能直接作为 previous_response_id。
                  </div>
                  <div>
                    • <strong className='text-foreground'>Chat 接口续接：</strong>使用 Session Key (<code className='font-mono'>{conversationDetail.session_key || '—'}</code>) 作为请求头 <code className='font-mono'>x-kuku-session</code> 发送，建议同时定向原账号 <code className='font-mono'>{conversationDetail.account}</code>。
                  </div>
                  {getResponsesContinuationId(conversationDetail) && (
                    <div>
                      • <strong className='text-foreground'>Responses 续接：</strong>请使用原服务端真实 Response ID: <code className='font-mono font-bold text-foreground'>{getResponsesContinuationId(conversationDetail)}</code> 作为 <code className='font-mono'>previous_response_id</code>。
                    </div>
                  )}
                </div>

                <div className='flex flex-wrap items-center gap-2 pt-1 border-t border-blue-500/20'>
                  {conversationDetail.session_key && (
                    <Button
                      variant='outline'
                      size='sm'
                      className='h-7 text-xs gap-1'
                      onClick={() => handleCopy(conversationDetail.session_key || '', 'Session Key')}
                    >
                      <Copy size={12} />
                      <span>复制 Session Key</span>
                    </Button>
                  )}
                  {getResponsesContinuationId(conversationDetail) && (
                    <Button
                      variant='outline'
                      size='sm'
                      className='h-7 text-xs gap-1'
                      onClick={() => handleCopy(getResponsesContinuationId(conversationDetail) || '', 'Response ID')}
                    >
                      <Copy size={12} />
                      <span>复制真实 Response ID</span>
                    </Button>
                  )}
                  <Button asChild size='sm' className='h-7 text-xs gap-1 ms-auto'>
                    <Link
                      to='/chats'
                      search={{
                        model: conversationDetail.model,
                        previous_response_id: getResponsesContinuationId(conversationDetail) || undefined,
                      }}
                    >
                      <Bot size={13} />
                      <span>前往 AI 对话</span>
                    </Link>
                  </Button>
                </div>
              </div>

              {/* Raw JSON Debug View */}
              <div className='pt-1'>
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={() => setShowRawJson(!showRawJson)}
                  className='h-6 text-[11px] text-muted-foreground gap-1'
                >
                  {showRawJson ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  <span>{showRawJson ? '折叠原始 JSON' : '展开原始数据 JSON (调试用)'}</span>
                </Button>
                {showRawJson && (
                  <pre className='mt-2 p-3 rounded border bg-muted/60 font-mono text-[10px] whitespace-pre overflow-x-auto max-h-48'>
                    {JSON.stringify(conversationDetail, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
