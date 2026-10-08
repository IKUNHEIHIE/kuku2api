'use client'

import { useEffect } from 'react'
import { z } from 'zod'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import {
  QrCode,
  Smartphone,
  KeyRound,
  Info,
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
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { type Account, kukuApi } from '@/lib/kuku-api'
import { useUsers } from './users-provider'
import { AddAccountQr } from './add-account-qr'
import { AddAccountSms } from './add-account-sms'

const accountFormSchema = z.object({
  id: z.string().min(1, '请输入账号 ID (如 kuku-1)'),
  alias: z.string(),
  priority: z.number().min(0, '优先级不能小于 0'),
  bduss: z.string(),
  tokenType: z.enum(['stoken', 'ptoken']),
  token: z.string(),
  device_id: z.string(),
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
      tokenType: 'stoken',
      token: '',
      device_id: '',
      disabled: currentRow?.disabled ?? false,
    },
  })

  useEffect(() => {
    if (open) {
      form.reset({
        id: currentRow?.id ?? '',
        alias: currentRow?.alias ?? '',
        priority: currentRow?.priority ?? (accounts.length > 0 ? Math.max(...accounts.map((a) => a.priority)) + 1 : 0),
        bduss: '',
        tokenType: 'stoken',
        token: '',
        device_id: '',
        disabled: currentRow?.disabled ?? false,
      })
    }
  }, [open, currentRow, accounts, form])

  const onSubmit = async (values: AccountFormValues) => {
    try {
      if (isEdit && currentRow) {
        const trimmedAlias = values.alias?.trim()
        const updates: {
          alias?: string
          priority?: number
          disabled?: boolean
          bduss?: string
          stoken?: string
          ptoken?: string
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
      } else {
        const trimmedBduss = values.bduss?.trim()
        const trimmedToken = values.token?.trim()

        if (!trimmedBduss || !trimmedToken) {
          toast.error(`添加账号必须提供非空的 BDUSS 与 ${values.tokenType === 'stoken' ? 'STOKEN' : 'PTOKEN'} 凭据`)
          return
        }

        const addRes = await kukuApi.addAccount({
          id: values.id.trim(),
          alias: values.alias?.trim() || values.id.trim(),
          priority: values.priority,
          bduss: trimmedBduss,
          stoken: values.tokenType === 'stoken' ? trimmedToken : undefined,
          ptoken: values.tokenType === 'ptoken' ? trimmedToken : undefined,
          disabled: values.disabled,
          device_id: values.device_id?.trim() || undefined,
        })

        if (addRes.minted_stoken) {
          toast.success(`账号 ${values.id.trim()} 添加成功（已自动向百度换取 STOKEN 并验证可用）`)
        } else {
          toast.success(`账号 ${values.id.trim()} 添加成功`)
        }
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

  const selectedTokenType = useWatch({
    control: form.control,
    name: 'tokenType',
  })

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
          <DialogTitle>{isEdit ? `配置账号: ${currentRow?.id ?? ''}` : '添加上游百度账号'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? '修改账号的别名、调度优先级、停用状态或换绑新凭据（换绑后自动清空失效标记与冷却）。'
              : '支持通过百度App扫码、手机验证码，或手动录入 BDUSS+STOKEN/PTOKEN 凭据添加账号。'}
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
                        PATCH 改号仅支持直接轮转 STOKEN，更新有效凭据后会自动清除失效标记与冷却时间（若需以 PTOKEN 换票，请使用扫码/短信重新加号）。
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
          /* Add Tabs: QR Scan / SMS Code / Manual Entry */
          <Tabs value={addTab} onValueChange={(val) => setAddTab(val as 'qr' | 'sms' | 'manual')} className='w-full'>
            <TabsList className='grid w-full grid-cols-3 mb-2'>
              <TabsTrigger value='qr' className='gap-1.5 text-xs'>
                <QrCode size={14} />
                <span>百度App 扫码</span>
              </TabsTrigger>
              <TabsTrigger value='sms' className='gap-1.5 text-xs'>
                <Smartphone size={14} />
                <span>手机验证码</span>
              </TabsTrigger>
              <TabsTrigger value='manual' className='gap-1.5 text-xs'>
                <KeyRound size={14} />
                <span>手动录入凭据</span>
              </TabsTrigger>
            </TabsList>

            {/* QR Scan Tab */}
            <TabsContent value='qr' forceMount className='data-[state=inactive]:hidden'>
              <AddAccountQr onSuccess={() => onOpenChange(false)} />
            </TabsContent>

            {/* SMS Code Tab */}
            <TabsContent value='sms' forceMount className='data-[state=inactive]:hidden'>
              <AddAccountSms onSuccess={() => onOpenChange(false)} />
            </TabsContent>

            {/* Manual Entry Tab */}
            <TabsContent value='manual' forceMount className='data-[state=inactive]:hidden'>
              <div className='space-y-4 py-2'>
                <div className='flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-amber-900 dark:text-amber-200 text-xs'>
                  <Info size={16} className='text-amber-600 shrink-0 mt-0.5' />
                  <div>
                    <span className='font-semibold'>凭据录入说明：</span>
                    <p className='text-muted-foreground mt-0.5 leading-relaxed'>
                      STOKEN 与 PTOKEN 均带 httpOnly 保护，DevTools 无法直接查看。日常加号<strong>强烈建议使用左侧的百度App扫码或短信验证码</strong>。若有导出的凭据，请选择录入 STOKEN 或 PTOKEN（二选一，同时传入将报错）。
                    </p>
                  </div>
                </div>

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

                    <FormField
                      control={form.control}
                      name='bduss'
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>BDUSS 凭据</FormLabel>
                          <FormControl>
                            <Input
                              type='password'
                              placeholder='粘贴 BDUSS (约 192 字符)'
                              autoComplete='off'
                              {...field}
                            />
                          </FormControl>
                          <FormDescription className='text-xs'>
                            提交后立即清除输入框，不写入浏览器本地存储。
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {/* Radio Switch between STOKEN and PTOKEN */}
                    <div className='space-y-2 rounded-lg border bg-card p-3 shadow-xs'>
                      <FormField
                        control={form.control}
                        name='tokenType'
                        render={({ field }) => (
                          <FormItem className='space-y-2'>
                            <FormLabel className='text-xs font-semibold'>凭据类型选择 (二选一)</FormLabel>
                            <FormControl>
                              <RadioGroup
                                value={field.value}
                                onValueChange={field.onChange}
                                className='grid grid-cols-2 gap-3'
                              >
                                <div className='flex items-center space-x-2 rounded-md border p-2 cursor-pointer hover:bg-muted/50'>
                                  <RadioGroupItem value='stoken' id='add-stoken' />
                                  <Label htmlFor='add-stoken' className='text-xs font-medium cursor-pointer'>
                                    直接提供 STOKEN
                                  </Label>
                                </div>
                                <div className='flex items-center space-x-2 rounded-md border p-2 cursor-pointer hover:bg-muted/50'>
                                  <RadioGroupItem value='ptoken' id='add-ptoken' />
                                  <Label htmlFor='add-ptoken' className='text-xs font-medium cursor-pointer'>
                                    提供 PTOKEN (自动换票)
                                  </Label>
                                </div>
                              </RadioGroup>
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name='token'
                        render={({ field }) => (
                          <FormItem className='pt-1'>
                            <FormLabel className='text-xs'>
                              {selectedTokenType === 'stoken' ? 'STOKEN 凭据' : 'PTOKEN 凭据'}
                            </FormLabel>
                            <FormControl>
                              <Input
                                type='password'
                                placeholder={
                                  selectedTokenType === 'stoken'
                                    ? '粘贴 STOKEN (约 64 字符)'
                                    : '粘贴 PTOKEN (后端将自动向百度换取 STOKEN)'
                                }
                                autoComplete='off'
                                {...field}
                              />
                            </FormControl>
                            <FormDescription className='text-[11px]'>
                              {selectedTokenType === 'stoken'
                                ? '传统的 STOKEN 凭据。'
                                : '只给 bduss + ptoken 时，后端将自动请求认证接口换取 STOKEN 并入池。'}
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    <FormField
                      control={form.control}
                      name='device_id'
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>设备 ID (可选)</FormLabel>
                          <FormControl>
                            <Input placeholder='缺省将使用服务端 default_device_id' {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

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
                        确认添加
                      </Button>
                    </DialogFooter>
                  </form>
                </Form>
              </div>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  )
}
