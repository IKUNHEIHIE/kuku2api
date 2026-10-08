import { createFileRoute } from '@tanstack/react-router'
import { StatsFeature } from '@/features/stats'

export const Route = createFileRoute('/_authenticated/stats/')({
  validateSearch: (search: Record<string, unknown>) => search,
  component: StatsFeature,
})
