import AppController from './app/index'
import { DriverMigrationFlow } from './components/DriverMigrationDialog'
import { LegacyCleanupFlow } from './components/LegacyCleanupDialog'

export default function App() {
  return (
    <LegacyCleanupFlow>
      <DriverMigrationFlow>
        <AppController />
      </DriverMigrationFlow>
    </LegacyCleanupFlow>
  )
}
