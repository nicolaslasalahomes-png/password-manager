import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import Layout from '../components/Layout'
import NeedsYouPanel from '../components/NeedsYouPanel'
import { useVault } from '../state/VaultContext'
import { useToast } from '../state/ToastContext'
import { useIsDesktop } from '../lib/desktop'
import {
  type Briefing,
  generateBriefing,
  getBriefingEnabled,
  listBriefings,
  markBriefingsSeen,
} from '../lib/briefing'
import { useAuth } from '../state/AuthContext'

export default function BriefingPage() {
  const { dek } = useVault()
  const { user } = useAuth()
  const toast = useToast()
  const isDesktop = useIsDesktop()
  const [briefs, setBriefs] = useState<Briefing[] | null>(null)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [generating, setGenerating] = useState(false)

  const reload = useCallback(async () => {
    if (!dek) return
    try {
      const [list, on] = await Promise.all([listBriefings(dek), getBriefingEnabled()])
      setBriefs(list)
      setEnabled(on)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load briefings')
      setBriefs([])
    }
  }, [dek, toast])

  useEffect(() => {
    void reload()
    // Mark seen so the sidebar dot clears once the user is on this tab.
    void markBriefingsSeen()
  }, [reload])

  async function onGenerate() {
    if (!user || !dek) return
    setGenerating(true)
    try {
      await generateBriefing(user.id, dek)
      await reload()
      await markBriefingsSeen()
      toast.success('Brief generated')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not generate brief')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <Layout
      rightSlot={
        isDesktop ? (
          <button
            onClick={onGenerate}
            disabled={generating}
            className="btn-ghost !px-2 !py-1.5"
            title="Generate a brief now"
          >
            <Sparkles size={16} className={generating ? 'animate-pulse' : ''} />
          </button>
        ) : null
      }
    >
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-ink-50">Daily brief</h1>
        <p className="mt-1 text-sm text-ink-300">
          Claude's morning rundown of what to focus on, one entry per day. Newest first.
        </p>
      </div>

      <NeedsYouPanel className="mb-4" />

      {briefs === null ? (
        <p className="py-12 text-center text-sm text-ink-300">Loading…</p>
      ) : briefs.length === 0 ? (
        <div className="card mx-auto max-w-md p-8 text-center">
          <Sparkles className="mx-auto mb-3 text-accent-400" size={28} />
          <h2 className="text-base font-semibold">No briefs yet</h2>
          <p className="mt-2 text-sm text-ink-300">
            {enabled === false
              ? 'Turn on Daily briefing in Settings → Tasks & notifications, then generate your first one.'
              : 'Your first brief appears the next time you open Keyring on a new day — or generate one now.'}
          </p>
          {enabled === false ? (
            <Link to="/vault/settings" className="btn-primary mt-5 inline-flex">
              Open Settings
            </Link>
          ) : (
            <button onClick={onGenerate} disabled={generating} className="btn-primary mt-5 inline-flex">
              <Sparkles size={14} /> {generating ? 'Writing…' : 'Generate now'}
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {briefs.map((b) => (
            <div key={b.id} className="card p-0">
              <header className="flex items-center justify-between border-b border-ink-800 px-5 py-3">
                <div className="flex items-center gap-2">
                  <Sparkles size={14} className="text-accent-400" />
                  <span className="text-sm font-semibold text-ink-100">{dayLabel(b.generated_at)}</span>
                </div>
                <span className="text-[11px] tabular-nums text-ink-500">
                  {new Date(b.generated_at).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </header>
              <div className="px-5 py-4">
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-100">{b.content}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </Layout>
  )
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date().toDateString()
  const yesterday = new Date(Date.now() - 86_400_000).toDateString()
  if (d.toDateString() === today) return 'Today'
  if (d.toDateString() === yesterday) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}
