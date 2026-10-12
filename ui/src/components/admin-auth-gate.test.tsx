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

  it('prefills the current page backend and uses it for first-login verification', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ keys: [] }), { status: 200 }))
    const screen = await render(<AdminAuthGate />)
    await userEvent.click(screen.getByRole('button', { name: '服务端地址配置' }))
    await expect.element(screen.getByLabelText('服务端基准地址 (Base URL)')).toHaveValue(window.location.origin)
    await userEvent.fill(screen.getByPlaceholder('请输入后端 ADMIN_TOKEN 凭证'), 'test-admin')
    await userEvent.click(screen.getByRole('button', { name: '验证并进入控制台' }))
    expect(fetchSpy).toHaveBeenCalledWith(`${window.location.origin}/pool/admin/keys`, expect.anything())
    expect(JSON.parse(localStorage.getItem('kuku_api_settings') || '{}').baseUrl).toBe(window.location.origin)
  })

  it('shows invalid URL errors without sending credentials', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const screen = await render(<AdminAuthGate />)
    await userEvent.click(screen.getByRole('button', { name: '服务端地址配置' }))
    await userEvent.fill(screen.getByLabelText('服务端基准地址 (Base URL)'), 'ftp://example.com')
    await userEvent.fill(screen.getByPlaceholder('请输入后端 ADMIN_TOKEN 凭证'), 'test-admin')
    await userEvent.click(screen.getByRole('button', { name: '验证并进入控制台' }))
    await expect.element(screen.getByText(/后端地址必须使用 HTTP 或 HTTPS/)).toBeVisible()
    expect(fetchSpy).not.toHaveBeenCalled()
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
