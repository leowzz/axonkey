(function () {
  const DATA = window.QUICK_OVERLAY_CONFIG_DATA
  if (!DATA) return

  let stepSeq = 100
  function nextStepId() {
    stepSeq += 1
    return 'st-' + stepSeq
  }

  function cloneDevices(source) {
    return JSON.parse(JSON.stringify(source))
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  const initialSelection = {
    rc003: 'xiaomi.rc003.confirm',
    mouse: 'mouse.forward',
    k18: 'k18.k02',
    xbox: 'xbox.a',
  }

  const state = {
    scheme: '01',
    stage: 'entry',
    deviceId: 'rc003',
    devices: cloneDevices(DATA.devices),
    selectedInputByDevice: { ...initialSelection },
    selectedStepId: 's-c1',
    toolboxCategory: 'all',
    toolboxQuery: '',
    toolboxItems: JSON.parse(JSON.stringify(DATA.toolboxItems)),
    subwsSidebarTab: 'list',
    dragPayload: null,
    previewOpen: false,
    diffOpen: false,
  }

  const rootEl = document.getElementById('studio-shell')
  const stageEl = document.getElementById('studio-stage')
  const summaryEl = document.getElementById('scheme-summary-bar')
  const hudBackdropEl = document.getElementById('hud-preview-backdrop')
  const diffPopoverEl = document.getElementById('legacy-diff-popover')
  const diffBtnEl = document.getElementById('legacy-diff-btn')
  const toastEl = document.getElementById('studio-toast')

  let toastTimer = null
  function showToast(msg) {
    if (!toastEl) return
    toastEl.textContent = msg
    toastEl.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toastEl.hidden = true
    }, 2400)
  }

  function currentDevice() {
    return state.devices[state.deviceId]
  }

  function currentInput() {
    const dev = currentDevice()
    const id = state.selectedInputByDevice[dev.id] || dev.triggerInputId
    return dev.inputs[id] || Object.values(dev.inputs)[0]
  }

  function syncSelectedStepForInput(input) {
    if (!input || !input.steps.length) {
      state.selectedStepId = null
      return
    }
    if (!input.steps.some(s => s.id === state.selectedStepId)) {
      state.selectedStepId = input.steps[0].id
    }
  }

  function activeSteps(input) {
    return (input.steps || []).filter(s => s.enabled !== false)
  }

  function stepShortParam(step) {
    if (step.type === 'shortcut') return step.keys || '快捷键'
    if (step.type === 'delay') return `${Number(step.ms) || 0} ms`
    if (step.type === 'paste') return (step.text || '').trim().slice(0, 18) || '文本片段'
    if (step.type === 'typeText') return (step.text || '').trim().slice(0, 18) || '键入文本'
    if (step.type === 'media') return step.command || '媒体'
    if (step.type === 'openApp' || step.type === 'openWebsite') return step.target || '目标路径'
    if (step.type === 'wheel') return step.direction || '滚动'
    return step.name || '步骤'
  }

  function stepTitle(step) {
    return (step.alias && step.alias.trim()) || step.name || stepShortParam(step)
  }

  function stepIcon(step) {
    if (step.type === 'shortcut') return '⌘'
    if (step.type === 'delay') return '⏱'
    if (step.type === 'paste') return '📋'
    if (step.type === 'typeText') return '⌨'
    if (step.type === 'media') return '▶'
    if (step.type === 'openApp' || step.type === 'openWebsite') return '↗'
    if (step.type === 'wheel') return '↕'
    return '•'
  }

  function formatCeramicInfo(input) {
    if (input.isTrigger) {
      return {
        isTrigger: true,
        isEmpty: false,
        badge: '再按退出',
        badgeClass: 'is-exit',
        title: '唤起与退出',
      }
    }
    const enabled = activeSteps(input)
    if (enabled.length === 0) {
      return {
        isTrigger: false,
        isEmpty: true,
        badge: '',
        badgeClass: '',
        title: '单击未配置',
      }
    }
    if (enabled.length === 1) {
      const only = enabled[0]
      return {
        isTrigger: false,
        isEmpty: false,
        badge: stepShortParam(only),
        badgeClass: '',
        title: stepTitle(only),
      }
    }
    const meaningful = enabled.find(s => s.type !== 'delay') || enabled[0]
    return {
      isTrigger: false,
      isEmpty: false,
      badge: `${enabled.length} 步组合`,
      badgeClass: 'is-multi',
      title: stepTitle(meaningful),
    }
  }

  function countConfiguredInputs(device) {
    return Object.values(device.inputs).filter(inp => !inp.isTrigger && activeSteps(inp).length > 0).length
  }

  function configuredInputsList(device) {
    return Object.values(device.inputs).filter(inp => inp.isTrigger || activeSteps(inp).length > 0)
  }

  /* ==========================================================================
     Shared Ceramic Surface HTML Renderer (Scheme 05 Faithful Keycaps)
     ========================================================================== */

  function renderCeramicKeyTile(input, opts) {
    const info = formatCeramicInfo(input)
    const selected = opts.selectedInputId === input.id
    const classes = [
      'ceramic-key',
      info.isTrigger ? 'is-trigger' : '',
      info.isEmpty ? 'is-empty' : '',
      selected && opts.selectable !== false ? 'is-selected' : '',
      input.span ? `span-${input.span}` : '',
      opts.extraClass || '',
    ]
      .filter(Boolean)
      .join(' ')

    const dropAttr = opts.droppable ? `data-drop-input="${escapeHtml(input.id)}"` : ''
    const selectAttr =
      opts.selectable !== false
        ? `data-select-input="${escapeHtml(input.id)}"`
        : opts.previewClickable
          ? `data-preview-trigger-key="${escapeHtml(input.id)}"`
          : ''

    return `
      <button
        type="button"
        class="${classes}"
        ${selectAttr}
        ${dropAttr}
        data-key-tile="${escapeHtml(input.id)}"
        aria-label="${escapeHtml(input.label)} · ${escapeHtml(info.title)}"
      >
        <span class="ck-top">
          <span class="ck-name">${escapeHtml(input.short)}</span>
          ${info.badge ? `<span class="ck-badge ${info.badgeClass}">${escapeHtml(info.badge)}</span>` : ''}
        </span>
        <span class="ck-action">${escapeHtml(info.title)}</span>
      </button>
    `
  }

  function renderCeramicBody(device, opts) {
    const layout = device.layout
    if (layout.kind === 'panel') {
      const blocks = layout.mainGroups
        .map(group => {
          if (group.type === 'row') {
            return `
              <div class="ceramic-row cols-${group.cols}">
                ${group.items.map(id => renderCeramicKeyTile(device.inputs[id], opts)).join('')}
              </div>
            `
          }
          if (group.type === 'cross') {
            return `
              <div class="ceramic-cross">
                ${['up', 'left', 'center', 'right', 'down']
                  .map(pos => {
                    const inp = device.inputs[group.items[pos]]
                    return renderCeramicKeyTile(inp, { ...opts, extraClass: `pos-${pos}` })
                  })
                  .join('')}
              </div>
            `
          }
          if (group.type === 'rocker') {
            return `
              <div class="ceramic-row cols-2">
                ${group.items.map(id => renderCeramicKeyTile(device.inputs[id], opts)).join('')}
              </div>
            `
          }
          return ''
        })
        .join('')
      return `<div class="ceramic-panel-stack">${blocks}</div>`
    }

    if (layout.kind === 'matrix') {
      return `
        <div class="ceramic-matrix-grid">
          ${layout.items.map(id => renderCeramicKeyTile(device.inputs[id], opts)).join('')}
        </div>
      `
    }

    if (layout.kind === 'controller') {
      return `
        <div class="ceramic-controller-grid">
          <div class="ceramic-pod">
            ${layout.leftPod
              .map((id, idx) => renderCeramicKeyTile(device.inputs[id], { ...opts, extraClass: idx === 0 ? 'span-2' : '' }))
              .join('')}
          </div>
          <div class="ceramic-bridge">
            ${layout.bridge.map(id => renderCeramicKeyTile(device.inputs[id], opts)).join('')}
          </div>
          <div class="ceramic-pod">
            ${layout.rightPod
              .map((id, idx) => renderCeramicKeyTile(device.inputs[id], { ...opts, extraClass: idx === 0 ? 'span-2' : '' }))
              .join('')}
          </div>
        </div>
      `
    }

    if (layout.kind === 'mouse') {
      return `
        <div class="ceramic-mouse-scopes">
          ${layout.scopes
            .map(
              scope => `
            <div>
              <div class="ceramic-scope-label">${escapeHtml(scope.title)}</div>
              <div class="ceramic-mouse-grid">
                ${scope.items.map(id => renderCeramicKeyTile(device.inputs[id], opts)).join('')}
              </div>
            </div>
          `,
            )
            .join('')}
        </div>
      `
    }
    return ''
  }

  function renderCeramicSurface(device, opts) {
    const shellClasses = [
      'ceramic-shell',
      `variant-${device.variant}`,
      opts.compact ? 'is-compact' : '',
      opts.largeHud ? 'is-hud-large' : '',
    ]
      .filter(Boolean)
      .join(' ')

    const showHead = opts.showHead !== false
    return `
      <div class="${shellClasses}" data-ceramic-device="${escapeHtml(device.id)}">
        ${
          showHead
            ? `<div class="ceramic-shell-head">
                <div class="ceramic-head-title">
                  <span class="ceramic-mode-pill">${opts.largeHud ? '快捷交互窗 · 仅单击' : '实时键帽面板'}</span>
                  <span class="ceramic-title-text">${escapeHtml(device.overlayTitle)}</span>
                </div>
                <span class="ceramic-exit-badge">再按 ${escapeHtml(device.triggerName)} 退出</span>
              </div>`
            : ''
        }
        ${renderCeramicBody(device, opts)}
      </div>
    `
  }

  /* ==========================================================================
     Single-Click Workflow Canvas + Bottom Step Editor + Action Toolbox
     ========================================================================== */

  function renderStepEditor(device, input) {
    if (input.isTrigger) {
      return `<div class="wf-step-editor"><div class="wf-editor-placeholder">触发键由外层控制，不可绑定内部单击动作</div></div>`
    }
    const step = input.steps.find(s => s.id === state.selectedStepId) || input.steps[0]
    if (!step) {
      return `<div class="wf-step-editor"><div class="wf-editor-placeholder">从右侧工具箱拖入动作或预设组合，即可配置「${escapeHtml(input.label)}」单击序列</div></div>`
    }
    const stepIndex = input.steps.findIndex(s => s.id === step.id)

    let paramFields = ''
    if (step.type === 'shortcut') {
      paramFields = `
        <div class="wf-editor-row">
          <span class="wf-editor-label">按键组合</span>
          <input class="ax-input" style="width:140px;font-weight:700" data-edit-field="keys" value="${escapeHtml(step.keys || '')}" />
          ${DATA.shortcutPresets
            .slice(0, 8)
            .map(
              k =>
                `<button type="button" class="preset-pill ${step.keys === k ? 'is-active' : ''}" data-preset-key="${escapeHtml(k)}">${escapeHtml(k)}</button>`,
            )
            .join('')}
        </div>
      `
    } else if (step.type === 'paste' || step.type === 'typeText') {
      paramFields = `
        <div class="wf-editor-row" style="align-items:flex-start">
          <span class="wf-editor-label" style="padding-top:6px">${step.type === 'paste' ? '粘贴内容' : '键入文本'}</span>
          <textarea class="wf-textarea" style="flex:1" data-edit-field="text" placeholder="输入文本或 AI Prompt…">${escapeHtml(step.text || '')}</textarea>
        </div>
      `
    } else if (step.type === 'delay') {
      paramFields = `
        <div class="wf-editor-row">
          <span class="wf-editor-label">延时毫秒</span>
          <input class="ax-input" type="number" min="10" max="5000" step="10" style="width:96px" data-edit-field="ms" value="${Number(step.ms) || 30}" />
          ${[20, 30, 50, 100, 200]
            .map(
              ms =>
                `<button type="button" class="preset-pill ${Number(step.ms) === ms ? 'is-active' : ''}" data-preset-ms="${ms}">${ms} ms</button>`,
            )
            .join('')}
        </div>
      `
    } else if (step.type === 'media') {
      const opts = ['播放 / 暂停', '音量增大', '音量减小', '静音', '上一曲', '下一曲']
      paramFields = `
        <div class="wf-editor-row">
          <span class="wf-editor-label">媒体命令</span>
          <select class="ax-input" data-edit-field="command">
            ${opts.map(o => `<option value="${escapeHtml(o)}" ${step.command === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
          </select>
        </div>
      `
    } else {
      paramFields = `
        <div class="wf-editor-row">
          <span class="wf-editor-label">动作目标</span>
          <input class="ax-input" style="flex:1;max-width:320px" data-edit-field="target" value="${escapeHtml(step.target || step.direction || '')}" />
        </div>
      `
    }

    return `
      <div class="wf-step-editor" data-editing-step-id="${escapeHtml(step.id)}">
        <div class="wf-step-editor-head">
          <span class="wf-step-editor-title">第 ${stepIndex + 1} 步 · ${escapeHtml(step.name)}</span>
          <div class="wf-step-editor-tools">
            <button type="button" class="ax-btn is-sm" data-move-step="-1" ${stepIndex <= 0 ? 'disabled' : ''}>左移</button>
            <button type="button" class="ax-btn is-sm" data-move-step="1" ${stepIndex >= input.steps.length - 1 ? 'disabled' : ''}>右移</button>
            <button type="button" class="ax-btn is-sm" data-toggle-step>${step.enabled !== false ? '已启用' : '已停用'}</button>
            <button type="button" class="ax-btn is-sm is-danger-ghost" data-delete-step="${escapeHtml(step.id)}">删除</button>
          </div>
        </div>
        <div class="wf-editor-row">
          <span class="wf-editor-label">键帽显示</span>
          <input class="ax-input" style="width:200px" data-edit-field="alias" placeholder="在交互窗键帽上展示的短名" value="${escapeHtml(step.alias || '')}" />
        </div>
        ${paramFields}
      </div>
    `
  }

  function renderSingleClickWorkflow(device, input) {
    syncSelectedStepForInput(input)

    if (input.isTrigger) {
      return `
        <section class="wf-pane" aria-label="触发键说明">
          <div class="wf-lane-head">
            <div class="wf-lane-head-left">
              <span class="wf-lane-key-title">${escapeHtml(input.label)}</span>
              <span class="ceramic-exit-badge">唤起与退出键</span>
            </div>
          </div>
          <div class="wf-canvas">
            <div class="wf-trigger-locked-empty">
              <strong>「${escapeHtml(input.label)}」负责唤起当前快捷交互窗，再次按下将直接退出。</strong><br>
              请选择其他按键来编排交互窗内的单击执行序列。
            </div>
          </div>
          ${renderStepEditor(device, input)}
        </section>
      `
    }

    const stepsHtml = input.steps
      .map((step, idx) => {
        const isSel = step.id === state.selectedStepId
        const iconCls = step.type === 'delay' ? 'is-delay' : step.type === 'paste' ? 'is-paste' : ''
        return `
          <div class="wf-drop-slot" data-drop-index="${idx}" title="拖放到此处插入"></div>
          <div
            class="wf-step-node ${isSel ? 'is-selected' : ''} ${step.enabled === false ? 'is-disabled' : ''}"
            draggable="true"
            data-step-drag="${escapeHtml(step.id)}"
            data-step-select="${escapeHtml(step.id)}"
            data-step-node="${escapeHtml(step.id)}"
          >
            <span class="wf-step-icon ${iconCls}">${stepIcon(step)}</span>
            <span class="wf-step-body">
              <span class="wf-step-name" style="display:block">${escapeHtml(stepTitle(step))}</span>
              <span class="wf-step-sub" style="display:block">${escapeHtml(stepShortParam(step))}</span>
            </span>
            <button type="button" class="wf-step-del" data-delete-step="${escapeHtml(step.id)}" aria-label="删除步骤">×</button>
          </div>
        `
      })
      .join('')

    return `
      <section class="wf-pane" aria-label="${escapeHtml(input.label)} · 单击执行序列">
        <div class="wf-lane-head">
          <div class="wf-lane-head-left">
            <span class="wf-lane-key-title">${escapeHtml(input.label)}</span>
            <span class="wf-single-chip">仅单击 · ${input.steps.length} 步</span>
          </div>
          <div class="wf-lane-head-actions">
            ${
              input.steps.length > 0
                ? `<button type="button" class="ax-btn is-sm" data-save-sequence>存为组合序列</button>
                   <button type="button" class="ax-btn is-sm is-danger-ghost" data-clear-key>清空</button>`
                : ''
            }
          </div>
        </div>
        <div class="wf-canvas">
          <div class="wf-flow-track">
            <span class="wf-node-anchor is-start"><span class="wf-dot"></span>单击按下</span>
            ${stepsHtml}
            <div class="wf-drop-slot" data-drop-index="${input.steps.length}"></div>
            <div class="wf-tail-drop" data-drop-index="${input.steps.length}">
              + 拖入动作或右侧点选添加
            </div>
            ${
              input.steps.length > 0
                ? `<span class="wf-node-anchor is-end">自动收起</span>`
                : ''
            }
          </div>
          <button type="button" class="wf-trash-zone" data-drop-trash="true" tabindex="-1" aria-label="拖入删除">
            🗑 拖入删除
          </button>
        </div>
        ${renderStepEditor(device, input)}
      </section>
    `
  }

  function filteredToolboxItems() {
    const q = state.toolboxQuery.trim().toLowerCase()
    return state.toolboxItems.filter(item => {
      if (state.toolboxCategory !== 'all' && item.category !== state.toolboxCategory) return false
      if (!q) return true
      return item.name.toLowerCase().includes(q) || item.desc.toLowerCase().includes(q)
    })
  }

  function renderToolbox(compact) {
    const items = filteredToolboxItems()
    return `
      <aside class="tb-panel" aria-label="动作与组合工具箱">
        <div class="tb-head">
          <div class="tb-title-row">
            <span>动作工具箱</span>
            <span style="font-size:11px;color:var(--ax-muted);font-weight:500">${items.length} 项</span>
          </div>
          <input
            type="search"
            class="tb-search"
            id="tb-search-input"
            placeholder="搜索动作、快捷键或组合…"
            value="${escapeHtml(state.toolboxQuery)}"
          />
          ${
            compact
              ? `<select class="ax-input" id="tb-cat-select" style="height:28px;font-size:12px">
                  ${DATA.toolboxCategories
                    .map(
                      c =>
                        `<option value="${c.id}" ${state.toolboxCategory === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`,
                    )
                    .join('')}
                </select>`
              : `<div class="tb-cats">
                  ${DATA.toolboxCategories
                    .map(
                      c =>
                        `<button type="button" class="tb-cat-pill ${state.toolboxCategory === c.id ? 'is-active' : ''}" data-tb-cat="${c.id}">${escapeHtml(c.name)}</button>`,
                    )
                    .join('')}
                </div>`
          }
        </div>
        <div class="tb-list">
          ${items
            .map(
              item => `
            <div class="tb-item" draggable="true" data-toolbox-id="${escapeHtml(item.id)}">
              <div class="tb-item-info">
                <div class="tb-item-top">
                  <span class="tb-item-name">${escapeHtml(item.name)}</span>
                  ${item.kind === 'composite' ? `<span class="tb-composite-tag">${item.steps.length}步组合</span>` : ''}
                </div>
                <div class="tb-item-desc">${escapeHtml(item.desc)}</div>
              </div>
              <button
                type="button"
                class="tb-add-btn"
                data-add-toolbox="${escapeHtml(item.id)}"
                aria-label="添加 ${escapeHtml(item.name)} 到当前键单击"
                title="点击添加"
              >+</button>
            </div>
          `,
            )
            .join('')}
        </div>
      </aside>
    `
  }

  /* ==========================================================================
     Entry Stage: Simplified Main Workbench + 「快捷交互窗」Behavior Editor
     ========================================================================== */

  function renderBaseWorkbench(device, highlightEntry) {
    const hostList = Object.values(device.inputs).slice(0, 7)
    const configured = configuredInputsList(device)
    const configuredCount = countConfiguredInputs(device)
    const activeSchemeMeta = DATA.schemes[state.scheme === 'all' ? '01' : state.scheme]

    return `
      <div class="ax-app-window">
        <header class="ax-app-header">
          <div class="ax-app-header-left">
            <span class="ax-back-pill">← 我的设备</span>
            <span class="ax-device-title">${escapeHtml(device.name)}</span>
          </div>
          <div class="ax-profile-chip-bar" aria-label="设备顶层常驻配置栏">
            <span class="ax-chip-select">${escapeHtml(device.hostProfileName)} ▾</span>
            <span class="ax-chip-meta">独立常驻配置 · 不再混入快捷配置</span>
          </div>
          <div class="ax-app-header-right">
            <span class="ax-back-pill">设备设置</span>
          </div>
        </header>

        <div class="ax-app-body">
          <aside class="ax-sidebar" aria-label="常驻配置按键">
            <div class="ax-sidebar-title">常驻映射按键</div>
            ${hostList
              .map(inp => {
                const isHostTrigger = inp.id === device.triggerInputId
                return `
                  <div class="ax-key-row ${isHostTrigger ? 'is-selected' : ''}">
                    <span class="ax-key-row-name">${escapeHtml(inp.label)}</span>
                    <span class="ax-key-row-summary">${isHostTrigger ? `快捷窗 · ${escapeHtml(device.overlayTitle)}` : '默认映射'}</span>
                  </div>
                `
              })
              .join('')}
          </aside>

          <main class="ax-main-pane">
            <div class="ax-key-head">
              <h2>${escapeHtml(device.triggerName)}</h2>
              <div class="ax-lane-pill-group">
                <span class="ax-lane-pill is-active">单击 1</span>
                <span class="ax-lane-pill">双击 0</span>
                <span class="ax-lane-pill">长按 0</span>
              </div>
            </div>

            <div class="entry-split">
              <div class="ax-outer-lanes">
                <div class="outer-lane-row">
                  <span class="outer-lane-badge is-primary">单击</span>
                  <div class="outer-step-card">
                    <span>快捷交互窗</span>
                    <span class="outer-step-tag">${escapeHtml(device.overlayTitle)} · 已配 ${configuredCount} 键</span>
                  </div>
                </div>
                <div class="outer-lane-row">
                  <span class="outer-lane-badge">双击</span>
                  <span class="outer-lane-empty">常驻配置支持多触发器，拖拽动作到此添加</span>
                </div>
                <div class="outer-lane-row">
                  <span class="outer-lane-badge">长按</span>
                  <span class="outer-lane-empty">按住触发行为，留空即保持空闲</span>
                </div>
              </div>

              ${
                highlightEntry
                  ? `<section class="entry-behavior-editor" aria-label="快捷交互窗行为编辑">
                      <div class="entry-editor-head">
                        <div class="entry-editor-title">
                          <span>编辑行为 · 快捷交互窗</span>
                          <span class="entry-single-badge">仅单击触发 · 独立保存于此步骤</span>
                        </div>
                        <span class="entry-scheme-hint">当前入口样式将展开：方案 ${activeSchemeMeta.id}「${activeSchemeMeta.name}」</span>
                      </div>

                      <div class="entry-form-grid">
                        <label class="entry-field-label" for="entry-title-input">交互窗标题</label>
                        <div class="entry-title-row">
                          <input
                            id="entry-title-input"
                            class="ax-input"
                            value="${escapeHtml(device.overlayTitle)}"
                            placeholder="例如：AI 编程副驾"
                          />
                        </div>

                        <span class="entry-field-label">按键速览</span>
                        <div class="entry-keys-preview">
                          ${configured
                            .map(inp => {
                              const info = formatCeramicInfo(inp)
                              return `
                                <button
                                  type="button"
                                  class="key-chip-btn ${info.isTrigger ? 'is-trigger' : ''}"
                                  data-jump-input="${escapeHtml(inp.id)}"
                                  title="点击直接编辑该键的交互窗单击序列"
                                >
                                  <strong>${escapeHtml(inp.short)}</strong>
                                  <span>${escapeHtml(info.isTrigger ? '再按退出' : info.title)}</span>
                                </button>
                              `
                            })
                            .join('')}
                        </div>
                      </div>

                      <div class="entry-actions-row">
                        <div class="entry-actions-left">
                          <button type="button" class="ax-btn is-primary" data-open-configurator>
                            配置交互窗按键（已配 ${configuredCount} 键）
                          </button>
                          <button type="button" class="ax-btn" data-preview-hud>
                            预览交互窗
                          </button>
                        </div>
                      </div>
                    </section>`
                  : ''
              }
            </div>
          </main>
        </div>
      </div>
    `
  }

  /* ==========================================================================
     4 Distinct Configurator Schemes (Strictly Single-Click + Drag & Drop)
     ========================================================================== */

  function renderScheme01(device, input) {
    const count = countConfiguredInputs(device)
    return `
      <div style="position:relative;width:min(1280px,100%);height:696px">
        ${renderBaseWorkbench(device, false)}
        <div class="overlay-scrim">
          <div class="modal-studio" role="dialog" aria-modal="true" aria-label="快捷交互窗配置 · 专注模态工作台">
            <header class="studio-dialog-head">
              <div class="studio-dialog-head-left">
                <span class="entry-single-badge">仅单击</span>
                <input
                  class="ax-input"
                  style="width:210px;font-weight:700"
                  data-overlay-title-input
                  value="${escapeHtml(device.overlayTitle)}"
                  aria-label="快捷交互窗标题"
                />
                <span style="font-size:12px;color:var(--ax-muted)">${escapeHtml(device.name)} · 已配 ${count} 键</span>
              </div>
              <div class="studio-dialog-head-right">
                <button type="button" class="ax-btn" data-preview-hud>预览交互窗</button>
                <button type="button" class="ax-btn is-primary" data-close-configurator>完成</button>
              </div>
            </header>

            <div class="scheme01-grid">
              <div class="keycap-picker-col">
                <div class="col-caption">
                  <span>选择要配置的交互窗按键</span>
                  <span style="font-weight:500;color:var(--ax-muted)">${escapeHtml(device.triggerName)}已锁定</span>
                </div>
                ${renderCeramicSurface(device, {
                  selectedInputId: input.id,
                  selectable: true,
                  droppable: false,
                  showHead: false,
                  compact: true,
                })}
              </div>
              ${renderSingleClickWorkflow(device, input)}
              ${renderToolbox(false)}
            </div>
          </div>
        </div>
      </div>
    `
  }

  function renderScheme02(device, input) {
    syncSelectedStepForInput(input)
    const step = input.steps.find(s => s.id === state.selectedStepId) || input.steps[0]
    const dockSteps = input.isTrigger
      ? `<span style="font-size:12.5px;color:var(--ax-warn);font-weight:600">「${escapeHtml(input.label)}」为触发/退出键，不可拖入动作</span>`
      : `
          <span class="wf-node-anchor is-start"><span class="wf-dot"></span>单击</span>
          ${input.steps
            .map((s, idx) => {
              const isSel = s.id === state.selectedStepId
              const iconCls = s.type === 'delay' ? 'is-delay' : s.type === 'paste' ? 'is-paste' : ''
              return `
                <div class="wf-drop-slot" data-drop-index="${idx}"></div>
                <div
                  class="wf-step-node ${isSel ? 'is-selected' : ''} ${s.enabled === false ? 'is-disabled' : ''}"
                  draggable="true"
                  data-step-drag="${escapeHtml(s.id)}"
                  data-step-select="${escapeHtml(s.id)}"
                  data-step-node="${escapeHtml(s.id)}"
                  style="min-width:116px"
                >
                  <span class="wf-step-icon ${iconCls}">${stepIcon(s)}</span>
                  <span class="wf-step-body">
                    <span class="wf-step-name" style="display:block">${escapeHtml(stepTitle(s))}</span>
                    <span class="wf-step-sub" style="display:block">${escapeHtml(stepShortParam(s))}</span>
                  </span>
                  <button type="button" class="wf-step-del" data-delete-step="${escapeHtml(s.id)}" aria-label="删除步骤">×</button>
                </div>
              `
            })
            .join('')}
          <div class="wf-drop-slot" data-drop-index="${input.steps.length}"></div>
          <div class="wf-tail-drop" data-drop-index="${input.steps.length}" style="padding:7px 12px">+ 拖入追加步骤</div>
        `

    const inlineBar =
      !input.isTrigger && step
        ? `
          <div class="scheme02-inline-edit" data-editing-step-id="${escapeHtml(step.id)}">
            <span class="wf-step-editor-title">${escapeHtml(step.name)}</span>
            <input class="ax-input" style="width:165px;height:28px" data-edit-field="alias" placeholder="键帽短名称" value="${escapeHtml(step.alias || '')}" />
            ${
              step.type === 'shortcut'
                ? `<input class="ax-input" style="width:120px;height:28px;font-weight:700" data-edit-field="keys" value="${escapeHtml(step.keys || '')}" />`
                : step.type === 'delay'
                  ? `<input class="ax-input" type="number" min="10" max="5000" step="10" style="width:86px;height:28px" data-edit-field="ms" value="${Number(step.ms) || 30}" />`
                  : `<input class="ax-input" style="flex:1;min-width:180px;height:28px" data-edit-field="${step.type === 'paste' || step.type === 'typeText' ? 'text' : 'target'}" value="${escapeHtml(step.text || step.command || step.target || '')}" />`
            }
            <button type="button" class="ax-btn is-sm is-danger-ghost" data-delete-step="${escapeHtml(step.id)}">删除此步</button>
          </div>
        `
        : ''

    return `
      <div style="position:relative;width:min(1280px,100%);height:696px">
        ${renderBaseWorkbench(device, false)}
        <div class="overlay-scrim">
          <div class="wysiwyg-studio" role="dialog" aria-modal="true" aria-label="快捷交互窗 · 阳极铝原地直编">
            <header class="studio-dialog-head">
              <div class="studio-dialog-head-left">
                <span class="entry-single-badge">直接拖放到键帽上绑定</span>
                <input
                  class="ax-input"
                  style="width:210px;font-weight:700"
                  data-overlay-title-input
                  value="${escapeHtml(device.overlayTitle)}"
                  aria-label="快捷交互窗标题"
                />
              </div>
              <div class="studio-dialog-head-right">
                <button type="button" class="ax-btn" data-preview-hud>实时交互模拟</button>
                <button type="button" class="ax-btn is-primary" data-close-configurator>完成</button>
              </div>
            </header>

            <div class="scheme02-grid">
              <div class="scheme02-center">
                <div class="scheme02-hud-stage">
                  ${renderCeramicSurface(device, {
                    selectedInputId: input.id,
                    selectable: true,
                    droppable: true,
                    showHead: true,
                    compact: false,
                  })}
                </div>
                <div class="scheme02-dock">
                  <div class="scheme02-dock-head">
                    <div class="wf-lane-head-left">
                      <span class="wf-lane-key-title">${escapeHtml(input.label)}</span>
                      <span class="wf-single-chip">单击序列 · ${input.steps.length} 步</span>
                    </div>
                    <div class="wf-lane-head-actions">
                      ${
                        !input.isTrigger && input.steps.length > 0
                          ? `<button type="button" class="ax-btn is-sm is-danger-ghost" data-clear-key>清空该键</button>`
                          : ''
                      }
                    </div>
                  </div>
                  <div class="scheme02-dock-rail">${dockSteps}</div>
                  ${inlineBar}
                </div>
              </div>
              ${renderToolbox(false)}
            </div>
          </div>
        </div>
      </div>
    `
  }

  function renderScheme03(device, input) {
    const inputs = Object.values(device.inputs)
    return `
      <div class="ax-app-window">
        <header class="subws-header">
          <div class="subws-breadcrumb">
            <button type="button" class="ax-back-pill" data-close-configurator>← 返回「${escapeHtml(device.hostProfileName)} · ${escapeHtml(device.triggerName)}」</button>
            <span class="subws-sep">/</span>
            <input
              class="ax-input"
              style="width:210px;font-weight:700"
              data-overlay-title-input
              value="${escapeHtml(device.overlayTitle)}"
              aria-label="快捷交互窗标题"
            />
            <span class="entry-single-badge">独立子工作区 · 仅单击</span>
          </div>
          <div class="ax-app-header-right">
            <button type="button" class="ax-btn" data-preview-hud>预览交互窗</button>
            <button type="button" class="ax-btn is-primary" data-close-configurator>完成编辑</button>
          </div>
        </header>

        <div class="subws-body">
          <aside class="subws-sidebar" aria-label="交互窗按键列表">
            <div class="subws-side-toggle" role="tablist">
              <button type="button" class="${state.subwsSidebarTab === 'list' ? 'is-active' : ''}" data-subws-tab="list">按键清单</button>
              <button type="button" class="${state.subwsSidebarTab === 'map' ? 'is-active' : ''}" data-subws-tab="map">阳极铝键图</button>
            </div>
            <div class="subws-side-scroll">
              ${
                state.subwsSidebarTab === 'map'
                  ? renderCeramicSurface(device, {
                      selectedInputId: input.id,
                      selectable: true,
                      droppable: false,
                      showHead: false,
                      compact: true,
                    })
                  : inputs
                      .map(inp => {
                        const info = formatCeramicInfo(inp)
                        const isSel = inp.id === input.id
                        return `
                          <button
                            type="button"
                            class="ax-key-row ${info.isTrigger ? 'is-trigger-locked' : isSel ? 'is-selected' : ''}"
                            data-select-input="${escapeHtml(inp.id)}"
                          >
                            <span class="ax-key-row-name">${escapeHtml(inp.label)}</span>
                            <span class="ax-key-row-summary">${escapeHtml(info.isTrigger ? '再按退出' : info.isEmpty ? '未配置' : info.title)}</span>
                          </button>
                        `
                      })
                      .join('')
              }
            </div>
          </aside>
          ${renderSingleClickWorkflow(device, input)}
          ${renderToolbox(false)}
        </div>
      </div>
    `
  }

  function renderScheme04(device, input) {
    return `
      <div style="position:relative;width:min(1280px,100%);height:696px">
        ${renderBaseWorkbench(device, false)}
        <div class="drawer-backdrop">
          <aside class="slideover-drawer" role="dialog" aria-modal="true" aria-label="快捷交互窗配置抽屉">
            <header class="studio-dialog-head">
              <div class="studio-dialog-head-left">
                <span class="entry-single-badge">仅单击</span>
                <input
                  class="ax-input"
                  style="width:190px;font-weight:700"
                  data-overlay-title-input
                  value="${escapeHtml(device.overlayTitle)}"
                  aria-label="快捷交互窗标题"
                />
              </div>
              <div class="studio-dialog-head-right">
                <button type="button" class="ax-btn" data-preview-hud>预览</button>
                <button type="button" class="ax-btn is-primary" data-close-configurator>完成</button>
              </div>
            </header>

            <div class="drawer-body">
              <div class="drawer-key-matrix">
                <div class="col-caption" style="margin-bottom:7px">
                  <span>速配键帽矩阵（点击选键，或直接把动作拖放到键帽卡片）</span>
                  <span style="font-weight:500;color:var(--ax-muted)">左侧对照常驻配置</span>
                </div>
                <div class="drawer-flat-grid">
                  ${Object.values(device.inputs)
                    .map(inp =>
                      renderCeramicKeyTile(inp, {
                        selectedInputId: input.id,
                        selectable: true,
                        droppable: true,
                      }),
                    )
                    .join('')}
                </div>
              </div>
              <div class="drawer-bottom-split">
                ${renderSingleClickWorkflow(device, input)}
                ${renderToolbox(true)}
              </div>
            </div>
          </aside>
        </div>
      </div>
    `
  }

  function renderOverview() {
    const wireframes = {
      '01': `
        <div class="ov-wireframe ov-wf-01">
          <div class="wf-box is-accent">阳极铝键帽<br>点选</div>
          <div class="wf-box">单泳道单击序列<br>+ 底部参数编辑</div>
          <div class="wf-box">分类<br>工具箱</div>
        </div>
      `,
      '02': `
        <div class="ov-wireframe ov-wf-02">
          <div class="ov-wf-02-left">
            <div class="wf-box is-accent">放大方案 05 阳极铝画布（支持动作直拖落键）</div>
            <div class="wf-box">底部单击组合轨道</div>
          </div>
          <div class="wf-box">拖拽<br>工具箱</div>
        </div>
      `,
      '03': `
        <div class="ov-wireframe ov-wf-03">
          <div class="wf-box is-accent">← 返回原按键 / 快捷交互窗面包屑</div>
          <div class="ov-wf-03-cols">
            <div class="wf-box">单键清单</div>
            <div class="wf-box">全屏单泳道画布</div>
            <div class="wf-box">工具箱</div>
          </div>
        </div>
      `,
      '04': `
        <div class="ov-wireframe ov-wf-04">
          <div class="wf-box is-dim">左侧常驻<br>映射参照</div>
          <div class="ov-wf-04-right">
            <div class="wf-box is-accent">顶部紧凑键帽矩阵（可直拖）</div>
            <div class="wf-box">左下单击流 + 右下工具箱</div>
          </div>
        </div>
      `,
    }

    return `
      <div class="overview-grid">
        ${Object.values(DATA.schemes)
          .map(
            s => `
          <article class="overview-card">
            <div class="ov-head">
              <div class="ov-title-group">
                <span class="ov-num">${s.id}</span>
                <span class="ov-name">${escapeHtml(s.name)}</span>
              </div>
              <span class="ov-badge">${escapeHtml(s.badge)}</span>
            </div>
            ${wireframes[s.id]}
            <p class="ov-summary">${escapeHtml(s.summary)}</p>
            <div class="ov-metrics">
              <div class="ov-metric-row"><span>核心优势</span><span>${escapeHtml(s.pros[0])}</span></div>
              <div class="ov-metric-row"><span>代码复用</span><span>${escapeHtml(s.reuse)}</span></div>
              <div class="ov-metric-row"><span>权衡取舍</span><span>${escapeHtml(s.tradeoff)}</span></div>
            </div>
            <div class="ov-foot">
              <span style="font-size:11.5px;color:var(--ax-muted)">仅单击 · 独立保存于行为自身</span>
              <button type="button" class="ax-btn is-primary is-sm" data-try-scheme="${s.id}">进入交互体验</button>
            </div>
          </article>
        `,
          )
          .join('')}
      </div>
    `
  }

  /* ==========================================================================
     Render Loop & Live Synchronization
     ========================================================================== */

  function renderSummaryBar() {
    const schemeInfo = DATA.schemes[state.scheme]
    if (state.scheme === 'all') {
      summaryEl.innerHTML = `
        <div class="summary-left">
          <span class="summary-badge">全景横向对比</span>
          <span class="summary-title">4 套独立「仅单击」快捷交互窗配置方案</span>
          <span class="summary-desc">统一入口挂在「快捷交互窗」行为上；彻底移除顶层快捷 Profile 与双击/长按泳道。</span>
        </div>
        <div class="summary-actions">
          <button type="button" class="ax-btn is-sm" data-reset-demo>恢复示例初始数据</button>
        </div>
      `
      return
    }
    const stageText =
      state.stage === 'entry'
        ? `入口态：菜单点击「配置交互窗按键」即打开「${schemeInfo.name}」`
        : schemeInfo.summary
    summaryEl.innerHTML = `
      <div class="summary-left">
        <span class="summary-badge">方案 ${schemeInfo.id} · ${escapeHtml(schemeInfo.badge)}</span>
        <span class="summary-title">${escapeHtml(schemeInfo.name)}</span>
        <span class="summary-desc">${escapeHtml(stageText)}</span>
      </div>
      <div class="summary-actions">
        ${
          state.stage === 'entry'
            ? `<button type="button" class="ax-btn is-primary is-sm" data-open-configurator>展开方案 ${schemeInfo.id} →</button>`
            : `<button type="button" class="ax-btn is-sm" data-close-configurator>← 回到入口</button>`
        }
        <button type="button" class="ax-btn is-sm" data-reset-demo>重置数据</button>
      </div>
    `
  }

  function renderPreviewHud() {
    if (!state.previewOpen) {
      hudBackdropEl.hidden = true
      hudBackdropEl.innerHTML = ''
      return
    }
    const dev = currentDevice()
    hudBackdropEl.hidden = false
    hudBackdropEl.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;gap:12px;width:min(760px,100%)">
        ${renderCeramicSurface(dev, {
          selectedInputId: null,
          selectable: false,
          droppable: false,
          previewClickable: true,
          showHead: true,
          largeHud: true,
        })}
        <button type="button" class="ax-btn" data-close-preview style="background:rgb(255 255 255 / 92%)">关闭模拟预览</button>
      </div>
    `
  }

  function render() {
    rootEl.dataset.scheme = state.scheme
    rootEl.dataset.stage = state.stage
    rootEl.dataset.device = state.deviceId

    document.querySelectorAll('.scheme-tab').forEach(btn => {
      btn.setAttribute('aria-selected', String(btn.dataset.scheme === state.scheme))
    })
    document.querySelectorAll('#stage-switch .seg-btn').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.stage === state.stage && state.scheme !== 'all')
      btn.disabled = state.scheme === 'all'
    })
    document.querySelectorAll('#device-switch .seg-btn').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.device === state.deviceId)
    })

    diffPopoverEl.hidden = !state.diffOpen
    diffBtnEl.setAttribute('aria-pressed', String(state.diffOpen))

    renderSummaryBar()

    const dev = currentDevice()
    const inp = currentInput()

    if (state.scheme === 'all') {
      stageEl.innerHTML = renderOverview()
    } else if (state.stage === 'entry') {
      stageEl.innerHTML = renderBaseWorkbench(dev, true)
    } else if (state.scheme === '01') {
      stageEl.innerHTML = renderScheme01(dev, inp)
    } else if (state.scheme === '02') {
      stageEl.innerHTML = renderScheme02(dev, inp)
    } else if (state.scheme === '03') {
      stageEl.innerHTML = renderScheme03(dev, inp)
    } else if (state.scheme === '04') {
      stageEl.innerHTML = renderScheme04(dev, inp)
    }

    renderPreviewHud()
  }

  /* ==========================================================================
     Mutations & Drag-and-Drop Engine
     ========================================================================== */

  function cloneToolboxSteps(item) {
    return item.steps.map(s => ({ ...s, id: nextStepId() }))
  }

  function insertToolboxToInput(input, toolboxId, insertIndex) {
    if (!input) return
    if (input.isTrigger) {
      showToast(`「${input.label}」为唤起/退出键，不可绑定内部单击动作`)
      return
    }
    const item = state.toolboxItems.find(x => x.id === toolboxId)
    if (!item) return
    const newSteps = cloneToolboxSteps(item)
    const idx = typeof insertIndex === 'number' ? Math.max(0, Math.min(insertIndex, input.steps.length)) : input.steps.length
    input.steps.splice(idx, 0, ...newSteps)
    state.selectedInputByDevice[currentDevice().id] = input.id
    state.selectedStepId = newSteps[0]?.id || null
    showToast(`已添加到「${input.label}」单击序列：${item.name}`)
    render()
  }

  function moveStepOrder(input, stepId, targetIndex) {
    if (!input || input.isTrigger) return
    const fromIdx = input.steps.findIndex(s => s.id === stepId)
    if (fromIdx < 0) return
    const [removed] = input.steps.splice(fromIdx, 1)
    let toIdx = Math.max(0, Math.min(targetIndex, input.steps.length + 1))
    if (fromIdx < toIdx) toIdx -= 1
    toIdx = Math.max(0, Math.min(toIdx, input.steps.length))
    input.steps.splice(toIdx, 0, removed)
    state.selectedStepId = removed.id
    render()
  }

  function liveUpdateStepDom(input, step) {
    const dev = currentDevice()
    const node = stageEl.querySelector(`[data-step-node="${CSS.escape(step.id)}"]`)
    if (node) {
      const nameEl = node.querySelector('.wf-step-name')
      const subEl = node.querySelector('.wf-step-sub')
      if (nameEl) nameEl.textContent = stepTitle(step)
      if (subEl) subEl.textContent = stepShortParam(step)
    }
    stageEl.querySelectorAll(`[data-key-tile="${CSS.escape(input.id)}"]`).forEach(tile => {
      const info = formatCeramicInfo(input)
      tile.classList.toggle('is-empty', info.isEmpty)
      const actionEl = tile.querySelector('.ck-action')
      if (actionEl) actionEl.textContent = info.title
      let badgeEl = tile.querySelector('.ck-badge')
      if (info.badge) {
        if (!badgeEl) {
          badgeEl = document.createElement('span')
          tile.querySelector('.ck-top')?.appendChild(badgeEl)
        }
        badgeEl.className = `ck-badge ${info.badgeClass}`
        badgeEl.textContent = info.badge
      } else if (badgeEl) {
        badgeEl.remove()
      }
    })
    if (dev && state.stage === 'entry') {
      renderSummaryBar()
    }
  }

  /* ==========================================================================
     Event Listeners
     ========================================================================== */

  document.querySelectorAll('.scheme-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const nextScheme = btn.dataset.scheme
      state.scheme = nextScheme
      if (nextScheme !== 'all') {
        state.stage = 'editor'
      }
      render()
    })
  })

  document.querySelectorAll('#stage-switch .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (state.scheme === 'all') return
      state.stage = btn.dataset.stage
      render()
    })
  })

  document.querySelectorAll('#device-switch .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.deviceId = btn.dataset.device
      syncSelectedStepForInput(currentInput())
      render()
    })
  })

  diffBtnEl.addEventListener('click', () => {
    state.diffOpen = !state.diffOpen
    render()
  })

  document.getElementById('legacy-diff-close').addEventListener('click', () => {
    state.diffOpen = false
    render()
  })

  document.addEventListener('click', e => {
    const target = e.target
    if (!(target instanceof Element)) return

    if (target.closest('[data-reset-demo]')) {
      state.devices = cloneDevices(DATA.devices)
      state.selectedInputByDevice = { ...initialSelection }
      state.toolboxItems = JSON.parse(JSON.stringify(DATA.toolboxItems))
      syncSelectedStepForInput(currentInput())
      showToast('已恢复各设备示例配置')
      render()
      return
    }

    const tryScheme = target.closest('[data-try-scheme]')
    if (tryScheme) {
      state.scheme = tryScheme.dataset.tryScheme
      state.stage = 'editor'
      render()
      return
    }

    if (target.closest('[data-open-configurator]')) {
      if (state.scheme === 'all') state.scheme = '01'
      state.stage = 'editor'
      render()
      return
    }

    if (target.closest('[data-close-configurator]')) {
      state.stage = 'entry'
      render()
      return
    }

    const jumpBtn = target.closest('[data-jump-input]')
    if (jumpBtn) {
      const dev = currentDevice()
      const inp = dev.inputs[jumpBtn.dataset.jumpInput]
      if (inp && inp.isTrigger) {
        showToast(`「${inp.label}」为当前快捷窗的唤醒/退出键`)
        return
      }
      state.selectedInputByDevice[dev.id] = jumpBtn.dataset.jumpInput
      syncSelectedStepForInput(currentInput())
      if (state.scheme === 'all') state.scheme = '01'
      state.stage = 'editor'
      render()
      return
    }

    if (target.closest('[data-preview-hud]')) {
      state.previewOpen = true
      renderPreviewHud()
      return
    }

    if (target.closest('[data-close-preview]') || target === hudBackdropEl) {
      state.previewOpen = false
      renderPreviewHud()
      return
    }

    const previewKey = target.closest('[data-preview-trigger-key]')
    if (previewKey) {
      const dev = currentDevice()
      const inp = dev.inputs[previewKey.dataset.previewTriggerKey]
      if (!inp) return
      if (inp.isTrigger) {
        state.previewOpen = false
        renderPreviewHud()
        showToast(`再次按下「${inp.label}」，已直接退出交互窗`)
        return
      }
      const steps = activeSteps(inp)
      if (!steps.length) {
        showToast(`「${inp.label}」尚未配置单击动作`)
        return
      }
      state.previewOpen = false
      renderPreviewHud()
      showToast(`已触发「${inp.label}」单击（${steps.length} 步）并自动收起交互窗`)
      return
    }

    const delBtn = target.closest('[data-delete-step]')
    if (delBtn) {
      const inp = currentInput()
      const delId = delBtn.dataset.deleteStep
      inp.steps = inp.steps.filter(s => s.id !== delId)
      if (state.selectedStepId === delId) state.selectedStepId = inp.steps[0]?.id || null
      render()
      return
    }

    const selKey = target.closest('[data-select-input]')
    if (selKey) {
      const dev = currentDevice()
      state.selectedInputByDevice[dev.id] = selKey.dataset.selectInput
      syncSelectedStepForInput(currentInput())
      render()
      return
    }

    const selStep = target.closest('[data-step-select]')
    if (selStep) {
      state.selectedStepId = selStep.dataset.stepSelect
      render()
      return
    }

    const addTb = target.closest('[data-add-toolbox]')
    if (addTb) {
      insertToolboxToInput(currentInput(), addTb.dataset.addToolbox)
      return
    }

    const tbCat = target.closest('[data-tb-cat]')
    if (tbCat) {
      state.toolboxCategory = tbCat.dataset.tbCat
      render()
      return
    }

    const subTab = target.closest('[data-subws-tab]')
    if (subTab) {
      state.subwsSidebarTab = subTab.dataset.subwsTab
      render()
      return
    }

    const presetKey = target.closest('[data-preset-key]')
    if (presetKey) {
      const inp = currentInput()
      const step = inp.steps.find(s => s.id === state.selectedStepId)
      if (step) {
        step.keys = presetKey.dataset.presetKey
        render()
      }
      return
    }

    const presetMs = target.closest('[data-preset-ms]')
    if (presetMs) {
      const inp = currentInput()
      const step = inp.steps.find(s => s.id === state.selectedStepId)
      if (step) {
        step.ms = Number(presetMs.dataset.presetMs)
        render()
      }
      return
    }

    const moveBtn = target.closest('[data-move-step]')
    if (moveBtn) {
      const inp = currentInput()
      const delta = Number(moveBtn.dataset.moveStep)
      const idx = inp.steps.findIndex(s => s.id === state.selectedStepId)
      const next = idx + delta
      if (idx >= 0 && next >= 0 && next < inp.steps.length) {
        const [item] = inp.steps.splice(idx, 1)
        inp.steps.splice(next, 0, item)
        render()
      }
      return
    }

    if (target.closest('[data-toggle-step]')) {
      const inp = currentInput()
      const step = inp.steps.find(s => s.id === state.selectedStepId)
      if (step) {
        step.enabled = step.enabled === false
        render()
      }
      return
    }

    if (target.closest('[data-clear-key]')) {
      const inp = currentInput()
      inp.steps = []
      state.selectedStepId = null
      showToast(`已清空「${inp.label}」的单击序列`)
      render()
      return
    }

    if (target.closest('[data-save-sequence]')) {
      const inp = currentInput()
      if (!inp.steps.length) return
      const name = `我的序列：${inp.short} (${inp.steps.length}步)`
      state.toolboxItems.unshift({
        id: 'tb-custom-' + Date.now(),
        category: 'saved',
        kind: inp.steps.length > 1 ? 'composite' : 'single',
        name,
        desc: inp.steps.map(s => stepTitle(s)).join(' → '),
        steps: inp.steps.map(({ id, ...rest }) => ({ ...rest })),
      })
      state.toolboxCategory = 'saved'
      showToast(`已保存到工具箱「已保存序列」`)
      render()
      return
    }
  })

  document.addEventListener('input', e => {
    const target = e.target
    if (!(target instanceof HTMLElement)) return

    if (target.id === 'entry-title-input' || target.hasAttribute('data-overlay-title-input')) {
      currentDevice().overlayTitle = target.value
      const ceramicTitle = stageEl.querySelector('.ceramic-title-text')
      if (ceramicTitle) ceramicTitle.textContent = target.value || '快捷交互窗'
      return
    }

    if (target.id === 'tb-search-input') {
      const caret = target.selectionStart
      state.toolboxQuery = target.value
      render()
      const fresh = document.getElementById('tb-search-input')
      if (fresh) {
        fresh.focus()
        if (typeof caret === 'number') fresh.setSelectionRange(caret, caret)
      }
      return
    }

    const field = target.dataset.editField
    if (field) {
      const inp = currentInput()
      const step = inp.steps.find(s => s.id === state.selectedStepId)
      if (!step) return
      step[field] = field === 'ms' ? Number(target.value) || 0 : target.value
      liveUpdateStepDom(inp, step)
    }
  })

  document.addEventListener('change', e => {
    const target = e.target
    if (!(target instanceof HTMLSelectElement)) return
    if (target.id === 'tb-cat-select') {
      state.toolboxCategory = target.value
      render()
    } else if (target.dataset.editField === 'command') {
      const inp = currentInput()
      const step = inp.steps.find(s => s.id === state.selectedStepId)
      if (step) {
        step.command = target.value
        render()
      }
    }
  })

  /* Drag and Drop */
  document.addEventListener('dragstart', e => {
    const target = e.target
    if (!(target instanceof Element)) return
    const tb = target.closest('[data-toolbox-id]')
    if (tb) {
      state.dragPayload = { source: 'toolbox', toolboxId: tb.dataset.toolboxId }
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
      return
    }
    const stepEl = target.closest('[data-step-drag]')
    if (stepEl) {
      state.dragPayload = { source: 'step', stepId: stepEl.dataset.stepDrag }
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
    }
  })

  document.addEventListener('dragend', () => {
    state.dragPayload = null
    document
      .querySelectorAll('.is-drop-active, .is-drop-over, .is-drop-blocked')
      .forEach(el => el.classList.remove('is-drop-active', 'is-drop-over', 'is-drop-blocked'))
  })

  document.addEventListener('dragover', e => {
    if (!state.dragPayload) return
    const target = e.target
    if (!(target instanceof Element)) return

    const dropSlot = target.closest('[data-drop-index]')
    if (dropSlot) {
      e.preventDefault()
      dropSlot.classList.add('is-drop-active')
      return
    }

    const trash = target.closest('[data-drop-trash]')
    if (trash && state.dragPayload.source === 'step') {
      e.preventDefault()
      trash.classList.add('is-drop-active')
      return
    }

    const keyTile = target.closest('[data-drop-input]')
    if (keyTile && state.dragPayload.source === 'toolbox') {
      e.preventDefault()
      const dev = currentDevice()
      const inp = dev.inputs[keyTile.dataset.dropInput]
      keyTile.classList.add(inp?.isTrigger ? 'is-drop-blocked' : 'is-drop-over')
    }
  })

  document.addEventListener('dragleave', e => {
    const target = e.target
    if (!(target instanceof Element)) return
    const zone = target.closest('[data-drop-index], [data-drop-trash], [data-drop-input]')
    if (zone && !zone.contains(e.relatedTarget)) {
      zone.classList.remove('is-drop-active', 'is-drop-over', 'is-drop-blocked')
    }
  })

  document.addEventListener('drop', e => {
    if (!state.dragPayload) return
    const target = e.target
    if (!(target instanceof Element)) return

    const dropSlot = target.closest('[data-drop-index]')
    if (dropSlot) {
      e.preventDefault()
      const idx = Number(dropSlot.dataset.dropIndex)
      const payload = state.dragPayload
      state.dragPayload = null
      if (payload.source === 'toolbox') {
        insertToolboxToInput(currentInput(), payload.toolboxId, idx)
      } else if (payload.source === 'step') {
        moveStepOrder(currentInput(), payload.stepId, idx)
      }
      return
    }

    const trash = target.closest('[data-drop-trash]')
    if (trash && state.dragPayload.source === 'step') {
      e.preventDefault()
      const delId = state.dragPayload.stepId
      state.dragPayload = null
      const inp = currentInput()
      inp.steps = inp.steps.filter(s => s.id !== delId)
      if (state.selectedStepId === delId) state.selectedStepId = inp.steps[0]?.id || null
      showToast('已删除该步骤')
      render()
      return
    }

    const keyTile = target.closest('[data-drop-input]')
    if (keyTile && state.dragPayload.source === 'toolbox') {
      e.preventDefault()
      const payload = state.dragPayload
      state.dragPayload = null
      const dev = currentDevice()
      const inp = dev.inputs[keyTile.dataset.dropInput]
      insertToolboxToInput(inp, payload.toolboxId)
    }
  })

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.previewOpen) {
      state.previewOpen = false
      renderPreviewHud()
    }
  })

  render()
})()
