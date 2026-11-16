import { createDescriptorView, type DescriptorInputId } from '../shared/descriptorSvg.ts'

export type TclRc902nRemoteButtonId = DescriptorInputId<'tcl-rc902n'>
export const tclRc902nRemoteView = createDescriptorView('tcl-rc902n')
export const tclRc902nRemoteButtons = tclRc902nRemoteView.buttons
export const tclRc902nRemoteButtonIds = tclRc902nRemoteButtons.map(button => button.id)
