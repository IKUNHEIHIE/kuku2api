import { useState, useEffect } from 'react'
import { Outlet } from '@tanstack/react-router'
import { getCookie } from '@/lib/cookies'
import { cn } from '@/lib/utils'
import { LayoutProvider } from '@/context/layout-provider'
import { SearchProvider } from '@/context/search-provider'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/layout/app-sidebar'
import { SkipToMain } from '@/components/skip-to-main'
import { AdminAuthGate } from '@/components/admin-auth-gate'
import { getApiSettings } from '@/lib/kuku-api'

type AuthenticatedLayoutProps = {
  children?: React.ReactNode
}

export function AuthenticatedLayout({ children }: AuthenticatedLayoutProps) {
  const defaultOpen = getCookie('sidebar_state') !== 'false'
  const [authSettings, setAuthSettings] = useState(() => getApiSettings())
  const [isAuthorized, setIsAuthorized] = useState(() =>
    Boolean(authSettings.adminToken && authSettings.adminToken.trim().length > 0)
  )
  const [unauthorizedReason, setUnauthorizedReason] = useState<string | null>(null)

  useEffect(() => {
    const handleSettingsChanged = () => {
      const current = getApiSettings()
      setAuthSettings(current)
      const hasToken = Boolean(current.adminToken && current.adminToken.trim().length > 0)
      setIsAuthorized(hasToken)
      if (hasToken) {
        setUnauthorizedReason(null)
      }
    }

    const handleUnauthorized = (e: Event) => {
      const customEvent = e as CustomEvent<{ message?: string }>
      setIsAuthorized(false)
      setUnauthorizedReason(customEvent.detail?.message || '管理员令牌失效或未通过鉴权 (401)')
    }

    window.addEventListener('kuku-settings-changed', handleSettingsChanged)
    window.addEventListener('kuku-admin-unauthorized', handleUnauthorized)
    window.addEventListener('storage', handleSettingsChanged)

    return () => {
      window.removeEventListener('kuku-settings-changed', handleSettingsChanged)
      window.removeEventListener('kuku-admin-unauthorized', handleUnauthorized)
      window.removeEventListener('storage', handleSettingsChanged)
    }
  }, [])

  if (!isAuthorized) {
    return (
      <SearchProvider>
        <LayoutProvider>
          <AdminAuthGate
            unauthorizedReason={unauthorizedReason}
            onAuthenticated={() => {
              setIsAuthorized(true)
              setUnauthorizedReason(null)
            }}
          />
        </LayoutProvider>
      </SearchProvider>
    )
  }

  return (
    <SearchProvider>
      <LayoutProvider>
        <SidebarProvider defaultOpen={defaultOpen}>
          <SkipToMain />
          <AppSidebar />
          <SidebarInset
            className={cn(
              // Set content container, so we can use container queries
              '@container/content',

              // If layout is fixed, set the height
              // to 100svh to prevent overflow
              'has-data-[layout=fixed]:h-svh',

              // If layout is fixed and sidebar is inset,
              // set the height to 100svh - spacing (total margins) to prevent overflow
              'peer-data-[variant=inset]:has-data-[layout=fixed]:h-[calc(100svh-(var(--spacing)*4))]'
            )}
          >
            {children ?? <Outlet />}
          </SidebarInset>
        </SidebarProvider>
      </LayoutProvider>
    </SearchProvider>
  )
}
