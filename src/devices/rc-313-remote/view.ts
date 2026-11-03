import { cmiotA15RemoteButtonIds, cmiotA15RemoteView } from '../cmiot-a15-remote/view.ts'

// RC-313 currently uses the same artwork and button layout as CMIOT-A15.
export const rc313RemoteButtonIds = cmiotA15RemoteButtonIds
export const rc313RemoteView = cmiotA15RemoteView

export { cmiotA15RemoteButtons as rc313RemoteButtons } from '../cmiot-a15-remote/view.ts'
