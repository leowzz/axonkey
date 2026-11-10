import { createDescriptorView } from '../shared/descriptorSvg.ts'

export const rc313RemoteView = createDescriptorView('rc313')
export const rc313RemoteButtons = rc313RemoteView.buttons
export const rc313RemoteButtonIds = rc313RemoteButtons.map(button => button.id)
