import { createDescriptorView, type DescriptorInputId } from '../shared/descriptorSvg.ts'

export type ObeRcuR5RemoteButtonId = DescriptorInputId<'obe-rcu-r5'>
export const obeRcuR5RemoteView = createDescriptorView('obe-rcu-r5')
export const obeRcuR5RemoteButtons = obeRcuR5RemoteView.buttons
export const obeRcuR5RemoteButtonIds = obeRcuR5RemoteButtons.map(button => button.id)
