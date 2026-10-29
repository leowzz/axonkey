import { ConfigMigrationFlow } from './components/ConfigMigrationFlow'
import { DriverMigrationFlow } from './components/DriverMigrationDialog'
import { LegacyCleanupFlow } from './components/LegacyCleanupDialog'

export default function App() {
  return (
    <LegacyCleanupFlow>
      <DriverMigrationFlow>
        <ConfigMigrationFlow />
      </DriverMigrationFlow>
    </LegacyCleanupFlow>
  )
}
