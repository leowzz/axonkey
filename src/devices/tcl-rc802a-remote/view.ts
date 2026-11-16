import { createDescriptorView, type DescriptorInputId } from '../shared/descriptorSvg.ts'

export type TclRc802aRemoteButtonId = DescriptorInputId<'tcl-rc802a'>
export const tclRc802aRemoteView = createDescriptorView('tcl-rc802a')
export const tclRc802aRemoteButtons = tclRc802aRemoteView.buttons
export const tclRc802aRemoteButtonIds = tclRc802aRemoteButtons.map(button => button.id)
