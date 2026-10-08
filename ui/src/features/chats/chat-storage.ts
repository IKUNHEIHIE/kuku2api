export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  responseId?: string
  account?: string
  consumePoints?: number
  tokens?: {
    input: number
    output: number
    total: number
    cached?: number
    reasoning?: number
  }
  thinkModeRequested?: number
  hasReasoningContent?: boolean
  isStreaming?: boolean
  error?: string
}

export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  apiMode: 'responses' | 'chat_completions'
  model: string
  thinkMode: string
  account: string
  sessionKey: string
  previousResponseId: string | null
  instructions: string
}

const SESSIONS_STORAGE_KEY = 'kuku_chat_sessions_v1'
const ACTIVE_SESSION_STORAGE_KEY = 'kuku_active_session_id_v1'
const MAX_SESSIONS = 50

export function deriveSessionTitle(messages: ChatMessage[], fallbackTitle = '新对话'): string {
  const firstUserMsg = messages.find((m) => m.role === 'user' && m.content.trim())
  if (!firstUserMsg) return fallbackTitle
  const clean = firstUserMsg.content.trim().replace(/\s+/g, ' ')
  return clean.length > 28 ? clean.slice(0, 28) + '...' : clean
}

export function loadSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (s): s is ChatSession =>
          Boolean(s && typeof s === 'object' && typeof s.id === 'string' && Array.isArray(s.messages))
      )
    }
  } catch {
    // ignore parse error
  }
  return []
}

export function loadActiveSessionId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY) || null
  } catch {
    return null
  }
}

export function saveActiveSessionId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, id)
  } catch {
    // ignore
  }
}

export function saveSession(session: ChatSession): void {
  try {
    const sessions = loadSessions()
    const index = sessions.findIndex((s) => s.id === session.id)
    const updated = {
      ...session,
      updatedAt: Date.now(),
      // Ensure title is up-to-date if still default
      title: session.title === '新对话' ? deriveSessionTitle(session.messages, '新对话') : session.title,
    }

    if (index >= 0) {
      sessions[index] = updated
    } else {
      sessions.unshift(updated)
    }

    // Sort by updatedAt descending
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)

    // Limit to MAX_SESSIONS
    const trimmed = sessions.slice(0, MAX_SESSIONS)
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(trimmed))
    saveActiveSessionId(session.id)
  } catch {
    // ignore storage write failure
  }
}

export function deleteSession(id: string): ChatSession[] {
  try {
    const sessions = loadSessions().filter((s) => s.id !== id)
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions))
    const currentActive = loadActiveSessionId()
    if (currentActive === id) {
      const nextActive = sessions[0]?.id || ''
      if (nextActive) {
        saveActiveSessionId(nextActive)
      } else {
        localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY)
      }
    }
    return sessions
  } catch {
    return []
  }
}

export function clearAllSessions(): void {
  try {
    localStorage.removeItem(SESSIONS_STORAGE_KEY)
    localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY)
  } catch {
    // ignore
  }
}

export function createDefaultSession(initial?: Partial<ChatSession>): ChatSession {
  const now = Date.now()
  return {
    id: initial?.id || `chat-${now}-${Math.random().toString(36).slice(2, 7)}`,
    title: initial?.title || '新对话',
    createdAt: initial?.createdAt || now,
    updatedAt: initial?.updatedAt || now,
    messages: initial?.messages || [],
    apiMode: initial?.apiMode || 'responses',
    model: initial?.model || 'gateway-glm-5.3-flash',
    thinkMode: initial?.thinkMode || '3',
    account: initial?.account || 'auto',
    sessionKey: initial?.sessionKey || `session-${now.toString(36)}`,
    previousResponseId: initial?.previousResponseId ?? null,
    instructions: initial?.instructions || '',
  }
}
