'use client'

import { useState, useEffect, useCallback } from 'react'
import { Link } from '@tanstack/react-router'
import {
  Package,
  Crown,
  Search,
  ArrowRight,
  RefreshCw,
  Coins,
} from 'lucide-react'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'
import { ConfigDrawer } from '@/components/config-drawer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { toast } from 'sonner'
import { kukuApi, type ModelItem } from '@/lib/kuku-api'

export function Apps() {
  const [models, setModels] = useState<ModelItem[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [search, setSearch] = useState<string>('')
  const [filterVip, setFilterVip] = useState<'all' | 'vip' | 'free'>('all')

  const fetchModels = useCallback(async () => {
    try {
      setLoading(true)
      const res = await kukuApi.getModels()
      setModels(res.data || [])
    } catch (err: unknown) {
      toast.error('获取模型清单失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let ignore = false
    void (async () => {
      try {
        const res = await kukuApi.getModels()
        if (!ignore) {
          setModels(res.data || [])
        }
      } catch (err: unknown) {
        if (!ignore) {
          toast.error('获取模型清单失败: ' + (err instanceof Error ? err.message : String(err)))
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

  const filteredModels = models.filter((m) => {
    const matchesSearch =
      m.display_name.toLowerCase().includes(search.toLowerCase()) ||
      m.id.toLowerCase().includes(search.toLowerCase()) ||
      (m.description && m.description.toLowerCase().includes(search.toLowerCase()))

    const isVip = m.owned_by.includes('(vip)')
    if (filterVip === 'vip') return matchesSearch && isVip
    if (filterVip === 'free') return matchesSearch && !isVip
    return matchesSearch
  })

  return (
    <>
      <Header fixed>
        <div className='flex items-center gap-2'>
          <Package className='size-5 text-primary' />
          <h1 className='text-base font-semibold'>上游模型目录 (Model Catalog)</h1>
          <Badge variant='outline' className='text-xs font-mono'>
            GET /v1/models
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
            <h2 className='text-2xl font-bold tracking-tight'>可用模型清单</h2>
            <p className='text-sm text-muted-foreground mt-1'>
              百度库库AI上游网关提供的推理模型，下拉框显示展示名 (display_name)，接口提交模型标识 (id)。
            </p>
          </div>

          <Button
            variant='outline'
            size='sm'
            onClick={fetchModels}
            className='gap-1.5'
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            <span>重新拉取目录</span>
          </Button>
        </div>

        {/* Search and Filters */}
        <div className='flex flex-wrap items-center gap-3'>
          <div className='relative w-full max-w-sm'>
            <Search className='absolute left-2.5 top-2.5 size-4 text-muted-foreground' />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder='搜索模型展示名或模型 ID...'
              className='pl-8 h-9 text-xs'
            />
          </div>

          <div className='flex items-center gap-1.5'>
            <Button
              variant={filterVip === 'all' ? 'default' : 'outline'}
              size='sm'
              onClick={() => setFilterVip('all')}
              className='h-9 text-xs'
            >
              全部 ({models.length})
            </Button>
            <Button
              variant={filterVip === 'free' ? 'default' : 'outline'}
              size='sm'
              onClick={() => setFilterVip('free')}
              className='h-9 text-xs'
            >
              常规号可用 ({models.filter((m) => !m.owned_by.includes('(vip)')).length})
            </Button>
            <Button
              variant={filterVip === 'vip' ? 'default' : 'outline'}
              size='sm'
              onClick={() => setFilterVip('vip')}
              className='h-9 text-xs gap-1'
            >
              <Crown size={13} className='text-amber-500' />
              <span>VIP 优先 ({models.filter((m) => m.owned_by.includes('(vip)')).length})</span>
            </Button>
          </div>
        </div>

        {/* Model Cards Grid */}
        {!loading && models.length === 0 ? (
          <div className='flex flex-col items-center justify-center p-12 text-center rounded-lg border bg-card'>
            <Package className='size-12 text-muted-foreground/50 mb-3' />
            <h3 className='text-base font-semibold'>上游模型目录暂不可达或为空</h3>
            <p className='text-xs text-muted-foreground max-w-md mt-1 mb-4'>
              未获取到可用的上游推理模型。请检查后端服务健康状态 (/healthz) 与号池可用凭据 (/pool/state)。
            </p>
            <Button size='sm' variant='outline' onClick={fetchModels}>
              重新拉取目录
            </Button>
          </div>
        ) : (
          <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
            {filteredModels.map((model) => {
              const isVip = model.owned_by.includes('(vip)')
              const isCheapest = model.id === 'gateway-glm-5.3-flash'

              return (
                <Card
                  key={model.id}
                  className={`flex flex-col justify-between transition-all hover:border-primary/50 hover:shadow-md ${
                    isCheapest ? 'border-primary/40 bg-primary/5' : ''
                  }`}
                >
                  <CardHeader className='pb-3'>
                    <div className='flex items-start justify-between gap-2'>
                      <div>
                        <CardTitle className='text-base font-semibold flex items-center gap-1.5'>
                          <span>{model.display_name}</span>
                          {isCheapest && (
                            <Badge className='bg-primary/20 text-primary border-primary/30 text-[10px] px-1 py-0'>
                              最推荐
                            </Badge>
                          )}
                        </CardTitle>
                        <CardDescription className='font-mono text-xs mt-1 text-muted-foreground select-all'>
                          {model.id}
                        </CardDescription>
                      </div>

                      {isVip ? (
                        <Badge variant='outline' className='bg-amber-500/10 text-amber-600 border-amber-500/30 text-[11px] gap-1 shrink-0'>
                          <Crown size={12} />
                          VIP
                        </Badge>
                      ) : (
                        <Badge variant='secondary' className='text-[11px] shrink-0 font-normal'>
                          开放
                        </Badge>
                      )}
                    </div>
                  </CardHeader>

                  <CardContent className='space-y-3 pb-4 text-xs'>
                    <div className='flex items-center justify-between py-1.5 px-2 rounded-md bg-muted/50 font-mono'>
                      <span className='text-muted-foreground flex items-center gap-1'>
                        <Coins size={13} /> 倍率系数:
                      </span>
                      <span className='font-bold text-foreground'>
                        {model.cost_ratio || '标准 (1.0x)'}
                      </span>
                    </div>

                    <div className='text-xs text-muted-foreground min-h-[36px] line-clamp-2'>
                      {model.description || '官方基础大语言模型，支持通用问答与多轮推理。'}
                    </div>
                  </CardContent>

                  <CardFooter className='pt-0 border-t border-border/40 mt-auto'>
                    {isVip ? (
                      <Button
                        variant='ghost'
                        size='sm'
                        disabled
                        className='w-full mt-3 justify-between text-xs opacity-50 cursor-not-allowed'
                      >
                        <span>VIP 专属 (当前不可用)</span>
                        <Crown size={13} className='text-amber-500' />
                      </Button>
                    ) : (
                      <Button
                        asChild
                        variant='ghost'
                        size='sm'
                        className='w-full mt-3 justify-between text-xs hover:bg-primary/10 hover:text-primary'
                      >
                        <Link to='/chats' search={{ model: model.id }}>
                          <span>在对话中调用</span>
                          <ArrowRight size={14} />
                        </Link>
                      </Button>
                    )}
                  </CardFooter>
                </Card>
              )
            })}
          </div>
        )}
      </Main>
    </>
  )
}
