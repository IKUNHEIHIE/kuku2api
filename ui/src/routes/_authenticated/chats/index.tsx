import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { Chats } from '@/features/chats'

const chatsSearchSchema = z.object({
  model: z.string().optional().catch(''),
  previous_response_id: z.string().optional().catch(''),
  session_key: z.string().optional().catch(''),
})

export const Route = createFileRoute('/_authenticated/chats/')({
  validateSearch: chatsSearchSchema,
  component: Chats,
})

