import { Eye, EyeOff } from 'lucide-react'
import type { VisibilityTier } from '../lib/items'

const styles: Record<VisibilityTier, string> = {
  low: 'bg-ink-700/60 text-ink-200',
  medium: 'bg-amber-900/40 text-amber-200',
  high: 'bg-red-900/40 text-red-200',
}

const labels: Record<VisibilityTier, string> = {
  low: 'Visible',
  medium: 'Click to reveal',
  high: 'Hidden — copy only',
}

export default function TierBadge({ tier, compact = false }: { tier: VisibilityTier; compact?: boolean }) {
  const Icon = tier === 'low' || tier === 'medium' ? Eye : EyeOff
  return (
    <span className={`badge ${styles[tier]}`}>
      <Icon size={10} />
      {!compact && labels[tier]}
    </span>
  )
}
