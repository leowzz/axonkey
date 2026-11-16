import { createDescriptorView, type DescriptorInputId } from '../shared/descriptorSvg.ts'

export type PhicommDb1RRemoteButtonId = DescriptorInputId<'phicomm-db1-r'>
export const phicommDb1RRemoteView = createDescriptorView('phicomm-db1-r')
export const phicommDb1RRemoteButtons = phicommDb1RRemoteView.buttons
export const phicommDb1RRemoteButtonIds = phicommDb1RRemoteButtons.map(button => button.id)
