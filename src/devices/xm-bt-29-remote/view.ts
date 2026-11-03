import { cmiotA15RemoteButtonIds, cmiotA15RemoteView } from '../cmiot-a15-remote/view.ts'

// XM-BT-29 currently uses the same artwork and button layout as CMIOT-A15.
export const xmBt29RemoteButtonIds = cmiotA15RemoteButtonIds
export const xmBt29RemoteView = cmiotA15RemoteView

export { cmiotA15RemoteButtons as xmBt29RemoteButtons } from '../cmiot-a15-remote/view.ts'
