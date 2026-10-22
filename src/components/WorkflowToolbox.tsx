import { useState } from 'react'
import { Search } from 'lucide-react'
import { Vector } from 'sequential-workflow-designer'
import type { DesignerApi, ToolboxGroupConfiguration } from 'sequential-workflow-designer'

export type WorkflowToolboxPalette = {
  name: string
  groups: ToolboxGroupConfiguration[]
}

export function WorkflowToolbox({ api, palettes, iconUrls, selectedCategory, onCategoryChange }: {
  api: DesignerApi
  palettes: WorkflowToolboxPalette[]
  iconUrls: Record<string, string>
  selectedCategory: string
  onCategoryChange: (category: string) => void
}) {
  const [query, setQuery] = useState('')
  const filter = query.trim().toLocaleLowerCase()
  const categories = palettes.flatMap((palette) => palette.groups.map((group) => ({
    id: `${palette.name}/${group.name}`,
    palette: palette.name,
    ...group,
  }))).filter((group) => group.steps.length > 0)
  const currentCategory = categories.some((group) => group.id === selectedCategory) ? selectedCategory : 'all'
  const visibleGroups = categories
    .filter((group) => filter || currentCategory === 'all' || group.id === currentCategory)
    .map((group) => ({
      ...group,
      steps: group.steps.filter((step) => `${group.palette} ${group.name} ${step.name} ${step.properties.description ?? ''}`.toLocaleLowerCase().includes(filter)),
    })).filter((group) => group.steps.length > 0)

  return <>
    <h2 className="workflow-toolbox-title">行为库</h2>
    <div className="workflow-toolbox-search sqd-toolbox-filter">
      <label className="workflow-toolbox-search-field">
        <Search size={16} strokeWidth={1.8} aria-hidden="true" />
        <input
          className="sqd-toolbox-filter-input"
          type="search"
          aria-label="搜索行为"
          placeholder="搜索行为或预置"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
    </div>
    <div className="workflow-toolbox-browser">
      <nav className="workflow-toolbox-categories" aria-label="行为分类">
        <button type="button" aria-pressed={!filter && currentCategory === 'all'} onClick={() => { setQuery(''); onCategoryChange('all') }}>全部</button>
        {categories.map((group) => <button type="button" key={group.id} aria-pressed={!filter && currentCategory === group.id} onClick={() => { setQuery(''); onCategoryChange(group.id) }}>{group.name}</button>)}
      </nav>
      <div className="workflow-toolbox-list" aria-label={filter ? '行为搜索结果' : '可选行为'}>
        {visibleGroups.map((group) => <section key={group.id} aria-label={group.name}>
          <h3 className="sqd-toolbox-group-title">{group.name}</h3>
          {group.steps.map((step) => <div
            key={step.type}
            className={`sqd-toolbox-item sqd-type-${step.type}`}
            title={step.name}
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
        {visibleGroups.length === 0 && <p className="workflow-toolbox-empty">没有匹配的行为</p>}
      </div>
    </div>
  </>
}
