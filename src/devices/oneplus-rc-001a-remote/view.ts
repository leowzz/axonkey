import { createDescriptorView, type DescriptorInputId } from '../shared/descriptorSvg.ts'

export type OneplusRc001aRemoteButtonId = DescriptorInputId<'oneplus-rc-001a'>
export const oneplusRc001aRemoteView = createDescriptorView('oneplus-rc-001a')
export const oneplusRc001aRemoteButtons = oneplusRc001aRemoteView.buttons
export const oneplusRc001aRemoteButtonIds = oneplusRc001aRemoteButtons.map(button => button.id)
