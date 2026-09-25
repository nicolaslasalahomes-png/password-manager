import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  ExternalLink,
  Plus,
  Save,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import {
  decryptCachedPayload,
  getAiInboxEnabled,
  getAnthropicApiKey,
  getAuthSenders,
  getSpamSenders,
  listUnclassifiedMessages,
  removeAuthSender,
  removeSpamSender,
  saveAnthropicApiKey,
  setAiInboxEnabled,
  setMessageImportance,
} from '../lib/email'
import { classifyEmail } from '../lib/ai/classifier'
import Layout from '../components/Layout'
import { useAuth } from '../state/AuthContext'
import { useVault } from '../state/VaultContext'
import { useToast } from '../state/ToastContext'
import {
  type EmailAccountRow,
  deleteAccount,
  listAccounts,
  saveAccount,
} from '../lib/google/tokens'
import {
  GoogleOAuthError,
  connectGoogleAccount,
  getEffectiveClientId,
  getEffectiveClientSecret,
  revokeRefreshToken,
  saveClientId,
  saveClientSecret,
} from '../lib/google/oauth'
import { decryptJson } from '../lib/encryption'

export default function InboxSettings() {
  const { user } = useAuth()
  const { dek } = useVault()
  const toast = useToast()
  const [accounts, setAccounts] = useState<EmailAccountRow[] | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [clientId, setClientId] = useState<string>('')
  const [clientIdSaved, setClientIdSaved] = useState<string>('')
  const [clientSecret, setClientSecret] = useState<string>('')
  const [clientSecretSaved, setClientSecretSaved] = useState<string>('')
  const [showSecret, setShowSecret] = useState(false)
  const [savingCreds, setSavingCreds] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [spamSenders, setSpamSenders] = useState<string[]>([])
  const [authSenders, setAuthSenders] = useState<string[]>([])
  const [aiEnabled, setAiEnabledState] = useState(false)
  const [aiApiKey, setAiApiKey] = useState('')
  const [aiApiKeySaved, setAiApiKeySaved] = useState('')
  const [showAiKey, setShowAiKey] = useState(false)
  const [savingAi, setSavingAi] = useState(false)
  const [unclassifiedCount, setUnclassifiedCount] = useState<number | null>(null)
  const [classifying, setClassifying] = useState(false)
  const [classifyProgress, setClassifyProgress] = useState<{ done: number; total: number } | null>(
    null,
  )

  const reload = useCallback(async () => {
    try {
      setAccounts(await listAccounts())
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not list accounts')
    }
  }, [toast])

  useEffect(() => {
    void reload()
  }, [reload])

  const refreshUnclassifiedCount = useCallback(async () => {
    try {
      const rows = await listUnclassifiedMessages(2000)
      setUnclassifiedCount(rows.length)
    } catch {
      setUnclassifiedCount(null)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const [id, secret, spams, auths, aiOn, aiKey] = await Promise.all([
        getEffectiveClientId(),
        getEffectiveClientSecret(),
        getSpamSenders(),
        getAuthSenders(),
        getAiInboxEnabled(),
        getAnthropicApiKey(),
      ])
      setClientId(id)
      setClientIdSaved(id)
      setClientSecret(secret)
      setClientSecretSaved(secret)
      setSpamSenders(spams)
      setAuthSenders(auths)
      setAiEnabledState(aiOn)
      setAiApiKey(aiKey)
      setAiApiKeySaved(aiKey)
      if (!id || !secret) setShowHelp(true)
    })()
    void refreshUnclassifiedCount()
  }, [refreshUnclassifiedCount])

  async function onRemoveSpam(addr: string) {
    try {
      const next = await removeSpamSender(addr)
      setSpamSenders(next)
      toast.success(`Removed ${addr} from spam`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove')
    }
  }

  async function onRemoveAuth(addr: string) {
    try {
      const next = await removeAuthSender(addr)
      setAuthSenders(next)
      toast.success(`Removed ${addr} from auth senders`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove')
    }
  }

  async function onToggleAi(next: boolean) {
    try {
      await setAiInboxEnabled(next)
      setAiEnabledState(next)
      if (next && !aiApiKeySaved) {
        toast.info('Paste your Anthropic API key below to start classifying.')
      } else {
        toast.success(next ? 'AI classifier enabled' : 'AI classifier disabled')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not toggle')
    }
  }

  async function onSaveAiKey() {
    setSavingAi(true)
    try {
      await saveAnthropicApiKey(aiApiKey.trim())
      setAiApiKeySaved(aiApiKey.trim())
      toast.success('API key saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSavingAi(false)
    }
  }

  /**
   * Classify every unclassified cached email. Runs N concurrent classifications
   * to keep wall-clock reasonable on 200+ inboxes without hammering rate limits.
   */
  async function onClassifyAll() {
    if (!dek) {
      toast.error('Unlock the vault first')
      return
    }
    if (!aiApiKeySaved) {
      toast.error('Save your Anthropic API key first')
      return
    }
    setClassifying(true)
    try {
      const rows = await listUnclassifiedMessages(2000)
      setClassifyProgress({ done: 0, total: rows.length })
      let done = 0
      const CONCURRENCY = 5
      let cursor = 0
      async function worker() {
        while (cursor < rows.length) {
          const i = cursor++
          const row = rows[i]
          try {
            const payload = await decryptCachedPayload(row, dek!)
            const result = await classifyEmail(
              {
                subject: payload.subject,
                from: row.sender ?? '',
                snippet: payload.snippet,
                bodyText: payload.bodyText,
              },
              aiApiKeySaved,
            )
            await setMessageImportance(row.id, result.important, result.reason)
          } catch (err) {
            console.warn('[classify-all] row failed:', row.id, err)
          }
          done++
          setClassifyProgress({ done, total: rows.length })
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
      toast.success(`Classified ${done} emails`)
      await refreshUnclassifiedCount()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Batch classify failed')
    } finally {
      setClassifying(false)
      setClassifyProgress(null)
    }
  }

  const aiKeyDirty = aiApiKey.trim() !== aiApiKeySaved.trim()

  const dirty =
    clientId.trim() !== clientIdSaved.trim() || clientSecret.trim() !== clientSecretSaved.trim()
  const configured =
    clientIdSaved.trim().length > 0 && clientSecretSaved.trim().length > 0

  async function onSaveCredentials() {
    setSavingCreds(true)
    try {
      await Promise.all([saveClientId(clientId.trim()), saveClientSecret(clientSecret.trim())])
      setClientIdSaved(clientId.trim())
      setClientSecretSaved(clientSecret.trim())
      toast.success('OAuth credentials saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSavingCreds(false)
    }
  }

  async function onConnect() {
    if (!user || !dek) return
    if (!configured) {
      toast.error('Save your OAuth Client ID first')
      return
    }
    setConnecting(true)
    try {
      const { email, refreshToken, scopes } = await connectGoogleAccount()
      await saveAccount(user.id, email, refreshToken, scopes, dek)
      toast.success(`Connected ${email}`)
      await reload()
    } catch (err) {
      const msg =
        err instanceof GoogleOAuthError
          ? err.message
          : err instanceof Error
          ? err.message
          : 'Could not connect account'
      toast.error(msg)
    } finally {
      setConnecting(false)
    }
  }

  async function onDisconnect(acc: EmailAccountRow) {
    if (!dek) return
    if (!confirm(`Disconnect ${acc.email}? Cached emails for this account will be removed.`)) return
    try {
      try {
        const refreshToken = await decryptJson<string>(
          acc.encrypted_refresh_token,
          acc.iv_refresh_token,
          dek,
        )
        await revokeRefreshToken(refreshToken)
      } catch (revokeErr) {
        console.warn('[inbox-settings] revoke failed (non-fatal):', revokeErr)
      }
      await deleteAccount(acc.id)
      toast.success(`Disconnected ${acc.email}`)
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Disconnect failed')
    }
  }

  return (
    <Layout>
      <Link to="/vault/inbox" className="btn-ghost mb-4 !px-2 !py-1.5 !text-ink-400">
        <ArrowLeft size={14} /> Back to inbox
      </Link>

      <div className="space-y-6">
        <header>
          <h1 className="text-lg font-semibold text-ink-50">Inbox accounts</h1>
          <p className="mt-1 text-sm text-ink-300">
            Link Gmail accounts to populate the unified inbox and enable the 2FA
            auto-popover. Refresh tokens are encrypted with your master-password
            key before being stored.
          </p>
        </header>

        {/* OAuth credentials — Client ID + Secret + collapsible help */}
        <section className="card p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-ink-100">Google OAuth credentials</h2>
              <p className="mt-0.5 text-xs text-ink-400">
                One-time setup. Copy both fields from Google Cloud → Credentials → your Desktop client.
              </p>
            </div>
            {configured && !dirty && (
              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
                <CheckCircle2 size={11} /> Saved
              </span>
            )}
          </div>

          <div className="mt-3 space-y-2">
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wider text-ink-400">
                Client ID
              </label>
              <input
                type="text"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="123456789012-abcdefghij…apps.googleusercontent.com"
                className="input-mono w-full text-xs"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wider text-ink-400">
                Client Secret
              </label>
              <div className="relative">
                <input
                  type={showSecret ? 'text' : 'password'}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder="GOCSPX-…"
                  className="input-mono w-full pr-9 text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-100"
                  title={showSecret ? 'Hide' : 'Reveal'}
                >
                  {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
              <p className="mt-1 text-[10px] text-ink-500">
                Per Google's docs the secret isn't actually confidential for installed apps —
                stored locally in plaintext, never synced to Supabase.
              </p>
            </div>
          </div>

          <div className="mt-3 flex justify-end">
            <button
              onClick={onSaveCredentials}
              disabled={savingCreds || !dirty}
              className="btn-primary !px-3 !py-2 !text-xs"
            >
              <Save size={12} /> {savingCreds ? 'Saving…' : 'Save credentials'}
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowHelp((v) => !v)}
            className="mt-3 inline-flex items-center gap-1 text-[11px] text-ink-400 hover:text-ink-100"
          >
            {showHelp ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {showHelp ? 'Hide setup steps' : 'How do I get these?'}
          </button>

          {showHelp && (
            <ol className="mt-3 list-decimal space-y-1.5 rounded-md border border-ink-800 bg-ink-900/30 p-3 pl-7 text-xs text-ink-300">
              <li>
                Open{' '}
                <a
                  className="text-accent-400 underline-offset-2 hover:underline"
                  href="https://console.cloud.google.com/projectcreate"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  console.cloud.google.com <ExternalLink size={9} className="inline" />
                </a>{' '}
                and create a project (any name).
              </li>
              <li>
                APIs &amp; Services → Library → enable <code className="rounded bg-ink-800 px-1">Gmail API</code>.
              </li>
              <li>
                OAuth consent screen → User type <strong>External</strong> → app name "Keyring" →
                add the scope <code className="rounded bg-ink-800 px-1">gmail.modify</code> →
                add every Gmail address you want to link as a <strong>Test user</strong>{' '}
                (without this, OAuth refuses).
              </li>
              <li>
                Credentials → Create credentials → <strong>OAuth client ID</strong> →
                Application type <strong>Desktop app</strong> → copy <em>both</em> the Client ID
                AND the Client Secret into the fields above. (Google requires the secret even for
                Desktop apps with PKCE.)
              </li>
            </ol>
          )}
        </section>

        {/* AI inbox classifier */}
        <section className="card p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink-100">
                <Sparkles size={13} className="text-accent-400" /> AI inbox classifier
              </h2>
              <p className="mt-0.5 text-xs text-ink-400">
                Uses Claude Haiku to decide whether each email is worth reading. When enabled, the
                main <strong>Inbox</strong> only shows AI-approved emails. ~$0.00005 per email
                (cents per month at typical volume). Email metadata + a snippet of the body are sent
                to Anthropic; your vault contents stay local.
              </p>
            </div>
            <label className="flex flex-shrink-0 items-center gap-2">
              <input
                type="checkbox"
                checked={aiEnabled}
                onChange={(e) => void onToggleAi(e.target.checked)}
                className="h-4 w-4 accent-accent-500"
              />
              <span className="text-xs text-ink-300">{aiEnabled ? 'On' : 'Off'}</span>
            </label>
          </div>

          <div className="mt-3">
            <label className="mb-1 block text-[11px] uppercase tracking-wider text-ink-400">
              Anthropic API key
            </label>
            <div className="relative">
              <input
                type={showAiKey ? 'text' : 'password'}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                value={aiApiKey}
                onChange={(e) => setAiApiKey(e.target.value)}
                placeholder="sk-ant-api03-…"
                className="input-mono w-full pr-9 text-xs"
              />
              <button
                type="button"
                onClick={() => setShowAiKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-100"
                title={showAiKey ? 'Hide' : 'Reveal'}
              >
                {showAiKey ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            <p className="mt-1 text-[10px] text-ink-500">
              Get one at{' '}
              <a
                className="text-accent-400 underline-offset-2 hover:underline"
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noreferrer noopener"
              >
                console.anthropic.com/settings/keys
              </a>
              . Stored locally — never sent to Supabase.
            </p>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] text-ink-400">
              {unclassifiedCount === null
                ? 'Loading…'
                : unclassifiedCount === 0
                ? 'All cached emails classified.'
                : `${unclassifiedCount} unclassified email${unclassifiedCount === 1 ? '' : 's'} in cache.`}
              {classifyProgress && (
                <span className="ml-2 text-accent-300">
                  {classifyProgress.done}/{classifyProgress.total} done…
                </span>
              )}
            </div>
            <div className="flex gap-2">
              {aiKeyDirty && (
                <button
                  onClick={onSaveAiKey}
                  disabled={savingAi}
                  className="btn-primary !px-3 !py-1.5 !text-xs"
                >
                  <Save size={12} /> {savingAi ? 'Saving…' : 'Save key'}
                </button>
              )}
              <button
                onClick={onClassifyAll}
                disabled={classifying || !aiApiKeySaved || unclassifiedCount === 0}
                className="btn-secondary !px-3 !py-1.5 !text-xs"
                title={!aiApiKeySaved ? 'Save your API key first' : undefined}
              >
                <Sparkles size={12} />
                {classifying ? 'Classifying…' : 'Classify all unclassified'}
              </button>
            </div>
          </div>
        </section>

        {/* Spam senders */}
        <section className="card p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-ink-100">Spam senders</h2>
              <p className="mt-0.5 text-xs text-ink-400">
                Senders here are hidden from the main <strong>Inbox</strong> but still visible
                under <strong>All emails</strong>. Add new ones via the{' '}
                <ShieldOff size={11} className="inline" /> button in any email's preview.
              </p>
            </div>
            <span className="text-[11px] tabular-nums text-ink-500">{spamSenders.length}</span>
          </div>

          {spamSenders.length === 0 ? (
            <p className="mt-3 text-center text-xs text-ink-500">No spam senders yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-ink-800 rounded-md border border-ink-800">
              {spamSenders.map((addr) => (
                <li key={addr} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-200">
                    {addr}
                  </span>
                  <button
                    onClick={() => onRemoveSpam(addr)}
                    className="text-ink-400 hover:text-ink-100"
                    title="Remove"
                  >
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Auth senders */}
        <section className="card p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink-100">
                <ShieldCheck size={13} className="text-accent-400" /> Auth senders
              </h2>
              <p className="mt-0.5 text-xs text-ink-400">
                Emails from these senders are always treated as auth/2FA — they get the shield, show
                in the 2FA filter, and trigger the popover when they contain a code or link. Add via
                the <ShieldCheck size={11} className="inline" /> button in any email's preview.
              </p>
            </div>
            <span className="text-[11px] tabular-nums text-ink-500">{authSenders.length}</span>
          </div>

          {authSenders.length === 0 ? (
            <p className="mt-3 text-center text-xs text-ink-500">No auth senders yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-ink-800 rounded-md border border-ink-800">
              {authSenders.map((addr) => (
                <li key={addr} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-200">
                    {addr}
                  </span>
                  <button
                    onClick={() => onRemoveAuth(addr)}
                    className="text-ink-400 hover:text-ink-100"
                    title="Remove"
                  >
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Linked accounts */}
        <div className="card divide-y divide-ink-800">
          {accounts === null ? (
            <p className="px-4 py-6 text-center text-sm text-ink-400">Loading…</p>
          ) : accounts.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-ink-400">
              No accounts linked yet. {configured ? 'Click the button below to connect your first Gmail.' : 'Save your Client ID above, then come back here.'}
            </p>
          ) : (
            accounts.map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink-100">{a.email}</span>
                    {a.status === 'needs_reauth' ? (
                      <span className="inline-flex items-center gap-1 rounded bg-amber-950/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-300">
                        <ShieldAlert size={9} /> Needs reauth
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
                        <CheckCircle2 size={11} /> ok
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] text-ink-500">
                    {a.last_synced_at
                      ? `Last synced ${new Date(a.last_synced_at).toLocaleString()}`
                      : 'Not yet synced'}
                  </p>
                </div>
                <button
                  onClick={() => onDisconnect(a)}
                  className="btn-ghost !px-2 !py-1.5 !text-red-400 hover:!bg-red-950/40"
                  title="Disconnect"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="flex justify-end">
          <button
            onClick={onConnect}
            disabled={connecting || !configured}
            className="btn-primary"
            title={!configured ? 'Save your Client ID first' : undefined}
          >
            <Plus size={14} /> {connecting ? 'Waiting for Google…' : 'Connect Google account'}
          </button>
        </div>
      </div>
    </Layout>
  )
}
