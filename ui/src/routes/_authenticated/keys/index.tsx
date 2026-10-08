import { createFileRoute } from '@tanstack/react-router'
import { Keys } from '@/features/keys'

export const Route = createFileRoute('/_authenticated/keys/')({
  validateSearch: (search: Record<string, unknown>) => search,
  component: Keys,
})
