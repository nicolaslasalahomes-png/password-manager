import { Link, useLocation } from 'react-router-dom'
import { Lock, LogOut, Plus, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { useAuth } from '../state/AuthContext'
import { useVault } from '../state/VaultContext'
import { useToast } from '../state/ToastContext'

interface Props {
  children: ReactNode
  rightSlot?: ReactNode
}

export default function Layout({ children, rightSlot }: Props) {
  const { signOut, user } = useAuth()
  const { lockVault } = useVault()
  const toast = useToast()
  const loc = useLocation()
  const onVaultList = loc.pathname === '/vault'

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-30 border-b border-ink-800 bg-ink-950/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
          <Link to="/vault" className="flex items-center gap-2 text-ink-100">
            <ShieldCheck className="h-5 w-5 text-accent-400" />
            <span className="font-semibold tracking-tight">Keyring</span>
          </Link>
          <div className="flex-1" />
          {rightSlot}
          {onVaultList && (
            <Link to="/vault/new" className="btn-primary !px-3 !py-1.5">
              <Plus size={14} /> New
            </Link>
          )}
          <button
            onClick={() => {
              lockVault()
              toast.info('Vault locked')
            }}
            className="btn-ghost !px-2 !py-1.5"
            title="Lock vault"
          >
            <Lock size={16} />
          </button>
          <button
            onClick={() => signOut()}
            className="btn-ghost !px-2 !py-1.5"
            title={`Sign out ${user?.email ?? ''}`}
          >
            <LogOut size={16} />
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  )
}
