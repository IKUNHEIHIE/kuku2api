import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { Account } from '@/lib/kuku-api'
import { UsersDeleteDialog } from './users-delete-dialog'
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

describe('UsersDeleteDialog', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders confirmation dialog with account id', async () => {
    const { getByText } = await render(
      <UsersProvider>
        <UsersDeleteDialog open onOpenChange={vi.fn()} currentRow={MOCK_ACCOUNT} />
      </UsersProvider>
    )

    await expect.element(getByText(/删除账号 kuku-0/i)).toBeInTheDocument()
  })
})
