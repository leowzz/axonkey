import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Vector } from 'sequential-workflow-designer'
import type { DesignerApi, ToolboxGroupConfiguration } from 'sequential-workflow-designer'

export type WorkflowToolboxPalette = {
  name: string
  groups: ToolboxGroupConfiguration[]
}

export function WorkflowToolbox({ api, palettes, iconUrls }: {
  api: DesignerApi
  palettes: WorkflowToolboxPalette[]
  iconUrls: Record<string, string>
}) {
  const id = useId()
  const [expanded, setExpanded] = useState<Record<number, boolean>>({ 0: true })
  const [queries, setQueries] = useState<Record<number, string>>({})

  return <>{palettes.map((palette, index) => {
    const open = expanded[index] ?? false
    const query = queries[index] ?? ''
    const filter = query.trim().toLocaleLowerCase()
    const groups = palette.groups.map((group) => ({
      ...group,
      steps: group.steps.filter((step) => `${step.name} ${step.properties.description ?? ''}`.toLocaleLowerCase().includes(filter)),
    })).filter((group) => group.steps.length > 0)

    return <section key={palette.name} className={`workflow-toolbox-section ${open ? 'is-open' : ''}`}>
      <h2 className="workflow-toolbox-heading">
        <button
          id={`${id}-heading-${index}`}
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-panel-${index}`}
          onClick={() => setExpanded((current) => ({ ...current, [index]: !open }))}
        >{palette.name}<ChevronDown size={16} aria-hidden="true" /></button>
      </h2>
      <div id={`${id}-panel-${index}`} role="region" aria-labelledby={`${id}-heading-${index}`} className="workflow-toolbox-content" hidden={!open}>
        <div className="sqd-toolbox-filter">
          <input
            className="sqd-toolbox-filter-input"
            type="search"
            aria-label={`搜索${palette.name}积木`}
            placeholder={`搜索${palette.name}积木…`}
            value={query}
            onChange={(event) => setQueries((current) => ({ ...current, [index]: event.target.value }))}
          />
        </div>
        <div className="workflow-toolbox-list">
          {groups.map((group) => <section key={group.name} aria-label={group.name}>
            {palette.groups.length > 1 && <h3 className="sqd-toolbox-group-title">{group.name}</h3>}
            {group.steps.map((step) => <div
              key={step.type}
              className={`sqd-toolbox-item sqd-type-${step.type}`}
              title={String(step.properties.description || step.name)}
              onMouseDown={(event) => {
                if (event.button !== 0) return
                event.preventDefault()
                event.stopPropagation()
                api.toolbox.tryDrag(new Vector(event.clientX, event.clientY), step)
              }}
              onTouchStart={(event) => {
                if (event.touches.length !== 1) return
                event.preventDefault()
                event.stopPropagation()
                const touch = event.touches[0]
                api.toolbox.tryDrag(new Vector(touch.clientX, touch.clientY), step)
              }}
            >
              <span className="sqd-toolbox-item-icon"><img className="sqd-toolbox-item-icon-image" src={iconUrls[step.type]} alt="" draggable={false} /></span>
              <span className="sqd-toolbox-item-text">{step.name}</span>
            </div>)}
          </section>)}
          {groups.length === 0 && <p className="workflow-toolbox-empty">没有匹配的积木</p>}
        </div>
      </div>
    </section>
  })}</>
}
