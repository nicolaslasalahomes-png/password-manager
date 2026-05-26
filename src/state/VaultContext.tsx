import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { supabase } from '../lib/supabase'
import {
  setupVault as cryptoSetupVault,
  unlockVault as cryptoUnlockVault,
  verifyMasterPassword as cryptoVerifyMasterPassword,
  zero,
  type KdfParams,
} from '../lib/encryption'
import { useAuth } from './AuthContext'

export type VaultStatus = 'loading' | 'no-vault' | 'locked' | 'unlocked'

export interface VaultMeta {
  encryptedDek: string
  ivDek: string
  kdfSalt: string
  kdfParams: KdfParams
  verifierCiphertext: string
  verifierIv: string
}

interface VaultApi {
  status: VaultStatus
  meta: VaultMeta | null
  /** The raw DEK — only available while unlocked. Never persist. */
  dek: Uint8Array | null
  setupVault: (masterPassword: string) => Promise<void>
  unlockVault: (masterPassword: string) => Promise<void>
  lockVault: () => void
  verifyMasterPassword: (masterPassword: string) => Promise<boolean>
  reload: () => Promise<void>
}

const VaultContext = createContext<VaultApi | null>(null)

interface VaultUsersRow {
  encrypted_dek: string
  iv_dek: string
  kdf_salt: string
  kdf_params: KdfParams
  verifier_ciphertext: string
  verifier_iv: string
}

function rowToMeta(row: VaultUsersRow): VaultMeta {
  return {
    encryptedDek: row.encrypted_dek,
    ivDek: row.iv_dek,
    kdfSalt: row.kdf_salt,
    kdfParams: row.kdf_params,
    verifierCiphertext: row.verifier_ciphertext,
    verifierIv: row.verifier_iv,
  }
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth()
  const [meta, setMeta] = useState<VaultMeta | null>(null)
  const [status, setStatus] = useState<VaultStatus>('loading')
  const dekRef = useRef<Uint8Array | null>(null)
  const [, forceTick] = useState(0)

  const loadMeta = useCallback(async () => {
    if (!user) {
      setMeta(null)
      setStatus('loading')
      return
    }
    const { data, error } = await supabase
      .from('vault_users')
      .select('encrypted_dek, iv_dek, kdf_salt, kdf_params, verifier_ciphertext, verifier_iv')
      .eq('user_id', user.id)
      .maybeSingle()

    if (error) {
      console.error('[vault] load meta failed', error)
      setStatus('no-vault')
      return
    }
    if (!data) {
      setMeta(null)
      setStatus('no-vault')
      return
    }
    setMeta(rowToMeta(data as VaultUsersRow))
    setStatus((prev) => (prev === 'unlocked' ? 'unlocked' : 'locked'))
  }, [user])

  // Load meta whenever auth changes
  useEffect(() => {
    if (authLoading) {
      setStatus('loading')
      return
    }
    if (!user) {
      // signed out: clear everything
      if (dekRef.current) {
        zero(dekRef.current)
        dekRef.current = null
      }
      setMeta(null)
      setStatus('loading')
      return
    }
    void loadMeta()
  }, [user, authLoading, loadMeta])

  const setupVault = useCallback(
    async (masterPassword: string) => {
      if (!user) throw new Error('Must be signed in to set up a vault')
      const material = await cryptoSetupVault(masterPassword)
      const { error } = await supabase.from('vault_users').insert({
        user_id: user.id,
        encrypted_dek: material.encryptedDek,
        iv_dek: material.ivDek,
        kdf_salt: material.kdfSalt,
        kdf_params: material.kdfParams,
        verifier_ciphertext: material.verifierCiphertext,
        verifier_iv: material.verifierIv,
      })
      if (error) {
        zero(material.dek)
        throw error
      }
      dekRef.current = material.dek
      setMeta({
        encryptedDek: material.encryptedDek,
        ivDek: material.ivDek,
        kdfSalt: material.kdfSalt,
        kdfParams: material.kdfParams,
        verifierCiphertext: material.verifierCiphertext,
        verifierIv: material.verifierIv,
      })
      setStatus('unlocked')
      forceTick((t) => t + 1)
    },
    [user],
  )

  const unlockVault = useCallback(
    async (masterPassword: string) => {
      if (!meta) throw new Error('No vault to unlock')
      const { dek } = await cryptoUnlockVault({ masterPassword, ...meta })
      if (dekRef.current) zero(dekRef.current)
      dekRef.current = dek
      setStatus('unlocked')
      forceTick((t) => t + 1)
    },
    [meta],
  )

  const lockVault = useCallback(() => {
    if (dekRef.current) {
      zero(dekRef.current)
      dekRef.current = null
    }
    setStatus((prev) => (prev === 'unlocked' ? 'locked' : prev))
    forceTick((t) => t + 1)
  }, [])

  const verifyMasterPassword = useCallback(
    async (masterPassword: string) => {
      if (!meta) return false
      return cryptoVerifyMasterPassword({ masterPassword, ...meta })
    },
    [meta],
  )

  // Wipe DEK on tab close
  useEffect(() => {
    const handler = () => {
      if (dekRef.current) zero(dekRef.current)
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  const api = useMemo<VaultApi>(
    () => ({
      status,
      meta,
      dek: dekRef.current,
      setupVault,
      unlockVault,
      lockVault,
      verifyMasterPassword,
      reload: loadMeta,
    }),
    // dekRef changes are surfaced via forceTick — meta + status reflect transitions
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, meta, setupVault, unlockVault, lockVault, verifyMasterPassword, loadMeta],
  )

  return <VaultContext.Provider value={api}>{children}</VaultContext.Provider>
}

export function useVault(): VaultApi {
  const ctx = useContext(VaultContext)
  if (!ctx) throw new Error('useVault must be used within VaultProvider')
  return ctx
}
