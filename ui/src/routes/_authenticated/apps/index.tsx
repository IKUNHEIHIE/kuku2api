import { createFileRoute } from '@tanstack/react-router'
import { Apps } from '@/features/apps'

export const Route = createFileRoute('/_authenticated/apps/')({
  validateSearch: (search: Record<string, unknown>) => search,
  component: Apps,
})
