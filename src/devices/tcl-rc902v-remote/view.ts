import { createDescriptorView, type DescriptorInputId } from '../shared/descriptorSvg.ts'

export type TclRc902vRemoteButtonId = DescriptorInputId<'tcl-rc902v'>
export const tclRc902vRemoteView = createDescriptorView('tcl-rc902v')
export const tclRc902vRemoteButtons = tclRc902vRemoteView.buttons
export const tclRc902vRemoteButtonIds = tclRc902vRemoteButtons.map(button => button.id)
