import { createDescriptorView } from '../shared/descriptorSvg.ts'

export const g17TouchView = createDescriptorView('g17-touch')
export const g17TouchButtons = g17TouchView.buttons
export const g17TouchButtonIds = g17TouchButtons.map(button => button.id)
