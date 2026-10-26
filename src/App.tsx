import AppController from './app/index'
import { DriverMigrationFlow } from './components/DriverMigrationDialog'

export default function App() {
  return (
    <DriverMigrationFlow>
      <AppController />
    </DriverMigrationFlow>
  )
}
