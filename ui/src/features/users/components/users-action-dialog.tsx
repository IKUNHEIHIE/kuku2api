'use client'

import { useEffect, useRef } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import {
  QrCode,
  Smartphone,
  KeyRound,
  Globe2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { type Account, kukuApi } from '@/lib/kuku-api'
import { useUsers } from './users-provider'
import { AddAccountQr } from './add-account-qr'
import { AddAccountSms } from './add-account-sms'
import { AddAccountScnet } from './add-account-scnet'
import { AddAccountScnetPassword } from './add-account-scnet-password'

const accountFormSchema = z.object({
  id: z.string().min(1, '请输入账号 ID (如 kuku-1)'),
  alias: z.string(),
  priority: z.number().min(0, '优先级不能小于 0'),
  bduss: z.string(),
  token: z.string(),
  disabled: z.boolean(),
})

type AccountFormValues = z.infer<typeof accountFormSchema>

type UsersActionDialogProps = {
  currentRow?: Account | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function UsersActionDialog({
  currentRow,
  open,
  onOpenChange,
}: UsersActionDialogProps) {
  const isEdit = Boolean(currentRow)
  const { refreshAccounts, accounts, runHealthCheck, addTab, setAddTab } = useUsers()

  const defaultPriority = isEdit
    ? currentRow?.priority ?? 0
    : accounts.length > 0
      ? Math.max(...accounts.map((a) => a.priority)) + 1
      : 0

  const form = useForm<AccountFormValues>({
    resolver: zodResolver(accountFormSchema),
    defaultValues: {
      id: currentRow?.id ?? '',
      alias: currentRow?.alias ?? '',
      priority: defaultPriority,
      bduss: '',
      token: '',
      disabled: currentRow?.disabled ?? false,
    },
  })

  const initialized = useRef<string | null>(null)
  useEffect(() => {
    if (!open) { initialized.current = null; return }
    const key = JSON.stringify([Boolean(currentRow), currentRow?.id])
    if (initialized.current !== key) {
      initialized.current = key
      form.reset({
        id: currentRow?.id ?? '',
        alias: currentRow?.alias ?? '',
        priority: currentRow?.priority ?? (accounts.length > 0 ? Math.max(...accounts.map((a) => a.priority)) + 1 : 0),
        bduss: '',
        token: '',
        disabled: currentRow?.disabled ?? false,
      })
    }
  }, [open, currentRow, accounts, form])

  const onSubmit = async (values: AccountFormValues) => {
    if (!isEdit || !currentRow) return
    try {
      const trimmedAlias = values.alias?.trim()
      const updates: {
        alias?: string
        priority?: number
        disabled?: boolean
        bduss?: string
        stoken?: string
      } = {
        alias: trimmedAlias || currentRow.alias || values.id,
        priority: values.priority,
        disabled: values.disabled,
      }
      const trimmedBduss = values.bduss?.trim()
      const trimmedToken = values.token?.trim()

      if (values.bduss.length > 0 && !trimmedBduss) {
        toast.error('换绑 BDUSS 凭据不能全为空白字符')
        return
      }
      if (values.token.length > 0 && !trimmedToken) {
        toast.error('换绑凭据不能全为空白字符')
        return
      }

      if (trimmedBduss) updates.bduss = trimmedBduss
      if (trimmedToken) updates.stoken = trimmedToken

      await kukuApi.updateAccount(currentRow.id, updates)
      if (trimmedBduss || trimmedToken) {
        toast.success(`账号 ${currentRow.id} 更新成功，新凭据已生效并重置冷却，正在执行上游体检...`)
        try {
          await runHealthCheck(currentRow.id)
        } catch {
          // Handled
        }
      } else {
        toast.success(`账号 ${currentRow.id} 更新成功`)
      }

      // Security: Clear credentials from state immediately
      form.setValue('bduss', '')
      form.setValue('token', '')

      await refreshAccounts()
      onOpenChange(false)
    } catch (err: unknown) {
      toast.error('操作失败: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(state) => {
        if (!state) {
          form.setValue('bduss', '')
          form.setValue('token', '')
        }
        onOpenChange(state)
      }}
    >
      <DialogContent className='sm:max-w-xl max-h-[90vh] overflow-y-auto'>
        <DialogHeader className='text-start'>
          <DialogTitle>{isEdit ? `配置账号: ${currentRow?.id ?? ''}` : '添加上游账号'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? '修改账号的别名、调度优先级、停用状态或换绑新凭据（换绑后自动清空失效标记与冷却）。'
              : '先选择平台：百度账号支持 App 扫码或手机验证码；超算互联网（SCNet）支持验证码或账密登录，仅反代免费模型 SCNet-Max。'}
          </DialogDescription>
        </DialogHeader>

        {isEdit ? (
          /* Edit Form */
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className='space-y-4'>
              <FormField
                control={form.control}
                name='id'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>账号 ID</FormLabel>
                    <FormControl>
                      <Input
                        placeholder='例如: kuku-1'
                        disabled
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      系统内的账号唯一标识，添加后不可修改。
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className='grid grid-cols-2 gap-3'>
                <FormField
                  control={form.control}
                  name='alias'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>别名 / 备注</FormLabel>
                      <FormControl>
                        <Input placeholder='例如: 备用号-1' {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name='priority'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>优先级 (越小越优先)</FormLabel>
                      <FormControl>
                        <Input
                          type='number'
                          min={0}
                          value={field.value}
                          onChange={(e) => field.onChange(Number(e.target.value))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Edit Credential Rotation Box */}
              <div className='space-y-3 rounded-lg border border-dashed p-3 bg-muted/20'>
                <div className='flex items-center justify-between'>
                  <div className='text-xs font-semibold'>凭据换绑 / 轮转 (可选)</div>
                  {currentRow?.auth_dead ? (
                    <Badge variant='destructive' className='text-[10px]'>
                      当前登录失效 (Auth Dead)
                    </Badge>
                  ) : (
                    <span className='text-[11px] text-muted-foreground'>留空保持原值</span>
                  )}
                </div>

                <FormField
                  control={form.control}
                  name='bduss'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className='text-xs'>换绑 BDUSS (可选)</FormLabel>
                      <FormControl>
                        <Input
                          type='password'
                          placeholder='留空表示保持当前凭据不变 (约 192 字符)'
                          autoComplete='off'
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name='token'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className='text-xs'>
                        换绑 STOKEN (可选)
                      </FormLabel>
                      <FormControl>
                        <Input
                          type='password'
                          placeholder='留空保持不变 (约 64 字符)'
                          autoComplete='off'
                          {...field}
                        />
                      </FormControl>
                      <FormDescription className='text-[11px]'>
                        更新有效凭据后会清除失效标记。要为旧账号启用自动续期，可重新扫码或短信登录同一账号，系统会更新原账号，不会重复添加。
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name='disabled'
                render={({ field }) => (
                  <FormItem className='flex items-center justify-between rounded-lg border p-3 shadow-xs'>
                    <div className='space-y-0.5'>
                      <FormLabel>是否停用该账号</FormLabel>
                      <FormDescription className='text-xs'>
                        停用后该账号将暂时不参与任何调度与请求。
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <DialogFooter className='gap-y-2'>
                <Button
                  type='button'
                  variant='outline'
                  onClick={() => onOpenChange(false)}
                >
                  取消
                </Button>
                <Button type='submit'>
                  保存更改
                </Button>
              </DialogFooter>
            </form>
          </Form>
        ) : (
          /* Add: two-level navigation — pick a platform, then a login method */
          <Tabs
            value={addTab.startsWith('scnet') ? 'scnet' : 'baidu'}
            onValueChange={(platform) => setAddTab(platform === 'scnet' ? 'scnet-sms' : 'qr')}
            className='w-full'
          >
            <TabsList className='grid w-full grid-cols-2 mb-3'>
              <TabsTrigger value='baidu' className='gap-1.5 text-sm'>
                <Smartphone size={15} />
                <span>百度账号</span>
              </TabsTrigger>
              <TabsTrigger value='scnet' className='gap-1.5 text-sm'>
                <Globe2 size={15} />
                <span>超算互联网</span>
              </TabsTrigger>
            </TabsList>

            {/* 百度账号：App 扫码 / 手机验证码 */}
            <TabsContent value='baidu' forceMount className='data-[state=inactive]:hidden'>
              <Tabs value={addTab} onValueChange={(val) => setAddTab(val as 'qr' | 'sms')} className='w-full'>
                <TabsList className='grid w-full grid-cols-2 mb-2'>
                  <TabsTrigger value='qr' className='gap-1.5 text-xs'>
                    <QrCode size={14} />
                    <span>App 扫码</span>
                  </TabsTrigger>
                  <TabsTrigger value='sms' className='gap-1.5 text-xs'>
                    <Smartphone size={14} />
                    <span>手机验证码</span>
                  </TabsTrigger>
                </TabsList>
                <TabsContent value='qr' forceMount className='data-[state=inactive]:hidden'>
                  <AddAccountQr onSuccess={() => onOpenChange(false)} />
                </TabsContent>
                <TabsContent value='sms' forceMount className='data-[state=inactive]:hidden'>
                  <AddAccountSms
                    onSuccess={() => onOpenChange(false)}
                    onSwitchToQr={() => setAddTab('qr')}
                  />
                </TabsContent>
              </Tabs>
            </TabsContent>

            {/* 超算互联网：验证码登录 / 账密登录 */}
            <TabsContent value='scnet' forceMount className='data-[state=inactive]:hidden'>
              <Tabs value={addTab} onValueChange={(val) => setAddTab(val as 'scnet-sms' | 'scnet-password')} className='w-full'>
                <TabsList className='grid w-full grid-cols-2 mb-2'>
                  <TabsTrigger value='scnet-sms' className='gap-1.5 text-xs'>
                    <Smartphone size={14} />
                    <span>验证码登录</span>
                  </TabsTrigger>
                  <TabsTrigger value='scnet-password' className='gap-1.5 text-xs'>
                    <KeyRound size={14} />
                    <span>账密登录</span>
                  </TabsTrigger>
                </TabsList>
                <TabsContent value='scnet-sms' forceMount className='data-[state=inactive]:hidden'>
                  <AddAccountScnet onSuccess={() => onOpenChange(false)} />
                </TabsContent>
                <TabsContent value='scnet-password' forceMount className='data-[state=inactive]:hidden'>
                  <AddAccountScnetPassword onSuccess={() => onOpenChange(false)} />
                </TabsContent>
              </Tabs>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  )
}
