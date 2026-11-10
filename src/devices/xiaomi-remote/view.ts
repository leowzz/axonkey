import { createDescriptorView, type DescriptorInputId } from '../shared/descriptorSvg.ts'

export type XiaomiRemoteButtonId = DescriptorInputId<'rc003'>
export const xiaomiRemoteView = createDescriptorView('rc003')
export const xiaomiRemoteButtons = xiaomiRemoteView.buttons
export const xiaomiRemoteButtonIds = xiaomiRemoteButtons.map(button => button.id)
