export type Application = { id: string; name: string; path: string }
export type ApplicationProfile = { application: Application; profileId: string }
export type ForegroundApplications = {
  supported: boolean
  current: Application | null
  recent: { application: Application; lastUsedAt: number }[]
  error: string | null
}
