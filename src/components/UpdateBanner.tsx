import { useState } from 'react'
import { Download, Loader2, X } from 'lucide-react'
import { downloadAndInstallUpdate } from '../lib/desktop'

interface Props {
  version: string
  currentVersion?: string
  onDismiss: () => void
}

export default function UpdateBanner({ version, currentVersion, onDismiss }: Props) {
  const [phase, setPhase] = useState<
    | { kind: 'idle' }
    | { kind: 'downloading'; pct: number | null }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  async function onInstall() {
    setPhase({ kind: 'downloading', pct: null })
    try {
      await downloadAndInstallUpdate((downloaded, total) => {
        const pct = total ? Math.round((downloaded / total) * 100) : null
        setPhase({ kind: 'downloading', pct })
      })
    } catch (err) {
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Update failed',
      })
    }
  }

  return (
    <div className="border-b border-accent-500/40 bg-accent-950/40 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2 text-sm">
        <Download size={14} className="flex-shrink-0 text-accent-300" />
        <div className="min-w-0 flex-1">
          <span className="text-accent-100">
            Update available: <span className="font-mono font-medium">{version}</span>
            {currentVersion && (
              <span className="text-accent-300/70"> (you have {currentVersion})</span>
            )}
          </span>
        </div>
        {phase.kind === 'idle' && (
          <>
            <button
              onClick={onInstall}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent-600 px-3 py-1 text-xs font-medium text-white hover:bg-accent-500"
            >
              Install &amp; restart
            </button>
            <button
              onClick={onDismiss}
              className="text-accent-300 hover:text-accent-100"
              aria-label="Dismiss"
              title="Hide until next launch"
            >
              <X size={14} />
            </button>
          </>
        )}
        {phase.kind === 'downloading' && (
          <span className="inline-flex items-center gap-1.5 text-xs text-accent-200">
            <Loader2 size={12} className="animate-spin" />
            Downloading {phase.pct !== null ? `${phase.pct}%` : '…'}
          </span>
        )}
        {phase.kind === 'error' && (
          <span className="text-xs text-red-300">{phase.message}</span>
        )}
      </div>
    </div>
  )
}
