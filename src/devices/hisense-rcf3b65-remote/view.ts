import { createDescriptorView, type DescriptorInputId } from '../shared/descriptorSvg.ts'

export type HisenseRcf3b65RemoteButtonId = DescriptorInputId<'hisense-rcf3b65'>
export const hisenseRcf3b65RemoteView = createDescriptorView('hisense-rcf3b65')
export const hisenseRcf3b65RemoteButtons = hisenseRcf3b65RemoteView.buttons
export const hisenseRcf3b65RemoteButtonIds = hisenseRcf3b65RemoteButtons.map(button => button.id)
