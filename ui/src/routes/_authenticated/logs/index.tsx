import { createFileRoute } from '@tanstack/react-router'
import { LogsFeature } from '@/features/logs'

export const Route = createFileRoute('/_authenticated/logs/')({
  validateSearch: (search: Record<string, unknown>) => search,
  component: LogsFeature,
})
