'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  ScrollText,
  RefreshCw,
  Filter,
  Calendar,
  Layers,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  ShieldCheck,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import { kukuApi, type LogItem, type LogsParams } from '@/lib/kuku-api'

export function LogsFeature() {
  const [logs, setLogs] = useState<LogItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  // Filters state
  const [level, setLevel] = useState<'info' | 'warn' | 'error' | 'all'>('all')
  const [kind, setKind] = useState<'http' | 'system' | 'legacy' | 'all'>('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [limit, setLimit] = useState(50)
  const [offset, setOffset] = useState(0)

  // Message modal state
  const [selectedLog, setSelectedLog] = useState<LogItem | null>(null)

  const fetchLogs = useCallback(
    async (showLoading = true) => {
      try {
        if (showLoading) setLoading(true)
        const params: LogsParams = {
          level: level === 'all' ? undefined : level,
          kind: kind === 'all' ? undefined : kind,
          from: from || undefined,
          to: to || undefined,
          limit,
          offset,
        }
        const res = await kukuApi.getAdminLogs(params)
        setLogs(res.data || [])
        setTotal(res.total || 0)
      } catch (err: unknown) {
        toast.error('获取日志列表失败: ' + (err instanceof Error ? err.message : String(err)))
      } finally {
        setLoading(false)
      }
    },
    [level, kind, from, to, limit, offset]
  )

  useEffect(() => {
    let ignore = false
    void (async () => {
      try {
        const params: LogsParams = {
          level: level === 'all' ? undefined : level,
          kind: kind === 'all' ? undefined : kind,
          from: from || undefined,
          to: to || undefined,
          limit,
          offset,
        }
        const res = await kukuApi.getAdminLogs(params)
        if (!ignore) {
          setLogs(res.data || [])
          setTotal(res.total || 0)
        }
      } catch (err: unknown) {
        if (!ignore) {
          toast.error('获取日志列表失败: ' + (err instanceof Error ? err.message : String(err)))
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
  }, [level, kind, from, to, limit, offset])

  const handleResetFilters = () => {
    setLevel('all')
    setKind('all')
    setFrom('')
    setTo('')
    setOffset(0)
  }

  // Pagination helpers
  const currentPage = Math.floor(offset / limit) + 1
  const totalPages = Math.max(1, Math.ceil(total / limit))

  const handlePrevPage = () => {
    if (offset > 0) {
      setOffset(Math.max(0, offset - limit))
    }
  }

  const handleNextPage = () => {
    if (offset + limit < total) {
      setOffset(offset + limit)
    }
  }

  const formatTime = (ts: number) => {
    if (!ts) return '—'
    const d = new Date(ts)
    return d.toLocaleString()
  }

  const getStatusBadge = (status?: number | null) => {
    if (status === null || status === undefined) return <span className='text-muted-foreground'>—</span>
    if (status === 499) {
      return (
        <Badge variant='outline' className='text-[10px] font-mono text-amber-600 border-amber-500/40 bg-amber-500/10'>
          499 (客户端断开)
        </Badge>
      )
    }
    if (status >= 200 && status < 300) {
      return (
        <Badge variant='outline' className='text-[10px] font-mono text-emerald-600 border-emerald-500/40 bg-emerald-500/10'>
          {status}
        </Badge>
      )
    }
    if (status >= 400 && status < 500) {
      return (
        <Badge variant='outline' className='text-[10px] font-mono text-amber-600 border-amber-500/40 bg-amber-500/10'>
          {status}
        </Badge>
      )
    }
    return (
      <Badge variant='destructive' className='text-[10px] font-mono'>
        {status}
      </Badge>
    )
  }

  const getLevelBadge = (lvl: LogItem['level']) => {
    switch (lvl) {
      case 'error':
        return <Badge variant='destructive' className='text-[10px]'>ERROR</Badge>
      case 'warn':
        return <Badge variant='outline' className='text-[10px] text-amber-600 border-amber-500/40 bg-amber-500/10'>WARN</Badge>
      default:
        return <Badge variant='secondary' className='text-[10px] font-mono'>INFO</Badge>
    }
  }

  const getKindBadge = (k: LogItem['kind']) => {
    switch (k) {
      case 'http':
        return <Badge variant='outline' className='text-[10px] font-mono text-primary border-primary/30'>HTTP</Badge>
      case 'system':
        return <Badge variant='outline' className='text-[10px] font-mono text-indigo-600 border-indigo-500/30'>SYSTEM</Badge>
      case 'legacy':
        return <Badge variant='outline' className='text-[10px] font-mono text-muted-foreground'>LEGACY</Badge>
      default:
        return <Badge variant='outline' className='text-[10px] font-mono'>{k}</Badge>
    }
  }

  return (
    <>
      <Header fixed>
        <div className='flex items-center gap-2'>
          <ScrollText className='size-5 text-primary' />
          <h1 className='text-base font-semibold'>系统日志查询</h1>
          <Badge variant='outline' className='text-[10px] font-mono'>
            脱敏存储
          </Badge>
        </div>
        <div className='ms-auto flex items-center space-x-2'>
          <Button
            variant='outline'
            size='sm'
            onClick={() => void fetchLogs()}
            disabled={loading}
            className='h-8 text-xs gap-1.5'
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            <span>手动刷新</span>
          </Button>
          <ThemeSwitch />
          <ConfigDrawer />
        </div>
      </Header>

      <Main className='space-y-6'>
        {/* Filter Bar */}
        <div className='rounded-lg border bg-card p-4 shadow-xs space-y-3.5'>
          <div className='flex items-center justify-between border-b pb-2.5'>
            <div className='flex items-center gap-1.5 font-semibold text-xs text-foreground'>
              <Filter size={14} className='text-primary' />
              <span>日志过滤条件</span>
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

          <div className='grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3 text-xs'>
            {/* Level */}
            <div className='space-y-1.5'>
              <Label className='text-[11px] font-medium'>日志级别 (Level)</Label>
              <Select
                value={level}
                onValueChange={(val: 'info' | 'warn' | 'error' | 'all') => {
                  setLevel(val)
                  setOffset(0)
                }}
              >
                <SelectTrigger className='h-8 text-xs'>
                  <SelectValue placeholder='全部级别' />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='all'>全部级别</SelectItem>
                  <SelectItem value='info'>INFO 信息</SelectItem>
                  <SelectItem value='warn'>WARN 警告</SelectItem>
                  <SelectItem value='error'>ERROR 错误</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Kind */}
            <div className='space-y-1.5'>
              <Label className='text-[11px] font-medium'>日志类型 (Kind)</Label>
              <Select
                value={kind}
                onValueChange={(val: 'http' | 'system' | 'legacy' | 'all') => {
                  setKind(val)
                  setOffset(0)
                }}
              >
                <SelectTrigger className='h-8 text-xs'>
                  <SelectValue placeholder='全部类型' />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='all'>全部类型</SelectItem>
                  <SelectItem value='http'>HTTP 请求日志</SelectItem>
                  <SelectItem value='system'>SYSTEM 内部系统日志</SelectItem>
                  <SelectItem value='legacy'>LEGACY 历史导入日志</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* From */}
            <div className='space-y-1.5'>
              <Label className='text-[11px] font-medium flex items-center gap-1'>
                <Calendar size={12} className='text-muted-foreground' />
                <span>开始日期 (UTC)</span>
              </Label>
              <Input
                type='date'
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value)
                  setOffset(0)
                }}
                className='h-8 text-xs font-mono'
              />
            </div>

            {/* To */}
            <div className='space-y-1.5'>
              <Label className='text-[11px] font-medium flex items-center gap-1'>
                <Calendar size={12} className='text-muted-foreground' />
                <span>结束日期 (UTC)</span>
              </Label>
              <Input
                type='date'
                value={to}
                onChange={(e) => {
                  setTo(e.target.value)
                  setOffset(0)
                }}
                className='h-8 text-xs font-mono'
              />
            </div>

            {/* Limit */}
            <div className='space-y-1.5'>
              <Label className='text-[11px] font-medium'>每页条数</Label>
              <Select
                value={String(limit)}
                onValueChange={(val) => {
                  setLimit(parseInt(val, 10))
                  setOffset(0)
                }}
              >
                <SelectTrigger className='h-8 text-xs font-mono'>
                  <SelectValue placeholder='50 条/页' />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='20'>20 条/页</SelectItem>
                  <SelectItem value='50'>50 条/页</SelectItem>
                  <SelectItem value='100'>100 条/页</SelectItem>
                  <SelectItem value='200'>200 条/页</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Security & Desensitization Note */}
        <div className='rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground flex items-center gap-2'>
          <ShieldCheck className='size-4 text-emerald-500 shrink-0' />
          <span>
            所有入库日志均已由服务端严格过滤脱敏（不记录请求头、Cookie、令牌和对话正文，安全审计留痕，刷新频率受控）。
          </span>
        </div>

        {/* Logs Table */}
        <div className='rounded-lg border bg-card shadow-xs overflow-hidden space-y-0'>
          <div className='p-3.5 border-b bg-muted/20 flex items-center justify-between text-xs'>
            <div className='font-semibold flex items-center gap-1.5'>
              <Layers size={14} className='text-primary' />
              <span>
                日志流清单（共 {total.toLocaleString()} 条记录，当前第 {currentPage} / {totalPages} 页）
              </span>
            </div>
            {/* Pagination Controls */}
            <div className='flex items-center gap-2'>
              <Button
                variant='outline'
                size='sm'
                onClick={handlePrevPage}
                disabled={offset === 0 || loading}
                className='h-7 text-xs px-2 gap-1'
              >
                <ChevronLeft size={13} />
                <span>上一页</span>
              </Button>
              <span className='font-mono text-xs text-muted-foreground px-1'>
                {offset + 1} - {Math.min(offset + limit, total)}
              </span>
              <Button
                variant='outline'
                size='sm'
                onClick={handleNextPage}
                disabled={offset + limit >= total || loading}
                className='h-7 text-xs px-2 gap-1'
              >
                <span>下一页</span>
                <ChevronRight size={13} />
              </Button>
            </div>
          </div>

          <div className='overflow-x-auto'>
            <Table>
              <TableHeader>
                <TableRow className='text-xs'>
                  <TableHead className='w-40 font-semibold'>时间 (Time)</TableHead>
                  <TableHead className='w-20 font-semibold'>级别</TableHead>
                  <TableHead className='w-24 font-semibold'>类型</TableHead>
                  <TableHead className='font-semibold'>请求方法与路径</TableHead>
                  <TableHead className='w-24 font-semibold'>状态</TableHead>
                  <TableHead className='w-20 font-semibold text-right'>耗时</TableHead>
                  <TableHead className='font-semibold'>说明 / 脱敏消息</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={7} className='text-center py-8 text-muted-foreground text-xs'>
                      正在加载日志...
                    </TableCell>
                  </TableRow>
                ) : logs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className='text-center py-8 text-muted-foreground text-xs'>
                      暂无匹配的日志记录
                    </TableCell>
                  </TableRow>
                ) : (
                  logs.map((item) => (
                    <TableRow key={item.id} className='text-xs font-mono hover:bg-muted/40'>
                      <TableCell className='text-muted-foreground whitespace-nowrap text-[11px]'>
                        {formatTime(item.created_at)}
                      </TableCell>
                      <TableCell>{getLevelBadge(item.level)}</TableCell>
                      <TableCell>{getKindBadge(item.kind)}</TableCell>
                      <TableCell className='font-mono'>
                        {item.method && item.path ? (
                          <span>
                            <span className='font-semibold text-primary'>{item.method}</span>{' '}
                            <span className='text-foreground'>{item.path}</span>
                          </span>
                        ) : (
                          <span className='text-muted-foreground'>—</span>
                        )}
                      </TableCell>
                      <TableCell>{getStatusBadge(item.status)}</TableCell>
                      <TableCell className='text-right text-muted-foreground'>
                        {item.duration_ms !== null && item.duration_ms !== undefined ? `${item.duration_ms}ms` : '—'}
                      </TableCell>
                      <TableCell className='max-w-md truncate'>
                        {item.message ? (
                          <button
                            type='button'
                            onClick={() => setSelectedLog(item)}
                            className='text-start hover:underline truncate w-full text-foreground'
                            title='点击查看完整说明'
                          >
                            {item.message}
                          </button>
                        ) : (
                          <span className='text-muted-foreground text-[11px] italic'>
                            {item.kind === 'http' ? '正常 HTTP 请求记录' : '—'}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* Message Modal */}
        <Dialog open={Boolean(selectedLog)} onOpenChange={(open) => !open && setSelectedLog(null)}>
          <DialogContent className='sm:max-w-xl'>
            <DialogHeader className='text-start'>
              <DialogTitle className='text-sm font-semibold flex items-center gap-2'>
                <ScrollText size={16} className='text-primary' />
                <span>日志详情记录 #{selectedLog?.id}</span>
              </DialogTitle>
              <DialogDescription className='text-xs font-mono'>
                记录时间: {selectedLog ? formatTime(selectedLog.created_at) : '—'}
              </DialogDescription>
            </DialogHeader>
            <div className='space-y-3 py-2 text-xs'>
              <div className='flex items-center gap-2'>
                <span>级别:</span>
                {selectedLog && getLevelBadge(selectedLog.level)}
                <span className='ms-3'>类型:</span>
                {selectedLog && getKindBadge(selectedLog.kind)}
                {selectedLog?.status && (
                  <>
                    <span className='ms-3'>状态:</span>
                    {getStatusBadge(selectedLog.status)}
                  </>
                )}
              </div>
              {selectedLog?.path && (
                <div className='font-mono bg-muted/40 p-2 rounded text-xs'>
                  {selectedLog.method} {selectedLog.path}
                </div>
              )}
              <div className='space-y-1.5'>
                <Label className='text-xs font-semibold'>脱敏内容 / 诊断文本</Label>
                <div className='font-mono text-xs p-3 rounded-lg border bg-muted/30 whitespace-pre-wrap break-all max-h-60 overflow-y-auto leading-relaxed'>
                  {selectedLog?.message || '（无附带附加消息）'}
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </Main>
    </>
  )
}
