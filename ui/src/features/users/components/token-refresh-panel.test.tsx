import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { kukuApi, type TokenRefreshState, type PoolCooldown } from '@/lib/kuku-api'
import { TokenRefreshPanel } from './token-refresh-panel'

const context = vi.hoisted(() => ({
  adminEnabled: true,
  refreshAccountStatus: vi.fn(),
  upstreamCooldowns: [] as PoolCooldown[],
}))
vi.mock('./users-provider', () => ({ useUsers: () => context }))
vi.mock('@/lib/kuku-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/kuku-api')>()
  return {
    ...actual,
    kukuApi: {
      ...actual.kukuApi,
      getTokenRefresh: vi.fn(),
      configureTokenRefresh: vi.fn(),
      refreshAccountTokens: vi.fn(),
    },
  }
})
const state: TokenRefreshState = {
  enabled: true,
  interval_hours: 6,
  running: false,
  last_run_at: null,
  next_run_at: null,
  last_result: null,
}

describe('account credential renewal controls', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetAllMocks()
    context.adminEnabled = true
    context.upstreamCooldowns = []
    context.refreshAccountStatus.mockResolvedValue(undefined)
    vi.mocked(kukuApi.getTokenRefresh).mockResolvedValue({
      ok: true,
      token_refresh: state,
    })
  })

  it('shows a model-specific shared failure and the suggested retry time', async () => {
    context.upstreamCooldowns = [{ scope: 'model', model: 'fixture-model', reason: '上游模型生成暂时失败', retry_after_ms: 10000, recovering: false }]
    const screen = await render(<TokenRefreshPanel />)
    await expect.element(screen.getByRole('status')).toHaveTextContent('模型 fixture-model：上游模型生成暂时失败，约 10 秒后重试')
  })

  it('loads saved settings, toggles scheduling and manually refreshes accounts without model calls', async () => {
    vi.mocked(kukuApi.configureTokenRefresh).mockResolvedValue({
      ok: true,
      token_refresh: { ...state, enabled: false },
    })
    vi.mocked(kukuApi.refreshAccountTokens).mockResolvedValue({
      ok: true,
      result: {
        accounts: [
          {
            id: 'one',
            ok: true,
            refreshed: true,
            status: 'valid',
            message: '',
          },
        ],
        took_ms: 12,
      },
    })
    const screen = await render(<TokenRefreshPanel />)
    const checkbox = screen.getByRole('checkbox', { name: '定时刷新' })
    await expect.element(checkbox).toBeChecked()
    await userEvent.click(checkbox)
    await expect.element(checkbox).not.toBeChecked()
    expect(kukuApi.configureTokenRefresh).toHaveBeenCalledExactlyOnceWith({
      enabled: false,
    })
    await userEvent.click(screen.getByRole('button', { name: '立即刷新全部' }))
    await expect
      .poll(() => context.refreshAccountStatus.mock.calls.length)
      .toBe(2)
    expect(kukuApi.refreshAccountTokens).toHaveBeenCalledExactlyOnceWith()
    await expect
      .element(screen.getByText('缺少 PTOKEN', { exact: false }))
      .toBeVisible()
  })

  it('disables submissions while the backend batch is running', async () => {
    vi.mocked(kukuApi.getTokenRefresh).mockResolvedValue({
      ok: true,
      token_refresh: { ...state, running: true },
    })
    const screen = await render(<TokenRefreshPanel />)
    await expect
      .element(screen.getByRole('button', { name: '正在依次刷新…' }))
      .toBeDisabled()
    expect(kukuApi.refreshAccountTokens).not.toHaveBeenCalled()
  })

  it('does not schedule more polls after unmounting an unresolved request', async () => {
    let resolve!: (value: {
      ok: boolean
      token_refresh: TokenRefreshState
    }) => void
    vi.mocked(kukuApi.getTokenRefresh).mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const screen = await render(<TokenRefreshPanel />)
    await screen.unmount()
    resolve({ ok: true, token_refresh: state })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(timers.mock.calls.filter((call) => call[1] === 15_000)).toHaveLength(
      0
    )
    timers.mockRestore()
  })

  it('hides administrator controls and avoids requests without admin access', async () => {
    context.adminEnabled = false
    const screen = await render(<TokenRefreshPanel />)
    await expect
      .element(screen.getByRole('region', { name: '账号 Token 自动续期' }))
      .not.toBeInTheDocument()
    expect(kukuApi.getTokenRefresh).not.toHaveBeenCalled()
  })
})
