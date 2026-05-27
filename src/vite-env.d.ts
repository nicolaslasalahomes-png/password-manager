/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  // Dev-only: see src/lib/devTest.ts
  readonly VITE_DEV_TEST_EMAIL?: string
  readonly VITE_DEV_TEST_SIGNIN_PASSWORD?: string
  readonly VITE_DEV_TEST_MASTER_PASSWORD?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
