import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

if (!url || !anonKey) {
  // Surfaced in the UI rather than thrown, so a missing env var doesn't break the bundle.
  console.warn('[supabase] VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY is missing')
}

export const supabase = createClient(url ?? '', anonKey ?? '')

export const supabaseConfigured = Boolean(url && anonKey)
