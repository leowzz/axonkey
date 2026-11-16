import { createDescriptorView } from '../shared/descriptorSvg.ts'

export const kivoK18LiteView = createDescriptorView('kivo-k18-lite')
export const kivoK18LiteButtons = kivoK18LiteView.buttons
export const kivoK18LiteButtonIds = kivoK18LiteButtons.map(button => button.id)
