import { remoteViewFor } from '../packages.ts'

export { cmiotA15RemoteButtonIds, cmiotA15RemoteButtons } from './buttons.ts'
export { cmiotA15RemoteKeyRegions, cmiotA15RemoteViewBox } from './geometry.ts'
export const cmiotA15RemoteView = remoteViewFor('cmiotA15')
