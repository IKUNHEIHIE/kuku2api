import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { AdminAuthGate } from './admin-auth-gate'

describe('AdminAuthGate', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('renders the gate and disables submit when token is empty', async () => {
    const { getByText, getByRole, getByPlaceholder } = await render(
      <AdminAuthGate />
    )

    await expect.element(getByText('KuKu 运维控制台鉴权')).toBeInTheDocument()
    const submitBtn = getByRole('button', { name: /验证并进入控制台/i })
    await expect.element(submitBtn).toBeDisabled()

    const input = getByPlaceholder('请输入后端 ADMIN_TOKEN 凭证')
    await expect.element(input).toBeInTheDocument()
  })

  it('verifies token successfully and invokes onAuthenticated', async () => {
    const onAuthMock = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ open: true, keys: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )

    const { getByRole, getByPlaceholder } = await render(
      <AdminAuthGate onAuthenticated={onAuthMock} />
    )

    const input = getByPlaceholder('请输入后端 ADMIN_TOKEN 凭证')
    await userEvent.fill(input, 'my-secret-admin-token')

    const submitBtn = getByRole('button', { name: /验证并进入控制台/i })
    await expect.element(submitBtn).not.toBeDisabled()

    await userEvent.click(submitBtn)

    expect(onAuthMock).toHaveBeenCalledOnce()
    const stored = JSON.parse(localStorage.getItem('kuku_api_settings') || '{}')
    expect(stored.adminToken).toBe('my-secret-admin-token')
  })

  it('displays error alert when verification fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: 'admin token required' },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      )
    )

    const { getByRole, getByPlaceholder, getByText } = await render(
      <AdminAuthGate />
    )

    const input = getByPlaceholder('请输入后端 ADMIN_TOKEN 凭证')
    await userEvent.fill(input, 'bad-token')

    const submitBtn = getByRole('button', { name: /验证并进入控制台/i })
    await userEvent.click(submitBtn)

    await expect.element(getByText('admin token required')).toBeInTheDocument()
  })
})
