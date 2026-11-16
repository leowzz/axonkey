import { createDescriptorView, type DescriptorInputId } from '../shared/descriptorSvg.ts'

export type XmBt29RemoteButtonId = DescriptorInputId<'xm-bt-29'>
export const xmBt29RemoteView = createDescriptorView('xm-bt-29')
export const xmBt29RemoteButtons = xmBt29RemoteView.buttons
export const xmBt29RemoteButtonIds = xmBt29RemoteButtons.map(button => button.id)
