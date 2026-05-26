import { Loader2 } from 'lucide-react'

export default function FullPageLoader({ label }: { label?: string }) {
  return (
    <div className="flex h-full items-center justify-center bg-ink-950">
      <div className="flex flex-col items-center gap-3 text-ink-300">
        <Loader2 className="h-6 w-6 animate-spin" />
        {label && <p className="text-sm">{label}</p>}
      </div>
    </div>
  )
}
