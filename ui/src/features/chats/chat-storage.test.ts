import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadSessions,
  saveSession,
  deleteSession,
  clearAllSessions,
  loadActiveSessionId,
  saveActiveSessionId,
  createDefaultSession,
  deriveSessionTitle,
} from './chat-storage'

const store = new Map<string, string>()
const mockLocalStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, val: string) => {
    store.set(key, val)
  },
  removeItem: (key: string) => {
    store.delete(key)
  },
  clear: () => {
    store.clear()
  },
}
Object.defineProperty(globalThis, 'localStorage', {
  value: mockLocalStorage,
  writable: true,
})

describe('chat-storage session persistence', () => {
  beforeEach(() => {
    try {
      localStorage.clear()
    } catch {
      // ignore
    }
    store.clear()
  })

  it('returns empty array when no sessions stored', () => {
    expect(loadSessions()).toEqual([])
    expect(loadActiveSessionId()).toBeNull()
  })

  it('saves and retrieves chat session, updating active session id', () => {
    const session = createDefaultSession({
      title: '新对话',
      messages: [
        { id: '1', role: 'user', content: '介绍一下微服务架构' },
        { id: '2', role: 'assistant', content: '微服务架构是一种设计模式...' },
      ],
    })

    saveSession(session)

    const list = loadSessions()
    expect(list.length).toBe(1)
    expect(list[0].id).toBe(session.id)
    // Title auto-derived from first user message
    expect(list[0].title).toBe('介绍一下微服务架构')
    expect(list[0].messages.length).toBe(2)
    expect(loadActiveSessionId()).toBe(session.id)
  })

  it('deletes specific session and updates active session if needed', () => {
    const s1 = createDefaultSession({ id: 's1', title: '会话1' })
    const s2 = createDefaultSession({ id: 's2', title: '会话2' })
    saveSession(s1)
    saveSession(s2)

    saveActiveSessionId('s2')
    const remaining = deleteSession('s2')
    expect(remaining.length).toBe(1)
    expect(remaining[0].id).toBe('s1')
    expect(loadActiveSessionId()).toBe('s1')
  })

  it('clears all sessions', () => {
    const s1 = createDefaultSession({ id: 's1' })
    saveSession(s1)
    expect(loadSessions().length).toBe(1)

    clearAllSessions()
    expect(loadSessions()).toEqual([])
    expect(loadActiveSessionId()).toBeNull()
  })

  it('correctly derives title from user messages', () => {
    expect(deriveSessionTitle([])).toBe('新对话')
    expect(deriveSessionTitle([{ id: '1', role: 'assistant', content: 'hello' }])).toBe('新对话')
    expect(
      deriveSessionTitle([{ id: '1', role: 'user', content: '简短问题' }])
    ).toBe('简短问题')
    const longPrompt = '这是一个非常非常长的提示词，用来测试超长文本是否会被截断展示...'
    const derived = deriveSessionTitle([{ id: '1', role: 'user', content: longPrompt }])
    expect(derived.endsWith('...')).toBe(true)
    expect(derived.length).toBeLessThanOrEqual(31)
  })
})
