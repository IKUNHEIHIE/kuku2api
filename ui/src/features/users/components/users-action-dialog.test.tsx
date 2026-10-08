import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { Account } from '@/lib/kuku-api'
import { UsersActionDialog } from './users-action-dialog'
import { UsersProvider } from './users-provider'

const MOCK_ACCOUNT: Account = {
  id: 'kuku-0',
  alias: '主号',
  priority: 0,
  disabled: false,
  auth_dead: false,
  cooldown_remaining_ms: 0,
  has_credential: true,
}

describe('UsersActionDialog', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders add dialog with title and fields', async () => {
    const { getByRole, getByText } = await render(
      <UsersProvider>
        <UsersActionDialog open onOpenChange={vi.fn()} />
      </UsersProvider>
    )

    const title = getByRole('heading', {
      level: 2,
      name: /添加上游百度账号/i,
    })
    await expect.element(title).toBeInTheDocument()
    await expect.element(getByText(/账号唯一标识/i)).toBeInTheDocument()
  })

  it('renders edit dialog when currentRow is provided', async () => {
    const { getByRole } = await render(
      <UsersProvider>
        <UsersActionDialog open onOpenChange={vi.fn()} currentRow={MOCK_ACCOUNT} />
      </UsersProvider>
    )

    const title = getByRole('heading', {
      level: 2,
      name: /配置账号: kuku-0/i,
    })
    await expect.element(title).toBeInTheDocument()
  })
})
