import { useCallback } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './state/AuthContext'
import { useVault } from './state/VaultContext'
import { useIdleLock } from './lib/useIdleLock'
import Login from './pages/Login'
import Signup from './pages/Signup'
import VaultSetup from './pages/VaultSetup'
import VaultUnlock from './pages/VaultUnlock'
import VaultList from './pages/VaultList'
import ItemNew from './pages/ItemNew'
import ItemView from './pages/ItemView'
import FullPageLoader from './components/FullPageLoader'

export default function App() {
  const { user, loading: authLoading } = useAuth()
  const { status: vaultStatus, lockVault } = useVault()

  // Auto-lock after 10min idle or on tab hide
  const onIdle = useCallback(() => {
    if (vaultStatus === 'unlocked') lockVault()
  }, [vaultStatus, lockVault])
  useIdleLock(vaultStatus === 'unlocked', onIdle)

  if (authLoading) return <FullPageLoader label="Loading session…" />

  // Not signed in → auth pages only
  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  if (vaultStatus === 'loading') return <FullPageLoader label="Loading vault…" />

  // Signed in but no vault yet → setup
  if (vaultStatus === 'no-vault') {
    return (
      <Routes>
        <Route path="/setup" element={<VaultSetup />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    )
  }

  // Signed in, vault exists but locked → unlock
  if (vaultStatus === 'locked') {
    return (
      <Routes>
        <Route path="/unlock" element={<VaultUnlock />} />
        <Route path="*" element={<Navigate to="/unlock" replace />} />
      </Routes>
    )
  }

  // Fully unlocked
  return (
    <Routes>
      <Route path="/vault" element={<VaultList />} />
      <Route path="/vault/new" element={<ItemNew />} />
      <Route path="/vault/:id" element={<ItemView />} />
      <Route path="*" element={<Navigate to="/vault" replace />} />
    </Routes>
  )
}
