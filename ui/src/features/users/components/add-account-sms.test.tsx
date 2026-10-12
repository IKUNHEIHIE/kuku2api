import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { kukuApi } from '@/lib/kuku-api'
import { AddAccountSms } from './add-account-sms'

const { refreshAccounts, setAddTab } = vi.hoisted(() => ({
  refreshAccounts: vi.fn(),
  setAddTab: vi.fn(),
}))
vi.mock('./users-provider', () => ({
  useUsers: () => ({ accounts: [], refreshAccounts, setAddTab }),
}))
vi.mock('@/lib/kuku-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/kuku-api')>()
  return {
    ...actual,
    kukuApi: {
      ...actual.kukuApi,
      startLoginSms: vi.fn(),
      resendLoginSms: vi.fn(),
      verifyLoginSms: vi.fn(),
      getAdminBlobUrl: vi.fn(),
    },
  }
})

const sent = {
  state: 'sent' as const,
  login_id: 'ls-fixture',
  expires_in_ms: 600000,
  retry_after_ms: 60000,
  sends_remaining: 4,
}
async function start() {
  const screen = await render(<AddAccountSms />)
  await userEvent.fill(screen.getByLabelText('手机号码 (必填)'), '13800000000')
  await userEvent.click(
    screen.getByRole('button', { name: '发送验证码', exact: true })
  )
  return screen
}

describe('SMS account login', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(kukuApi.startLoginSms).mockResolvedValue(sent)
    vi.mocked(kukuApi.getAdminBlobUrl).mockResolvedValue('blob:fixture-image')
  })

  it('requires exactly six digits and adds the account once without an extra metadata request', async () => {
    vi.mocked(kukuApi.verifyLoginSms).mockResolvedValue({
      state: 'added',
      account_id: 'fixture-account',
    })
    const screen = await start()
    const submit = screen.getByRole('button', { name: '提交并登录入池' })
    await userEvent.fill(screen.getByLabelText('短信验证码 (6位数字)'), '1234')
    await expect.element(submit).toBeDisabled()
    await userEvent.fill(
      screen.getByLabelText('短信验证码 (6位数字)'),
      '123456'
    )
    await userEvent.click(submit)
    await expect.element(screen.getByText('短信加号成功！')).toBeVisible()
    expect(kukuApi.verifyLoginSms).toHaveBeenCalledExactlyOnceWith({
      login_id: 'ls-fixture',
      code: '123456',
    })
    expect(refreshAccounts).toHaveBeenCalledOnce()
  })

  it('solves the send captcha using only the entered code, keeping challenge IDs on the backend', async () => {
    vi.mocked(kukuApi.startLoginSms).mockResolvedValue({
      state: 'captcha_required',
      login_id: 'ls-fixture',
      captcha_path: '/fixture-captcha',
      captcha_stage: 'send',
      expires_in_ms: 600000,
      sends_remaining: 5,
    })
    vi.mocked(kukuApi.resendLoginSms).mockResolvedValue(sent)
    const screen = await start()
    await userEvent.fill(
      screen.getByLabelText('输入图形验证码中的字符'),
      'ABCD'
    )
    await userEvent.click(
      screen.getByRole('button', { name: '确认并发送短信' })
    )
    expect(kukuApi.resendLoginSms).toHaveBeenCalledExactlyOnceWith({
      login_id: 'ls-fixture',
      captcha: { code: 'ABCD' },
    })
    await expect
      .element(screen.getByLabelText('短信验证码 (6位数字)'))
      .toBeVisible()
  })

  it('submits a login captcha with the original SMS code without sending another SMS', async () => {
    vi.mocked(kukuApi.verifyLoginSms)
      .mockResolvedValueOnce({
        state: 'captcha_required',
        captcha_stage: 'verify',
        captcha_path: '/fixture-captcha',
        slide: false,
      })
      .mockResolvedValueOnce({ state: 'added', account_id: 'fixture-account' })
    const screen = await start()
    await userEvent.fill(
      screen.getByLabelText('短信验证码 (6位数字)'),
      '123456'
    )
    await userEvent.click(
      screen.getByRole('button', { name: '提交并登录入池' })
    )
    await userEvent.fill(
      screen.getByLabelText('输入图形验证码中的字符'),
      'ABCD'
    )
    await userEvent.click(
      screen.getByRole('button', { name: '确认并完成登录' })
    )
    expect(kukuApi.verifyLoginSms).toHaveBeenLastCalledWith({
      login_id: 'ls-fixture',
      code: '123456',
      captcha: { code: 'ABCD' },
    })
    expect(kukuApi.resendLoginSms).not.toHaveBeenCalled()
    await expect.element(screen.getByText('短信加号成功！')).toBeVisible()
  })

  it('resets the old session when changing phone and displays terminal duplicate-account failures', async () => {
    vi.mocked(kukuApi.verifyLoginSms).mockResolvedValue({
      state: 'failed',
      code: 'account_already_exists',
      reason: '该账号已存在于号池',
    })
    const screen = await start()
    await userEvent.click(screen.getByRole('button', { name: '更换手机号' }))
    await userEvent.fill(
      screen.getByLabelText('手机号码 (必填)'),
      '13900000000'
    )
    await userEvent.click(
      screen.getByRole('button', { name: '发送验证码', exact: true })
    )
    expect(kukuApi.startLoginSms).toHaveBeenLastCalledWith(
      expect.objectContaining({ phone: '13900000000' })
    )
    await userEvent.fill(
      screen.getByLabelText('短信验证码 (6位数字)'),
      '123456'
    )
    await userEvent.click(
      screen.getByRole('button', { name: '提交并登录入池' })
    )
    await expect.element(screen.getByText('该账号已存在于号池')).toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: '返回重新登录' }))
      .toBeVisible()
  })

  it('shows image-loading errors and lets the user refresh instead of spinning indefinitely', async () => {
    vi.mocked(kukuApi.startLoginSms).mockResolvedValue({
      state: 'captcha_required',
      login_id: 'ls-fixture',
      captcha_path: '/fixture-captcha',
      captcha_stage: 'send',
    })
    vi.mocked(kukuApi.getAdminBlobUrl)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('blob:fixture-image')
    const screen = await start()
    await expect
      .element(screen.getByText('图形验证码加载失败，请点击刷新重试'))
      .toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '刷新图形码' }))
    await expect
      .element(screen.getByText('图形验证码加载失败，请点击刷新重试'))
      .not.toBeInTheDocument()
    expect(kukuApi.getAdminBlobUrl).toHaveBeenCalledTimes(2)
  })

  it('blocks expired sessions and offers a fresh attempt without automatically sending SMS', async () => {
    vi.mocked(kukuApi.startLoginSms).mockResolvedValue({
      ...sent,
      expires_in_ms: 0,
    })
    const screen = await start()
    await expect.element(screen.getByText('短信会话已过期')).toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: '提交并登录入池' }))
      .toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '重新发起登录' }))
    await expect
      .element(screen.getByRole('button', { name: '发送验证码', exact: true }))
      .toBeVisible()
    expect(kukuApi.startLoginSms).toHaveBeenCalledOnce()
  })

  it('offers QR login for slider verification without trying to resend SMS', async () => {
    vi.mocked(kukuApi.verifyLoginSms).mockResolvedValue({
      state: 'captcha_required',
      captcha_stage: 'verify',
      slide: true,
    })
    const screen = await start()
    await userEvent.fill(
      screen.getByLabelText('短信验证码 (6位数字)'),
      '123456'
    )
    await userEvent.click(
      screen.getByRole('button', { name: '提交并登录入池' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: '改用百度App扫码登录' })
    )
    expect(setAddTab).toHaveBeenCalledWith('qr')
    expect(kukuApi.resendLoginSms).not.toHaveBeenCalled()
  })

  it('normalizes pasted phone numbers and displays diagnostic advice when upstream rejects with format error', async () => {
    vi.mocked(kukuApi.startLoginSms).mockResolvedValue({
      state: 'refused',
      login_id: 'ls-fixture',
      message: '手机号格式错误',
    })
    const onSwitch = vi.fn()
    const screen = await render(<AddAccountSms onSwitchToQr={onSwitch} />)

    // Fill with formatted +86 string
    await userEvent.fill(
      screen.getByLabelText('手机号码 (必填)'),
      '+86 138 0000 0000'
    )
    await expect.element(screen.getByText('✓ 格式有效')).toBeVisible()

    await userEvent.click(
      screen.getByRole('button', { name: '发送验证码', exact: true })
    )

    expect(kukuApi.startLoginSms).toHaveBeenCalledWith(
      expect.objectContaining({ phone: '13800000000' })
    )

    // Explains upstream issue clearly
    await expect
      .element(screen.getByText(/上游百度登录接口拒绝：提示“手机号格式错误”/))
      .toBeVisible()

    // Can switch to QR
    const switchBtn = screen.getByRole('button', {
      name: '切换到百度App扫码登录',
    })
    await expect.element(switchBtn).toBeVisible()
    await userEvent.click(switchBtn)
    expect(onSwitch).toHaveBeenCalledOnce()
  })
})

