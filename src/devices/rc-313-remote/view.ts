import { remoteViewFor } from '../packages.ts'

export const rc313RemoteView = remoteViewFor('rc313')
export const rc313RemoteButtons = rc313RemoteView.buttons
export const rc313RemoteButtonIds = rc313RemoteButtons.map(button => button.id)
