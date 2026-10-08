import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  kukuApi,
  ApiError,
  getApiSettings,
  saveApiSettings,
  verifyAdminToken,
  sanitizeHeaderValue,
  safeSetHeader,
} from './kuku-api'

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

describe('kuku-api client', () => {
  beforeEach(() => {
    store.clear()
    vi.restoreAllMocks()
  })

  describe('settings management & header safety', () => {
    it('returns default settings when localStorage is empty', () => {
      const settings = getApiSettings()
      expect(settings.baseUrl).toBe('http://127.0.0.1:8787')
      expect(settings.apiKey).toBe('')
      expect(settings.adminToken).toBe('')
    })

    it('saves and retrieves updated settings', () => {
      saveApiSettings({
        baseUrl: 'http://custom-proxy:9999/',
        apiKey: 'sk-test-12345',
        adminToken: 'admin-secret-888',
      })

      const updated = getApiSettings()
      expect(updated.baseUrl).toBe('http://custom-proxy:9999')
      expect(updated.apiKey).toBe('sk-test-12345')
      expect(updated.adminToken).toBe('admin-secret-888')
    })

    it('sanitizes non ISO-8859-1 characters (such as Chinese) to prevent Headers.set errors', () => {
      expect(sanitizeHeaderValue('sk-test-测试中文-123')).toBe('sk-test--123')
      expect(sanitizeHeaderValue('　demo-admin-key　')).toBe('demo-admin-key')
      expect(sanitizeHeaderValue('纯中文')).toBe('')

      const headers = new Headers()
      expect(() => {
        safeSetHeader(headers, 'x-admin-token', '带中文令牌-123')
      }).not.toThrow()
      expect(headers.get('x-admin-token')).toBe('-123')
    })

    it('auto-recovers and cleans dirty Chinese tokens stored in localStorage', () => {
      store.set('kuku_api_settings', JSON.stringify({
        baseUrl: 'http://127.0.0.1:8787',
        apiKey: 'sk-kuku-带中文测试密钥',
        adminToken: '管理员纯中文凭证',
      }))

      const settings = getApiSettings()
      expect(settings.apiKey).toBe('sk-kuku-')
      // If adminToken is stripped to empty due to pure Chinese, it safely falls back to empty string
      expect(settings.adminToken).toBe('')
    })
  })

  describe('ApiError', () => {
    it('properly initializes error fields', () => {
      const err = new ApiError(401, 'Unauthorized access', 'auth_error', 'invalid_key')
      expect(err.status).toBe(401)
      expect(err.message).toBe('Unauthorized access')
      expect(err.type).toBe('auth_error')
      expect(err.code).toBe('invalid_key')
      expect(err.name).toBe('ApiError')
    })
  })

  describe('API requests', () => {
    it('fetches healthz status successfully', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

      const res = await kukuApi.getHealthz()
      expect(res.ok).toBe(true)
    })

    it('handles 401/403 ApiError correctly', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: 'Invalid Admin Token', type: 'unauthorized', code: 'forbidden' },
          }),
          {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }
        )
      )

      await expect(kukuApi.getPoolState()).rejects.toThrow('Invalid Admin Token')
    })

    it('fetches models list', async () => {
      const mockModels = {
        object: 'list',
        data: [
          {
            id: 'gateway-glm-5.3-flash',
            display_name: 'GLM 5.3 Flash',
            owned_by: 'zhipu (kuku2api)',
            vip: false,
          },
        ],
      }

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(mockModels), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

      const res = await kukuApi.getModels()
      expect(res.data.length).toBe(1)
      expect(res.data[0].id).toBe('gateway-glm-5.3-flash')
    })

    it('creates response with directional account header', async () => {
      let capturedHeaders: HeadersInit | undefined
      let capturedBody: string | undefined

      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, init) => {
        capturedHeaders = init?.headers
        capturedBody = init?.body as string
        return new Response(
          JSON.stringify({
            id: 'resp_123',
            object: 'response',
            created_at: 1700000000,
            status: 'completed',
            model: 'gateway-glm-5.3-flash',
            output_text: 'Hello world',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })

      const res = await kukuApi.createResponse({
        model: 'gateway-glm-5.3-flash',
        input: 'Hi',
        account: 'kuku-0',
      })

      const getHeader = (h: HeadersInit | undefined, name: string) => {
        if (!h) return undefined
        if (h instanceof Headers) return h.get(name)
        if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]
        return (h as Record<string, string>)[name]
      }

      expect(res.id).toBe('resp_123')
      expect(res.output_text).toBe('Hello world')
      expect(getHeader(capturedHeaders, 'x-kuku-account')).toBe('kuku-0')
      expect(JSON.parse(capturedBody || '{}').input).toBe('Hi')
    })
  })

  describe('streamResponse SSE parsing', () => {
    it('parses reasoning, delta text, and completion events', async () => {
      const sseData = [
        'event: response.reasoning_summary_text.delta\n',
        'data: {"delta": "Thinking step 1..."}\n\n',
        'event: response.output_text.delta\n',
        'data: {"delta": "Hello"}\n\n',
        'event: response.output_text.delta\n',
        'data: {"delta": " from test!"}\n\n',
        'event: response.completed\n',
        'data: {"response": {"id": "resp_999", "status": "completed", "output_text": "Hello from test!"}}\n\n',
        'data: [DONE]\n\n',
      ].join('')

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData))
          controller.close()
        },
      })

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      )

      let reasoning = ''
      let text = ''
      let completedId = ''

      await kukuApi.streamResponse(
        { model: 'gateway-glm-5.3-flash', input: 'test' },
        {
          onReasoningDelta: (delta) => {
            reasoning += delta
          },
          onTextDelta: (delta) => {
            text += delta
          },
          onCompleted: (res) => {
            completedId = res.id
          },
        }
      )

      expect(reasoning).toBe('Thinking step 1...')
      expect(text).toBe('Hello from test!')
      expect(completedId).toBe('resp_999')
    })

    it('handles streamResponse error events', async () => {
      const sseData = [
        'event: error\n',
        'data: {"message": "upstream rate limit", "code": "rate_limited"}\n\n',
      ].join('')

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData))
          controller.close()
        },
      })

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      )

      let capturedError: unknown = null

      await kukuApi.streamResponse(
        { model: 'gateway-glm-5.3-flash', input: 'test' },
        {
          onError: (err) => {
            capturedError = err
          },
        }
      )

      expect(capturedError).not.toBeNull()
      expect((capturedError as { message: string }).message).toBe('upstream rate limit')
    })
  })

  describe('streamChatCompletion SSE parsing', () => {
    it('parses content deltas, reasoning_content, usage and kuku meta', async () => {
      const sseData = [
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"reasoning_content":"Thinking..."}}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Hi "}}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"there!"}}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n',
        'data: {"kuku":{"account":"kuku-0","consume_points":0.05,"session_id":"sess-123"}}\n\n',
        'data: [DONE]\n\n',
      ].join('')

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData))
          controller.close()
        },
      })

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      )

      let reasoning = ''
      let text = ''
      let completedResp: import('./kuku-api').ChatCompletionResponse | null = null

      await kukuApi.streamChatCompletion(
        {
          model: 'gateway-glm-5.3-flash',
          messages: [{ role: 'user', content: 'hello' }],
          session: 'custom-session-key',
        },
        {
          onReasoningDelta: (delta) => {
            reasoning += delta
          },
          onTextDelta: (delta) => {
            text += delta
          },
          onCompleted: (resp) => {
            completedResp = resp
          },
        }
      )

      expect(reasoning).toBe('Thinking...')
      expect(text).toBe('Hi there!')
      expect(completedResp).not.toBeNull()
      const resp = completedResp as unknown as import('./kuku-api').ChatCompletionResponse
      expect(resp.choices[0]?.message?.content).toBe('Hi there!')
      expect(resp.usage?.total_tokens).toBe(12)
      expect(resp.kuku?.consume_points).toBe(0.05)
      expect(resp.kuku?.account).toBe('kuku-0')
    })
  })

  describe('responses management & pagination', () => {
    it('sends correct query parameters for listResponses', async () => {
      let requestedUrl = ''
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (url) => {
        requestedUrl = String(url)
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [],
            first_id: null,
            last_id: null,
            has_more: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })

      await kukuApi.listResponses({ limit: 10, after: 'resp_abc', session_key: 'sess_1' })
      expect(requestedUrl).toContain('/v1/responses?limit=10&after=resp_abc&session_key=sess_1')
    })

    it('encodes response ID with special characters on get and delete', async () => {
      const requestedUrls: string[] = []
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        requestedUrls.push(String(url))
        return new Response(
          JSON.stringify({ id: 'resp/test', object: 'response', deleted: true }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })

      await kukuApi.getResponse('resp/test')
      await kukuApi.deleteResponse('resp/test')

      expect(requestedUrls[0]).toContain('/v1/responses/resp%2Ftest')
      expect(requestedUrls[1]).toContain('/v1/responses/resp%2Ftest')
    })
  })

  describe('pool administration operations', () => {
    it('executes addAccount with admin token', async () => {
      let capturedHeader = ''
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, init) => {
        const h = init?.headers as Headers
        capturedHeader = (h instanceof Headers ? h.get('x-admin-token') : (h as Record<string, string>)?.['x-admin-token']) || ''
        return new Response(
          JSON.stringify({ ok: true, accounts: [] }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        )
      })

      saveApiSettings({
        baseUrl: 'http://127.0.0.1:8787',
        apiKey: '',
        adminToken: 'test-admin-key',
      })

      const res = await kukuApi.addAccount({
        id: 'new-account',
        bduss: 'bduss-val',
        stoken: 'stoken-val',
        alias: 'New',
        priority: 1,
      })

      expect(res.ok).toBe(true)
      expect(capturedHeader).toBe('test-admin-key')
    })

    it('executes updateAccount and deleteAccount with URL encoding', async () => {
      const requestedUrls: string[] = []
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        requestedUrls.push(String(url))
        return new Response(
          JSON.stringify({ ok: true, account: {}, accounts: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })

      await kukuApi.updateAccount('kuku/special', { priority: 2 })
      await kukuApi.deleteAccount('kuku/special')
      await kukuApi.resequenceAccounts()
      await kukuApi.resetCooldown('kuku/special')

      expect(requestedUrls[0]).toContain('/pool/admin/accounts/kuku%2Fspecial')
      expect(requestedUrls[1]).toContain('/pool/admin/accounts/kuku%2Fspecial')
      expect(requestedUrls[2]).toContain('/pool/admin/resequence')
      expect(requestedUrls[3]).toContain('/pool/admin/reset-cooldown')
    })

    it('queries pool health with optional account parameter', async () => {
      const requestedUrls: string[] = []
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        requestedUrls.push(String(url))
        return new Response(
          JSON.stringify({ checked_at: '2026-10-04T00:00:00Z', accounts: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })

      await kukuApi.getPoolHealth()
      await kukuApi.getPoolHealth('kuku/0')

      expect(requestedUrls[0]).toContain('/pool/health')
      expect(requestedUrls[1]).toContain('/pool/health?account=kuku%2F0')
    })

    it('queries pool points with and without account parameter', async () => {
      const requestedUrls: string[] = []
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        requestedUrls.push(String(url))
        return new Response(
          JSON.stringify({
            checked_at: '2026-10-04T00:00:00Z',
            total_balance_points: 2567.22,
            accounts: [
              {
                id: 'kuku-0',
                alias: '主号',
                ok: true,
                balance_points: 2567.22,
                duration_points: 7200,
                scheduled_task_points: 2,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })

      const resAll = await kukuApi.getPoolPoints()
      const resSingle = await kukuApi.getPoolPoints('kuku/0')

      expect(requestedUrls[0]).toContain('/pool/points')
      expect(requestedUrls[1]).toContain('/pool/points?account=kuku%2F0')
      expect(resAll.total_balance_points).toBe(2567.22)
      expect(resSingle.accounts[0].balance_points).toBe(2567.22)
    })

    it('queries pool sessions with pagination and account parameters', async () => {
      let requestedUrl = ''
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (url) => {
        requestedUrl = String(url)
        return new Response(
          JSON.stringify({
            checked_at: '2026-10-04T00:00:00Z',
            accounts: [
              {
                id: 'kuku-0',
                alias: '主号',
                ok: true,
                offset: 0,
                size: 20,
                total: 10,
                sessions: [
                  {
                    session_id: 'sess-40chars-abcdef',
                    title: '测试会话',
                    status: 3,
                    session_type: 1,
                    is_read: false,
                    ctime: 1700000000,
                    mtime: 1700000001,
                    artifact_count: 0,
                    created_by_this_pool: true,
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })

      const res = await kukuApi.getPoolSessions({ account: 'kuku-0', offset: 0, size: 20 })
      expect(requestedUrl).toContain('/pool/sessions?account=kuku-0&offset=0&size=20')
      expect(res.accounts[0].sessions[0].created_by_this_pool).toBe(true)
      expect(res.accounts[0].sessions[0].title).toBe('测试会话')
    })

    it('updates account credentials (bduss and stoken) via PATCH', async () => {
      let capturedBody = ''
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, init) => {
        capturedBody = init?.body as string
        return new Response(
          JSON.stringify({
            ok: true,
            account: { id: 'kuku-0', has_credential: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })

      const res = await kukuApi.updateAccount('kuku-0', {
        bduss: 'new-bduss-value',
        stoken: 'new-stoken-value',
      })

      expect(res.ok).toBe(true)
      const parsedBody = JSON.parse(capturedBody)
      expect(parsedBody.bduss).toBe('new-bduss-value')
      expect(parsedBody.stoken).toBe('new-stoken-value')
    })
  })

  describe('Chat Completions non-stream and error mapping', () => {
    it('creates non-streaming chat completion with kuku metadata', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 1700000000,
            model: 'gateway-glm-5.3-flash',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Test reply' } }],
            kuku: { account: 'kuku-0', consume_points: 0.02 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )

      const res = await kukuApi.createChatCompletion({
        model: 'gateway-glm-5.3-flash',
        messages: [{ role: 'user', content: 'hello' }],
      })

      expect(res.id).toBe('chatcmpl-test')
      expect(res.choices[0].message?.content).toBe('Test reply')
      expect(res.kuku?.consume_points).toBe(0.02)
    })

    it('parses error with code model_not_found', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: 'model invalid-model not in catalog',
              type: 'invalid_request_error',
              code: 'model_not_found',
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
      )

      try {
        await kukuApi.createResponse({ model: 'invalid-model', input: 'test' })
        expect.unreachable('Should have thrown ApiError')
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ApiError)
        const apiErr = err as ApiError
        expect(apiErr.status).toBe(400)
        expect(apiErr.code).toBe('model_not_found')
      }
    })

    it('parses error with code cursor_not_found on bad responses after cursor', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: "unknown 'after' cursor: resp_expired",
              type: 'invalid_request_error',
              code: 'cursor_not_found',
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
      )

      try {
        await kukuApi.listResponses({ after: 'resp_expired' })
        expect.unreachable('Should have thrown ApiError')
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ApiError)
        const apiErr = err as ApiError
        expect(apiErr.status).toBe(400)
        expect(apiErr.code).toBe('cursor_not_found')
      }
    })

    it('passes x-kuku-session header in createResponse and streamResponse when session is provided', async () => {
      let capturedHeaders: HeadersInit | undefined

      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, init) => {
        capturedHeaders = init?.headers
        return new Response(
          JSON.stringify({
            id: 'resp_session_test',
            object: 'response',
            created_at: 1700000000,
            status: 'completed',
            model: 'gateway-glm-5.3-flash',
            output_text: 'Session response',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })

      const getHeader = (h: HeadersInit | undefined, name: string) => {
        if (!h) return undefined
        if (h instanceof Headers) return h.get(name)
        if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]
        return (h as Record<string, string>)[name]
      }

      await kukuApi.createResponse({
        model: 'gateway-glm-5.3-flash',
        input: 'Test session header',
        session: 'custom-session-key-42',
      })

      expect(getHeader(capturedHeaders, 'x-kuku-session')).toBe('custom-session-key-42')
    })

    it('handles 400 invalid_think_mode error preserving error.code', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: 'unusable thinking setting: think_mode must be one of [1, 2, 3, 4]',
              type: 'invalid_request_error',
              code: 'invalid_think_mode',
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
      )

      try {
        await kukuApi.createChatCompletion({
          messages: [{ role: 'user', content: 'test' }],
          think_mode: 99,
        })
        expect.unreachable('Should have thrown ApiError')
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ApiError)
        const apiErr = err as ApiError
        expect(apiErr.status).toBe(400)
        expect(apiErr.code).toBe('invalid_think_mode')
        expect(apiErr.message).toContain('unusable thinking setting')
      }
    })

    it('transmits think_mode and reasoning in createResponse and createChatCompletion payload', async () => {
      let capturedBody: string | undefined

      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, init) => {
        capturedBody = init?.body as string
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-test-think-mode',
            object: 'chat.completion',
            created: 1700000000,
            model: 'gateway-glm-5.3-flash',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hello' } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
              reasoning_tokens: 0,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })

      const res = await kukuApi.createChatCompletion({
        model: 'gateway-glm-5.3-flash',
        messages: [{ role: 'user', content: 'hi' }],
        think_mode: 4,
      })

      expect(res.choices[0].message?.content).toBe('hello')
      expect(res.usage?.reasoning_tokens).toBe(0)
      const parsedBody = JSON.parse(capturedBody || '{}')
      expect(parsedBody.think_mode).toBe(4)
    })

    it('handles 400 error when updateAccount receives empty credentials', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: 'bduss/stoken must be non-empty',
              type: 'invalid_request_error',
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
      )

      await expect(
        kukuApi.updateAccount('kuku-0', { bduss: '' })
      ).rejects.toThrow('bduss/stoken must be non-empty')
    })

    it('parses VIP account info in getPoolPoints', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            checked_at: '2026-10-04T00:00:00Z',
            total_balance_points: 999.5,
            accounts: [
              {
                id: 'kuku-vip',
                alias: 'VIP号',
                ok: true,
                is_vip: true,
                vip_type: 1,
                vip_end_time: 1799999999,
                balance_points: 999.5,
                duration_points: 5000,
                scheduled_task_points: 10,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )

      const res = await kukuApi.getPoolPoints('kuku-vip')
      expect(res.accounts[0].is_vip).toBe(true)
      expect(res.accounts[0].vip_type).toBe(1)
      expect(res.accounts[0].balance_points).toBe(999.5)
    })

    it('supports addAccount with ptoken and minted_stoken response', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            accounts: [{ id: 'kuku-1', alias: '号1', priority: 1, disabled: false, auth_dead: false, cooldown_remaining_ms: 0, has_credential: true }],
            minted_stoken: true,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        )
      )

      const res = await kukuApi.addAccount({
        id: 'kuku-1',
        alias: '号1',
        bduss: 'test_bduss',
        ptoken: 'test_ptoken',
      })

      expect(res.ok).toBe(true)
      expect(res.minted_stoken).toBe(true)
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:8787/pool/admin/accounts',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            id: 'kuku-1',
            alias: '号1',
            bduss: 'test_bduss',
            ptoken: 'test_ptoken',
          }),
        })
      )
    })

    it('handles QR code login flow: startLoginQr and pollLoginQr', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              login_id: 'lq-123',
              image_path: '/pool/admin/login/qr/lq-123.png',
              poll_path: '/pool/admin/login/qr/lq-123',
              prompt: '请用百度App扫码',
              expires_in_ms: 240000,
              scanned_by: '百度App',
            }),
            { status: 201, headers: { 'content-type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              state: 'scanned',
              login_id: 'lq-123',
              probe: { errno: 0 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              state: 'added',
              login_id: 'lq-123',
              account_id: 'kuku-2',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )

      const start = await kukuApi.startLoginQr({ alias: '扫码号' })
      expect(start.login_id).toBe('lq-123')
      expect(start.image_path).toBe('/pool/admin/login/qr/lq-123.png')

      const poll1 = await kukuApi.pollLoginQr('lq-123')
      expect(poll1.state).toBe('scanned')

      const poll2 = await kukuApi.pollLoginQr('lq-123')
      expect(poll2.state).toBe('added')
      expect(poll2.account_id).toBe('kuku-2')
    })

    it('passes abort signal in pollLoginQr to fetch', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({ state: 'pending' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      const controller = new AbortController()
      await kukuApi.pollLoginQr('lq-test', { signal: controller.signal })
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:8787/pool/admin/login/qr/lq-test',
        expect.objectContaining({
          method: 'GET',
          signal: controller.signal,
        })
      )
    })

    it('fetches blob image with admin credentials in getAdminBlobUrl', async () => {
      const mockBlob = new Blob(['mock-image-bytes'], { type: 'image/png' })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(mockBlob, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      )
      const createObjectURLMock = vi.fn().mockReturnValue('blob:http://localhost/test-blob-id')
      globalThis.URL.createObjectURL = createObjectURLMock

      const blobUrl = await kukuApi.getAdminBlobUrl('/pool/admin/login/qr/lq-1.png')
      expect(blobUrl).toBe('blob:http://localhost/test-blob-id')
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:8787/pool/admin/login/qr/lq-1.png',
        expect.objectContaining({
          headers: expect.any(Headers),
        })
      )
    })

    it('handles SMS login flow: start, resend with captcha, and verify', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              state: 'captcha_required',
              login_id: 'ls-999',
              captcha_path: '/pool/admin/login/sms/captcha/ls-999',
              message: '请输入图形验证码',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              state: 'sent',
              login_id: 'ls-999',
              message: '验证码已发送到该手机号',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              state: 'added',
              login_id: 'ls-999',
              account_id: 'kuku-3',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )

      const start = await kukuApi.startLoginSms({ phone: '13800000000' })
      expect(start.state).toBe('captcha_required')
      expect(start.captcha_path).toBe('/pool/admin/login/sms/captcha/ls-999')

      const resend = await kukuApi.resendLoginSms({
        login_id: 'ls-999',
        captcha: { code: 'abcd' },
      })
      expect(resend.state).toBe('sent')

      const verify = await kukuApi.verifyLoginSms({
        login_id: 'ls-999',
        code: '123456',
      })
      expect(verify.state).toBe('added')
      expect(verify.account_id).toBe('kuku-3')
    })

    it('handles API keys management: listKeys, createKey, deleteKey', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              open: true,
              keys: [],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              key: {
                id: 'key-1',
                hint: 'sk-kuku-123...456',
                label: '测试密钥',
                created_at: '2026-10-04T00:00:00Z',
                from_env: false,
                secret: 'sk-kuku-123456789abcdef0123456789abcdef0',
              },
              warning: 'copy the secret now; it is not retrievable',
            }),
            { status: 201, headers: { 'content-type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              keys: [],
              api_now_unauthenticated: true,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )

      const list1 = await kukuApi.listKeys()
      expect(list1.open).toBe(true)
      expect(list1.keys).toHaveLength(0)

      const created = await kukuApi.createKey('测试密钥')
      expect(created.ok).toBe(true)
      expect(created.key.secret).toBe('sk-kuku-123456789abcdef0123456789abcdef0')

      const deleted = await kukuApi.deleteKey('key-1')
      expect(deleted.ok).toBe(true)
      expect(deleted.api_now_unauthenticated).toBe(true)
    })

    it('handles Free Points & Auto Claim API routes correctly', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              accounts: [
                {
                  id: 'kuku-0',
                  alias: '主号',
                  ok: true,
                  code: null,
                  message: '',
                  tasks: [
                    {
                      activity_key: 'genflow_free_points',
                      period_id: 4,
                      tab_key: 'tab-1',
                      task_key: 'daily_chat',
                      task_name: '每日对话',
                      task_type: 'CHAT',
                      task_status: 'UNFINISHED',
                      reward_point: 50,
                      max_reward_point: 50,
                      claimable_point: 50,
                    },
                  ],
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              accounts: [
                {
                  id: 'kuku-0',
                  alias: '主号',
                  ok: true,
                  claimed: [
                    {
                      task_key: 'daily_chat',
                      task_type: 'CHAT',
                      claimed_point: 50,
                      claim_status: 'SUCCESS',
                    },
                  ],
                  points_earned: 50,
                },
              ],
              points_earned: 50,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              configured: true,
              enabled: false,
              hour: 9,
              last_run_at: null,
              last_result: null,
              next_run_at: null,
              running: false,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              auto_claim: {
                configured: true,
                enabled: true,
                hour: 10,
                last_run_at: null,
                last_result: null,
                next_run_at: 1760000000000,
                running: false,
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                took_ms: 120,
                accounts: [
                  {
                    id: 'kuku-0',
                    ok: true,
                    points_earned: 50,
                    claimed: ['CHAT'],
                  },
                ],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )

      const tasks = await kukuApi.getFreePointTasks()
      expect(tasks.accounts).toHaveLength(1)
      expect(tasks.accounts[0].tasks[0].claimable_point).toBe(50)

      const claimRes = await kukuApi.claimFreePoints({ chat: true })
      expect(claimRes.ok).toBe(true)
      expect(claimRes.points_earned).toBe(50)

      const autoClaimState = await kukuApi.getAutoClaim()
      expect(autoClaimState.enabled).toBe(false)
      expect(autoClaimState.hour).toBe(9)

      const configRes = await kukuApi.configureAutoClaim({ enabled: true, hour: 10 })
      expect(configRes.ok).toBe(true)
      expect(configRes.auto_claim.enabled).toBe(true)
      expect(configRes.auto_claim.hour).toBe(10)

      const runRes = await kukuApi.runAutoClaim()
      expect(runRes.ok).toBe(true)
      expect(runRes.result.accounts[0].points_earned).toBe(50)
    })

    it('handles balance_dead and auto_claim in pool state', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accounts: [
              {
                id: 'kuku-0',
                alias: '主号',
                priority: 0,
                disabled: false,
                auth_dead: false,
                balance_dead: true,
                balance_retry_in_ms: 540000,
                cooldown_remaining_ms: 0,
                has_credential: true,
              },
            ],
            sessions: 3,
            admin_enabled: true,
            api_open: false,
            api_key_count: 2,
            auto_claim: {
              configured: true,
              enabled: true,
              hour: 9,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )

      const state = await kukuApi.getPoolState()
      expect(state.accounts[0].balance_dead).toBe(true)
      expect(state.accounts[0].balance_retry_in_ms).toBe(540000)
      expect(state.auto_claim?.enabled).toBe(true)
    })

    it('handles 402 insufficient_balance JSON error in streamResponse', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: '积分不足，无法继续任务。',
              type: 'upstream_error',
              code: 'insufficient_balance',
            },
          }),
          {
            status: 402,
            headers: { 'content-type': 'application/json' },
          }
        )
      )

      await expect(
        kukuApi.streamResponse(
          {
            input: 'hello',
          },
          {}
        )
      ).rejects.toThrow('积分不足，无法继续任务。')
    })

    it('handles 402 insufficient_balance JSON error in streamChatCompletion', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: '积分不足，无法继续任务。',
              type: 'upstream_error',
              code: 'insufficient_balance',
            },
          }),
          {
            status: 402,
            headers: { 'content-type': 'application/json' },
          }
        )
      )

      await expect(
        kukuApi.streamChatCompletion(
          {
            messages: [{ role: 'user', content: 'hello' }],
          },
          {}
        )
      ).rejects.toThrow('积分不足，无法继续任务。')
    })

    it('handles in-stream error frame in streamChatCompletion', async () => {
      const ssePayload = [
        'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"部分内容"}}]}\n\n',
        'data: {"error":{"message":"mid-stream failure","type":"upstream_error","code":"upstream_died"}}\n\n',
        'data: [DONE]\n\n',
      ].join('')

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(ssePayload))
          controller.close()
        },
      })

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      )

      const onError = vi.fn()
      const onTextDelta = vi.fn()
      const onCompleted = vi.fn()

      await kukuApi.streamChatCompletion(
        {
          messages: [{ role: 'user', content: 'test' }],
        },
        {
          onTextDelta,
          onError,
          onCompleted,
        }
      )

      expect(onTextDelta).toHaveBeenCalledWith('部分内容')
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'mid-stream failure',
        })
      )
      expect(onCompleted).not.toHaveBeenCalled()
    })

    it('handles in-stream error frame in streamResponse and does not call onCompleted', async () => {
      const ssePayload = [
        'event: response.output_text.delta\n',
        'data: {"delta": "partial output"}\n\n',
        'data: {"error":{"message":"stream severed","type":"upstream_error","code":"server_error"}}\n\n',
        'data: [DONE]\n\n',
      ].join('')

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(ssePayload))
          controller.close()
        },
      })

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      )

      const onError = vi.fn()
      const onTextDelta = vi.fn()
      const onCompleted = vi.fn()

      await kukuApi.streamResponse(
        {
          input: 'test',
        },
        {
          onTextDelta,
          onError,
          onCompleted,
        }
      )

      expect(onTextDelta).toHaveBeenCalledWith('partial output')
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'stream severed',
        })
      )
      expect(onCompleted).not.toHaveBeenCalled()
    })

    it('rejects streamResponse when content-type is not text/event-stream', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Unexpected JSON response' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

      await expect(
        kukuApi.streamResponse({ input: 'hello' }, {})
      ).rejects.toThrow('Unexpected JSON response')
    })

    it('handles absolute URL in getAdminBlobUrl', async () => {
      const mockBlob = new Blob(['test'], { type: 'image/png' })
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(mockBlob, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      )

      const url = await kukuApi.getAdminBlobUrl('http://127.0.0.1:8787/pool/admin/login/qr/1.png')
      expect(url).toBeDefined()
    })
  })

  describe('verifyAdminToken', () => {
    it('returns error when token is empty or whitespace', async () => {
      const res = await verifyAdminToken('')
      expect(res.ok).toBe(false)
      expect(res.message).toContain('请输入管理员令牌')

      const resWhitespace = await verifyAdminToken('   ')
      expect(resWhitespace.ok).toBe(false)
    })

    it('returns ok: true when backend returns 200', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ open: true, keys: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

      const res = await verifyAdminToken('correct-token', 'http://127.0.0.1:8787')
      expect(res.ok).toBe(true)
    })

    it('returns ok: false with message when backend returns 401', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: 'admin token required',
              type: 'authentication_error',
            },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } }
        )
      )

      const res = await verifyAdminToken('invalid-token', 'http://127.0.0.1:8787')
      expect(res.ok).toBe(false)
      expect(res.message).toBe('admin token required')
    })

    it('catches network errors gracefully', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network connection refused'))

      const res = await verifyAdminToken('token', 'http://invalid-host:1234')
      expect(res.ok).toBe(false)
      expect(res.message).toContain('连接后端服务失败')
    })
  })

  describe('SQLite Backend APIs', () => {
    it('fetches token stats with query parameters', async () => {
      let capturedUrl = ''
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
        capturedUrl = String(input)
        return new Response(
          JSON.stringify({
            ok: true,
            checked_at: '2026-10-06T19:55:01.785Z',
            summary: { attempts: 10, completed: 8, failed: 2, cancelled: 0, total_tokens: 50000 },
            group_by: 'model',
            groups: [{ bucket: 'gateway-glm-5.3-flash', attempts: 8, total_tokens: 40000 }],
            groups_truncated: false,
            token_scope: 'reported_per_attempt',
            timezone: 'UTC',
            historical_coverage: 'legacy',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })

      const res = await kukuApi.getTokenStats({
        from: '2026-10-01',
        to: '2026-10-07',
        model: 'gateway-glm-5.3-flash',
        group_by: 'model',
      })

      expect(res.ok).toBe(true)
      expect(res.summary.attempts).toBe(10)
      expect(capturedUrl).toContain('/pool/admin/stats/tokens')
      expect(capturedUrl).toContain('from=2026-10-01')
      expect(capturedUrl).toContain('to=2026-10-07')
      expect(capturedUrl).toContain('model=gateway-glm-5.3-flash')
      expect(capturedUrl).toContain('group_by=model')
    })

    it('fetches conversations list with pagination and filters', async () => {
      let capturedUrl = ''
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
        capturedUrl = String(input)
        return new Response(
          JSON.stringify({
            ok: true,
            data: [
              {
                id: 'turn-123',
                created_at: 1791316490000,
                source: 'chat',
                model: 'gateway-glm-5.3-flash',
                account: 'kuku-0',
                status: 'completed',
                content_stored: 1,
                prompt_tokens: 100,
                completion_tokens: 20,
                total_tokens: 120,
                consume_points: 0.05,
              },
            ],
            total: 1,
            limit: 20,
            offset: 0,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })

      const res = await kukuApi.getConversations({
        limit: 20,
        offset: 0,
        source: 'chat',
        status: 'completed',
      })

      expect(res.ok).toBe(true)
      expect(res.data.length).toBe(1)
      expect(res.data[0].id).toBe('turn-123')
      expect(capturedUrl).toContain('/pool/admin/conversations')
      expect(capturedUrl).toContain('limit=20')
      expect(capturedUrl).toContain('offset=0')
      expect(capturedUrl).toContain('source=chat')
      expect(capturedUrl).toContain('status=completed')
    })

    it('fetches single conversation detail', async () => {
      let capturedUrl = ''
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
        capturedUrl = String(input)
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              id: 'turn-456',
              created_at: 1791316490000,
              source: 'responses',
              model: 'gateway-glm-5.3-flash',
              account: 'kuku-0',
              status: 'completed',
              content_stored: 1,
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              consume_points: 0.05,
              reply_id: 'resp-789',
              messages: [{ role: 'user', content: 'hello' }],
              output_text: 'world',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })

      const res = await kukuApi.getConversationDetail('turn-456')
      expect(res.ok).toBe(true)
      expect(res.data.id).toBe('turn-456')
      expect(res.data.reply_id).toBe('resp-789')
      expect(capturedUrl).toContain('/pool/admin/conversations/turn-456')
    })

    it('fetches admin logs with filters', async () => {
      let capturedUrl = ''
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
        capturedUrl = String(input)
        return new Response(
          JSON.stringify({
            ok: true,
            data: [
              {
                id: 1,
                created_at: 1791316490000,
                level: 'info',
                kind: 'http',
                method: 'GET',
                path: '/v1/models',
                status: 200,
                duration_ms: 5,
              },
            ],
            total: 1,
            limit: 50,
            offset: 0,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })

      const res = await kukuApi.getAdminLogs({ level: 'info', kind: 'http', limit: 50 })
      expect(res.ok).toBe(true)
      expect(res.data.length).toBe(1)
      expect(capturedUrl).toContain('/pool/admin/logs')
      expect(capturedUrl).toContain('level=info')
      expect(capturedUrl).toContain('kind=http')
    })

    it('fetches and patches server settings', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            settings: { site_name: 'kuku2api', log_retention_days: 30, conversation_retention_days: 0 },
            auto_claim: { enabled: false, hour: 9 },
            storage: { engine: 'sqlite', schema_version: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )

      const settingsRes = await kukuApi.getServerSettings()
      expect(settingsRes.ok).toBe(true)
      expect(settingsRes.settings.site_name).toBe('kuku2api')

      let patchedBody = ''
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_input, init) => {
        patchedBody = String(init?.body)
        return new Response(
          JSON.stringify({
            ok: true,
            settings: { site_name: '新号池站点', log_retention_days: 60, conversation_retention_days: 90 },
            auto_claim: { enabled: false, hour: 9 },
            storage: { engine: 'sqlite', schema_version: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })

      const patchRes = await kukuApi.patchServerSettings({ site_name: '新号池站点', log_retention_days: 60 })
      expect(patchRes.ok).toBe(true)
      expect(patchRes.settings.site_name).toBe('新号池站点')
      expect(JSON.parse(patchedBody)).toEqual({ site_name: '新号池站点', log_retention_days: 60 })
    })
  })
})


