import type { ReactNode } from 'react'
import { DriverMigrationFlow } from './DriverMigrationDialog'

export function LegacyCleanupFlow({ children, onComplete }: { children?: ReactNode; onComplete?: () => void }) {
  return (
    <DriverMigrationFlow kind="legacyCleanup" onComplete={onComplete}>
      {children}
    </DriverMigrationFlow>
  )
}
