import { FileText, Key, Lock, Sparkles } from 'lucide-react'
import type { ItemType } from '../lib/items'

interface Props {
  type: ItemType | string
  size?: number
  className?: string
}

export default function TypeIcon({ type, size = 16, className = '' }: Props) {
  switch (type) {
    case 'login':
      return <Lock size={size} className={className} />
    case 'api_key':
      return <Key size={size} className={className} />
    case 'note':
      return <FileText size={size} className={className} />
    default:
      return <Sparkles size={size} className={className} />
  }
}

export function typeLabel(type: ItemType | string): string {
  switch (type) {
    case 'login':
      return 'Login'
    case 'api_key':
      return 'API key'
    case 'note':
      return 'Secure note'
    default:
      return type
  }
}
