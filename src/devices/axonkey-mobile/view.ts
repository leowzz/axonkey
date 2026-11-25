import { createDescriptorView } from '../shared/descriptorSvg.ts'

export const axonkeyMobileView = createDescriptorView('axonkey-mobile')
export const axonkeyMobileButtons = axonkeyMobileView.buttons
export const axonkeyMobileButtonIds = axonkeyMobileButtons.map(button => button.id)
