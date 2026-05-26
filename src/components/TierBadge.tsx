import { Eye, EyeOff, KeyRound } from 'lucide-react'
import type { VisibilityTier } from '../lib/items'

const styles: Record<VisibilityTier, string> = {
  low: 'bg-ink-700/60 text-ink-200',
  medium: 'bg-amber-900/40 text-amber-200',
  high: 'bg-red-900/40 text-red-200',
}

const labels: Record<VisibilityTier, string> = {
  low: 'Visible',
  medium: 'Reveal w/ password',
  high: 'Hidden — copy only',
}

export default function TierBadge({ tier, compact = false }: { tier: VisibilityTier; compact?: boolean }) {
  const Icon = tier === 'low' ? Eye : tier === 'medium' ? KeyRound : EyeOff
  return (
    <span className={`badge ${styles[tier]}`}>
      <Icon size={10} />
      {!compact && labels[tier]}
    </span>
  )
}
