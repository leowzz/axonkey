import type { RemoteButton } from '../../appTypes'
import { deviceDescriptors } from '../generatedDescriptors.ts'
import type { RemoteView } from '../types.ts'

type DescriptorName = keyof typeof deviceDescriptors
export type DescriptorInputId<Name extends DescriptorName> = (typeof deviceDescriptors)[Name]['inputs'][number]['id']

export function createDescriptorView<Name extends DescriptorName>(name: Name): RemoteView<DescriptorInputId<Name>> {
  const descriptor = deviceDescriptors[name]
  const buttons = descriptor.inputs.map(input => ({
    id: input.id as DescriptorInputId<Name>,
    label: input.label,
    short: input.short,
    icon: input.icon as RemoteButton['icon'],
    side: input.anchor.x < descriptor.viewBox.width / 2 ? ('left' as const) : ('right' as const),
    x: (input.anchor.x / descriptor.viewBox.width) * 100,
    y: (input.anchor.y / descriptor.viewBox.height) * 100,
  }))
  return {
    buttons,
    viewBox: descriptor.viewBox,
    keyRegions: Object.fromEntries(
      descriptor.inputs.map(input => [
        input.id,
        {
          path: input.path,
          anchor: input.anchor,
          ...('transform' in input ? { transform: input.transform } : {}),
        },
      ]),
    ),
    artworkUrl: descriptor.artworkUrl,
    ariaLabel: descriptor.ariaLabel,
  }
}
