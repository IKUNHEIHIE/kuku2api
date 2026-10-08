export interface Account {
  id: string
  alias: string
  priority: number
  disabled: boolean
  auth_dead: boolean
  balance_dead?: boolean
  balance_retry_in_ms?: number
  cooldown_remaining_ms: number
  has_credential: boolean
}

export interface PoolState {
  accounts: Account[]
  sessions: number
  admin_enabled: boolean
  api_open?: boolean
  api_key_count?: number
  auto_claim?: AutoClaimState
}

export interface AccountHealthResult {
  id: string
  alias: string
  ok: boolean
  code: number | null
  message: string
  unreachable?: boolean
}

export interface PoolHealthResponse {
  checked_at: string
  accounts: AccountHealthResult[]
}

export interface AssetBucket {
  asset_type: number
  asset_name: string
  total_point: number
  bonus_point: number
  vip_point: number
  charge_point: number
  freeze_point: number
}

export interface AccountPointsResult {
  id: string
  alias: string
  ok: boolean
  code: number | null
  message: string
  is_vip?: boolean
  vip_type?: number
  vip_end_time?: number | null
  is_trial?: boolean
  assets?: AssetBucket[]
  balance_points?: number
  duration_points?: number
  scheduled_task_points?: number
  unreachable?: boolean
}

export interface PoolPointsResponse {
  checked_at: string
  total_balance_points: number
  accounts: AccountPointsResult[]
}

export interface UpstreamSessionItem {
  session_id: string
  title: string
  status: number
  session_type: number
  is_read: boolean
  ctime: number
  mtime: number
  artifact_count: number
  created_by_this_pool: boolean
}

export interface AccountSessionsResult {
  id: string
  alias: string
  ok: boolean
  code: number | null
  message: string
  offset: number
  size: number
  total: number
  sessions: UpstreamSessionItem[]
  unreachable?: boolean
}

export interface PoolSessionsResponse {
  checked_at: string
  accounts: AccountSessionsResult[]
}

export interface ModelItem {
  id: string
  object: string
  owned_by: string
  display_name: string
  cost_ratio: string
  description: string
}

export interface ThinkModeItem {
  id: string
  think_name: string
  description: string
}

export interface ModelsResponse {
  object: 'list'
  data: ModelItem[]
  think_list: ThinkModeItem[]
  default_model: string
  default_think_id: number
}

export interface ResponseOutputMessage {
  id: string
  type: 'message' | 'reasoning'
  role?: 'assistant'
  status?: string
  content?: Array<{
    type: 'output_text'
    text: string
    annotations?: unknown[]
  }>
  summary?: Array<{
    type: 'summary_text'
    text: string
  }>
}

export interface ResponseItem {
  id: string
  object: 'response'
  created_at: number
  status: string
  completed_at?: number
  error?: unknown
  incomplete_details?: unknown
  instructions?: string | null
  model: string
  output?: ResponseOutputMessage[]
  output_text?: string
  parallel_tool_calls?: boolean
  previous_response_id?: string | null
  store?: boolean
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
    input_tokens_details?: {
      cached_tokens: number
      cache_write_tokens: number
    }
    output_tokens_details?: {
      reasoning_tokens: number
    }
    kuku_consume_points?: number
  }
  kuku?: {
    account: string
    session_id?: string
    reply_id?: string
    consume_points?: number
  }
}

export interface ResponsesListResponse {
  object: 'list'
  data: ResponseItem[]
  first_id: string | null
  last_id: string | null
  has_more: boolean
}

export interface ChatCompletionMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface ChatCompletionChoice {
  index: number
  message?: {
    role: 'assistant'
    content: string
  }
  delta?: {
    role?: string
    content?: string
    reasoning_content?: string
  }
  finish_reason?: string | null
}

export interface ChatCompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: ChatCompletionChoice[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    reasoning_tokens?: number
    cache_read_tokens?: number
    output_tokens_details?: {
      reasoning_tokens?: number
    }
    completion_tokens_details?: {
      reasoning_tokens?: number
    }
  }
  kuku?: {
    account: string
    consume_points: number
    session_id?: string
    reply_id?: string
  }
}

export interface LoginQrStartResponse {
  login_id: string
  image_path: string
  poll_path: string
  prompt?: string
  expires_in_ms: number
  scanned_by: string
}

export interface LoginQrPollResponse {
  state: 'pending' | 'scanned' | 'confirmed' | 'added' | 'expired' | 'failed'
  login_id?: string
  account_id?: string
  reason?: string
  expires_in_ms?: number
  probe?: unknown
}

export interface LoginSmsStartResponse {
  state: 'sent' | 'captcha_required' | 'refused' | 'unregistered'
  login_id: string
  captcha_path?: string
  message?: string
  errno?: number
}

export interface LoginSmsVerifyResponse {
  state: 'added' | 'captcha_required' | 'refused' | 'failed'
  account_id?: string
  login_id?: string
  captcha_path?: string
  message?: string
  slide?: unknown
}

export interface ApiKeyItem {
  id: string
  hint: string
  label: string
  created_at: string
  from_env: boolean
}

export interface ApiKeysListResponse {
  open: boolean
  keys: ApiKeyItem[]
}

export interface CreateApiKeyResponse {
  ok: boolean
  key: ApiKeyItem & { secret: string }
  warning: string
}

export interface DeleteApiKeyResponse {
  ok: boolean
  keys: ApiKeyItem[]
  api_now_unauthenticated: boolean
}

// 3.3 Free Points & Auto Claim Interfaces
export interface FreePointTaskItem {
  activity_key: string | null
  period_id: number
  tab_key: string | null
  task_key: string | null
  task_name: string | null
  task_type: string | null
  task_status: string | null
  reward_point: number
  max_reward_point: number
  claimable_point: number
}

export interface AccountFreePointTasks {
  id: string
  alias: string
  ok: boolean
  code: number | null
  message: string
  unreachable?: boolean
  tasks: FreePointTaskItem[]
}

export interface FreePointTasksResponse {
  accounts: AccountFreePointTasks[]
}

export interface FreePointClaimedItem {
  task_key: string | null
  task_type: string | null
  claimed_point: number
  claim_status: string | null
}

export interface AccountClaimResult {
  id: string
  alias: string
  ok: boolean
  code: number | null
  message: string
  unreachable?: boolean
  claimed: FreePointClaimedItem[]
  reported?: string[]
  chat_turn?: { ran: boolean; consume_points: number | null } | null
  points_earned?: number
  tasks_after?: FreePointTaskItem[]
  notes?: string | string[]
}

export interface ClaimFreePointsResponse {
  ok: boolean
  accounts: AccountClaimResult[]
  points_earned: number
}

export interface AutoClaimResultAccount {
  id: string
  ok: boolean
  points_earned: number
  claimed: string[]
  chat_turn?: { ran: boolean; consume_points: number | null } | null
  message?: string
  notes?: string | string[]
}

export interface AutoClaimLastResult {
  took_ms: number
  accounts: AutoClaimResultAccount[]
}

export interface AutoClaimState {
  configured?: boolean
  enabled: boolean
  hour?: number
  last_run_at?: number | null
  last_result?: AutoClaimLastResult | null
  next_run_at?: number | null
  running?: boolean
}

export interface AutoClaimResponse extends AutoClaimState {
  configured: boolean
}

// 3.4 SQLite Token Stats (/pool/admin/stats/tokens)
export interface TokenStatsSummary {
  attempts: number
  completed: number
  failed: number
  cancelled: number
  usage_known_attempts: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  reasoning_tokens: number
  cache_read_tokens: number
  consume_points: number
  points_known_attempts: number
  partial_usage_attempts: number
}

export interface TokenStatsGroup extends TokenStatsSummary {
  bucket: string
}

export interface TokenStatsResponse {
  ok: boolean
  checked_at: string
  summary: TokenStatsSummary
  group_by: 'day' | 'model' | 'account' | 'source'
  groups: TokenStatsGroup[]
  groups_truncated: boolean
  token_scope: string
  timezone: string
  historical_coverage: string
}

export interface TokenStatsParams {
  from?: string
  to?: string
  model?: string
  account?: string
  source?: 'chat' | 'responses' | 'claim' | 'legacy_response'
  status?: 'completed' | 'failed' | 'cancelled'
  group_by?: 'day' | 'model' | 'account' | 'source'
}

// 3.5 SQLite Conversations (/pool/admin/conversations)
export interface ConversationItem {
  id: string
  created_at: number // Unix ms
  source: 'chat' | 'responses' | 'claim' | 'legacy_response'
  model: string
  account: string
  session_key?: string | null
  session_id?: string | null
  status: 'completed' | 'failed' | 'cancelled'
  content_stored: number // 0 or 1
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  consume_points: number | null
  usage_scope: 'single_model_call' | 'last_model_call' | 'reported' | 'unknown'
  duration_ms: number | null
}

export interface ConversationsListResponse {
  ok: boolean
  data: ConversationItem[]
  total: number
  limit: number
  offset: number
}

export interface ConversationsParams {
  from?: string
  to?: string
  model?: string
  account?: string
  source?: 'chat' | 'responses' | 'claim' | 'legacy_response'
  status?: 'completed' | 'failed' | 'cancelled'
  session_key?: string
  limit?: number
  offset?: number
}

export interface UsageEvent {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  reasoning_tokens: number
  cache_read_tokens: number
}

export interface ConversationDetail extends ConversationItem {
  reply_id?: string | null
  think_mode?: number | string | null
  messages?: Array<{ role: string; content: unknown }> | null
  output_text?: string | null
  reasoning_text?: string | null
  reasoning_tokens?: number
  cache_read_tokens?: number
  model_call_count?: number
  usage_events?: UsageEvent[]
  error_code?: string | null
}

export interface ConversationDetailResponse {
  ok: boolean
  data: ConversationDetail
}

// 3.6 SQLite Logs (/pool/admin/logs)
export interface LogItem {
  id: number
  created_at: number // Unix ms
  level: 'info' | 'warn' | 'error'
  kind: 'http' | 'system' | 'legacy'
  method?: string | null
  path?: string | null
  status?: number | null
  duration_ms?: number | null
  message?: string | null
}

export interface LogsListResponse {
  ok: boolean
  data: LogItem[]
  total: number
  limit: number
  offset: number
}

export interface LogsParams {
  from?: string
  to?: string
  level?: 'info' | 'warn' | 'error'
  kind?: 'http' | 'system' | 'legacy'
  limit?: number
  offset?: number
}

// 3.7 SQLite Settings (/pool/admin/settings)
export interface ServerSettings {
  site_name: string
  log_retention_days: number
  conversation_retention_days: number
}

export interface AutoClaimSettings {
  enabled: boolean
  hour: number
  last_run_at: number | null
  last_result: unknown | null
  next_run_at: number | null
  running: boolean
}

export interface StorageInfo {
  engine: string
  schema_version: number
}

export interface AdminSettingsResponse {
  ok: boolean
  settings: ServerSettings
  auto_claim: AutoClaimSettings
  storage: StorageInfo
}

export interface PatchSettingsPayload {
  site_name?: string
  log_retention_days?: number
  conversation_retention_days?: number
}

export interface ApiSettings {
  baseUrl: string
  apiKey: string
  adminToken: string
}

const SETTINGS_KEY = 'kuku_api_settings'

/**
 * 校验并过滤 HTTP Header 的值，确保严格符合 ByteString / ISO-8859-1 规范（字符码 <= 255）。
/**
 * 校验字符串是否仅包含合法的 ISO-8859-1 可见字符及普通空格（字符码 32..255）。
 */
export function isSafeHeaderString(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c < 32 || c > 255) return false
  }
  return true
}

/**
 * 校验并过滤 HTTP Header 的值，确保严格符合 ByteString / ISO-8859-1 规范（字符码 <= 255）。
 * 如果包含非 ISO-8859-1 字符（例如中文汉字、全角标点），自动剔除，防止 Headers.set 抛出异常。
 */
export function sanitizeHeaderValue(val: unknown): string {
  if (val === null || val === undefined) return ''
  const str = String(val).trim()
  if (!str) return ''
  let result = ''
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code >= 32 && code <= 255) {
      result += str[i]
    }
  }
  return result.trim()
}

/**
 * 安全设置 Header，保证永远不抛出 "String contains non ISO-8859-1 code point" 异常
 */
export function safeSetHeader(headers: Headers, name: string, value: unknown): void {
  const clean = sanitizeHeaderValue(value)
  if (!clean) return
  try {
    headers.set(name, clean)
  } catch {
    // 降级保护：若极端情况下抛错，尝试 URI 编码
    try {
      headers.set(name, encodeURIComponent(clean))
    } catch {
      // 绝不让网络请求因单个 header 异常而崩溃
    }
  }
}

/**
 * 安全创建 Headers 对象，防止 options.headers 中传入非 ASCII / 中文字符引发崩溃
 */
export function createSafeHeaders(rawHeaders?: HeadersInit): Headers {
  const headers = new Headers()
  if (!rawHeaders) return headers

  if (rawHeaders instanceof Headers) {
    rawHeaders.forEach((value, key) => {
      safeSetHeader(headers, key, value)
    })
    return headers
  }

  if (Array.isArray(rawHeaders)) {
    for (const [key, value] of rawHeaders) {
      safeSetHeader(headers, key, value)
    }
    return headers
  }

  if (typeof rawHeaders === 'object') {
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (value !== undefined && value !== null) {
        const valStr = String(value)
        if (!isSafeHeaderString(valStr)) {
          // 若包含中文字符（如账号中文别名），使用 URI 编码保证合法 ISO-8859-1
          safeSetHeader(headers, key, encodeURI(valStr))
        } else {
          safeSetHeader(headers, key, valStr)
        }
      }
    }
  }

  return headers
}

export function getApiSettings(): ApiSettings {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      const cleanAdminToken = sanitizeHeaderValue(parsed.adminToken)
      const cleanApiKey = sanitizeHeaderValue(parsed.apiKey)
      const cleanBaseUrl = String(parsed.baseUrl ?? 'http://127.0.0.1:8787').trim().replace(/\/+$/, '')

      return {
        baseUrl: cleanBaseUrl || 'http://127.0.0.1:8787',
        apiKey: cleanApiKey,
        adminToken: cleanAdminToken,
      }
    }
  } catch {
    // fallback
  }
  return {
    baseUrl: 'http://127.0.0.1:8787',
    apiKey: '',
    adminToken: '',
  }
}

export function saveApiSettings(settings: ApiSettings): void {
  const cleanSettings: ApiSettings = {
    baseUrl: settings.baseUrl ? settings.baseUrl.trim().replace(/\/+$/, '') : 'http://127.0.0.1:8787',
    apiKey: sanitizeHeaderValue(settings.apiKey),
    adminToken: sanitizeHeaderValue(settings.adminToken),
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(cleanSettings))
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('kuku-settings-changed', { detail: cleanSettings }))
  }
}

export async function verifyAdminToken(
  token: string,
  baseUrl?: string
): Promise<{ ok: boolean; message?: string }> {
  const cleanToken = sanitizeHeaderValue(token)
  if (!cleanToken) {
    return { ok: false, message: '请输入管理员令牌' }
  }
  const settings = getApiSettings()
  const cleanBase = (baseUrl || settings.baseUrl || 'http://127.0.0.1:8787').trim().replace(/\/+$/, '')
  try {
    const headers = new Headers()
    safeSetHeader(headers, 'x-admin-token', cleanToken)
    safeSetHeader(headers, 'Authorization', `Bearer ${cleanToken}`)
    const res = await fetch(`${cleanBase}/pool/admin/keys`, {
      method: 'GET',
      headers,
    })
    if (res.ok) {
      return { ok: true }
    }
    const data = await res.json().catch(() => ({}))
    const msg = data?.error?.message || `鉴权失败 (HTTP ${res.status})`
    return { ok: false, message: msg }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `连接后端服务失败: ${msg}` }
  }
}

export class ApiError extends Error {
  status: number
  type: string
  code?: string

  constructor(status: number, message: string, type: string = 'api_error', code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.type = type
    this.code = code
  }
}

async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  requireAdmin: boolean = false
): Promise<T> {
  const { baseUrl, apiKey, adminToken } = getApiSettings()
  const cleanBase = baseUrl.replace(/\/+$/, '')
  const url = `${cleanBase}${path.startsWith('/') ? path : `/${path}`}`

  const headers = createSafeHeaders(options.headers)
  if (!headers.has('content-type') && options.body && typeof options.body === 'string') {
    safeSetHeader(headers, 'content-type', 'application/json; charset=utf-8')
  }

  // 管理后台发出的请求始终附带 x-admin-token，表明管理员身份
  if (adminToken) {
    safeSetHeader(headers, 'x-admin-token', adminToken)
  }

  if (requireAdmin) {
    if (adminToken) {
      safeSetHeader(headers, 'Authorization', `Bearer ${adminToken}`)
    }
  } else {
    if (apiKey) {
      safeSetHeader(headers, 'Authorization', `Bearer ${apiKey}`)
      safeSetHeader(headers, 'x-api-key', apiKey)
    } else if (adminToken) {
      // 管理后台免填 API 密钥模式：若尚未配置普通 apiKey，自动透传 adminToken 作为授权凭证
      safeSetHeader(headers, 'Authorization', `Bearer ${adminToken}`)
      safeSetHeader(headers, 'x-api-key', adminToken)
    }
  }

  const res = await fetch(url, {
    ...options,
    headers,
  })

  if (res.status === 204) {
    return {} as T
  }

  const text = await res.text()
  let data: Record<string, unknown> | null
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : null
  } catch {
    data = { raw: text }
  }

  if (!res.ok) {
    const errData = (data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object')
      ? (data.error as Record<string, unknown>)
      : null
    const msg =
      (errData && typeof errData.message === 'string' ? errData.message : undefined) ||
      (data && typeof data.message === 'string' ? data.message : undefined) ||
      `HTTP ${res.status}: ${res.statusText}`
    const type = (errData && typeof errData.type === 'string' ? errData.type : undefined) || 'error'
    const code = errData && typeof errData.code === 'string' ? errData.code : undefined

    if (res.status === 401 && (msg.includes('admin token') || type === 'authentication_error')) {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('kuku-admin-unauthorized', {
            detail: { message: msg, code, status: 401 },
          })
        )
      }
    }

    throw new ApiError(res.status, msg, type, code)
  }

  return data as T
}

export const kukuApi = {
  // 1. Health & Status
  async getHealthz(): Promise<{ ok: boolean }> {
    return apiRequest<{ ok: boolean }>('/healthz')
  },

  async getPoolState(): Promise<PoolState> {
    return apiRequest<PoolState>('/pool/state')
  },

  async getPoolHealth(account?: string): Promise<PoolHealthResponse> {
    const query = account ? `?account=${encodeURIComponent(account)}` : ''
    return apiRequest<PoolHealthResponse>(`/pool/health${query}`)
  },

  async getPoolPoints(account?: string): Promise<PoolPointsResponse> {
    const query = account ? `?account=${encodeURIComponent(account)}` : ''
    return apiRequest<PoolPointsResponse>(`/pool/points${query}`)
  },

  async getPoolSessions(params?: {
    account?: string
    offset?: number
    size?: number
  }): Promise<PoolSessionsResponse> {
    const search = new URLSearchParams()
    if (params?.account) search.set('account', params.account)
    if (params?.offset !== undefined) search.set('offset', String(params.offset))
    if (params?.size !== undefined) search.set('size', String(params.size))
    const qs = search.toString() ? `?${search.toString()}` : ''
    return apiRequest<PoolSessionsResponse>(`/pool/sessions${qs}`)
  },

  // 2. Model Catalog
  async getModels(): Promise<ModelsResponse> {
    return apiRequest<ModelsResponse>('/v1/models')
  },

  // 3. Pool Admin
  async addAccount(accountData: {
    id: string
    bduss: string
    stoken?: string
    ptoken?: string
    alias?: string
    priority?: number
    disabled?: boolean
    device_id?: string
  }): Promise<{ ok: boolean; accounts: Account[]; minted_stoken?: boolean }> {
    return apiRequest<{ ok: boolean; accounts: Account[]; minted_stoken?: boolean }>(
      '/pool/admin/accounts',
      {
        method: 'POST',
        body: JSON.stringify(accountData),
      },
      true
    )
  },

  async updateAccount(
    id: string,
    updates: {
      alias?: string
      priority?: number
      disabled?: boolean
      bduss?: string
      stoken?: string
    }
  ): Promise<{ ok: boolean; account: Account }> {
    return apiRequest<{ ok: boolean; account: Account }>(
      `/pool/admin/accounts/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(updates),
      },
      true
    )
  },

  async deleteAccount(id: string): Promise<{ ok: boolean; accounts: Account[]; gap?: boolean }> {
    return apiRequest<{ ok: boolean; accounts: Account[]; gap?: boolean }>(
      `/pool/admin/accounts/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
      },
      true
    )
  },

  async resequenceAccounts(): Promise<{ ok: boolean; accounts: Account[] }> {
    return apiRequest<{ ok: boolean; accounts: Account[] }>(
      '/pool/admin/resequence',
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
      true
    )
  },

  async resetCooldown(id?: string): Promise<{ ok: boolean; accounts: Account[] }> {
    return apiRequest<{ ok: boolean; accounts: Account[] }>(
      '/pool/admin/reset-cooldown',
      {
        method: 'POST',
        body: JSON.stringify(id ? { id } : {}),
      },
      true
    )
  },

  // 3.1 Login Add Account (QR Code & SMS)
  async getAdminBlobUrl(path: string): Promise<string> {
    const { baseUrl, adminToken } = getApiSettings()
    const cleanBase = baseUrl.replace(/\/+$/, '')
    const url = /^https?:\/\//i.test(path)
      ? path
      : `${cleanBase}${path.startsWith('/') ? path : `/${path}`}`
    const headers = new Headers()
    if (adminToken) {
      safeSetHeader(headers, 'Authorization', `Bearer ${adminToken}`)
      safeSetHeader(headers, 'x-admin-token', adminToken)
    }
    const res = await fetch(url, { headers })
    if (!res.ok) {
      throw new ApiError(res.status, `加载图片失败 (HTTP ${res.status})`)
    }
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  },

  async startLoginQr(params?: {
    alias?: string
    priority?: number
  }): Promise<LoginQrStartResponse> {
    return apiRequest<LoginQrStartResponse>(
      '/pool/admin/login/qr',
      {
        method: 'POST',
        body: JSON.stringify(params || {}),
      },
      true
    )
  },

  async pollLoginQr(
    id: string,
    options?: { signal?: AbortSignal }
  ): Promise<LoginQrPollResponse> {
    return apiRequest<LoginQrPollResponse>(
      `/pool/admin/login/qr/${encodeURIComponent(id)}`,
      { method: 'GET', signal: options?.signal },
      true
    )
  },

  async startLoginSms(params: {
    phone: string
    alias?: string
    priority?: number
    captcha?: { vcodestr: string; vcodesign: string; code: string }
  }): Promise<LoginSmsStartResponse> {
    return apiRequest<LoginSmsStartResponse>(
      '/pool/admin/login/sms',
      {
        method: 'POST',
        body: JSON.stringify(params),
      },
      true
    )
  },

  async resendLoginSms(params: {
    login_id: string
    captcha?: { vcodestr?: string; vcodesign?: string; code: string }
  }): Promise<LoginSmsStartResponse> {
    return apiRequest<LoginSmsStartResponse>(
      '/pool/admin/login/sms/resend',
      {
        method: 'POST',
        body: JSON.stringify(params),
      },
      true
    )
  },

  async verifyLoginSms(params: {
    login_id: string
    code: string
  }): Promise<LoginSmsVerifyResponse> {
    return apiRequest<LoginSmsVerifyResponse>(
      '/pool/admin/login/sms/verify',
      {
        method: 'POST',
        body: JSON.stringify(params),
      },
      true
    )
  },

  // 3.2 API Keys Management (/pool/admin/keys)
  async listKeys(): Promise<ApiKeysListResponse> {
    return apiRequest<ApiKeysListResponse>(
      '/pool/admin/keys',
      { method: 'GET' },
      true
    )
  },

  async createKey(label?: string): Promise<CreateApiKeyResponse> {
    const res = await apiRequest<CreateApiKeyResponse>(
      '/pool/admin/keys',
      {
        method: 'POST',
        body: JSON.stringify(label ? { label } : {}),
      },
      true
    )
    if (res.ok && res.key?.secret) {
      const current = getApiSettings()
      if (!current.apiKey) {
        saveApiSettings({ ...current, apiKey: res.key.secret })
      }
    }
    return res
  },

  async deleteKey(id: string): Promise<DeleteApiKeyResponse> {
    const res = await apiRequest<DeleteApiKeyResponse>(
      `/pool/admin/keys/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      true
    )
    if (res.api_now_unauthenticated) {
      const current = getApiSettings()
      if (current.apiKey) {
        saveApiSettings({ ...current, apiKey: '' })
      }
    }
    return res
  },

  // 3.3 Free Points & Auto Claim (/pool/admin/claim, /pool/admin/auto-claim)
  async getFreePointTasks(account?: string): Promise<FreePointTasksResponse> {
    const query = account ? `?account=${encodeURIComponent(account)}` : ''
    return apiRequest<FreePointTasksResponse>(`/pool/admin/claim${query}`, { method: 'GET' }, true)
  },

  async claimFreePoints(params?: {
    id?: string
    account?: string
    chat?: boolean
    model?: string
    text?: string
  }): Promise<ClaimFreePointsResponse> {
    return apiRequest<ClaimFreePointsResponse>(
      '/pool/admin/claim',
      {
        method: 'POST',
        body: JSON.stringify(params || {}),
      },
      true
    )
  },

  async getAutoClaim(): Promise<AutoClaimResponse> {
    return apiRequest<AutoClaimResponse>('/pool/admin/auto-claim', { method: 'GET' }, true)
  },

  async configureAutoClaim(params: {
    enabled?: boolean
    hour?: number
  }): Promise<{ ok: boolean; auto_claim: AutoClaimState }> {
    return apiRequest<{ ok: boolean; auto_claim: AutoClaimState }>(
      '/pool/admin/auto-claim',
      {
        method: 'POST',
        body: JSON.stringify(params),
      },
      true
    )
  },

  async runAutoClaim(): Promise<{ ok: boolean; result: AutoClaimLastResult }> {
    return apiRequest<{ ok: boolean; result: AutoClaimLastResult }>(
      '/pool/admin/auto-claim/run',
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
      true
    )
  },

  // 4. Responses API
  async listResponses(params?: {
    limit?: number
    after?: string
    session_key?: string
  }): Promise<ResponsesListResponse> {
    const search = new URLSearchParams()
    if (params?.limit) search.set('limit', String(params.limit))
    if (params?.after) search.set('after', params.after)
    if (params?.session_key) search.set('session_key', params.session_key)
    const qs = search.toString() ? `?${search.toString()}` : ''
    return apiRequest<ResponsesListResponse>(`/v1/responses${qs}`)
  },

  async getResponse(id: string): Promise<ResponseItem> {
    return apiRequest<ResponseItem>(`/v1/responses/${encodeURIComponent(id)}`)
  },

  async deleteResponse(id: string): Promise<{ id: string; object: 'response'; deleted: boolean }> {
    return apiRequest<{ id: string; object: 'response'; deleted: boolean }>(
      `/v1/responses/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
      }
    )
  },

  async createResponse(
    payload: {
      model?: string
      input: string | Array<{ role: string; content: Array<{ type: string; text: string }> }>
      instructions?: string
      previous_response_id?: string
      stream?: boolean
      reasoning?: { effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }
      reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
      /**
       * 思考强度档位（1|2|3|4，对应 GET /v1/models 的 think_list id）。
       * think_mode 是权威字段，优先级高于 reasoning.effort 与 reasoning_effort。
       */
      think_mode?: number
      store?: boolean
      account?: string
      session?: string
    }
  ): Promise<ResponseItem> {
    const { account, session, ...rest } = payload
    const headers: Record<string, string> = {}
    if (account && account !== 'auto') {
      headers['x-kuku-account'] = account
    }
    if (session) {
      headers['x-kuku-session'] = session
    }
    return apiRequest<ResponseItem>('/v1/responses', {
      method: 'POST',
      headers,
      body: JSON.stringify(rest),
    })
  },

  // Stream responses via Server-Sent Events
  async streamResponse(
    payload: {
      model?: string
      input: string | Array<{ role: string; content: Array<{ type: string; text: string }> }>
      instructions?: string
      previous_response_id?: string
      reasoning?: { effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }
      reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
      /**
       * 思考强度档位（1|2|3|4，对应 GET /v1/models 的 think_list id）。
       * think_mode 是权威字段，优先级高于 reasoning.effort 与 reasoning_effort。
       */
      think_mode?: number
      store?: boolean
      account?: string
      session?: string
    },
    callbacks: {
      onReasoningDelta?: (delta: string) => void
      onTextDelta?: (delta: string) => void
      onCompleted?: (response: ResponseItem) => void
      onError?: (err: unknown) => void
    },
    signal?: AbortSignal
  ): Promise<void> {
    const { baseUrl, apiKey, adminToken } = getApiSettings()
    const cleanBase = baseUrl.replace(/\/+$/, '')
    const url = `${cleanBase}/v1/responses`

    const { account, session, ...restPayload } = payload
    const headers = createSafeHeaders({
      'content-type': 'application/json; charset=utf-8',
    })
    if (adminToken) {
      safeSetHeader(headers, 'x-admin-token', adminToken)
    }
    const tokenToUse = apiKey || adminToken
    if (tokenToUse) {
      safeSetHeader(headers, 'Authorization', `Bearer ${tokenToUse}`)
      safeSetHeader(headers, 'x-api-key', tokenToUse)
    }
    if (account && account !== 'auto') {
      const safeAccount = !isSafeHeaderString(account) ? encodeURI(account) : account
      safeSetHeader(headers, 'x-kuku-account', safeAccount)
    }
    if (session) {
      const safeSession = !isSafeHeaderString(session) ? encodeURI(session) : session
      safeSetHeader(headers, 'x-kuku-session', safeSession)
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...restPayload, stream: true }),
      signal,
    })

    const contentType = res.headers.get('content-type') || ''
    if (!res.ok || !contentType.includes('text/event-stream')) {
      const errText = await res.text()
      let errObj: Record<string, unknown> | null
      try {
        errObj = JSON.parse(errText)
      } catch {
        errObj = { message: errText }
      }
      const errRecord = (errObj?.error && typeof errObj.error === 'object') ? (errObj.error as Record<string, unknown>) : null
      const msg = (errRecord && typeof errRecord.message === 'string' ? errRecord.message : undefined) ||
                  (errObj && typeof errObj.message === 'string' ? errObj.message : undefined) ||
                  (res.ok ? '响应非事件流 (text/event-stream)' : `HTTP ${res.status}`)
      const type = (errRecord && typeof errRecord.type === 'string' ? errRecord.type : undefined) || 'error'
      const code = errRecord && typeof errRecord.code === 'string' ? errRecord.code : undefined
      throw new ApiError(res.status, msg, type, code)
    }

    const reader = res.body?.getReader()
    if (!reader) throw new Error('Response body is null')

    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let currentEvent = ''
    let hasStreamError = false
    let isStreamDone = false

    try {
      while (!hasStreamError) {
        const { done, value } = await reader.read()
        if (done) {
          isStreamDone = true
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) {
            currentEvent = ''
            continue
          }
          if (trimmed.startsWith('event:')) {
            currentEvent = trimmed.slice(6).trim()
            continue
          }
          if (trimmed.startsWith('data:')) {
            const rawData = trimmed.slice(5).trim()
            if (rawData === '[DONE]') continue
            try {
              const data = JSON.parse(rawData) as Record<string, unknown>
              if (data.error || currentEvent === 'error' || data.type === 'error') {
                hasStreamError = true
                callbacks.onError?.(data.error || data)
                break
              } else if (currentEvent === 'response.reasoning_summary_text.delta' || data.type === 'response.reasoning_summary_text.delta') {
                callbacks.onReasoningDelta?.((data.delta as string) ?? '')
              } else if (currentEvent === 'response.output_text.delta' || data.type === 'response.output_text.delta') {
                callbacks.onTextDelta?.((data.delta as string) ?? '')
              } else if (currentEvent === 'response.completed' || data.type === 'response.completed') {
                callbacks.onCompleted?.(data.response as ResponseItem)
              }
            } catch {
              // Ignore malformed intermediate chunks
            }
          }
        }
      }
    } finally {
      if (!isStreamDone) {
        reader.cancel().catch(() => {})
      }
      reader.releaseLock()
    }
  },

  // 5. Chat Completions API
  async createChatCompletion(payload: {
    model?: string
    messages: ChatCompletionMessage[]
    stream?: boolean
    /**
     * 思考强度档位（1|2|3|4，对应 GET /v1/models 的 think_list id）。
     * think_mode 是权威字段。
     */
    think_mode?: number
    kuku_meta?: boolean
    stream_options?: { include_usage?: boolean }
    account?: string
    session?: string
  }): Promise<ChatCompletionResponse> {
    const { account, session, ...rest } = payload
    const headers: Record<string, string> = {}
    if (account && account !== 'auto') {
      headers['x-kuku-account'] = account
    }
    if (session) {
      headers['x-kuku-session'] = session
    }
    return apiRequest<ChatCompletionResponse>('/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kuku_meta: true,
        stream_options: { include_usage: true },
        ...rest,
        stream: false,
      }),
    })
  },

  async streamChatCompletion(
    payload: {
      model?: string
      messages: ChatCompletionMessage[]
      /**
       * 思考强度档位（1|2|3|4，对应 GET /v1/models 的 think_list id）。
       * think_mode 是权威字段。
       */
      think_mode?: number
      kuku_meta?: boolean
      stream_options?: { include_usage?: boolean }
      account?: string
      session?: string
    },
    callbacks: {
      onReasoningDelta?: (delta: string) => void
      onTextDelta?: (delta: string) => void
      onCompleted?: (response: ChatCompletionResponse) => void
      onError?: (err: unknown) => void
    },
    signal?: AbortSignal
  ): Promise<void> {
    const { baseUrl, apiKey, adminToken } = getApiSettings()
    const cleanBase = baseUrl.replace(/\/+$/, '')
    const url = `${cleanBase}/v1/chat/completions`

    const { account, session, ...restPayload } = payload
    const headers = createSafeHeaders({
      'content-type': 'application/json; charset=utf-8',
    })
    if (adminToken) {
      safeSetHeader(headers, 'x-admin-token', adminToken)
    }
    const tokenToUse = apiKey || adminToken
    if (tokenToUse) {
      safeSetHeader(headers, 'Authorization', `Bearer ${tokenToUse}`)
      safeSetHeader(headers, 'x-api-key', tokenToUse)
    }
    if (account && account !== 'auto') {
      const safeAccount = !isSafeHeaderString(account) ? encodeURI(account) : account
      safeSetHeader(headers, 'x-kuku-account', safeAccount)
    }
    if (session) {
      const safeSession = !isSafeHeaderString(session) ? encodeURI(session) : session
      safeSetHeader(headers, 'x-kuku-session', safeSession)
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kuku_meta: true,
        stream_options: { include_usage: true },
        ...restPayload,
        stream: true,
      }),
      signal,
    })

    const contentType = res.headers.get('content-type') || ''
    if (!res.ok || !contentType.includes('text/event-stream')) {
      const errText = await res.text()
      let errObj: Record<string, unknown> | null
      try {
        errObj = JSON.parse(errText)
      } catch {
        errObj = { message: errText }
      }
      const errRecord = (errObj?.error && typeof errObj.error === 'object') ? (errObj.error as Record<string, unknown>) : null
      const msg = (errRecord && typeof errRecord.message === 'string' ? errRecord.message : undefined) ||
                  (errObj && typeof errObj.message === 'string' ? errObj.message : undefined) ||
                  (res.ok ? '响应非事件流 (text/event-stream)' : `HTTP ${res.status}`)
      const type = (errRecord && typeof errRecord.type === 'string' ? errRecord.type : undefined) || 'error'
      const code = errRecord && typeof errRecord.code === 'string' ? errRecord.code : undefined
      throw new ApiError(res.status, msg, type, code)
    }

    const reader = res.body?.getReader()
    if (!reader) throw new Error('Response body is null')

    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let fullText = ''
    let fullReasoning = ''
    let capturedKuku: ChatCompletionResponse['kuku'] | undefined
    let capturedUsage: ChatCompletionResponse['usage'] | undefined
    let capturedId = `chatcmpl-${Date.now()}`
    let capturedModel = payload.model || 'gateway-glm-5.3-flash'
    let hasStreamError = false
    let isStreamDone = false

    try {
      while (!hasStreamError) {
        const { done, value } = await reader.read()
        if (done) {
          isStreamDone = true
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          if (trimmed.startsWith('data:')) {
            const rawData = trimmed.slice(5).trim()
            if (rawData === '[DONE]') continue
            try {
              const data = JSON.parse(rawData) as Record<string, unknown>
              if (data.error) {
                hasStreamError = true
                callbacks.onError?.(data.error)
                break
              }
              if (data.id && typeof data.id === 'string') capturedId = data.id
              if (data.model && typeof data.model === 'string') capturedModel = data.model
              if (data.usage && typeof data.usage === 'object') {
                capturedUsage = data.usage as ChatCompletionResponse['usage']
              }
              if (data.kuku && typeof data.kuku === 'object') {
                capturedKuku = data.kuku as ChatCompletionResponse['kuku']
              }
              const choices = Array.isArray(data.choices) ? (data.choices as ChatCompletionChoice[]) : []
              if (choices.length > 0) {
                const delta = choices[0].delta
                if (delta?.reasoning_content) {
                  fullReasoning += delta.reasoning_content
                  callbacks.onReasoningDelta?.(delta.reasoning_content)
                }
                if (delta?.content) {
                  fullText += delta.content
                  callbacks.onTextDelta?.(delta.content)
                }
              }
            } catch {
              // Ignore malformed chunks
            }
          }
        }
      }

      if (!hasStreamError) {
        const finalResponse: ChatCompletionResponse = {
          id: capturedId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: capturedModel,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: fullText,
              },
              delta: {
                role: 'assistant',
                content: fullText,
                reasoning_content: fullReasoning,
              },
              finish_reason: 'stop',
            },
          ],
          usage: capturedUsage,
          kuku: capturedKuku,
        }
        callbacks.onCompleted?.(finalResponse)
      }
    } finally {
      if (!isStreamDone) {
        reader.cancel().catch(() => {})
      }
      reader.releaseLock()
    }
  },

  // 3.4 SQLite Token Stats
  async getTokenStats(params: TokenStatsParams = {}): Promise<TokenStatsResponse> {
    const sp = new URLSearchParams()
    if (params.from) sp.set('from', params.from)
    if (params.to) sp.set('to', params.to)
    if (params.model) sp.set('model', params.model)
    if (params.account) sp.set('account', params.account)
    if (params.source) sp.set('source', params.source)
    if (params.status) sp.set('status', params.status)
    if (params.group_by) sp.set('group_by', params.group_by)
    const qs = sp.toString()
    return apiRequest<TokenStatsResponse>(`/pool/admin/stats/tokens${qs ? `?${qs}` : ''}`, { method: 'GET' }, true)
  },

  // 3.5 SQLite Conversations
  async getConversations(params: ConversationsParams = {}): Promise<ConversationsListResponse> {
    const sp = new URLSearchParams()
    if (params.from) sp.set('from', params.from)
    if (params.to) sp.set('to', params.to)
    if (params.model) sp.set('model', params.model)
    if (params.account) sp.set('account', params.account)
    if (params.source) sp.set('source', params.source)
    if (params.status) sp.set('status', params.status)
    if (params.session_key) sp.set('session_key', params.session_key)
    if (params.limit !== undefined) sp.set('limit', String(params.limit))
    if (params.offset !== undefined) sp.set('offset', String(params.offset))
    const qs = sp.toString()
    return apiRequest<ConversationsListResponse>(`/pool/admin/conversations${qs ? `?${qs}` : ''}`, { method: 'GET' }, true)
  },

  async getConversationDetail(id: string): Promise<ConversationDetailResponse> {
    return apiRequest<ConversationDetailResponse>(`/pool/admin/conversations/${encodeURIComponent(id)}`, { method: 'GET' }, true)
  },

  // 3.6 SQLite Logs
  async getAdminLogs(params: LogsParams = {}): Promise<LogsListResponse> {
    const sp = new URLSearchParams()
    if (params.from) sp.set('from', params.from)
    if (params.to) sp.set('to', params.to)
    if (params.level) sp.set('level', params.level)
    if (params.kind) sp.set('kind', params.kind)
    if (params.limit !== undefined) sp.set('limit', String(params.limit))
    if (params.offset !== undefined) sp.set('offset', String(params.offset))
    const qs = sp.toString()
    return apiRequest<LogsListResponse>(`/pool/admin/logs${qs ? `?${qs}` : ''}`, { method: 'GET' }, true)
  },

  // 3.7 SQLite Settings
  async getServerSettings(): Promise<AdminSettingsResponse> {
    return apiRequest<AdminSettingsResponse>('/pool/admin/settings', { method: 'GET' }, true)
  },

  async patchServerSettings(payload: PatchSettingsPayload): Promise<AdminSettingsResponse> {
    return apiRequest<AdminSettingsResponse>(
      '/pool/admin/settings',
      {
        method: 'PATCH',
        body: JSON.stringify(payload),
      },
      true
    )
  },
}
