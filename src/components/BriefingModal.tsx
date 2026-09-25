import { Sparkles, X } from 'lucide-react'

/**
 * The once-a-day "here's your day" card from Claude. Plain-text content
 * (the system prompt forbids markdown), rendered with preserved line breaks.
 */
export default function BriefingModal({
  content,
  generatedAt,
  onClose,
}: {
  content: string
  generatedAt: string
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-lg p-0 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b border-ink-800 px-5 py-4">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-accent-600/15 text-accent-300">
            <Sparkles size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-ink-50">Your daily brief</h2>
            <p className="text-[11px] text-ink-500">
              {new Date(generatedAt).toLocaleString(undefined, {
                weekday: 'long',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          </div>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-100" aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-100">{content}</p>
        </div>
        <footer className="flex justify-end border-t border-ink-800 px-5 py-3">
          <button onClick={onClose} className="btn-primary !px-4 !py-1.5 !text-xs">
            Let's go
          </button>
        </footer>
      </div>
    </div>
  )
}
