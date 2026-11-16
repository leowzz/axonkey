import { createDescriptorView, type DescriptorInputId } from '../shared/descriptorSvg.ts'

export type CmiotA15RemoteButtonId = DescriptorInputId<'cmiot-a15'>
export const cmiotA15RemoteView = createDescriptorView('cmiot-a15')
export const cmiotA15RemoteButtons = cmiotA15RemoteView.buttons
export const cmiotA15RemoteButtonIds = cmiotA15RemoteButtons.map(button => button.id)
