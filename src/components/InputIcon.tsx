import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Command,
  Delete,
  Hash,
  Home,
  LocateFixed,
  Menu,
  Mic,
  Power,
  Settings,
  Tv,
  Undo2,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react'
import type { RemoteButton } from '../appTypes'

export const iconFor = (kind: RemoteButton['icon'], size = 16) => {
  const props = { size, strokeWidth: 1.8 }
  switch (kind) {
    case 'power':
      return <Power {...props} />
    case 'locate':
      return <LocateFixed {...props} />
    case 'mic':
      return <Mic {...props} />
    case 'up':
      return <ChevronUp {...props} />
    case 'left':
      return <ChevronLeft {...props} />
    case 'right':
      return <ChevronRight {...props} />
    case 'down':
      return <ChevronDown {...props} />
    case 'back':
      return <Undo2 {...props} />
    case 'volumeUp':
      return <Volume2 {...props} />
    case 'volumeDown':
      return <Volume1 {...props} />
    case 'home':
      return <Home {...props} />
    case 'menu':
      return <Menu {...props} />
    case 'tv':
      return <Tv {...props} />
    case 'mute':
      return <VolumeX {...props} />
    case 'settings':
      return <Settings {...props} />
    case 'number':
      return <Hash {...props} />
    case 'delete':
      return <Delete {...props} />
    case 'm':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          aria-hidden="true"
        >
          <path d="M5 19V5l7 10 7-10v14" />
        </svg>
      )
    default:
      return <Command {...props} />
  }
}
