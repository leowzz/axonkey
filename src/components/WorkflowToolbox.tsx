import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Vector } from 'sequential-workflow-designer'
import type { DesignerApi, ToolboxGroupConfiguration } from 'sequential-workflow-designer'

export type WorkflowToolboxPalette = {
  name: string
  groups: ToolboxGroupConfiguration[]
}

export function WorkflowToolbox({ api, palettes, iconUrls, expandedIndex, onExpandedChange }: {
  api: DesignerApi
  palettes: WorkflowToolboxPalette[]
  iconUrls: Record<string, string>
  expandedIndex: number | null
  onExpandedChange: (index: number | null) => void
}) {
  const id = useId()
  const [query, setQuery] = useState('')
  const filter = query.trim().toLocaleLowerCase()
  const filteredPalettes = palettes.map((palette, index) => ({
    palette,
    index,
    groups: palette.groups.map((group) => ({
      ...group,
      steps: group.steps.filter((step) => `${palette.name} ${group.name} ${step.name} ${step.properties.description ?? ''}`.toLocaleLowerCase().includes(filter)),
    })).filter((group) => group.steps.length > 0),
  })).filter(({ groups }) => groups.length > 0)

  return <>
    <div className="workflow-toolbox-search sqd-toolbox-filter">
      <input
        className="sqd-toolbox-filter-input"
        type="search"
        aria-label="搜索行为"
        placeholder="搜索行为"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
    </div>
    <div className="workflow-toolbox-scroll">
      {filteredPalettes.map(({ palette, index, groups }) => {
        // A search should reveal matches from every category at once, even if
        // the category was collapsed before the query was entered.
        const open = filter.length > 0 || expandedIndex === index

        return <section key={palette.name} className={`workflow-toolbox-section ${open ? 'is-open' : ''}`}>
          <h2 className="workflow-toolbox-heading">
            <button
              id={`${id}-heading-${index}`}
              type="button"
              aria-expanded={open}
              aria-controls={`${id}-panel-${index}`}
              onClick={() => onExpandedChange(open ? null : index)}
            >
              <span className="workflow-toolbox-heading-label">{palette.name}</span>
              <span className="workflow-toolbox-heading-action">
                <span className="workflow-toolbox-heading-state">{open ? '收起' : '展开'}</span>
                <ChevronDown size={18} aria-hidden="true" />
              </span>
            </button>
          </h2>
          <div id={`${id}-panel-${index}`} role="region" aria-labelledby={`${id}-heading-${index}`} className="workflow-toolbox-content" hidden={!open}>
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
            </div>
          </div>
        </section>
      })}
      {filteredPalettes.length === 0 && <p className="workflow-toolbox-empty">没有匹配的行为</p>}
    </div>
  </>
}
