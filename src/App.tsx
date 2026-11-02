import { ConfigMigrationFlow } from './components/ConfigMigrationFlow'
import { DriverMigrationFlow } from './components/DriverMigrationDialog'
import { LegacyCleanupFlow } from './components/LegacyCleanupDialog'
import { VirtualAudioUpgradeFlow } from './components/VirtualAudioUpgradeFlow'

export default function App() {
  return (
    <LegacyCleanupFlow>
      <DriverMigrationFlow>
        <VirtualAudioUpgradeFlow>
          <ConfigMigrationFlow />
        </VirtualAudioUpgradeFlow>
      </DriverMigrationFlow>
    </LegacyCleanupFlow>
  )
}
