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
  changeMasterPassword as cryptoChangeMasterPassword,
  createHighDek as cryptoCreateHighDek,
  elevateHighDek as cryptoElevateHighDek,
  setupVault as cryptoSetupVault,
  unlockVault as cryptoUnlockVault,
  verifyMasterPassword as cryptoVerifyMasterPassword,
  zero,
  type KdfParams,
} from '../lib/encryption'
import { useAuth } from './AuthContext'
import {
  biometricAvailable as desktopBiometricAvailable,
  biometricDelete,
  biometricExists,
  biometricRetrieve,
  biometricStore,
  clearSessionDek,
  getSessionDek,
  isDesktop,
  setSessionDek,
} from '../lib/desktop'

export type VaultStatus = 'loading' | 'no-vault' | 'locked' | 'unlocked'

export interface VaultMeta {
  encryptedDek: string
  ivDek: string
  /** Null on legacy vaults created before the two-key model (until migrated). */
  encryptedHighDek: string | null
  ivHighDek: string | null
  kdfSalt: string
  kdfParams: KdfParams
  verifierCiphertext: string
  verifierIv: string
}

interface VaultApi {
  status: VaultStatus
  meta: VaultMeta | null
  /** The raw DEK (low/medium items) — only while unlocked. Never persist. */
  dek: Uint8Array | null
  /** The raw highDek (high-tier items) — null until full unlock / elevation. */
  highDek: Uint8Array | null
  /** True when highDek is in memory: high-tier items are accessible. */
  highUnlocked: boolean
  setupVault: (masterPassword: string) => Promise<void>
  /** Full unlock with the master password: both keys in memory. */
  unlockVault: (masterPassword: string) => Promise<void>
  /** Standard unlock via Touch ID: only the DEK; high-tier stays locked. */
  unlockWithBiometric: () => Promise<void>
  /** From a Touch ID session, unwrap the highDek with the master password. */
  elevate: (masterPassword: string) => Promise<void>
  lockVault: () => void
  verifyMasterPassword: (masterPassword: string) => Promise<boolean>
  changeMasterPassword: (currentMasterPassword: string, newMasterPassword: string) => Promise<void>
  reload: () => Promise<void>
  // Biometric (Touch ID) management — all no-op/false off desktop.
  biometricAvailable: () => Promise<boolean>
  isBiometricEnrolled: () => Promise<boolean>
  enableBiometric: () => Promise<void>
  disableBiometric: () => Promise<void>
}

const VaultContext = createContext<VaultApi | null>(null)

interface VaultUsersRow {
  encrypted_dek: string
  iv_dek: string
  encrypted_high_dek: string | null
  iv_high_dek: string | null
  kdf_salt: string
  kdf_params: KdfParams
  verifier_ciphertext: string
  verifier_iv: string
}

const VAULT_USERS_COLUMNS =
  'encrypted_dek, iv_dek, encrypted_high_dek, iv_high_dek, kdf_salt, kdf_params, verifier_ciphertext, verifier_iv'

function rowToMeta(row: VaultUsersRow): VaultMeta {
  return {
    encryptedDek: row.encrypted_dek,
    ivDek: row.iv_dek,
    encryptedHighDek: row.encrypted_high_dek,
    ivHighDek: row.iv_high_dek,
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
  const highDekRef = useRef<Uint8Array | null>(null)
  // Bumped on every key transition (unlock / biometric / elevate / lock) so the
  // memoized api re-reads dekRef/highDekRef even when status & meta are unchanged.
  const [tick, forceTick] = useState(0)

  const loadMeta = useCallback(async () => {
    if (!user) {
      setMeta(null)
      setStatus('loading')
      return
    }
    const { data, error } = await supabase
      .from('vault_users')
      .select(VAULT_USERS_COLUMNS)
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
      if (highDekRef.current) {
        zero(highDekRef.current)
        highDekRef.current = null
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
        encrypted_high_dek: material.encryptedHighDek,
        iv_high_dek: material.ivHighDek,
        kdf_salt: material.kdfSalt,
        kdf_params: material.kdfParams,
        verifier_ciphertext: material.verifierCiphertext,
        verifier_iv: material.verifierIv,
      })
      if (error) {
        zero(material.dek)
        zero(material.highDek)
        throw error
      }
      dekRef.current = material.dek
      highDekRef.current = material.highDek
      // Mirror the DEK (only) to Rust state so the quick-add window can use it.
      void setSessionDek(material.dek)
      setMeta({
        encryptedDek: material.encryptedDek,
        ivDek: material.ivDek,
        encryptedHighDek: material.encryptedHighDek,
        ivHighDek: material.ivHighDek,
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
      if (!user || !meta) throw new Error('No vault to unlock')
      const { dek, highDek } = await cryptoUnlockVault({ masterPassword, ...meta })

      // Legacy single-key vault: mint a highDek now and persist it (one-time
      // migration). Pre-existing high-tier rows are re-encrypted lazily on
      // first access (see decryptItem). Idempotent and crash-safe.
      let resolvedHighDek = highDek
      if (!resolvedHighDek) {
        const minted = await cryptoCreateHighDek({
          masterPassword,
          kdfSalt: meta.kdfSalt,
          kdfParams: meta.kdfParams,
        })
        const { error } = await supabase
          .from('vault_users')
          .update({ encrypted_high_dek: minted.encryptedHighDek, iv_high_dek: minted.ivHighDek })
          .eq('user_id', user.id)
        if (error) {
          zero(dek)
          zero(minted.highDek)
          throw error
        }
        resolvedHighDek = minted.highDek
        setMeta((prev) =>
          prev
            ? { ...prev, encryptedHighDek: minted.encryptedHighDek, ivHighDek: minted.ivHighDek }
            : prev,
        )
      }

      if (dekRef.current) zero(dekRef.current)
      if (highDekRef.current) zero(highDekRef.current)
      dekRef.current = dek
      highDekRef.current = resolvedHighDek
      void setSessionDek(dek)
      setStatus('unlocked')
      forceTick((t) => t + 1)
    },
    [user, meta],
  )

  // Standard unlock via Touch ID. Retrieves only the DEK from the Secure
  // Enclave Keychain (triggers the fingerprint prompt). highDek stays null —
  // high-tier items remain locked until the user elevates with the master pw.
  const unlockWithBiometric = useCallback(async () => {
    if (!user) throw new Error('Must be signed in')
    const dek = await biometricRetrieve(user.id)
    if (dekRef.current) zero(dekRef.current)
    if (highDekRef.current) {
      zero(highDekRef.current)
      highDekRef.current = null
    }
    dekRef.current = dek
    void setSessionDek(dek)
    setStatus('unlocked')
    forceTick((t) => t + 1)
  }, [user])

  // Elevate a Touch ID (standard) session to full by unwrapping the highDek
  // with the master password. On a not-yet-migrated vault, mints + persists it.
  const elevate = useCallback(
    async (masterPassword: string) => {
      if (!user || !meta) throw new Error('Vault not loaded')
      let highDek: Uint8Array
      if (meta.encryptedHighDek && meta.ivHighDek) {
        highDek = await cryptoElevateHighDek({
          masterPassword,
          kdfSalt: meta.kdfSalt,
          kdfParams: meta.kdfParams,
          verifierCiphertext: meta.verifierCiphertext,
          verifierIv: meta.verifierIv,
          encryptedHighDek: meta.encryptedHighDek,
          ivHighDek: meta.ivHighDek,
        })
      } else {
        // Legacy vault elevated before its first full unlock: verify, then mint.
        const ok = await cryptoVerifyMasterPassword({ masterPassword, ...meta })
        if (!ok) throw new Error('Incorrect master password')
        const minted = await cryptoCreateHighDek({
          masterPassword,
          kdfSalt: meta.kdfSalt,
          kdfParams: meta.kdfParams,
        })
        const { error } = await supabase
          .from('vault_users')
          .update({ encrypted_high_dek: minted.encryptedHighDek, iv_high_dek: minted.ivHighDek })
          .eq('user_id', user.id)
        if (error) {
          zero(minted.highDek)
          throw error
        }
        highDek = minted.highDek
        setMeta((prev) =>
          prev
            ? { ...prev, encryptedHighDek: minted.encryptedHighDek, ivHighDek: minted.ivHighDek }
            : prev,
        )
      }
      if (highDekRef.current) zero(highDekRef.current)
      highDekRef.current = highDek
      forceTick((t) => t + 1)
    },
    [user, meta],
  )

  const lockVault = useCallback(() => {
    if (dekRef.current) {
      zero(dekRef.current)
      dekRef.current = null
    }
    if (highDekRef.current) {
      zero(highDekRef.current)
      highDekRef.current = null
    }
    void clearSessionDek()
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

  const changeMasterPassword = useCallback(
    async (currentMasterPassword: string, newMasterPassword: string) => {
      if (!user || !meta) throw new Error('Vault not loaded')
      // Derives new salt + KEK, re-wraps both keys. Throws if current pw is wrong.
      const material = await cryptoChangeMasterPassword({
        currentMasterPassword,
        newMasterPassword,
        ...meta,
      })
      // Persist the new wraps to Supabase. If this fails, the local state is
      // unchanged so the user can still unlock with the old pw.
      const { error } = await supabase
        .from('vault_users')
        .update({
          encrypted_dek: material.encryptedDek,
          iv_dek: material.ivDek,
          encrypted_high_dek: material.encryptedHighDek,
          iv_high_dek: material.ivHighDek,
          kdf_salt: material.kdfSalt,
          kdf_params: material.kdfParams,
          verifier_ciphertext: material.verifierCiphertext,
          verifier_iv: material.verifierIv,
        })
        .eq('user_id', user.id)
      if (error) {
        zero(material.dek)
        zero(material.highDek)
        throw error
      }
      // Both key bytes are unchanged; only the wrap (KEK) changed. The DEK in
      // the Touch ID Keychain item is therefore still valid — no re-store
      // needed. Adopt the fresh key instances and zero the old ones. Changing
      // the master pw also fully unlocks (both keys now in memory).
      if (dekRef.current && dekRef.current !== material.dek) zero(dekRef.current)
      if (highDekRef.current && highDekRef.current !== material.highDek) zero(highDekRef.current)
      dekRef.current = material.dek
      highDekRef.current = material.highDek
      void setSessionDek(material.dek)
      setMeta({
        encryptedDek: material.encryptedDek,
        ivDek: material.ivDek,
        encryptedHighDek: material.encryptedHighDek,
        ivHighDek: material.ivHighDek,
        kdfSalt: material.kdfSalt,
        kdfParams: material.kdfParams,
        verifierCiphertext: material.verifierCiphertext,
        verifierIv: material.verifierIv,
      })
      setStatus('unlocked')
      forceTick((t) => t + 1)
    },
    [user, meta],
  )

  // Biometric (Touch ID) management. All degrade to no-op/false off desktop.
  const biometricAvailable = useCallback(() => desktopBiometricAvailable(), [])

  const isBiometricEnrolled = useCallback(async () => {
    if (!user) return false
    return biometricExists(user.id)
  }, [user])

  const enableBiometric = useCallback(async () => {
    if (!user) throw new Error('Must be signed in')
    if (!dekRef.current) throw new Error('Unlock the vault before enabling Touch ID')
    // Store ONLY the DEK — never the master password or highDek.
    await biometricStore(user.id, dekRef.current)
  }, [user])

  const disableBiometric = useCallback(async () => {
    if (!user) return
    await biometricDelete(user.id)
  }, [user])

  // Wipe both keys on tab close
  useEffect(() => {
    const handler = () => {
      if (dekRef.current) zero(dekRef.current)
      if (highDekRef.current) zero(highDekRef.current)
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // Listen for popover-unlocked events. The quick-add window unlocks the
  // vault directly (calling setSessionDek on the Rust side); this listener
  // syncs our context's view so the main window doesn't keep showing the
  // unlock screen if the user opens it later.
  useEffect(() => {
    if (!isDesktop()) return
    let unlisten: (() => void) | null = null
    ;(async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        unlisten = await listen('vault://unlocked-from-popover', async () => {
          const dek = await getSessionDek()
          if (!dek) return
          if (dekRef.current) zero(dekRef.current)
          dekRef.current = dek
          setStatus('unlocked')
          forceTick((t) => t + 1)
        })
      } catch (err) {
        console.warn('[vault] failed to listen for popover-unlock events', err)
      }
    })()
    return () => {
      unlisten?.()
    }
  }, [])

  const api = useMemo<VaultApi>(
    () => ({
      status,
      meta,
      dek: dekRef.current,
      highDek: highDekRef.current,
      highUnlocked: highDekRef.current !== null,
      setupVault,
      unlockVault,
      unlockWithBiometric,
      elevate,
      lockVault,
      verifyMasterPassword,
      changeMasterPassword,
      reload: loadMeta,
      biometricAvailable,
      isBiometricEnrolled,
      enableBiometric,
      disableBiometric,
    }),
    // `tick` forces a re-read of dekRef/highDekRef on every key transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      tick,
      status,
      meta,
      setupVault,
      unlockVault,
      unlockWithBiometric,
      elevate,
      lockVault,
      verifyMasterPassword,
      changeMasterPassword,
      loadMeta,
      biometricAvailable,
      isBiometricEnrolled,
      enableBiometric,
      disableBiometric,
    ],
  )

  return <VaultContext.Provider value={api}>{children}</VaultContext.Provider>
}

export function useVault(): VaultApi {
  const ctx = useContext(VaultContext)
  if (!ctx) throw new Error('useVault must be used within VaultProvider')
  return ctx
}
