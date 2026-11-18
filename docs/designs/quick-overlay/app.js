(function () {
  const DATA = window.QUICK_OVERLAY_STUDIO_DATA;
  if (!DATA) return;

  const state = {
    scheme: '01',
    device: 'rc003',
    bg: 'ide',
    oneShot: false,
    activeId: '',
    pressedId: '',
    explode: 100,
    pitch: 46,
    yaw: -24,
    pointerTiltX: 0,
    pointerTiltY: 0,
    focusLayer: 'all',
    islandDock: 'top',
  };

  const root = document.querySelector('.studio-root');
  const metaBar = document.getElementById('scheme-meta-bar');
  const backdrop = document.getElementById('desktop-backdrop');
  const mount = document.getElementById('hud-mount');
  const explodeToolbar = document.getElementById('explode-toolbar');
  const dockToolbar = document.getElementById('island-dock-toolbar');
  const toastEl = document.getElementById('hud-toast');
  const metricsEl = document.getElementById('stage-metrics');
  const stageEl = document.getElementById('desktop-stage');

  const explodeRange = document.getElementById('explode-range');
  const explodeOut = document.getElementById('explode-out');
  const pitchRange = document.getElementById('pitch-range');
  const pitchOut = document.getElementById('pitch-out');
  const yawRange = document.getElementById('yaw-range');
  const yawOut = document.getElementById('yaw-out');

  let toastTimer = 0;
  let dismissTimer = 0;
  let wireFrameId = 0;

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function primaryTrigger(input) {
    if (input.isExitTrigger) return { kind: 'exit', badge: '退出键', text: '再按退出快捷交互' };
    if (!input.triggers || input.triggers.length === 0) return null;
    const t = input.triggers[0];
    return {
      kind: t.kind,
      badge: t.badge || t.triggerLabel,
      text: t.text,
      detail: t.detail || t.stepsSummary || '',
      fullPrompt: t.fullPrompt || '',
      multiCount: input.triggers.length,
    };
  }

  function isInteractive(input) {
    return Boolean(input.isExitTrigger || (input.triggers && input.triggers.length > 0));
  }

  function showToast(badge, message) {
    window.clearTimeout(toastTimer);
    toastEl.innerHTML = `<span class="toast-badge">${esc(badge)}</span><span>${esc(message)}</span>`;
    toastEl.hidden = false;
    toastTimer = window.setTimeout(() => {
      toastEl.hidden = true;
    }, 2200);
  }

  function handleTrigger(inputId) {
    const dev = DATA.devices[state.device];
    const input = dev.inputs.find((item) => item.id === inputId);
    if (!input || !isInteractive(input)) return;

    state.pressedId = inputId;
    state.activeId = inputId;
    syncHighlightClasses();

    if (input.isExitTrigger) {
      showToast('已退出', `再次按下「${input.label}」，关闭快捷交互窗`);
    } else {
      const prim = primaryTrigger(input);
      const summary = input.triggers.length > 1
        ? `${input.label}：${prim.text}（含 ${input.triggers.length} 个触发动作）`
        : `${input.label} → ${prim.text}`;
      showToast(prim.kind === 'prompt' ? 'Prompt 发送' : prim.kind === 'sequence' ? '序列执行' : '动作触发', summary);
    }

    window.setTimeout(() => {
      if (state.pressedId === inputId) {
        state.pressedId = '';
        syncHighlightClasses();
      }
    }, 240);

    if (state.oneShot) {
      window.clearTimeout(dismissTimer);
      mount.classList.add('is-oneshot-dismissed');
      dismissTimer = window.setTimeout(() => {
        mount.classList.remove('is-oneshot-dismissed');
      }, 950);
    }
  }

  function renderBackdrop() {
    if (state.bg === 'ide') {
      backdrop.innerHTML = `
        <div class="mock-window mock-ide">
          <div class="mock-ide-title">
            <span class="mock-lights"><i></i><i></i><i></i></span>
            <span>QuickOverlay.tsx — axonkey (Workspace)</span>
            <span>main · UTF-8</span>
          </div>
          <div class="mock-ide-body">
            <div class="mock-sidebar">
              <div>▾ src/components</div>
              <div>&nbsp;&nbsp;QuickOverlay.tsx</div>
              <div>&nbsp;&nbsp;QuickOverlay.css</div>
              <div>&nbsp;&nbsp;quickOverlayModel.ts</div>
              <div>&nbsp;&nbsp;BehaviorEditor.tsx</div>
              <div>▾ src-tauri/src</div>
              <div>&nbsp;&nbsp;quick_overlay.rs</div>
              <div>&nbsp;&nbsp;quick_mode.rs</div>
            </div>
            <div class="mock-code">
              <div><span class="kw">export function</span> <span class="fn">QuickOverlay</span>() {</div>
              <div>&nbsp;&nbsp;<span class="kw">const</span> view = <span class="fn">useMemo</span>(() =&gt; <span class="fn">buildQuickOverlayView</span>(session), [session]);</div>
              <div>&nbsp;&nbsp;<span class="cm">// 无框置顶快捷交互窗口：透明画布 + 空间定位映射</span></div>
              <div>&nbsp;&nbsp;<span class="kw">return</span> &lt;<span class="fn">SpatialQuickHud</span> view={view} onTrigger={triggerCard} /&gt;;</div>
              <div>}</div>
              <div>&nbsp;</div>
              <div><span class="kw">const</span> <span class="fn">triggerCard</span> = (inputId: <span class="str">string</span>) =&gt; {</div>
              <div>&nbsp;&nbsp;<span class="kw">return</span> <span class="fn">invoke</span>(<span class="str">'trigger_quick_overlay_input'</span>, { inputId });</div>
              <div>};</div>
            </div>
            <div class="mock-terminal">
              <div>$ npm run build</div>
              <div>✓ devices generated</div>
              <div>✓ tsc -b passed</div>
              <div>✓ vite build in 1.42s</div>
              <div>&nbsp;</div>
              <div>$ cargo test quick_overlay</div>
              <div>test result: ok. 18 passed</div>
            </div>
          </div>
        </div>
      `;
    } else if (state.bg === 'keynote') {
      backdrop.innerHTML = `
        <div class="mock-window mock-keynote">
          <div class="mock-keynote-title">
            <span class="mock-lights"><i></i><i></i><i></i></span>
            <span>Q4 产品架构评审.key — Keynote</span>
            <span>100%</span>
          </div>
          <div class="mock-keynote-body">
            <div class="mock-slides-list">
              <div class="mock-slide-thumb">01 · 项目愿景</div>
              <div class="mock-slide-thumb is-cur">02 · 快捷交互层</div>
              <div class="mock-slide-thumb">03 · 跨端低延迟</div>
              <div class="mock-slide-thumb">04 · 设备生态</div>
            </div>
            <div class="mock-slide-canvas">
              <div>
                <h3>让物理外设成为桌面的第二语义层</h3>
                <p>通过无框置顶快捷交互窗，用户在任意工作流中按下触发键即可直观查看当前键位所绑定的动作、序列与 AI 提示词。</p>
              </div>
              <div class="mock-slide-bars">
                <div class="mock-slide-bar"></div>
                <div class="mock-slide-bar"></div>
                <div class="mock-slide-bar"></div>
              </div>
            </div>
          </div>
        </div>
      `;
    } else {
      backdrop.innerHTML = `
        <div class="mock-wallpaper-dock">
          <i></i><i></i><i></i><i></i><i></i><i></i>
        </div>
      `;
    }
  }

  function renderMetaBar() {
    if (state.scheme === 'all') {
      metaBar.innerHTML = `
        <div class="meta-title-group">
          <span class="meta-badge">MATRIX // 05</span>
          <h2>5 套快捷交互窗架构全景对比</h2>
          <span class="meta-en">点击任意卡片即可进入全尺寸交互</span>
        </div>
        <div class="meta-chips">
          <span class="meta-chip">当前设备：${esc(DATA.devices[state.device].name)}</span>
          <span class="meta-chip">点击卡片直达细节调节</span>
        </div>
      `;
      return;
    }

    const s = DATA.schemes[state.scheme];
    const d = DATA.devices[state.device];
    metaBar.innerHTML = `
      <div class="meta-title-group">
        <span class="meta-badge">SCHEME ${s.id}</span>
        <h2>${esc(s.name)}</h2>
        <span class="meta-en">${esc(s.en)}</span>
        <p class="meta-tagline">${esc(s.tagline)}</p>
      </div>
      <div class="meta-chips">
        <span class="meta-chip">${esc(s.occlusion)}</span>
        <span class="meta-chip">${esc(s.style)}</span>
        <span class="meta-chip">设备：${esc(d.shortName)}</span>
      </div>
    `;
  }

  function renderKeyIconGlyph(glyph) {
    switch (glyph) {
      case 'power': return '⏻';
      case 'mic': return '🎙';
      case 'up': return '↑';
      case 'down': return '↓';
      case 'left': return '←';
      case 'right': return '→';
      case 'back': return '↩';
      case 'home': return '⌂';
      case 'menu': return '☰';
      case 'plus': return '+';
      case 'minus': return '−';
      case 'forward': return '↪';
      case 'mouse-left': return 'L';
      case 'mouse-right': return 'R';
      default: return '●';
    }
  }

  /* ------------------------------------------------------------------------
     SCHEME 01: 3D Isometric Z-Stack Exploded HUD
     ------------------------------------------------------------------------ */
  function distributeVerticalPositions(items, totalHeight, minGap) {
    if (items.length === 0) return [];
    const sorted = items.slice().sort((a, b) => a.ny - b.ny || a.nx - b.nx);
    const padTop = 36;
    const padBottom = 18;
    const usable = Math.max(80, totalHeight - padTop - padBottom);
    const positions = sorted.map((item) => padTop + item.ny * usable);

    for (let i = 1; i < positions.length; i++) {
      if (positions[i] - positions[i - 1] < minGap) {
        positions[i] = positions[i - 1] + minGap;
      }
    }
    const maxY = totalHeight - padBottom - 44;
    if (positions[positions.length - 1] > maxY) {
      const overflow = positions[positions.length - 1] - maxY;
      for (let i = 0; i < positions.length; i++) {
        positions[i] -= overflow;
      }
      for (let i = positions.length - 2; i >= 0; i--) {
        if (positions[i + 1] - positions[i] < minGap) {
          positions[i] = positions[i + 1] - minGap;
        }
      }
      if (positions[0] < padTop) {
        const step = Math.max(36, usable / Math.max(1, sorted.length));
        return sorted.map((item, idx) => ({ item, top: padTop + idx * step }));
      }
    }
    return sorted.map((item, idx) => ({ item, top: positions[idx] }));
  }

  function renderScheme01(dev) {
    const activeItems = dev.inputs.filter(isInteractive);
    const leftItems = activeItems.filter((item) => item.side === 'left');
    const rightItems = activeItems.filter((item) => item.side !== 'left');

    const leftPlaced = distributeVerticalPositions(leftItems, 456, 56);
    const rightPlaced = distributeVerticalPositions(rightItems, 456, 56);

    const w = dev.shellSize.w;
    const h = dev.shellSize.h;

    const pcbNodes = activeItems
      .map(
        (item) => `
        <span class="l1-switch-pad" data-key="${esc(item.id)}" style="left:${(item.nx * 100).toFixed(2)}%;top:${(item.ny * 100).toFixed(2)}%"></span>
        <span class="z-pin-node" data-layer="pcb" data-key="${esc(item.id)}" style="left:${(item.nx * 100).toFixed(2)}%;top:${(item.ny * 100).toFixed(2)}%"></span>
      `,
      )
      .join('');

    const pcbTracesSvg = activeItems
      .map((item) => {
        const cx = 50;
        const cy = 48;
        const tx = (item.nx * 100).toFixed(1);
        const ty = (item.ny * 100).toFixed(1);
        return `<path d="M ${cx} ${cy} L ${tx} ${ty}" stroke="rgba(34,211,238,0.22)" stroke-width="0.9" fill="none" />`;
      })
      .join('');

    const capBtns = dev.inputs
      .map((item) => {
        const prim = primaryTrigger(item);
        const cls = [
          'z-cap-btn',
          item.shape === 'circle' ? 'shape-circle' : '',
          !prim ? 'is-idle' : item.isExitTrigger ? 'is-exit' : `kind-${prim.kind}`,
        ]
          .filter(Boolean)
          .join(' ');
        const style = `left:${(item.nx * 100).toFixed(2)}%;top:${(item.ny * 100).toFixed(2)}%;width:${Math.max(11, item.w * 100).toFixed(2)}%;height:${Math.max(8, item.h * 100).toFixed(2)}%`;
        return `
          <button type="button" class="${cls}" data-input-id="${esc(item.id)}" style="${style}" aria-label="${esc(item.label)}" ${!prim ? 'disabled' : ''}>
            <span>${esc(item.code || item.short)}</span>
          </button>
          ${prim ? `<span class="z-pin-node" data-layer="cap" data-key="${esc(item.id)}" style="left:${(item.nx * 100).toFixed(2)}%;top:${(item.ny * 100).toFixed(2)}%"></span>` : ''}
        `;
      })
      .join('');

    const apexPins = activeItems
      .map(
        (item) =>
          `<span class="z-pin-node" data-layer="apex" data-key="${esc(item.id)}" style="left:${(item.nx * 100).toFixed(2)}%;top:${(item.ny * 100).toFixed(2)}%"></span>`,
      )
      .join('');

    const renderCard = (placed, side) => {
      const item = placed.item;
      const prim = primaryTrigger(item);
      const badgeCls =
        prim.kind === 'prompt' ? 'tag-kind-prompt' : prim.kind === 'sequence' ? 'tag-kind-sequence' : 'tag-kind-action';
      const subText = item.isExitTrigger
        ? '再次按下退出'
        : prim.multiCount > 1
          ? `含 ${prim.multiCount} 组触发 · ${prim.detail || prim.badge}`
          : prim.detail || prim.badge;

      return `
        <button type="button"
          class="holo-tag-card side-${side}${item.isExitTrigger ? ' is-exit' : ''}"
          data-input-id="${esc(item.id)}"
          data-side="${side}"
          style="top:${Math.round(placed.top)}px"
          aria-label="${esc(item.label)}：${esc(prim.text)}">
          <div class="holo-tag-body">
            <span class="holo-tag-title">${esc(prim.text)}</span>
            <span class="holo-tag-sub">
              ${item.contextLabel ? `${esc(item.contextLabel)} · ` : ''}${esc(subText)}
            </span>
          </div>
          <span class="holo-key-chip ${item.isExitTrigger ? '' : badgeCls}">${esc(item.short)}</span>
        </button>
      `;
    };

    const rx = state.pitch + state.pointerTiltY;
    const rz = state.yaw + state.pointerTiltX;
    const ex = (state.explode / 100).toFixed(2);

    mount.innerHTML = `
      <div class="exploded-stage" id="exploded-stage" data-focus-layer="${esc(state.focusLayer)}">
        <div class="exploded-hud-badge">
          <strong>${esc(dev.profileName)}</strong>
          <span>${esc(dev.name)}</span>
          <span class="exit-kbd">再按 ${esc(dev.triggerLabel)} 退出</span>
        </div>

        <svg class="exploded-laser-svg" id="exploded-laser-svg" aria-hidden="true"></svg>

        <div class="exploded-callout-col" id="exploded-left-col">
          ${leftPlaced.map((p) => renderCard(p, 'left')).join('')}
        </div>

        <div class="exploded-center-viewport">
          <div class="exploded-stack" id="exploded-stack" style="--dev-w:${w}px;--dev-h:${h}px;--rx:${rx}deg;--rz:${rz}deg;--ex:${ex}">
            <div class="exploded-layer" data-layer="L0">
              <div class="l0-shell-plate">
                <span class="layer-tag-3d">L0 底壳</span>
              </div>
            </div>
            <div class="exploded-layer" data-layer="L1">
              <div class="l1-pcb-board">
                <svg class="l1-pcb-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
                  ${pcbTracesSvg}
                  <rect x="38" y="42" width="24" height="12" rx="2" fill="rgba(8,47,73,0.9)" stroke="rgba(34,211,238,0.6)" stroke-width="0.6" />
                </svg>
                ${pcbNodes}
                <span class="layer-tag-3d">L1 微动PCB</span>
              </div>
            </div>
            <div class="exploded-layer" data-layer="L2">
              <div class="l2-cap-stage">
                ${dev.hasOled ? '<div class="l2-oled-3d"><span>OLED</span><strong>READY</strong></div>' : ''}
                ${capBtns}
                <span class="layer-tag-3d">L2 键帽层</span>
              </div>
            </div>
            <div class="exploded-layer" data-layer="L3">
              ${apexPins}
              <span class="layer-tag-3d">L3 激光锚</span>
            </div>
          </div>
        </div>

        <div class="exploded-callout-col" id="exploded-right-col">
          ${rightPlaced.map((p) => renderCard(p, 'right')).join('')}
        </div>
      </div>
    `;

    scheduleLaserSync();
  }

  function updateExplodedLasers() {
    const stage = document.getElementById('exploded-stage');
    const svg = document.getElementById('exploded-laser-svg');
    if (!stage || !svg) return;

    const stageRect = stage.getBoundingClientRect();
    if (!stageRect.width || !stageRect.height) return;

    const getPin = (layer, key) => {
      const el = stage.querySelector(`.z-pin-node[data-layer="${layer}"][data-key="${CSS.escape(key)}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2 - stageRect.left, y: r.top + r.height / 2 - stageRect.top };
    };

    const dev = DATA.devices[state.device];
    const parts = [];

    for (const card of stage.querySelectorAll('.holo-tag-card')) {
      const key = card.getAttribute('data-input-id');
      const side = card.getAttribute('data-side');
      const input = dev.inputs.find((i) => i.id === key);
      if (!key || !input) continue;

      const pcb = getPin('pcb', key);
      const cap = getPin('cap', key);
      const apex = getPin('apex', key);
      if (!cap || !apex) continue;

      const cardRect = card.getBoundingClientRect();
      const cx = (side === 'left' ? cardRect.right : cardRect.left) - stageRect.left;
      const cy = cardRect.top + cardRect.height / 2 - stageRect.top;
      const elbowX = side === 'left' ? cx + 18 : cx - 18;

      const prim = primaryTrigger(input);
      const kindCls = input.isExitTrigger ? 'is-exit' : prim ? `kind-${prim.kind}` : '';
      const activeCls = state.activeId === key ? 'is-active' : '';

      if (pcb) {
        parts.push(
          `<path class="z-column-line ${kindCls} ${activeCls}" d="M ${pcb.x.toFixed(1)} ${pcb.y.toFixed(1)} L ${cap.x.toFixed(1)} ${cap.y.toFixed(1)} L ${apex.x.toFixed(1)} ${apex.y.toFixed(1)}" />`,
        );
        parts.push(`<circle class="z-node-dot is-pcb ${kindCls}" cx="${pcb.x.toFixed(1)}" cy="${pcb.y.toFixed(1)}" r="2.6" />`);
      }

      parts.push(
        `<path class="z-leader-line ${kindCls} ${activeCls}" d="M ${cx.toFixed(1)} ${cy.toFixed(1)} H ${elbowX.toFixed(1)} L ${apex.x.toFixed(1)} ${apex.y.toFixed(1)}" />`,
      );
      parts.push(`<circle class="z-node-dot ${kindCls}" cx="${cap.x.toFixed(1)}" cy="${cap.y.toFixed(1)}" r="3.4" />`);
      parts.push(`<circle class="z-node-dot ${kindCls}" cx="${apex.x.toFixed(1)}" cy="${apex.y.toFixed(1)}" r="3.2" />`);
    }

    svg.innerHTML = parts.join('');
  }

  function scheduleLaserSync() {
    window.cancelAnimationFrame(wireFrameId);
    wireFrameId = window.requestAnimationFrame(() => {
      if (state.scheme === '01') updateExplodedLasers();
      if (state.scheme === '03') updateXrayTraces();
    });
  }

  /* ------------------------------------------------------------------------
     SCHEME 02: Frameless Spatial Topo-Halo (VisionOS Muscle Memory)
     ------------------------------------------------------------------------ */
  function sectorPath(cx, cy, rInner, rOuter, startDeg, endDeg) {
    const rad = (deg) => ((deg - 90) * Math.PI) / 180;
    const x1 = cx + rOuter * Math.cos(rad(startDeg));
    const y1 = cy + rOuter * Math.sin(rad(startDeg));
    const x2 = cx + rOuter * Math.cos(rad(endDeg));
    const y2 = cy + rOuter * Math.sin(rad(endDeg));
    const x3 = cx + rInner * Math.cos(rad(endDeg));
    const y3 = cy + rInner * Math.sin(rad(endDeg));
    const x4 = cx + rInner * Math.cos(rad(startDeg));
    const y4 = cy + rInner * Math.sin(rad(startDeg));
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${rOuter} ${rOuter} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)} L ${x3.toFixed(1)} ${y3.toFixed(1)} A ${rInner} ${rInner} 0 0 0 ${x4.toFixed(1)} ${y4.toFixed(1)} Z`;
  }

  function renderGlassPill(input) {
    const prim = primaryTrigger(input);
    const badgeCls = prim.kind === 'prompt' ? 'tag-kind-prompt' : prim.kind === 'sequence' ? 'tag-kind-sequence' : 'tag-kind-action';
    const badgeLabel = input.isExitTrigger ? '' : prim.detail || (prim.kind === 'prompt' ? 'Prompt' : prim.badge);
    return `
      <button type="button" class="halo-glass-pill${input.isExitTrigger ? ' is-exit' : ''}" data-input-id="${esc(input.id)}" aria-label="${esc(input.label)}：${esc(prim.text)}">
        <span class="halo-pill-key">${esc(input.short)}</span>
        <span class="halo-pill-action">${esc(prim.text)}</span>
        ${badgeLabel ? `<span class="halo-pill-badge ${badgeCls}">${esc(badgeLabel)}</span>` : ''}
      </button>
    `;
  }

  function renderCompassWidget(sectors, centerInput, centerFallbackTitle) {
    const cx = 150;
    const cy = 150;
    const sectorAngles = [
      { idx: 0, start: -40, end: 40, lx: 170, ly: 32 },
      { idx: 1, start: 50, end: 130, lx: 274, ly: 150 },
      { idx: 2, start: 140, end: 220, lx: 170, ly: 268 },
      { idx: 3, start: 230, end: 310, lx: 66, ly: 150 },
    ];

    const sectorSvg = sectors
      .map((item, i) => {
        if (!item) return '';
        const ang = sectorAngles[i];
        return `
          <g class="halo-sector" data-input-id="${esc(item.id)}" role="button" tabindex="0" aria-label="${esc(item.label)}">
            <path class="halo-sector-path" d="${sectorPath(cx, cy, 68, 136, ang.start, ang.end)}" />
          </g>
        `;
      })
      .join('');

    const sectorLabels = sectors
      .map((item, i) => {
        if (!item) return '';
        const ang = sectorAngles[i];
        const prim = primaryTrigger(item);
        return `
          <div class="halo-sector-label" style="left:${ang.lx}px;top:${ang.ly}px;transform:translate(-50%,-50%)">
            <span>${esc(item.short)}</span>
            <strong>${esc(prim ? prim.text : '未映射')}</strong>
          </div>
        `;
      })
      .join('');

    const centerPrim = centerInput ? primaryTrigger(centerInput) : null;
    return `
      <div class="halo-compass-wrap">
        <svg class="halo-ring-svg" viewBox="0 0 300 300">${sectorSvg}</svg>
        ${sectorLabels}
        <button type="button" class="halo-center-orb" ${centerInput ? `data-input-id="${esc(centerInput.id)}"` : ''} aria-label="${esc(centerInput ? centerInput.label : centerFallbackTitle)}">
          <span style="font-size:11px;font-weight:700;color:#7dd3fc">${esc(centerInput ? centerInput.short : centerFallbackTitle)}</span>
          <strong style="font-size:13px">${esc(centerPrim ? centerPrim.text : '中心操作')}</strong>
          ${centerPrim && centerPrim.multiCount > 1 ? `<small style="font-size:10px;opacity:.78">+${centerPrim.multiCount - 1} 项触发</small>` : ''}
        </button>
      </div>
    `;
  }

  function renderScheme02(dev) {
    const byId = new Map(dev.inputs.map((i) => [i.id, i]));
    let bodyHtml = '';

    if (dev.id === 'rc003') {
      const crown = ['xiaomi.rc003.power', 'xiaomi.rc003.voice'].map((id) => byId.get(id)).filter(Boolean);
      const compass = ['xiaomi.rc003.up', 'xiaomi.rc003.right', 'xiaomi.rc003.down', 'xiaomi.rc003.left'].map((id) => byId.get(id));
      const center = byId.get('xiaomi.rc003.confirm');
      const stem = ['xiaomi.rc003.back', 'xiaomi.rc003.home', 'xiaomi.rc003.menu', 'xiaomi.rc003.volumeUp', 'xiaomi.rc003.volumeDown']
        .map((id) => byId.get(id))
        .filter(Boolean);

      bodyHtml = `
        <div class="halo-crown-cluster">${crown.map(renderGlassPill).join('')}</div>
        ${renderCompassWidget(compass, center, '确认')}
        <div class="halo-satellite-cluster">${stem.map(renderGlassPill).join('')}</div>
      `;
    } else if (dev.id === 'mouse') {
      const leftBtn = byId.get('mouse.global.buttonLeft');
      const rightBtn = byId.get('mouse.global.buttonRight');
      const fwdBtn = byId.get('mouse.global.buttonForward');
      const backBtn = byId.get('mouse.top.buttonBack');
      const wheelSectors = ['mouse.global.up', 'mouse.global.right', 'mouse.global.down', 'mouse.global.left'].map((id) => byId.get(id));
      const midBtn = byId.get('mouse.global.buttonMiddle');

      const wingCard = (item) => {
        if (!item) return '';
        const prim = primaryTrigger(item);
        return `
          <button type="button" class="halo-wing-card${item.isExitTrigger ? ' is-exit' : ''}" data-input-id="${esc(item.id)}">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
              <span class="halo-pill-key">${esc(item.short)}</span>
              <span style="font-size:10.5px;opacity:.75">${esc(item.contextLabel || prim.badge)}</span>
            </div>
            <strong style="font-size:14px">${esc(prim.text)}</strong>
          </button>
        `;
      };

      bodyHtml = `
        <div class="halo-mouse-wings">
          <div class="halo-wing-col">${wingCard(leftBtn)}${wingCard(fwdBtn)}${wingCard(backBtn)}</div>
          ${renderCompassWidget(wheelSectors, midBtn, '滚轮中键')}
          <div class="halo-wing-col">${wingCard(rightBtn)}</div>
        </div>
      `;
    } else if (dev.id === 'xbox') {
      const shoulders = ['xbox.lt', 'xbox.lb', 'xbox.view', 'xbox.menu', 'xbox.rb', 'xbox.rt'].map((id) => byId.get(id)).filter(Boolean);
      const dpad = ['xbox.dpad.up', 'xbox.dpad.right', 'xbox.dpad.down', 'xbox.dpad.left'].map((id) => byId.get(id));
      const face = [
        { item: byId.get('xbox.y'), x: 130, y: 34 },
        { item: byId.get('xbox.x'), x: 42, y: 110 },
        { item: byId.get('xbox.b'), x: 218, y: 110 },
        { item: byId.get('xbox.a'), x: 130, y: 186 },
      ];

      bodyHtml = `
        <div class="halo-xbox-arena">
          <div class="halo-xbox-shoulders">${shoulders.map(renderGlassPill).join('')}</div>
          ${renderCompassWidget(dpad, null, '十字键')}
          <div class="halo-diamond">
            ${face
              .filter((f) => f.item)
              .map((f) => {
                const prim = primaryTrigger(f.item);
                return `
                  <button type="button" class="halo-glass-pill halo-diamond-node" data-input-id="${esc(f.item.id)}" style="left:${f.x}px;top:${f.y}px">
                    <span class="halo-pill-key">${esc(f.item.short)}</span>
                    <span class="halo-pill-action">${esc(prim.text)}</span>
                  </button>
                `;
              })
              .join('')}
          </div>
        </div>
      `;
    } else {
      bodyHtml = `
        <div class="halo-keypad-cluster">
          <div class="halo-oled-pill">
            <span style="font-size:10px;color:#7dd3fc;font-weight:700">${esc(dev.name)}</span>
            <strong style="font-size:14px">${esc(dev.profileName)}</strong>
          </div>
          ${dev.inputs
            .map((item) => {
              const prim = primaryTrigger(item);
              const style = `grid-column:${item.col};grid-row:${item.row}`;
              if (!prim) {
                return `<div class="halo-key-island is-idle" style="${style}" aria-hidden="true"><span>${esc(item.short)}</span></div>`;
              }
              return `
                <button type="button" class="halo-key-island${item.isExitTrigger ? ' is-exit' : ''}" data-input-id="${esc(item.id)}" style="${style}">
                  <span style="font-size:10.5px;font-weight:700;color:${item.isExitTrigger ? '#f59e0b' : '#38bdf8'}">${esc(item.short)}</span>
                  <strong style="font-size:12px;line-height:1.25">${esc(prim.text)}</strong>
                </button>
              `;
            })
            .join('')}
        </div>
      `;
    }

    mount.innerHTML = `
      <div class="halo-stage">
        <div class="halo-floating-header">
          <strong>${esc(dev.profileName)}</strong>
          <span style="opacity:.7">${esc(dev.name)}</span>
          <span style="color:#fbbf24;font-weight:600">再按 ${esc(dev.triggerLabel)} 退出</span>
        </div>
        ${bodyHtml}
      </div>
    `;
  }

  /* ------------------------------------------------------------------------
     SCHEME 03: Precision CAD X-Ray Blueprint (45° PCB Routing)
     ------------------------------------------------------------------------ */
  function renderScheme03(dev) {
    const activeItems = dev.inputs.filter(isInteractive);
    const leftItems = activeItems.filter((i) => i.side === 'left').sort((a, b) => a.ny - b.ny);
    const rightItems = activeItems.filter((i) => i.side !== 'left').sort((a, b) => a.ny - b.ny);

    const w = dev.shellSize.w;
    const h = dev.shellSize.h;

    const internalMarkup = (dev.xrayInternals || [])
      .map((part) => {
        if (part.type === 'circle') {
          return `
            <circle class="xray-internal-part" cx="${part.cx}" cy="${part.cy}" r="${part.r}" />
            <text class="xray-internal-label" x="${part.cx}" y="${part.cy + 3}">${esc(part.label)}</text>
          `;
        }
        return `
          <rect class="xray-internal-part" x="${part.x}" y="${part.y}" width="${part.w}" height="${part.h}" rx="${part.rx || 4}" />
          <text class="xray-internal-label" x="${part.x + part.w / 2}" y="${part.y + part.h / 2 + 3}">${esc(part.label)}</text>
        `;
      })
      .join('');

    const switchesMarkup = dev.inputs
      .map((item) => {
        const prim = primaryTrigger(item);
        const cx = item.nx * w;
        const cy = item.ny * h;
        const bw = Math.max(20, item.w * w * 0.78);
        const bh = Math.max(18, item.h * h * 0.78);
        const cls = [
          'xray-switch-hit',
          prim ? 'is-configured' : '',
          item.isExitTrigger ? 'is-exit' : prim ? `kind-${prim.kind}` : '',
        ]
          .filter(Boolean)
          .join(' ');
        return `
          <g class="${cls}" data-input-id="${esc(item.id)}" data-xray-anchor="${cx.toFixed(1)},${cy.toFixed(1)}">
            <rect class="xray-switch-box" x="${(cx - bw / 2).toFixed(1)}" y="${(cy - bh / 2).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="${item.shape === 'circle' ? bw / 2 : 5}" />
            <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="2.2" fill="${item.isExitTrigger ? '#ff5a1f' : prim ? '#00e5ff' : '#475569'}" />
          </g>
        `;
      })
      .join('');

    const renderXrayCard = (item, side) => {
      const prim = primaryTrigger(item);
      return `
        <button type="button" class="xray-node-card side-${side}${item.isExitTrigger ? ' is-exit' : ''}" data-input-id="${esc(item.id)}" data-side="${side}">
          <div style="min-width:0;flex:1 1 auto">
            <div class="xray-node-title">${esc(prim.text)}</div>
            <div class="xray-node-meta">${esc(item.contextLabel ? `${item.contextLabel} · ` : '')}${esc(prim.detail || prim.badge)}</div>
          </div>
          <span class="xray-node-code">${esc(item.code || item.short)}</span>
        </button>
      `;
    };

    mount.innerHTML = `
      <div class="xray-shell" id="xray-shell">
        <span class="xray-crosshair tl">+</span>
        <span class="xray-crosshair tr">+</span>
        <span class="xray-crosshair bl">+</span>
        <span class="xray-crosshair br">+</span>

        <div class="xray-telemetry-bar">
          <div class="xray-sys-id">
            <span class="xray-led"></span>
            <span>AXONKEY // X-RAY HUD</span>
            <span style="color:#64748b">|</span>
            <span style="color:#94a3b8">${esc(dev.profileName)} · ${esc(dev.model)}</span>
          </div>
          <span class="xray-exit-chip">EXIT: ${esc(dev.triggerLabel)} / ESC</span>
        </div>

        <div class="xray-stage" id="xray-stage">
          <svg class="xray-trace-svg" id="xray-trace-svg" aria-hidden="true"></svg>
          <div class="xray-col">${leftItems.map((i) => renderXrayCard(i, 'left')).join('')}</div>
          <div class="xray-device-center">
            <svg class="xray-blueprint-svg" id="xray-blueprint-svg" viewBox="0 0 ${w} ${h}">
              <path class="xray-shell-outline" d="${dev.silhouettePath}" />
              ${internalMarkup}
              ${switchesMarkup}
            </svg>
          </div>
          <div class="xray-col">${rightItems.map((i) => renderXrayCard(i, 'right')).join('')}</div>
        </div>
      </div>
    `;

    scheduleLaserSync();
  }

  function updateXrayTraces() {
    const stage = document.getElementById('xray-stage');
    const traceSvg = document.getElementById('xray-trace-svg');
    const devSvg = document.getElementById('xray-blueprint-svg');
    if (!stage || !traceSvg || !devSvg) return;

    const stageRect = stage.getBoundingClientRect();
    const devRect = devSvg.getBoundingClientRect();
    if (!stageRect.width || !devRect.width) return;

    const dev = DATA.devices[state.device];
    const vbW = dev.shellSize.w;
    const vbH = dev.shellSize.h;
    const paths = [];

    for (const card of stage.querySelectorAll('.xray-node-card')) {
      const key = card.getAttribute('data-input-id');
      const side = card.getAttribute('data-side');
      const input = dev.inputs.find((i) => i.id === key);
      if (!key || !input) continue;

      const cardRect = card.getBoundingClientRect();
      const x1 = (side === 'left' ? cardRect.right : cardRect.left) - stageRect.left;
      const y1 = cardRect.top + cardRect.height / 2 - stageRect.top;

      const ax = devRect.left - stageRect.left + input.nx * devRect.width;
      const ay = devRect.top - stageRect.top + input.ny * devRect.height;

      // 严格 45° PCB 斜切走线：先水平出线，再按 |dx|=|dy| 对角折入焊盘中心
      const dy = ay - y1;
      const absDy = Math.abs(dy);
      const maxDiag = Math.max(8, Math.abs(ax - x1) - 10);
      const diag = Math.min(absDy, maxDiag);
      const bendX = side === 'left' ? ax - diag : ax + diag;

      const prim = primaryTrigger(input);
      const cls = [
        'xray-trace-path',
        input.isExitTrigger ? 'is-exit' : prim ? `kind-${prim.kind}` : '',
        state.activeId === key ? 'is-active' : '',
      ]
        .filter(Boolean)
        .join(' ');

      const d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} H ${bendX.toFixed(1)} L ${ax.toFixed(1)} ${ay.toFixed(1)}`;
      paths.push(`<path class="${cls}" d="${d}" />`);
      paths.push(`<circle class="xray-pad-ring ${input.isExitTrigger ? 'is-exit' : prim ? `kind-${prim.kind}` : ''}" cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="4.2" />`);
    }

    traceSvg.innerHTML = paths.join('');
  }

  /* ------------------------------------------------------------------------
     SCHEME 04: Dynamic Peripheral Island
     ------------------------------------------------------------------------ */
  function renderScheme04(dev) {
    const activeItems = dev.inputs.filter(isInteractive);
    const hoveredInput = dev.inputs.find((i) => i.id === state.activeId) || activeItems.find((i) => i.triggers && i.triggers.some((t) => t.fullPrompt || t.stepsSummary));
    const hoveredPrim = hoveredInput ? primaryTrigger(hoveredInput) : null;

    const totemDots = dev.inputs
      .map((item) => {
        const active = isInteractive(item);
        const isCurrent = state.activeId === item.id;
        const fill = !active
          ? 'rgba(148,163,184,0.22)'
          : item.isExitTrigger
            ? '#fbbf24'
            : isCurrent
              ? '#34d399'
              : '#38bdf8';
        const r = isCurrent ? 5.2 : active ? 3.8 : 2.1;
        return `<circle cx="${(item.nx * 100).toFixed(1)}" cy="${(item.ny * 100).toFixed(1)}" r="${r}" fill="${fill}" />`;
      })
      .join('');

    const capsHtml = activeItems
      .map((item) => {
        const prim = primaryTrigger(item);
        return `
          <button type="button" class="island-cap-chip${item.isExitTrigger ? ' is-exit' : ''}" data-input-id="${esc(item.id)}" aria-label="${esc(item.label)}：${esc(prim.text)}">
            <span class="island-cap-code">${esc(item.short)}</span>
            <span class="island-cap-dot kind-${esc(prim.kind)}"></span>
            <span>${esc(item.isExitTrigger ? '再按退出' : prim.text)}</span>
          </button>
        `;
      })
      .join('');

    const drawerHtml =
      hoveredInput && hoveredPrim && (hoveredPrim.fullPrompt || hoveredPrim.detail || hoveredInput.triggers.length > 1)
        ? `
          <div class="island-drawer">
            <div class="island-drawer-head">
              <strong>${esc(hoveredInput.label)} · ${esc(hoveredPrim.badge)}</strong>
              <span style="color:#94a3b8">${esc(hoveredInput.triggers.map((t) => `${t.triggerLabel}: ${t.text}`).join('  |  '))}</span>
            </div>
            <p class="island-drawer-body">${esc(hoveredPrim.fullPrompt || hoveredPrim.detail || hoveredPrim.text)}</p>
          </div>
        `
        : '';

    mount.innerHTML = `
      <div class="island-arena${state.islandDock === 'bottom' ? ' is-bottom' : ''}">
        <div class="island-stack">
          <div class="island-pill">
            <div class="island-totem">
              <svg class="island-totem-svg" viewBox="0 0 100 100" aria-hidden="true">
                <rect x="10" y="6" width="80" height="88" rx="16" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.22)" stroke-width="2" />
                ${totemDots}
              </svg>
              <div class="island-totem-meta">
                <strong>${esc(dev.profileName)}</strong>
                <span>${esc(dev.shortName)} · ${activeItems.length} 键就绪</span>
              </div>
            </div>
            <div class="island-keys-rail">${capsHtml}</div>
          </div>
          ${drawerHtml}
        </div>
      </div>
    `;
  }

  /* ------------------------------------------------------------------------
     SCHEME 05: Light Vibrancy Ceramic Surface Projection (No Wires)
     ------------------------------------------------------------------------ */
  function renderCeramicButton(item, extraStyle) {
    if (!item) return '';
    const prim = primaryTrigger(item);
    const cls = [
      'ceramic-key',
      !prim ? 'is-idle' : item.isExitTrigger ? 'is-exit' : `kind-${prim.kind}`,
    ]
      .filter(Boolean)
      .join(' ');
    const tagText = !prim ? '未配置' : item.isExitTrigger ? '退出键' : prim.detail || prim.badge;
    const labelText = !prim ? '静默保留' : item.isExitTrigger ? '再按退出' : prim.text;

    return `
      <button type="button" class="${cls}" data-input-id="${esc(item.id)}" ${extraStyle ? `style="${extraStyle}"` : ''} ${!prim ? 'disabled' : ''}>
        <div class="ceramic-key-top">
          <span class="ceramic-key-code">${esc(item.short)}</span>
          <span class="ceramic-key-tag">${esc(tagText)}</span>
        </div>
        <strong class="ceramic-key-label">${esc(labelText)}</strong>
      </button>
    `;
  }

  function renderScheme05(dev) {
    const byId = new Map(dev.inputs.map((i) => [i.id, i]));
    let surfaceHtml = '';

    if (dev.id === 'rc003') {
      surfaceHtml = `
        <div class="ceramic-rc-surface">
          <div class="ceramic-rc-crown">
            ${renderCeramicButton(byId.get('xiaomi.rc003.power'))}
            ${renderCeramicButton(byId.get('xiaomi.rc003.voice'))}
          </div>
          <div class="ceramic-rc-ring">
            ${renderCeramicButton(byId.get('xiaomi.rc003.up'), 'grid-column:2;grid-row:1')}
            ${renderCeramicButton(byId.get('xiaomi.rc003.left'), 'grid-column:1;grid-row:2')}
            ${renderCeramicButton(byId.get('xiaomi.rc003.confirm'), 'grid-column:2;grid-row:2')}
            ${renderCeramicButton(byId.get('xiaomi.rc003.right'), 'grid-column:3;grid-row:2')}
            ${renderCeramicButton(byId.get('xiaomi.rc003.down'), 'grid-column:2;grid-row:3')}
          </div>
          <div class="ceramic-rc-stem">
            ${renderCeramicButton(byId.get('xiaomi.rc003.back'))}
            ${renderCeramicButton(byId.get('xiaomi.rc003.volumeUp'))}
            ${renderCeramicButton(byId.get('xiaomi.rc003.home'))}
            ${renderCeramicButton(byId.get('xiaomi.rc003.volumeDown'))}
            ${renderCeramicButton(byId.get('xiaomi.rc003.menu'))}
            ${renderCeramicButton(byId.get('xiaomi.rc003.tv'))}
          </div>
        </div>
      `;
    } else if (dev.id === 'mouse') {
      surfaceHtml = `
        <div class="ceramic-mouse-surface">
          <div class="ceramic-mouse-thumb">
            ${renderCeramicButton(byId.get('mouse.global.buttonForward'))}
            ${renderCeramicButton(byId.get('mouse.top.buttonBack'))}
          </div>
          <div style="grid-column:2 / span 2;display:flex;flex-direction:column;gap:12px">
            <div class="ceramic-mouse-main">
              ${renderCeramicButton(byId.get('mouse.global.buttonLeft'), 'min-height:92px')}
              ${renderCeramicButton(byId.get('mouse.global.buttonRight'), 'min-height:92px')}
            </div>
            <div class="ceramic-mouse-wheel">
              ${renderCeramicButton(byId.get('mouse.global.up'), 'grid-column:2;grid-row:1')}
              ${renderCeramicButton(byId.get('mouse.global.left'), 'grid-column:1;grid-row:2')}
              ${renderCeramicButton(byId.get('mouse.global.buttonMiddle'), 'grid-column:2;grid-row:2')}
              ${renderCeramicButton(byId.get('mouse.global.right'), 'grid-column:3;grid-row:2')}
              ${renderCeramicButton(byId.get('mouse.global.down'), 'grid-column:2;grid-row:3')}
            </div>
          </div>
        </div>
      `;
    } else if (dev.id === 'xbox') {
      surfaceHtml = `
        <div class="ceramic-xbox-surface">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            ${renderCeramicButton(byId.get('xbox.lt'))}
            ${renderCeramicButton(byId.get('xbox.lb'))}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            ${renderCeramicButton(byId.get('xbox.rb'))}
            ${renderCeramicButton(byId.get('xbox.rt'))}
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
            ${renderCeramicButton(byId.get('xbox.dpad.up'), 'grid-column:2;grid-row:1')}
            ${renderCeramicButton(byId.get('xbox.dpad.left'), 'grid-column:1;grid-row:2')}
            ${renderCeramicButton(byId.get('xbox.view'), 'grid-column:2;grid-row:2')}
            ${renderCeramicButton(byId.get('xbox.dpad.right'), 'grid-column:3;grid-row:2')}
            ${renderCeramicButton(byId.get('xbox.dpad.down'), 'grid-column:2;grid-row:3')}
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
            ${renderCeramicButton(byId.get('xbox.y'), 'grid-column:2;grid-row:1')}
            ${renderCeramicButton(byId.get('xbox.x'), 'grid-column:1;grid-row:2')}
            ${renderCeramicButton(byId.get('xbox.menu'), 'grid-column:2;grid-row:2')}
            ${renderCeramicButton(byId.get('xbox.b'), 'grid-column:3;grid-row:2')}
            ${renderCeramicButton(byId.get('xbox.a'), 'grid-column:2;grid-row:3')}
          </div>
        </div>
      `;
    } else {
      surfaceHtml = `
        <div class="ceramic-k18-surface">
          <div class="ceramic-k18-oled">
            <span style="font-size:10px;color:#7dd3fc">${esc(dev.name)}</span>
            <strong style="font-size:14px">${esc(dev.profileName)}</strong>
          </div>
          ${dev.inputs.map((i) => renderCeramicButton(i, `grid-column:${i.col};grid-row:${i.row}`)).join('')}
        </div>
      `;
    }

    const active = dev.inputs.find((i) => i.id === state.activeId);
    const activePrim = active ? primaryTrigger(active) : null;
    const loupeHtml =
      active && activePrim && activePrim.fullPrompt
        ? `<div class="ceramic-loupe"><strong>${esc(active.label)} · 提示词全文：</strong>${esc(activePrim.fullPrompt)}</div>`
        : '';

    mount.innerHTML = `
      <div class="ceramic-shell">
        <header class="ceramic-header">
          <div class="ceramic-title">
            <strong>${esc(dev.profileName)}</strong>
            <span>${esc(dev.name)}</span>
          </div>
          <span class="ceramic-exit-pill">再按 ${esc(dev.triggerLabel)} 退出</span>
        </header>
        ${surfaceHtml}
        ${loupeHtml}
      </div>
    `;
  }

  /* ------------------------------------------------------------------------
     Overview Matrix (All 5 Schemes Side-by-Side)
     ------------------------------------------------------------------------ */
  function renderOverview() {
    const d = DATA.devices[state.device];
    const cards = Object.values(DATA.schemes)
      .map((s) => {
        let previewGraphic = '';
        if (s.id === '01') {
          previewGraphic = `
            <svg viewBox="0 0 240 120" width="220" height="110">
              <rect x="75" y="70" width="90" height="32" rx="8" fill="rgba(30,41,59,0.85)" stroke="rgba(148,163,184,0.45)" transform="skewX(-18)" />
              <rect x="75" y="45" width="90" height="32" rx="8" fill="rgba(8,47,73,0.75)" stroke="rgba(34,211,238,0.65)" transform="skewX(-18)" />
              <rect x="75" y="20" width="90" height="32" rx="8" fill="rgba(37,99,235,0.45)" stroke="#60a5fa" transform="skewX(-18)" />
              <line x1="110" y1="14" x2="110" y2="85" stroke="#38bdf8" stroke-dasharray="2 2" />
              <rect x="14" y="18" width="52" height="16" rx="4" fill="rgba(15,23,42,0.9)" stroke="#38bdf8" />
              <rect x="174" y="40" width="52" height="16" rx="4" fill="rgba(15,23,42,0.9)" stroke="#fbbf24" />
            </svg>
          `;
        } else if (s.id === '02') {
          previewGraphic = `
            <svg viewBox="0 0 240 120" width="220" height="110">
              <circle cx="120" cy="60" r="42" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="16" stroke-dasharray="56 10" />
              <circle cx="120" cy="60" r="18" fill="rgba(56,189,248,0.28)" stroke="#38bdf8" />
              <rect x="26" y="48" width="44" height="18" rx="9" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.3)" />
              <rect x="170" y="48" width="44" height="18" rx="9" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.3)" />
            </svg>
          `;
        } else if (s.id === '03') {
          previewGraphic = `
            <svg viewBox="0 0 240 120" width="220" height="110">
              <rect x="92" y="16" width="56" height="88" rx="8" fill="rgba(0,229,255,0.06)" stroke="rgba(148,163,184,0.5)" />
              <path d="M 32 36 H 78 L 104 62" fill="none" stroke="#00e5ff" stroke-width="1.6" />
              <path d="M 208 42 H 162 L 136 68" fill="none" stroke="#ff5a1f" stroke-width="1.6" stroke-dasharray="3 2" />
              <circle cx="104" cy="62" r="3.5" fill="#090c11" stroke="#00e5ff" />
              <circle cx="136" cy="68" r="3.5" fill="#090c11" stroke="#ff5a1f" />
            </svg>
          `;
        } else if (s.id === '04') {
          previewGraphic = `
            <svg viewBox="0 0 240 120" width="220" height="110">
              <rect x="18" y="14" width="204" height="28" rx="14" fill="rgba(15,23,42,0.94)" stroke="rgba(56,189,248,0.45)" />
              <rect x="52" y="48" width="136" height="44" rx="10" fill="rgba(15,23,42,0.8)" stroke="rgba(255,255,255,0.16)" />
              <circle cx="34" cy="28" r="5" fill="#38bdf8" />
              <rect x="52" y="21" width="38" height="14" rx="5" fill="rgba(56,189,248,0.22)" />
              <rect x="96" y="21" width="42" height="14" rx="5" fill="rgba(192,132,252,0.22)" />
              <rect x="144" y="21" width="42" height="14" rx="5" fill="rgba(245,158,11,0.25)" />
            </svg>
          `;
        } else {
          previewGraphic = `
            <svg viewBox="0 0 240 120" width="220" height="110">
              <rect x="44" y="14" width="152" height="92" rx="16" fill="#f1f5f9" stroke="#cbd5e1" />
              <rect x="58" y="26" width="58" height="30" rx="8" fill="#ffffff" stroke="#93c5fd" />
              <rect x="124" y="26" width="58" height="30" rx="8" fill="#fef3c7" stroke="#f59e0b" />
              <rect x="58" y="64" width="124" height="30" rx="8" fill="#ffffff" stroke="#cbd5e1" />
            </svg>
          `;
        }

        return `
          <button type="button" class="overview-card" data-jump-scheme="${s.id}">
            <div class="overview-card-head">
              <strong>${s.id} · ${esc(s.name)}</strong>
              <span>进入交互 →</span>
            </div>
            <div class="overview-mini-stage">${previewGraphic}</div>
            <p>${esc(s.tagline)}</p>
            <span class="overview-mini-badge">${esc(s.occlusion)} · 适配 ${esc(d.shortName)}</span>
          </button>
        `;
      })
      .join('');

    mount.innerHTML = `<div class="overview-matrix">${cards}</div>`;
  }

  function syncHighlightClasses() {
    for (const el of mount.querySelectorAll('[data-input-id], .l1-switch-pad')) {
      const id = el.getAttribute('data-input-id') || el.getAttribute('data-key');
      el.classList.toggle('is-active', Boolean(id && id === state.activeId));
      el.classList.toggle('is-pressed', Boolean(id && id === state.pressedId));
    }
    if (state.scheme === '01') updateExplodedLasers();
    if (state.scheme === '03') updateXrayTraces();
  }

  function render() {
    root.dataset.scheme = state.scheme;
    root.dataset.device = state.device;
    root.dataset.bg = state.bg;

    for (const tab of document.querySelectorAll('.scheme-tab')) {
      tab.setAttribute('aria-selected', String(tab.dataset.scheme === state.scheme));
    }
    for (const btn of document.querySelectorAll('[data-device]')) {
      btn.classList.toggle('is-active', btn.dataset.device === state.device);
    }

    explodeToolbar.hidden = state.scheme !== '01';
    dockToolbar.hidden = state.scheme !== '04';

    renderMetaBar();
    renderBackdrop();

    const dev = DATA.devices[state.device];
    if (state.scheme === 'all') renderOverview();
    else if (state.scheme === '01') renderScheme01(dev);
    else if (state.scheme === '02') renderScheme02(dev);
    else if (state.scheme === '03') renderScheme03(dev);
    else if (state.scheme === '04') renderScheme04(dev);
    else if (state.scheme === '05') renderScheme05(dev);

    const activeCount = dev.inputs.filter(isInteractive).length;
    metricsEl.textContent = `${dev.name} · ${activeCount}/${dev.inputs.length} 键已配置`;
    syncHighlightClasses();
  }

  /* ========================================================================
     Event Delegation & Interactive Listeners
     ======================================================================== */
  document.querySelector('.scheme-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-scheme]');
    if (!tab) return;
    state.scheme = tab.dataset.scheme;
    state.activeId = '';
    render();
  });

  document.querySelector('.studio-controls').addEventListener('click', (e) => {
    const devBtn = e.target.closest('[data-device]');
    if (devBtn) {
      state.device = devBtn.dataset.device;
      state.activeId = '';
      render();
    }
  });

  document.getElementById('bg-select').addEventListener('change', (e) => {
    state.bg = e.target.value;
    render();
  });

  document.getElementById('oneshot-toggle').addEventListener('click', (e) => {
    state.oneShot = !state.oneShot;
    e.currentTarget.setAttribute('aria-pressed', String(state.oneShot));
    showToast(state.oneShot ? '单次执行模式' : '常驻把玩模式', state.oneShot ? '点击任意已配键将执行并自动收起' : '点击按键保留交互状态');
  });

  mount.addEventListener('click', (e) => {
    const jump = e.target.closest('[data-jump-scheme]');
    if (jump) {
      state.scheme = jump.dataset.jumpScheme;
      render();
      return;
    }
    const target = e.target.closest('[data-input-id]');
    if (target) {
      handleTrigger(target.getAttribute('data-input-id'));
    }
  });

  mount.addEventListener('pointerover', (e) => {
    const target = e.target.closest('[data-input-id]');
    if (!target) return;
    const id = target.getAttribute('data-input-id');
    if (id && id !== state.activeId) {
      state.activeId = id;
      if (state.scheme === '04' || state.scheme === '05') {
        const prev = document.activeElement;
        render();
        if (prev && prev.getAttribute?.('data-input-id') === id) {
          mount.querySelector(`[data-input-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
        }
      } else {
        syncHighlightClasses();
      }
    }
  });

  mount.addEventListener('pointerleave', () => {
    if (!state.activeId) return;
    state.activeId = '';
    if (state.scheme === '04' || state.scheme === '05') render();
    else syncHighlightClasses();
  });

  // Scheme 01 sliders & pointer parallax
  function syncSliders() {
    explodeOut.textContent = `${state.explode}%`;
    pitchOut.textContent = `${state.pitch}°`;
    yawOut.textContent = `${state.yaw}°`;
    const stack = document.getElementById('exploded-stack');
    if (stack) {
      stack.style.setProperty('--ex', (state.explode / 100).toFixed(2));
      stack.style.setProperty('--rx', `${(state.pitch + state.pointerTiltY).toFixed(1)}deg`);
      stack.style.setProperty('--rz', `${(state.yaw + state.pointerTiltX).toFixed(1)}deg`);
    }
    scheduleLaserSync();
  }

  explodeRange.addEventListener('input', (e) => {
    state.explode = Number(e.target.value);
    syncSliders();
  });
  pitchRange.addEventListener('input', (e) => {
    state.pitch = Number(e.target.value);
    syncSliders();
  });
  yawRange.addEventListener('input', (e) => {
    state.yaw = Number(e.target.value);
    syncSliders();
  });

  explodeToolbar.addEventListener('click', (e) => {
    const pill = e.target.closest('[data-layer]');
    if (pill) {
      state.focusLayer = pill.dataset.layer;
      for (const node of explodeToolbar.querySelectorAll('[data-layer]')) {
        node.classList.toggle('is-on', node.dataset.layer === state.focusLayer);
      }
      const st = document.getElementById('exploded-stage');
      if (st) st.dataset.focusLayer = state.focusLayer;
      return;
    }
    if (e.target.id === 'reset-3d') {
      state.explode = 100;
      state.pitch = 46;
      state.yaw = -24;
      state.pointerTiltX = 0;
      state.pointerTiltY = 0;
      state.focusLayer = 'all';
      explodeRange.value = '100';
      pitchRange.value = '46';
      yawRange.value = '-24';
      for (const node of explodeToolbar.querySelectorAll('[data-layer]')) {
        node.classList.toggle('is-on', node.dataset.layer === 'all');
      }
      const st = document.getElementById('exploded-stage');
      if (st) st.dataset.focusLayer = 'all';
      syncSliders();
    }
  });

  stageEl.addEventListener('pointermove', (e) => {
    if (state.scheme !== '01') return;
    const r = stageEl.getBoundingClientRect();
    const nx = (e.clientX - r.left) / Math.max(1, r.width) - 0.5;
    const ny = (e.clientY - r.top) / Math.max(1, r.height) - 0.5;
    state.pointerTiltX = nx * 9;
    state.pointerTiltY = -ny * 7;
    const stack = document.getElementById('exploded-stack');
    if (stack) {
      stack.style.setProperty('--rx', `${(state.pitch + state.pointerTiltY).toFixed(1)}deg`);
      stack.style.setProperty('--rz', `${(state.yaw + state.pointerTiltX).toFixed(1)}deg`);
    }
    scheduleLaserSync();
  });

  dockToolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dock]');
    if (!btn) return;
    state.islandDock = btn.dataset.dock;
    for (const b of dockToolbar.querySelectorAll('[data-dock]')) {
      b.classList.toggle('is-active', b.dataset.dock === state.islandDock);
    }
    render();
  });

  // Keyboard shortcuts to switch schemes & simulate hardware keys
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key >= '1' && e.key <= '5') {
      state.scheme = `0${e.key}`;
      render();
      return;
    }
    if (e.key === '0') {
      state.scheme = 'all';
      render();
      return;
    }
    const dev = DATA.devices[state.device];
    if (e.key === 'Escape') {
      handleTrigger(dev.triggerInputId);
      return;
    }
    const keyMap = {
      ArrowUp: dev.inputs.find((i) => i.glyph === 'up')?.id,
      ArrowDown: dev.inputs.find((i) => i.glyph === 'down')?.id,
      ArrowLeft: dev.inputs.find((i) => i.glyph === 'left')?.id,
      ArrowRight: dev.inputs.find((i) => i.glyph === 'right')?.id,
      Enter: dev.inputs.find((i) => i.glyph === 'center')?.id,
    };
    const matched = keyMap[e.key];
    if (matched) {
      e.preventDefault();
      handleTrigger(matched);
    }
  });

  window.addEventListener('resize', scheduleLaserSync);
  render();
})();
