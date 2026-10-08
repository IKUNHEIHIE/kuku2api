'use client'

import { useState, useEffect, useRef } from 'react'
import {
  Send,
  Square,
  Sparkles,
  Bot,
  User as UserIcon,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  BrainCircuit,
  Coins,
  Cpu,
  Info,
  AlertTriangle,
  X,
  History,
  Trash2,
  Plus,
  MessageSquare,
  Clock,
} from 'lucide-react'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'
import { ConfigDrawer } from '@/components/config-drawer'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from 'sonner'
import { getRouteApi, Link } from '@tanstack/react-router'
import {
  kukuApi,
  ApiError,
  type ModelItem,
  type ThinkModeItem,
  type Account,
  type ResponseItem,
  type ChatCompletionResponse,
  type PoolPointsResponse,
} from '@/lib/kuku-api'
import {
  type ChatMessage,
  type ChatSession,
  loadSessions,
  loadActiveSessionId,
  saveActiveSessionId,
  saveSession,
  deleteSession,
  clearAllSessions,
  createDefaultSession,
  deriveSessionTitle,
} from './chat-storage'

const routeApi = getRouteApi('/_authenticated/chats/')

export function Chats() {
  const navigate = routeApi.useNavigate()
  const search = routeApi.useSearch()
  const modelFromUrl = search?.model
  const previousResponseIdFromUrl = search?.previous_response_id
  const sessionKeyFromUrl = search?.session_key

  // Sessions and persistence state
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const loaded = loadSessions()
    if (loaded.length > 0) return loaded
    const initialSession = createDefaultSession({
      model: modelFromUrl || 'gateway-glm-5.3-flash',
      sessionKey: sessionKeyFromUrl || undefined,
      previousResponseId: previousResponseIdFromUrl || null,
    })
    saveSession(initialSession)
    return [initialSession]
  })

  const [currentSessionId, setCurrentSessionId] = useState<string>(() => {
    const activeId = loadActiveSessionId()
    const loaded = loadSessions()
    if (activeId && loaded.some((s) => s.id === activeId)) {
      return activeId
    }
    return loaded[0]?.id || ''
  })

  const [historyOpen, setHistoryOpen] = useState(false)

  const initialActiveSession =
    sessions.find((s) => s.id === currentSessionId) || sessions[0]

  const [apiMode, setApiMode] = useState<'responses' | 'chat_completions'>(
    () => initialActiveSession?.apiMode || 'responses'
  )
  const [sessionKey, setSessionKey] = useState<string>(
    () => sessionKeyFromUrl || initialActiveSession?.sessionKey || 'session-1'
  )
  const [models, setModels] = useState<ModelItem[]>([])
  const [thinkList, setThinkList] = useState<ThinkModeItem[]>([])
  const [selectedModel, setSelectedModel] = useState<string>(
    () => modelFromUrl || initialActiveSession?.model || 'gateway-glm-5.3-flash'
  )
  const [selectedThinkId, setSelectedThinkId] = useState<string>(
    () => initialActiveSession?.thinkMode || '3'
  )
  const [accounts, setAccounts] = useState<Account[]>([])
  const [selectedAccount, setSelectedAccount] = useState<string>(
    () => initialActiveSession?.account || 'auto'
  )
  const [poolPoints, setPoolPoints] = useState<PoolPointsResponse | null>(null)
  const [stream, setStream] = useState<boolean>(true)
  const [instructions, setInstructions] = useState<string>(
    () => initialActiveSession?.instructions || ''
  )
  const [showInstructions, setShowInstructions] = useState<boolean>(
    () => Boolean(initialActiveSession?.instructions)
  )

  const [input, setInput] = useState<string>('')
  const [messages, setMessages] = useState<ChatMessage[]>(
    () => initialActiveSession?.messages || []
  )
  const [isGenerating, setIsGenerating] = useState<boolean>(false)
  const [previousResponseId, setPreviousResponseId] = useState<string | null>(
    () => previousResponseIdFromUrl || initialActiveSession?.previousResponseId || null
  )
  const [expandedReasoning, setExpandedReasoning] = useState<Record<string, boolean>>({})

  // Scrolling management
  const abortControllerRef = useRef<AbortController | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const isUserScrolledUpRef = useRef(false)
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false)

  const handleViewportScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget
    const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight
    const scrolledUp = distanceToBottom > 80
    setIsUserScrolledUp(scrolledUp)
    isUserScrolledUpRef.current = scrolledUp
  }

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    if (viewportRef.current) {
      viewportRef.current.scrollTo({
        top: viewportRef.current.scrollHeight,
        behavior,
      })
      setIsUserScrolledUp(false)
      isUserScrolledUpRef.current = false
    } else if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior })
    }
  }

  useEffect(() => {
    if (!isUserScrolledUpRef.current) {
      scrollToBottom('smooth')
    }
  }, [messages])

  // Cleanup ongoing stream requests on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [])

  const persistSession = (
    msgsToSave: ChatMessage[],
    overrides?: Partial<ChatSession>
  ) => {
    if (!currentSessionId) return
    const cleanMessages = msgsToSave.map((m) =>
      m.isStreaming ? { ...m, isStreaming: false } : m
    )
    const all = loadSessions()
    const existing = all.find((s) => s.id === currentSessionId)
    const updated: ChatSession = {
      id: currentSessionId,
      title: deriveSessionTitle(cleanMessages, existing?.title || '新对话'),
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
      messages: cleanMessages,
      apiMode: overrides?.apiMode ?? apiMode,
      model: overrides?.model ?? selectedModel,
      thinkMode: overrides?.thinkMode ?? selectedThinkId,
      account: overrides?.account ?? selectedAccount,
      sessionKey: overrides?.sessionKey ?? sessionKey,
      previousResponseId:
        overrides?.previousResponseId !== undefined
          ? overrides.previousResponseId
          : previousResponseId,
      instructions: overrides?.instructions ?? instructions,
    }
    saveSession(updated)
    setSessions(loadSessions())
  }

  useEffect(() => {
    if (!previousResponseIdFromUrl) return
    let ignore = false
    void kukuApi
      .getResponse(previousResponseIdFromUrl)
      .then((resp) => {
        if (!ignore && resp) {
          const loadedMsg: ChatMessage = {
            id: resp.id,
            role: 'assistant',
            content: resp.output_text || '（历史轮次输出）',
            responseId: resp.id,
            account: resp.kuku?.account,
            consumePoints: resp.kuku?.consume_points ?? resp.usage?.kuku_consume_points,
          }
          setMessages([loadedMsg])
          if (resp.model) setSelectedModel(resp.model)
          persistSession([loadedMsg], {
            previousResponseId: resp.id,
            model: resp.model || selectedModel,
          })
          toast.success(`已载入上一轮上下文: ${resp.id}`)
        }
      })
      .catch(() => {
        if (!ignore) {
          toast.info(`已设置续接上一轮 ID: ${previousResponseIdFromUrl}`)
        }
      })
    return () => {
      ignore = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previousResponseIdFromUrl])

  // Load models & pool accounts & points on mount
  useEffect(() => {
    async function loadData() {
      try {
        const [modelsRes, poolRes, pointsRes] = await Promise.all([
          kukuApi.getModels().catch(() => null),
          kukuApi.getPoolState().catch(() => null),
          kukuApi.getPoolPoints().catch(() => null),
        ])

        if (pointsRes) {
          setPoolPoints(pointsRes)
        }

        if (modelsRes) {
          const list = modelsRes.data || []
          setModels(list)
          setThinkList(modelsRes.think_list || [])
          
          const targetFromUrl = modelFromUrl ? list.find((m) => m.id === modelFromUrl) : null
          if (targetFromUrl && !targetFromUrl.owned_by.includes('(vip)')) {
            setSelectedModel(targetFromUrl.id)
          } else if (modelsRes.default_model) {
            // Avoid selecting a VIP model by default if normal account cannot use it
            const defaultModelObj = list.find((m) => m.id === modelsRes.default_model)
            if (defaultModelObj && !defaultModelObj.owned_by.includes('(vip)')) {
              setSelectedModel(modelsRes.default_model)
            } else {
              const nonVip = list.find((m) => !m.owned_by.includes('(vip)'))
              if (nonVip) setSelectedModel(nonVip.id)
            }
          }
          if (modelsRes.default_think_id) {
            setSelectedThinkId(String(modelsRes.default_think_id))
          }
        }

        if (poolRes) {
          setAccounts(poolRes.accounts || [])
        }
      } catch (err: unknown) {
        toast.error('加载模型与账号列表失败: ' + (err instanceof Error ? err.message : String(err)))
      }
    }
    loadData()
  }, [modelFromUrl])



  const isVipEligible =
    selectedAccount !== 'auto' &&
    Boolean(poolPoints?.accounts.find((p) => p.id === selectedAccount)?.is_vip)

  const handleSwitchSession = (sessionId: string) => {
    if (sessionId === currentSessionId) {
      setHistoryOpen(false)
      return
    }
    if (isGenerating && abortControllerRef.current) {
      abortControllerRef.current.abort()
      setIsGenerating(false)
    }
    const all = loadSessions()
    const target = all.find((s) => s.id === sessionId)
    if (!target) return
    setCurrentSessionId(target.id)
    saveActiveSessionId(target.id)
    setMessages(target.messages || [])
    setApiMode(target.apiMode || 'responses')
    setSelectedModel(target.model || 'gateway-glm-5.3-flash')
    setSelectedThinkId(target.thinkMode || '3')
    setSelectedAccount(target.account || 'auto')
    setSessionKey(target.sessionKey || 'session-1')
    setPreviousResponseId(target.previousResponseId || null)
    setInstructions(target.instructions || '')
    setShowInstructions(Boolean(target.instructions))
    setExpandedReasoning({})
    setHistoryOpen(false)

    setIsUserScrolledUp(false)
    isUserScrolledUpRef.current = false
    setTimeout(() => scrollToBottom('instant'), 50)
    toast.info(`已切换至: ${target.title}`)
  }

  const handleDeleteSession = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const remaining = deleteSession(sessionId)
    setSessions(remaining)
    if (currentSessionId === sessionId) {
      if (remaining.length > 0) {
        handleSwitchSession(remaining[0].id)
      } else {
        const fresh = createDefaultSession({
          model: selectedModel,
          apiMode,
          thinkMode: selectedThinkId,
          account: selectedAccount,
        })
        saveSession(fresh)
        setSessions([fresh])
        setCurrentSessionId(fresh.id)
        saveActiveSessionId(fresh.id)
        setMessages([])
        setPreviousResponseId(null)
      }
    }
    toast.info('已删除该会话记录')
  }

  const handleClearAllSessions = () => {
    clearAllSessions()
    const fresh = createDefaultSession({
      model: selectedModel,
      apiMode,
      thinkMode: selectedThinkId,
      account: selectedAccount,
    })
    saveSession(fresh)
    setSessions([fresh])
    setCurrentSessionId(fresh.id)
    saveActiveSessionId(fresh.id)
    setMessages([])
    setPreviousResponseId(null)
    setExpandedReasoning({})
    setHistoryOpen(false)
    toast.info('已清空全部历史对话')
  }

  const handleAccountChange = (accId: string) => {
    setSelectedAccount(accId)
    const isAccVip = accId !== 'auto' && Boolean(poolPoints?.accounts.find((p) => p.id === accId)?.is_vip)
    const curModel = models.find((m) => m.id === selectedModel)
    let nextModel = selectedModel
    if (curModel?.owned_by.includes('(vip)') && !isAccVip) {
      const nonVip = models.find((m) => !m.owned_by.includes('(vip)'))
      if (nonVip) {
        nextModel = nonVip.id
        setSelectedModel(nonVip.id)
        toast.warning(`当前账号无 VIP 权益，已自动切换为标准模型 ${nonVip.display_name}`)
      }
    }
    persistSession(messages, { account: accId, model: nextModel })
  }

  const handleModelChange = (modelId: string) => {
    setSelectedModel(modelId)
    persistSession(messages, { model: modelId })
  }

  const handleThinkIdChange = (thinkId: string) => {
    setSelectedThinkId(thinkId)
    persistSession(messages, { thinkMode: thinkId })
  }

  const handleApiModeChange = (mode: 'responses' | 'chat_completions') => {
    setApiMode(mode)
    setMessages([])
    setPreviousResponseId(null)
    persistSession([], { apiMode: mode, previousResponseId: null })
    toast.info(`已切换至 ${mode === 'responses' ? 'Responses API' : 'Chat Completions API'} 协议`)
  }

  const currentModelMeta = models.find((m) => m.id === selectedModel)

  const handleNewChat = () => {
    if (isGenerating && abortControllerRef.current) {
      abortControllerRef.current.abort()
      setIsGenerating(false)
    }
    const newSession = createDefaultSession({
      apiMode,
      model: selectedModel,
      thinkMode: selectedThinkId,
      account: selectedAccount,
    })
    saveSession(newSession)
    setSessions(loadSessions())
    setCurrentSessionId(newSession.id)
    saveActiveSessionId(newSession.id)
    setMessages([])
    setPreviousResponseId(null)
    setExpandedReasoning({})
    setSessionKey(newSession.sessionKey)
    setIsUserScrolledUp(false)
    isUserScrolledUpRef.current = false
    setHistoryOpen(false)
    toast.info('已开启新对话，上一轮上下文已重置')
  }

  const toggleReasoning = (msgId: string) => {
    setExpandedReasoning((prev) => ({
      ...prev,
      [msgId]: !prev[msgId],
    }))
  }

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      setIsGenerating(false)
      const stopped = messages.map((m) =>
        m.isStreaming ? { ...m, isStreaming: false } : m
      )
      setMessages(stopped)
      persistSession(stopped)
    }
  }

  const handleSend = async () => {
    const trimmed = input.trim()
    if (!trimmed || isGenerating) return

    const userMsgId = 'msg-user-' + Date.now()
    const assistantMsgId = 'msg-asst-' + Date.now()

    const userMessage: ChatMessage = {
      id: userMsgId,
      role: 'user',
      content: trimmed,
    }

    const assistantPlaceholder: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      reasoning: '',
      thinkModeRequested: Number(selectedThinkId),
      isStreaming: true,
    }

    const newMessages = [...messages, userMessage, assistantPlaceholder]
    setMessages(newMessages)
    setInput('')
    setIsGenerating(true)
    setExpandedReasoning((prev) => ({ ...prev, [assistantMsgId]: true }))
    persistSession(newMessages)

    // Reset user scroll state to smooth scroll down for the new question
    setIsUserScrolledUp(false)
    isUserScrolledUpRef.current = false
    setTimeout(() => scrollToBottom('smooth'), 50)

    const effortMap: Record<string, 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'> = {
      '1': 'low',
      '2': 'medium',
      '3': 'high',
      '4': 'xhigh',
    }
    const reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' = effortMap[selectedThinkId] || 'high'

    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      if (apiMode === 'responses') {
        const payload: {
          model: string
          input: string
          reasoning: { effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }
          reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
          think_mode?: number
          stream: boolean
          store: boolean
          account?: string
          instructions?: string
          previous_response_id?: string
          session?: string
        } = {
          model: selectedModel,
          input: trimmed,
          reasoning: { effort: reasoningEffort },
          reasoning_effort: reasoningEffort,
          think_mode: Number(selectedThinkId),
          stream: stream,
          store: true,
          account: selectedAccount !== 'auto' ? selectedAccount : undefined,
          session: sessionKey.trim() || undefined,
        }

        if (instructions.trim()) {
          payload.instructions = instructions.trim()
        }

        if (previousResponseId) {
          payload.previous_response_id = previousResponseId
        }

        if (stream) {
          let accumulatedText = ''
          let accumulatedReasoning = ''

          await kukuApi.streamResponse(
            payload,
            {
              onReasoningDelta: (delta) => {
                accumulatedReasoning += delta
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMsgId
                      ? { ...msg, reasoning: accumulatedReasoning }
                      : msg
                  )
                )
              },
              onTextDelta: (delta) => {
                accumulatedText += delta
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMsgId
                      ? { ...msg, content: accumulatedText }
                      : msg
                  )
                )
              },
              onCompleted: (resp: ResponseItem) => {
                kukuApi.getPoolPoints().then(setPoolPoints).catch(() => {})
                setPreviousResponseId(resp.id)
                const reasoningTokens = resp.usage?.output_tokens_details?.reasoning_tokens ?? 0
                const hasReasoning = Boolean(
                  (resp.output && resp.output.some((o) => o.type === 'reasoning')) ||
                  accumulatedReasoning.trim().length > 0 ||
                  reasoningTokens > 0
                )
                setMessages((prev) => {
                  const next = prev.map((msg) =>
                    msg.id === assistantMsgId
                      ? {
                          ...msg,
                          content: resp.output_text || accumulatedText,
                          reasoning: accumulatedReasoning || msg.reasoning,
                          responseId: resp.id,
                          account: resp.kuku?.account,
                          consumePoints: resp.kuku?.consume_points ?? resp.usage?.kuku_consume_points,
                          tokens: resp.usage
                            ? {
                                input: resp.usage.input_tokens,
                                output: resp.usage.output_tokens,
                                total: resp.usage.total_tokens,
                                cached: resp.usage.input_tokens_details?.cached_tokens,
                                reasoning: reasoningTokens,
                              }
                            : undefined,
                          thinkModeRequested: Number(selectedThinkId),
                          hasReasoningContent: hasReasoning,
                          isStreaming: false,
                        }
                      : msg
                  )
                  persistSession(next, { previousResponseId: resp.id })
                  return next
                })
              },
              onError: (err) => {
                const errMsg =
                  (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string'
                    ? (err as { message: string }).message
                    : undefined) || '上游流式返回异常'
                const errCode = (err && typeof err === 'object' && 'code' in err) ? (err as { code: unknown }).code : undefined
                const isInvalidThinkMode = errCode === 'invalid_think_mode' || errMsg.includes('invalid_think_mode')
                const isInsufficient =
                  errCode === 'insufficient_balance' ||
                  errMsg.includes('insufficient_balance') ||
                  errMsg.includes('积分不足')

                let displayMsg = errMsg
                if (isInvalidThinkMode) {
                  displayMsg = '档位选择不合法，请从下拉框重选'
                } else if (isInsufficient) {
                  displayMsg = `所有账号积分耗尽 (402 insufficient_balance)：${errMsg}`
                }

                setMessages((prev) => {
                  const next = prev.map((msg) =>
                    msg.id === assistantMsgId
                      ? { ...msg, error: displayMsg, isStreaming: false }
                      : msg
                  )
                  persistSession(next)
                  return next
                })
                if (isInvalidThinkMode) {
                  toast.error(displayMsg)
                } else if (isInsufficient) {
                  toast.error(displayMsg, {
                    action: {
                      label: '查看号池与余额',
                      onClick: () => navigate({ to: '/users' }),
                    },
                    duration: 8000,
                  })
                } else {
                  toast.error(displayMsg)
                }
              },
            },
            controller.signal
          )
        } else {
          const resp = await kukuApi.createResponse(payload)
          kukuApi.getPoolPoints().then(setPoolPoints).catch(() => {})
          setPreviousResponseId(resp.id)

          let reasoningText = ''
          const reasoningPart = resp.output?.find((o) => o.type === 'reasoning')
          if (reasoningPart?.summary?.length) {
            reasoningText = reasoningPart.summary.map((s) => s.text).join('\n')
          }

          const reasoningTokens = resp.usage?.output_tokens_details?.reasoning_tokens ?? 0
          const hasReasoning = Boolean(
            (resp.output && resp.output.some((o) => o.type === 'reasoning')) ||
            reasoningText.trim().length > 0 ||
            reasoningTokens > 0
          )

          setMessages((prev) => {
            const next = prev.map((msg) =>
              msg.id === assistantMsgId
                ? {
                    ...msg,
                    content: resp.output_text || '',
                    reasoning: reasoningText,
                    responseId: resp.id,
                    account: resp.kuku?.account,
                    consumePoints: resp.kuku?.consume_points ?? resp.usage?.kuku_consume_points,
                    tokens: resp.usage
                      ? {
                          input: resp.usage.input_tokens,
                          output: resp.usage.output_tokens,
                          total: resp.usage.total_tokens,
                          cached: resp.usage.input_tokens_details?.cached_tokens,
                          reasoning: reasoningTokens,
                        }
                      : undefined,
                    thinkModeRequested: Number(selectedThinkId),
                    hasReasoningContent: hasReasoning,
                    isStreaming: false,
                  }
                : msg
            )
            persistSession(next, { previousResponseId: resp.id })
            return next
          })
        }
      } else {
        // Chat Completions API mode (/v1/chat/completions)
        const conversationMessages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = []
        if (instructions.trim()) {
          conversationMessages.push({ role: 'system', content: instructions.trim() })
        }
        for (const m of messages) {
          if (m.content && !m.error) {
            conversationMessages.push({ role: m.role, content: m.content })
          }
        }
        conversationMessages.push({ role: 'user', content: trimmed })

        if (stream) {
          let accumulatedText = ''
          let accumulatedReasoning = ''

          await kukuApi.streamChatCompletion(
            {
              model: selectedModel,
              messages: conversationMessages,
              think_mode: Number(selectedThinkId),
              kuku_meta: true,
              stream_options: { include_usage: true },
              account: selectedAccount !== 'auto' ? selectedAccount : undefined,
              session: sessionKey.trim() || undefined,
            },
            {
              onReasoningDelta: (delta) => {
                accumulatedReasoning += delta
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMsgId
                      ? { ...msg, reasoning: accumulatedReasoning }
                      : msg
                  )
                )
              },
              onTextDelta: (delta) => {
                accumulatedText += delta
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMsgId
                      ? { ...msg, content: accumulatedText }
                      : msg
                  )
                )
              },
              onCompleted: (resp: ChatCompletionResponse) => {
                kukuApi.getPoolPoints().then(setPoolPoints).catch(() => {})
                const reasoningTokens =
                  resp.usage?.reasoning_tokens ??
                  resp.usage?.output_tokens_details?.reasoning_tokens ??
                  0
                const hasReasoning = Boolean(
                  accumulatedReasoning.trim().length > 0 ||
                  reasoningTokens > 0
                )
                setMessages((prev) => {
                  const next = prev.map((msg) =>
                    msg.id === assistantMsgId
                      ? {
                          ...msg,
                          content: resp.choices[0]?.message?.content || accumulatedText,
                          reasoning: accumulatedReasoning || msg.reasoning,
                          responseId: resp.id,
                          account: resp.kuku?.account,
                          consumePoints: resp.kuku?.consume_points,
                          tokens: resp.usage
                            ? {
                                input: resp.usage.prompt_tokens,
                                output: resp.usage.completion_tokens,
                                total: resp.usage.total_tokens,
                                cached: resp.usage.cache_read_tokens,
                                reasoning: reasoningTokens,
                              }
                            : undefined,
                          thinkModeRequested: Number(selectedThinkId),
                          hasReasoningContent: hasReasoning,
                          isStreaming: false,
                        }
                      : msg
                  )
                  persistSession(next)
                  return next
                })
              },
              onError: (err) => {
                const errMsg =
                  (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string'
                    ? (err as { message: string }).message
                    : undefined) || '上游流式返回异常'
                const errCode = (err && typeof err === 'object' && 'code' in err) ? (err as { code: unknown }).code : undefined
                const isInvalidThinkMode = errCode === 'invalid_think_mode' || errMsg.includes('invalid_think_mode')
                const isInsufficient =
                  errCode === 'insufficient_balance' ||
                  errMsg.includes('insufficient_balance') ||
                  errMsg.includes('积分不足')

                let displayMsg = errMsg
                if (isInvalidThinkMode) {
                  displayMsg = '档位选择不合法，请从下拉框重选'
                } else if (isInsufficient) {
                  displayMsg = `所有账号积分耗尽 (402 insufficient_balance)：${errMsg}`
                }

                setMessages((prev) => {
                  const next = prev.map((msg) =>
                    msg.id === assistantMsgId
                      ? { ...msg, error: displayMsg, isStreaming: false }
                      : msg
                  )
                  persistSession(next)
                  return next
                })
                if (isInvalidThinkMode) {
                  toast.error(displayMsg)
                } else if (isInsufficient) {
                  toast.error(displayMsg, {
                    action: {
                      label: '查看号池与余额',
                      onClick: () => navigate({ to: '/users' }),
                    },
                    duration: 8000,
                  })
                } else {
                  toast.error(displayMsg)
                }
              },
            },
            controller.signal
          )
        } else {
          const resp = await kukuApi.createChatCompletion({
            model: selectedModel,
            messages: conversationMessages,
            think_mode: Number(selectedThinkId),
            kuku_meta: true,
            stream_options: { include_usage: true },
            account: selectedAccount !== 'auto' ? selectedAccount : undefined,
            session: sessionKey.trim() || undefined,
          })
          kukuApi.getPoolPoints().then(setPoolPoints).catch(() => {})

          const reasoningTokens =
            resp.usage?.reasoning_tokens ??
            resp.usage?.output_tokens_details?.reasoning_tokens ??
            0
          const hasReasoning = Boolean(reasoningTokens > 0)

          setMessages((prev) => {
            const next = prev.map((msg) =>
              msg.id === assistantMsgId
                ? {
                    ...msg,
                    content: resp.choices[0]?.message?.content || '',
                    responseId: resp.id,
                    account: resp.kuku?.account,
                    consumePoints: resp.kuku?.consume_points,
                    tokens: resp.usage
                      ? {
                          input: resp.usage.prompt_tokens,
                          output: resp.usage.completion_tokens,
                          total: resp.usage.total_tokens,
                          cached: resp.usage.cache_read_tokens,
                          reasoning: reasoningTokens,
                        }
                      : undefined,
                    thinkModeRequested: Number(selectedThinkId),
                    hasReasoningContent: hasReasoning,
                    isStreaming: false,
                  }
                : msg
            )
            persistSession(next)
            return next
          })
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        toast.info('对话生成已停止')
        setMessages((prev) => {
          const next = prev.map((m) =>
            m.id === assistantMsgId ? { ...m, isStreaming: false } : m
          )
          persistSession(next)
          return next
        })
      } else {
        let msg = err instanceof Error ? err.message : String(err)
        let isInsufficientBalance = false
        let isInvalidThinkMode = false
        if (err instanceof ApiError) {
          if (err.code === 'invalid_think_mode' || (err.status === 400 && (err.code === 'invalid_think_mode' || err.message.includes('invalid_think_mode')))) {
            isInvalidThinkMode = true
            msg = '档位选择不合法，请从下拉框重选'
          } else if (err.status === 402 || err.code === 'insufficient_balance' || err.message.includes('积分不足')) {
            isInsufficientBalance = true
            msg = `所有账号积分耗尽 (402 insufficient_balance)：${err.message || '积分不足，无法继续任务。'}`
          } else if (err.status === 400 && err.code === 'model_not_found') {
            const fallbackModel = models.find((m) => m.id === 'auto')?.id || 'gateway-glm-5.3-flash'
            msg = `模型 ${selectedModel} 不在目录中 (400 model_not_found)，已重置为推荐模型 ${fallbackModel}`
            setSelectedModel(fallbackModel)
          } else if (err.status === 404 && previousResponseId) {
            msg = `会话上下文已失效或过期 (404)，已重置上下文`
            setPreviousResponseId(null)
          } else if (err.status === 409) {
            msg = `号池无可用账号或指定账号不可用 (409)，请前往【号池管理】查看状态`
          } else if (err.status === 502) {
            msg = `上游网络链路不通 (502)，请稍后重试`
          }
        } else if (typeof msg === 'string' && msg.includes('invalid_think_mode')) {
          isInvalidThinkMode = true
          msg = '档位选择不合法，请从下拉框重选'
        }

        if (isInvalidThinkMode) {
          toast.error(msg)
        } else if (isInsufficientBalance) {
          toast.error(msg, {
            action: {
              label: '查看号池与余额',
              onClick: () => navigate({ to: '/users' }),
            },
            duration: 8000,
          })
        } else {
          toast.error(msg)
        }

        setMessages((prev) => {
          const next = prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, error: msg, isStreaming: false }
              : m
          )
          persistSession(next)
          return next
        })
      }
    } finally {
      setIsGenerating(false)
      abortControllerRef.current = null
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <TooltipProvider>
      <Header fixed>
        <div className='flex items-center gap-2'>
          <Bot className='size-5 text-primary' />
          <h1 className='text-base font-semibold'>AI 对话与调试台</h1>
          <Badge variant='outline' className='text-xs font-mono'>
            {apiMode === 'responses' ? 'OpenAI Responses API' : 'Chat Completions API'}
          </Badge>
          {poolPoints && (
            <Badge
              variant='secondary'
              className='text-xs font-mono gap-1 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20'
              title='号池可用于推理扣费的总剩余积分 (Token 桶)'
            >
              <Coins className='size-3 text-emerald-500' />
              号池总积分: {poolPoints.total_balance_points.toLocaleString()} pts
            </Badge>
          )}
        </div>
        <div className='ms-auto flex items-center gap-2'>
          <ThemeSwitch />
          <ConfigDrawer />
        </div>
      </Header>

      <Main fixed className='flex flex-col p-4 md:p-6 gap-3'>
        {models.length === 0 && (
          <div className='flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-800 dark:text-amber-300'>
            <AlertTriangle size={15} className='shrink-0 text-amber-600 dark:text-amber-400' />
            <span>上游模型目录暂未拉取到或暂不可达，请检查后端运行状态 (/healthz) 与号池配置 (/pool/state)。</span>
          </div>
        )}

        {/* Top Control Bar */}
        <div className='shrink-0 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3 shadow-xs'>
          <div className='flex flex-wrap items-center gap-3'>
            {/* Protocol API Mode */}
            <div className='flex items-center gap-2'>
              <Label className='text-xs font-medium text-muted-foreground text-nowrap'>
                接口协议:
              </Label>
              <Select
                value={apiMode}
                onValueChange={handleApiModeChange}
              >
                <SelectTrigger className='w-36 h-8 text-xs font-mono'>
                  <SelectValue placeholder='选择协议' />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='responses' className='text-xs'>
                    Responses API
                  </SelectItem>
                  <SelectItem value='chat_completions' className='text-xs'>
                    Chat Completions
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Model Selector */}
            <div className='flex items-center gap-2'>
              <Label className='text-xs font-medium text-muted-foreground text-nowrap'>
                模型:
              </Label>
              <Select value={selectedModel} onValueChange={handleModelChange}>
                <SelectTrigger className='w-48 sm:w-60 h-8 text-xs'>
                  <SelectValue placeholder='选择模型' />
                </SelectTrigger>
                <SelectContent className='max-h-80'>
                  {models.map((m) => {
                    const isVip = m.owned_by.includes('(vip)')
                    const disabled = isVip && !isVipEligible
                    return (
                      <SelectItem
                        key={m.id}
                        value={m.id}
                        disabled={disabled}
                        className={`text-xs ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                      >
                        <div className='flex items-center justify-between w-full gap-2'>
                          <span className={disabled ? 'line-through text-muted-foreground' : 'font-medium'}>
                            {m.display_name}
                          </span>
                          <div className='flex items-center gap-1.5'>
                            {m.cost_ratio && (
                              <span className='font-mono text-[10px] text-muted-foreground bg-muted px-1 rounded'>
                                {m.cost_ratio}
                              </span>
                            )}
                            {isVip && (
                              <span
                                className={`text-[10px] px-1 rounded font-medium ${
                                  isVipEligible
                                    ? 'bg-amber-500/20 text-amber-600'
                                    : 'bg-muted text-muted-foreground'
                                }`}
                              >
                                {isVipEligible ? 'VIP (可用)' : 'VIP (需会员号)'}
                              </span>
                            )}
                          </div>
                        </div>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
              {currentModelMeta?.description && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className='size-3.5 text-muted-foreground cursor-pointer' />
                  </TooltipTrigger>
                  <TooltipContent side='bottom' className='text-xs'>
                    {currentModelMeta.description} (倍率: {currentModelMeta.cost_ratio || '标准'})
                  </TooltipContent>
                </Tooltip>
              )}
            </div>

            {/* Think Mode Selector */}
            <div className='flex items-center gap-1.5'>
              <div className='flex items-center gap-1'>
                <Label className='text-xs font-medium text-muted-foreground text-nowrap'>
                  思考强度:
                </Label>
                <span className='text-[10px] text-muted-foreground/80 hidden lg:inline'>
                  (取决于模型)
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className='size-3.5 text-muted-foreground hover:text-foreground cursor-pointer' />
                  </TooltipTrigger>
                  <TooltipContent side='bottom' className='text-xs max-w-72 leading-relaxed'>
                    <div className='font-semibold mb-1'>think_list 思考档位说明（全模型共用）：</div>
                    <p className='text-muted-foreground'>
                      4 档声明始终可选，但具体是否生效取决于模型实现。除 gateway-glm-5.3-flash 已逐档验证外，其余 12 个型号上游可能静默降级（以回答下方的 reasoning_tokens 实际产生值为准）。
                    </p>
                    <div className='mt-1 text-[11px] text-amber-600 dark:text-amber-400'>
                      ⚠️ 注意：3 档「高」为上游默认档；4 档「极高」才是最高强度档位。推理成本与档位不成正比。
                    </div>
                  </TooltipContent>
                </Tooltip>
              </div>
              <Select value={selectedThinkId} onValueChange={handleThinkIdChange}>
                <SelectTrigger className='w-40 sm:w-44 h-8 text-xs font-medium'>
                  <SelectValue placeholder='思考强度'>
                    {selectedThinkId === '4' ? (
                      <span className='text-primary font-medium'>4 档 · 极高 (最高档)</span>
                    ) : selectedThinkId === '3' ? (
                      <span>3 档 · 高 (默认)</span>
                    ) : selectedThinkId === '2' ? (
                      <span>2 档 · 中 (一般)</span>
                    ) : selectedThinkId === '1' ? (
                      <span>1 档 · 低 (快速)</span>
                    ) : (
                      <span>{selectedThinkId} 档</span>
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className='w-64'>
                  {thinkList.length === 0 ? (
                    <>
                      <SelectItem value='1' className='text-xs'>
                        1 档 · 低 (快速问答)
                      </SelectItem>
                      <SelectItem value='2' className='text-xs'>
                        2 档 · 中 (一般问题)
                      </SelectItem>
                      <SelectItem value='3' className='text-xs'>
                        <div className='flex items-center gap-1.5'>
                          <span>3 档 · 高</span>
                          <Badge variant='outline' className='text-[10px] px-1 py-0 h-4 font-normal text-muted-foreground'>默认</Badge>
                          <span className='text-[11px] text-muted-foreground'>(专业办公)</span>
                        </div>
                      </SelectItem>
                      <SelectItem value='4' className='text-xs'>
                        <div className='flex items-center gap-1.5'>
                          <span className='font-medium text-primary'>4 档 · 极高</span>
                          <Badge variant='secondary' className='text-[10px] px-1 py-0 h-4 font-normal bg-primary/10 text-primary border border-primary/20'>最高档</Badge>
                          <span className='text-[11px] text-muted-foreground'>(深度改写)</span>
                        </div>
                      </SelectItem>
                    </>
                  ) : (
                    thinkList.map((t) => {
                      const isDefault = t.id === '3' || t.description?.includes('默认')
                      const isHighest = t.id === '4'
                      return (
                        <SelectItem key={t.id} value={t.id} className='text-xs'>
                          <div className='flex items-center justify-between w-full gap-2'>
                            <div className='flex items-center gap-1.5'>
                              <span className={`font-mono font-medium ${isHighest ? 'text-primary' : ''}`}>
                                {t.id} 档 · {t.think_name}
                              </span>
                              {isDefault && (
                                <Badge variant='outline' className='text-[10px] px-1 py-0 h-4 font-normal text-muted-foreground'>
                                  默认
                                </Badge>
                              )}
                              {isHighest && (
                                <Badge variant='secondary' className='text-[10px] px-1 py-0 h-4 font-normal bg-primary/10 text-primary border border-primary/20'>
                                  最高档
                                </Badge>
                              )}
                            </div>
                            <span className='text-muted-foreground text-[10px] truncate max-w-28'>
                              ({t.description})
                            </span>
                          </div>
                        </SelectItem>
                      )
                    })
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Account Selector */}
            <div className='flex items-center gap-2'>
              <Label className='text-xs font-medium text-muted-foreground text-nowrap'>
                定向账号:
              </Label>
              <Select value={selectedAccount} onValueChange={handleAccountChange}>
                <SelectTrigger className='w-36 h-8 text-xs font-mono'>
                  <SelectValue placeholder='自动调度' />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='auto' className='text-xs'>
                    自动调度 (号池择优)
                  </SelectItem>
                  {accounts.map((a) => {
                    const acctPt = poolPoints?.accounts.find((p) => p.id === a.id)
                    return (
                      <SelectItem key={a.id} value={a.id} className='text-xs'>
                        {a.alias || a.id} {a.disabled ? '(已停用)' : ''}
                        {acctPt ? ` [${acctPt.balance_points} pts${acctPt.is_vip ? '·VIP' : ''}]` : ''}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
              {selectedAccount !== 'auto' && (() => {
                const curAcctPt = poolPoints?.accounts.find((p) => p.id === selectedAccount)
                if (!curAcctPt) return null
                return (
                  <Badge variant='outline' className='text-[10px] font-mono gap-1 shrink-0'>
                    <Coins className='size-2.5 text-amber-500' />
                    {curAcctPt.balance_points} pts
                    {curAcctPt.is_vip && <span className='text-amber-500 font-bold'>VIP</span>}
                  </Badge>
                )
              })()}
            </div>

            {/* Stream Toggle */}
            <div className='flex items-center gap-1.5'>
              <Switch
                id='stream-toggle'
                checked={stream}
                onCheckedChange={setStream}
                className='scale-80'
              />
              <Label htmlFor='stream-toggle' className='text-xs text-muted-foreground cursor-pointer'>
                流式 (SSE)
              </Label>
            </div>

            {/* Session Key */}
            <div className='flex items-center gap-1.5'>
              <Label className='text-xs font-medium text-muted-foreground text-nowrap'>
                会话键:
              </Label>
              <Input
                value={sessionKey}
                onChange={(e) => {
                  setSessionKey(e.target.value)
                  persistSession(messages, { sessionKey: e.target.value })
                }}
                placeholder='session-1'
                className='h-8 w-28 text-xs font-mono'
                title='对应 x-kuku-session 请求头，可用于账本 session_key 归集与过滤'
              />
            </div>
          </div>

          <div className='flex items-center gap-2'>
            {apiMode === 'responses' && previousResponseId && (
              <div className='flex items-center gap-1'>
                <Badge variant='outline' className='text-[10px] font-mono text-muted-foreground'>
                  续接: {previousResponseId.slice(0, 10)}...
                </Badge>
                <Button
                  variant='ghost'
                  size='icon'
                  className='size-5 text-muted-foreground hover:text-foreground'
                  title='清除上下文续接'
                  onClick={() => {
                    setPreviousResponseId(null)
                    persistSession(messages, { previousResponseId: null })
                    toast.info('已清除上下文续接 ID')
                  }}
                >
                  <X size={11} />
                </Button>
              </div>
            )}

            {/* History Sessions Drawer */}
            <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
              <SheetTrigger asChild>
                <Button
                  variant='outline'
                  size='sm'
                  className='h-8 text-xs gap-1.5'
                  title='查看并切换历史会话'
                >
                  <History size={13} />
                  <span>历史记录</span>
                  {sessions.length > 0 && (
                    <Badge variant='secondary' className='h-4 px-1 text-[10px]'>
                      {sessions.length}
                    </Badge>
                  )}
                </Button>
              </SheetTrigger>
              <SheetContent side='right' className='w-80 sm:w-96 flex flex-col p-0'>
                <SheetHeader className='p-4 border-b shrink-0'>
                  <div className='flex items-center gap-2'>
                    <History size={16} className='text-primary' />
                    <SheetTitle className='text-base font-semibold'>历史对话记录</SheetTitle>
                  </div>
                  <SheetDescription className='text-xs text-muted-foreground'>
                    保存在本地浏览器中，刷新不丢失。可随时切换往期对话或开启新轮次。
                  </SheetDescription>
                  <div className='flex items-center justify-between pt-2'>
                    <Button
                      size='sm'
                      onClick={handleNewChat}
                      className='h-7 text-xs gap-1'
                    >
                      <Plus size={13} />
                      <span>新建对话</span>
                    </Button>
                    {sessions.length > 0 && (
                      <Button
                        variant='ghost'
                        size='sm'
                        onClick={handleClearAllSessions}
                        className='h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1'
                      >
                        <Trash2 size={13} />
                        <span>清空历史</span>
                      </Button>
                    )}
                  </div>
                </SheetHeader>

                {/* Session list */}
                <ScrollArea className='flex-1 min-h-0 p-3'>
                  {sessions.length === 0 ? (
                    <div className='flex flex-col items-center justify-center p-8 text-center text-muted-foreground space-y-2'>
                      <MessageSquare className='size-8 opacity-40' />
                      <p className='text-xs'>暂无历史会话</p>
                    </div>
                  ) : (
                    <div className='space-y-2'>
                      {sessions.map((s) => {
                        const isActive = s.id === currentSessionId
                        const formattedTime = new Date(s.updatedAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                        const formattedDate = new Date(s.updatedAt).toLocaleDateString([], {
                          month: 'numeric',
                          day: 'numeric',
                        })
                        return (
                          <div
                            key={s.id}
                            onClick={() => handleSwitchSession(s.id)}
                            className={`group relative flex flex-col gap-1 rounded-lg border p-3 text-left transition cursor-pointer hover:bg-accent/50 ${
                              isActive
                                ? 'border-primary/50 bg-primary/5 shadow-xs'
                                : 'border-border/60 bg-card'
                            }`}
                          >
                            <div className='flex items-start justify-between gap-2'>
                              <div className='font-medium text-xs leading-snug line-clamp-1'>
                                {s.title}
                              </div>
                              <Button
                                variant='ghost'
                                size='icon'
                                className='size-6 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10 shrink-0 transition'
                                title='删除会话'
                                onClick={(e) => handleDeleteSession(s.id, e)}
                              >
                                <Trash2 size={12} />
                              </Button>
                            </div>

                            <div className='flex items-center gap-2 text-[10px] text-muted-foreground'>
                              {isActive ? (
                                <Badge variant='default' className='h-3.5 px-1 text-[9px] font-normal leading-none'>
                                  当前
                                </Badge>
                              ) : null}
                              <span>{s.messages.length} 条消息</span>
                              <span>·</span>
                              <span className='truncate'>{s.model}</span>
                              <span className='ms-auto shrink-0 flex items-center gap-0.5'>
                                <Clock size={10} />
                                {formattedDate} {formattedTime}
                              </span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </ScrollArea>
              </SheetContent>
            </Sheet>

            <Button
              variant='outline'
              size='sm'
              onClick={handleNewChat}
              className='h-8 text-xs gap-1'
            >
              <RotateCcw size={13} />
              <span>新对话</span>
            </Button>
          </div>
        </div>

        {/* Messages Stream / List */}
        <div className='relative flex-1 min-h-0 my-1'>
          <ScrollArea
            className='h-full min-h-0 pr-3'
            viewportRef={viewportRef}
            onViewportScroll={handleViewportScroll}
          >
          {messages.length === 0 ? (
            <div className='flex flex-col items-center justify-center min-h-[360px] text-center p-6 space-y-4'>
              <div className='size-14 rounded-full bg-primary/10 flex items-center justify-center text-primary'>
                <Sparkles size={28} />
              </div>
              <div className='space-y-1.5'>
                <h3 className='text-lg font-semibold'>欢迎使用 kuku2api AI 调试台</h3>
                <p className='text-sm text-muted-foreground max-w-md'>
                  体验真实 OpenAI Responses API 协议，支持流式 SSE、动态思考深度、多轮记忆延续与每轮实扣积分显示。
                </p>
              </div>

              <div className='flex flex-wrap gap-2 justify-center max-w-lg mt-2'>
                {[
                  '用一句话介绍你自己，不超过30字',
                  '用 Python 写一个快速排序算法并说明时间复杂度',
                  '简述微服务架构与单体架构的权衡考量',
                ].map((sample) => (
                  <button
                    key={sample}
                    onClick={() => {
                      setInput(sample)
                    }}
                    className='text-xs rounded-full border border-border/80 bg-background hover:bg-accent hover:text-accent-foreground px-3 py-1.5 text-muted-foreground transition'
                  >
                    {sample}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className='space-y-4 pb-4'>
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex gap-3 ${
                    msg.role === 'user' ? 'justify-end' : 'justify-start'
                  }`}
                >
                  {msg.role === 'assistant' && (
                    <div className='size-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0 mt-0.5'>
                      <Bot size={17} />
                    </div>
                  )}

                  <div
                    className={`flex flex-col max-w-[85%] md:max-w-[75%] rounded-2xl p-4 shadow-xs ${
                      msg.role === 'user'
                        ? 'bg-primary text-primary-foreground rounded-tr-xs'
                        : 'bg-card border text-card-foreground rounded-tl-xs space-y-3'
                    }`}
                  >
                    {/* User message */}
                    {msg.role === 'user' ? (
                      <div className='whitespace-pre-wrap text-sm leading-relaxed'>
                        {msg.content}
                      </div>
                    ) : (
                      <>
                        {/* Reasoning / Thinking Accordion */}
                        {(msg.reasoning || (msg.isStreaming && !msg.content)) && (
                          <div className='rounded-lg border bg-muted/40 p-2.5 text-xs text-muted-foreground'>
                            <button
                              onClick={() => toggleReasoning(msg.id)}
                              className='flex items-center justify-between w-full font-medium hover:text-foreground transition'
                            >
                              <div className='flex items-center gap-1.5'>
                                <BrainCircuit
                                  size={14}
                                  className={
                                    msg.isStreaming && !msg.content
                                      ? 'animate-pulse text-primary'
                                      : 'text-muted-foreground'
                                  }
                                />
                                <span>思考过程</span>
                                {msg.isStreaming && !msg.content && (
                                  <span className='text-[10px] text-primary animate-pulse'>
                                    (深度思考中...)
                                  </span>
                                )}
                              </div>
                              {expandedReasoning[msg.id] ? (
                                <ChevronUp size={14} />
                              ) : (
                                <ChevronDown size={14} />
                              )}
                            </button>

                            {expandedReasoning[msg.id] && (
                              <div className='mt-2 pt-2 border-t border-border/50 font-mono whitespace-pre-wrap text-[11px] leading-relaxed max-h-60 overflow-y-auto opacity-90'>
                                {msg.reasoning || '正在整理思考逻辑...'}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Main Response Content */}
                        <div className='whitespace-pre-wrap text-sm leading-relaxed select-text'>
                          {msg.content}
                          {msg.isStreaming && (
                            <span className='inline-block w-1.5 h-4 ml-1 bg-primary align-middle animate-pulse' />
                          )}
                        </div>

                        {/* 思考内容判据与降级轻提示：调了 4 档但 reasoning_tokens 为 0 时显示"本模型此次未产生思考内容" */}
                        {!msg.isStreaming && !msg.error && (
                          (() => {
                            const hasReasoning = Boolean(
                              (msg.tokens?.reasoning !== undefined && msg.tokens.reasoning > 0) ||
                              msg.hasReasoningContent ||
                              (msg.reasoning && msg.reasoning.trim().length > 0)
                            )
                            if (hasReasoning) return null
                            if (msg.thinkModeRequested === 4 || (msg.thinkModeRequested !== undefined && msg.thinkModeRequested > 0)) {
                              return (
                                <div className='flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-400 bg-amber-500/10 px-2.5 py-1.5 rounded-md border border-amber-500/20'>
                                  <Info size={13} className='shrink-0 text-amber-600 dark:text-amber-400' />
                                  <span className='font-medium'>本模型此次未产生思考内容</span>
                                  <span className='text-[10px] text-muted-foreground'>
                                    ({msg.thinkModeRequested === 4 ? '已设 4 档极高' : `已设 ${msg.thinkModeRequested} 档`}，上游未输出 reasoning_tokens，可能对该模型静默降级)
                                  </span>
                                </div>
                              )
                            }
                            return null
                          })()
                        )}

                        {/* Error box */}
                        {msg.error && (
                          <div className='flex flex-col gap-1.5 text-xs text-destructive bg-destructive/10 p-2.5 rounded-lg border border-destructive/20'>
                            <div className='flex items-center gap-1.5'>
                              <AlertTriangle size={14} className='shrink-0' />
                              <span>{msg.error}</span>
                            </div>
                            {(msg.error.includes('insufficient_balance') ||
                              msg.error.includes('积分不足') ||
                              msg.error.includes('402')) && (
                              <div className='pt-1'>
                                <Button
                                  size='sm'
                                  variant='outline'
                                  asChild
                                  className='h-6 text-[11px] border-destructive/40 bg-background text-destructive hover:bg-destructive/10'
                                >
                                  <Link to='/users'>前往【号池管理】查看余额与免费积分</Link>
                                </Button>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Metadata Bar */}
                        {!msg.isStreaming && (msg.consumePoints !== undefined || msg.tokens) && (
                          <div className='flex flex-wrap items-center gap-2 pt-2 border-t border-border/40 text-[11px] text-muted-foreground font-mono'>
                            {msg.consumePoints !== undefined && (
                              <div className='flex items-center gap-1 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 px-2 py-0.5 rounded'>
                                <Coins size={12} />
                                <span>实扣积分: {msg.consumePoints} pts</span>
                              </div>
                            )}

                            {msg.account && (
                              <div className='flex items-center gap-1 bg-muted px-2 py-0.5 rounded'>
                                <Cpu size={12} />
                                <span>服务号: {msg.account}</span>
                              </div>
                            )}

                            {msg.tokens && (
                              <span className='text-muted-foreground'>
                                Tokens: {msg.tokens.input} 输入
                                {msg.tokens.cached ? ` (${msg.tokens.cached} 缓存)` : ''} /{' '}
                                {msg.tokens.output} 输出
                              </span>
                            )}

                            {msg.tokens?.reasoning !== undefined && msg.tokens.reasoning > 0 && (
                              <div className='flex items-center gap-1 bg-primary/10 text-primary px-2 py-0.5 rounded'>
                                <BrainCircuit size={12} />
                                <span>思考 Tokens: {msg.tokens.reasoning}</span>
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {msg.role === 'user' && (
                    <div className='size-8 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5 text-muted-foreground'>
                      <UserIcon size={17} />
                    </div>
                  )}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </ScrollArea>

        {/* Floating Scroll To Bottom Button */}
        {isUserScrolledUp && (
          <Button
            variant='outline'
            size='sm'
            onClick={() => scrollToBottom('smooth')}
            className='absolute bottom-3 right-6 z-20 rounded-full shadow-md bg-background/95 backdrop-blur-sm border-border hover:bg-muted text-xs gap-1.5 transition-all animate-in fade-in slide-in-from-bottom-2'
          >
            <ChevronDown size={14} className='animate-bounce' />
            <span>回到底部</span>
          </Button>
        )}
      </div>

      {/* Input Box Footer */}
      <div className='shrink-0 rounded-xl border bg-card p-3 shadow-sm space-y-2'>
        {showInstructions && (
          <div className='space-y-1 pb-2 border-b'>
            <Label className='text-xs text-muted-foreground'>系统 Instructions (可选):</Label>
            <Textarea
              value={instructions}
              onChange={(e) => {
                setInstructions(e.target.value)
                persistSession(messages, { instructions: e.target.value })
              }}
              placeholder='例如: Reply very briefly, in markdown format...'
              className='min-h-[50px] text-xs resize-none'
            />
          </div>
        )}

          <div className='flex gap-2 items-end'>
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder='输入您的问题... (按 Enter 发送，Shift + Enter 换行)'
              className='min-h-[60px] max-h-32 text-sm resize-none focus-visible:ring-1'
              disabled={isGenerating}
            />

            <div className='flex flex-col gap-1.5 shrink-0'>
              {isGenerating ? (
                <Button
                  variant='destructive'
                  size='sm'
                  onClick={handleStop}
                  className='h-9 px-3 gap-1'
                >
                  <Square size={14} />
                  <span>停止</span>
                </Button>
              ) : (
                <Button
                  size='sm'
                  onClick={handleSend}
                  disabled={!input.trim()}
                  className='h-9 px-4 gap-1.5'
                >
                  <Send size={15} />
                  <span>发送</span>
                </Button>
              )}
            </div>
          </div>

          <div className='flex items-center justify-between text-[11px] text-muted-foreground pt-1'>
            <button
              onClick={() => setShowInstructions(!showInstructions)}
              className='hover:text-foreground transition underline underline-offset-2'
            >
              {showInstructions ? '隐藏 Instructions' : '+ 自定义 Instructions'}
            </button>

            <span>
              已选模型: <strong className='text-foreground'>{currentModelMeta?.display_name || selectedModel}</strong> (
              {currentModelMeta?.cost_ratio || '标准'})
            </span>
          </div>
        </div>
      </Main>
    </TooltipProvider>
  )
}
