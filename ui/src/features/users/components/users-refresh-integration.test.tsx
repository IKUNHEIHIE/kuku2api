import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { kukuApi, type Account, type PoolState } from '@/lib/kuku-api'
import { TokenRefreshPanel } from './token-refresh-panel'
import { UsersActionDialog } from './users-action-dialog'
import { UsersProvider, useUsers } from './users-provider'

vi.mock('@/lib/kuku-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/kuku-api')>()
  return {
    ...actual,
    kukuApi: {
      ...actual.kukuApi,
      getPoolState: vi.fn(),
      getPoolPoints: vi.fn(),
      getTokenRefresh: vi.fn(),
      deleteAccount: vi.fn(),
    },
  }
})
const account: Account = {
  id: 'fixture',
  alias: 'original',
  priority: 0,
  disabled: false,
  auth_dead: false,
  cooldown_remaining_ms: 0,
  has_credential: true,
}
const state: PoolState = {
  accounts: [account],
  sessions: 0,
  admin_enabled: true,
}
let context: ReturnType<typeof useUsers>
function Snapshot() {
  context = useUsers()
  return (
    <p data-testid='account-snapshot'>
      {context.accounts.map((a) => a.alias).join(',') || 'empty'}
    </p>
  )
}

describe('credential polling with real account management components', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(kukuApi.getPoolState).mockResolvedValue(state)
    vi.mocked(kukuApi.getPoolPoints).mockResolvedValue({
      checked_at: 'fixture',
      accounts: [],
      total_balance_points: 0,
    })
    vi.mocked(kukuApi.getTokenRefresh).mockResolvedValue({
      ok: true,
      token_refresh: {
        enabled: true,
        interval_hours: 6,
        running: false,
        last_run_at: null,
        next_run_at: null,
        last_result: null,
      },
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('preserves unsaved alias and credentials when a real panel poll replaces the account array', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const screen = await render(
      <UsersProvider>
        <TokenRefreshPanel />
        <UsersActionDialog open currentRow={account} onOpenChange={vi.fn()} />
      </UsersProvider>
    )
    await expect
      .poll(() => timers.mock.calls.filter((call) => call[1] === 15000).length)
      .toBe(1)
    await userEvent.fill(screen.getByLabelText('别名 / 备注'), 'unsaved-alias')
    await userEvent.fill(
      screen.getByLabelText('换绑 BDUSS (可选)'),
      'synthetic-cookie'
    )
    await userEvent.fill(
      screen.getByLabelText('换绑 STOKEN (可选)'),
      'synthetic-token'
    )
    const before = vi.mocked(kukuApi.getPoolState).mock.calls.length
    const callback = timers.mock.calls.find((call) => call[1] === 15000)?.[0]
    if (typeof callback !== 'function') throw Error('Poll callback missing')
    callback()
    await expect
      .poll(() => vi.mocked(kukuApi.getPoolState).mock.calls.length)
      .toBe(before + 1)
    await expect
      .poll(() => timers.mock.calls.filter((call) => call[1] === 15000).length)
      .toBe(2)
    await expect
      .element(screen.getByLabelText('别名 / 备注'))
      .toHaveValue('unsaved-alias')
    await expect
      .element(screen.getByLabelText('换绑 BDUSS (可选)'))
      .toHaveValue('synthetic-cookie')
    await expect
      .element(screen.getByLabelText('换绑 STOKEN (可选)'))
      .toHaveValue('synthetic-token')
  })

  it('does not overwrite a newer refresh with an old polling response', async () => {
    const screen = await render(
      <UsersProvider>
        <Snapshot />
      </UsersProvider>
    )
    await expect
      .element(screen.getByTestId('account-snapshot'))
      .toHaveTextContent('original')
    let resolve!: (value: PoolState) => void
    vi.mocked(kukuApi.getPoolState).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    const old = context.refreshAccountStatus()
    vi.mocked(kukuApi.getPoolState).mockResolvedValueOnce({
      ...state,
      accounts: [{ ...account, alias: 'updated' }],
    })
    await context.refreshAccounts()
    resolve(state)
    await old
    await expect
      .element(screen.getByTestId('account-snapshot'))
      .toHaveTextContent('updated')
  })

  it('does not restore a deleted row from an earlier poll', async () => {
    const screen = await render(
      <UsersProvider>
        <Snapshot />
      </UsersProvider>
    )
    await expect
      .element(screen.getByTestId('account-snapshot'))
      .toHaveTextContent('original')
    let resolve!: (value: PoolState) => void
    vi.mocked(kukuApi.getPoolState).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    const old = context.refreshAccountStatus()
    vi.mocked(kukuApi.deleteAccount).mockResolvedValue({
      ok: true,
      accounts: [],
      gap: false,
    })
    await context.deleteAccount(account.id)
    resolve(state)
    await old
    await expect
      .element(screen.getByTestId('account-snapshot'))
      .toHaveTextContent('empty')
  })
})
