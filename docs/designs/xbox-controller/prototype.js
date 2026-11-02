(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const storageKey = 'axonkey.design.xbox-controller.v1';
  const controls = {
    a: ['A 键', '面板按键', 'A'], b: ['B 键', '面板按键', 'B'], x: ['X 键', '面板按键', 'X'], y: ['Y 键', '面板按键', 'Y'],
    lb: ['LB · 左肩键', '肩键', 'LB'], rb: ['RB · 右肩键', '肩键', 'RB'],
    lt: ['LT · 左扳机', '模拟扳机', 'LT', 'trigger'], rt: ['RT · 右扳机', '模拟扳机', 'RT', 'trigger'],
    view: ['View · 视图键', '功能按键', '▣'], menu: ['Menu · 菜单键', '功能按键', '☰'],
    ls: ['左摇杆 · 按下', '摇杆按键 · LS / L3', 'LS'], rs: ['右摇杆 · 按下', '摇杆按键 · RS / R3', 'RS'],
    guide: ['主键', '系统按键 · 输入待验证', '⌂', 'unverified'], share: ['Share · 分享键', '可选按键 · 输入待验证', '↥', 'unverified'],
  };
  const arrows = { up:['向上','↑'], right:['向右','→'], down:['向下','↓'], left:['向左','←'] };
  for (const [dir,[label,arrow]] of Object.entries(arrows)) {
    controls[`dpad.${dir}`] = [`方向键 · ${label}`, '十字方向键', arrow];
    controls[`ls.${dir}`] = [`左摇杆 · ${label}`, '摇杆方向 · 超过阈值时触发', arrow, 'axis'];
    controls[`rs.${dir}`] = [`右摇杆 · ${label}`, '摇杆方向 · 超过阈值时触发', arrow, 'axis'];
  }
  const initial = {
    profile: 'daily', share: false, deadzone: 15, thresholds: {},
    profiles: {
      daily: {
        'a:click': [{type:'keyboard',value:'Space',modifier:''}],
        'b:click': [{type:'keyboard',value:'Escape',modifier:''}],
        'lb:click': [{type:'media',value:'上一曲'}],
        'rb:click': [{type:'media',value:'下一曲'}],
        'dpad.up:click': [{type:'media',value:'音量增加'}],
        'dpad.down:click': [{type:'media',value:'音量减少'}],
      },
      blank: {},
    },
  };
  let state = structuredClone(initial);
  let storageAvailable = true;
  const isAction = (a) => a && ['keyboard','text','media','delay'].includes(a.type) && typeof a.value === 'string' && a.value.length <= 2000 && (a.modifier === undefined || typeof a.modifier === 'string');
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (raw && ['daily','blank'].includes(raw.profile) && raw.profiles && ['daily','blank'].every(id => raw.profiles[id] && typeof raw.profiles[id] === 'object')) {
      state.profile = raw.profile;
      state.share = raw.share === true;
      state.deadzone = Math.min(35,Math.max(5,Number(raw.deadzone) || 15));
      for (const id of ['daily','blank']) {
        state.profiles[id] = {};
        for (const [key, list] of Object.entries(raw.profiles[id])) {
          const [input, trigger] = key.split(':');
          if (controls[input] && ['click','doubleClick','longPress','enter','hold','release'].includes(trigger) && Array.isArray(list)) state.profiles[id][key] = list.filter(isAction).slice(0,30);
        }
      }
      if (raw.thresholds && typeof raw.thresholds === 'object') for (const [key,value] of Object.entries(raw.thresholds)) {
        if (controls[key] && Number.isFinite(value)) state.thresholds[key] = Math.min(95,Math.max(40,value));
      }
    }
  } catch { storageAvailable = false; }
  let selected = 'a', trigger = 'click', editIndex = null, actionTarget = null, toastTimer;
  let testing = false, frame = null, lastPaint = 0, lastPressed = new Set(), observedGuide = false;
  let liveValues = {};
  const targetKey = () => `${selected}:${trigger}`;
  const listFor = (id = selected, event = trigger) => state.profiles[state.profile][`${id}:${event}`] || [];
  const kind = () => controls[selected][3] || 'button';
  const triggersFor = (id) => {
    const type = controls[id][3];
    if (type === 'trigger') return [['enter','扣下'],['hold','保持'],['release','松开']];
    if (type === 'axis') return [['enter','推入'],['hold','保持'],['release','回中']];
    return [['click','单击'],['doubleClick','双击'],['longPress','长按']];
  };
  const threshold = (id = selected) => state.thresholds[id] || (controls[id][3] === 'trigger' ? 40 : 50);
  const actionLabel = (action) => {
    if (action.type === 'keyboard') return `${action.modifier ? `${action.modifier} + ` : ''}${action.value}`;
    if (action.type === 'delay') return `等待 ${action.value} 毫秒`;
    return action.value;
  };
  const actionTypes = {keyboard:'键盘快捷键',text:'输入文字',media:'媒体控制',delay:'等待'};
  function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; },2600); }
  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); storageAvailable = true; $('#save-state').textContent = '已保存到原型'; }
    catch { storageAvailable = false; $('#save-state').textContent = '无法保存 · 仅本次预览有效'; }
  }
  function visibleInputs() { return Object.keys(controls).filter(id => id !== 'share' || state.share); }
  function updateDiagram() {
    let count = 0;
    document.querySelectorAll('[data-key]').forEach(node => {
      const id = node.dataset.key;
      const mapped = triggersFor(id).some(([event]) => listFor(id,event).length > 0);
      node.classList.toggle('selected',id === selected);
      node.classList.toggle('mapped',mapped);
      node.setAttribute('aria-pressed',String(id === selected));
      if (mapped && visibleInputs().includes(id)) count++;
    });
    $('#mapped-count').textContent = `${count} 个输入已配置`;
    $('#card-profile').textContent = state.profile === 'daily' ? '日常控制 · 示例' : '空白配置';
    $('#share-key').style.display = state.share ? '' : 'none';
    $('#share-key').removeAttribute('hidden');
    $('#share-key').setAttribute('tabindex',state.share ? '0' : '-1');
  }
  function renderEditor() {
    const [title,defaultSubtitle,badge] = controls[selected];
    const subtitle = selected === 'guide' && observedGuide ? '系统按键 · 已收到实际输入' : defaultSubtitle;
    const type = kind();
    const unavailable = type === 'unverified' && !(selected === 'guide' && observedGuide);
    const actions = listFor();
    const triggerOptions = triggersFor(selected);
    const analog = type === 'axis' || type === 'trigger';
    const triggerName = triggerOptions.find(([id]) => id === trigger)?.[1] || '单击';
    const axisRelease = state.deadzone, triggerRelease = threshold()-10;
    const conditionText = type === 'axis'
      ? `偏移达到 ${threshold()}% 时触发，回到 ${axisRelease}% 以内后重置。斜推可同时触发两个方向。`
      : `扣至 ${threshold()}% 时触发，松回 ${triggerRelease}% 以下后重置。`;
    $('#editor').innerHTML = `
      <header class="editor-header"><div class="control-badge ${['a','b','x','y'].includes(selected)?selected:''}" aria-hidden="true">${escapeHtml(badge)}</div><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div><button class="icon-button" id="selected-help" aria-label="查看输入说明">${icon('info')}</button></header>
      ${unavailable ? `<div class="warning">${selected === 'guide' ? '已发现相关 HID 元素，但尚未验证主键的实际事件。完成输入测试后再开放映射。' : 'Share 是部分新款手柄的可选输入。当前设备未验证独立事件，此处仅预览位置。'}</div>` : ''}
      <div class="section-heading"><h3>触发方式</h3><span>${analog ? '模拟输入' : '数字按键'}</span></div>
      <div class="trigger-options" role="group" aria-label="触发方式">${triggerOptions.map(([id,label]) => `<button class="trigger-option" data-trigger="${id}" aria-pressed="${trigger === id}"><strong>${label}</strong><small>${listFor(selected,id).length ? escapeHtml(actionLabel(listFor(selected,id)[0])) : '未设置'}</small></button>`).join('')}</div>
      ${analog ? `<div class="parameter-box"><label class="parameter-row"><span>${type === 'trigger'?'触发深度':'方向阈值'}</span><input id="threshold" type="range" min="40" max="95" value="${threshold()}"><output id="threshold-output">${threshold()}%</output></label><p id="threshold-note">${conditionText}</p></div>` : ''}
      ${trigger === 'longPress' || trigger === 'hold' ? '<div class="parameter-box"><p style="margin:0">保持 400 毫秒触发一次；松开时结束。时长为此版本的设计默认值。</p></div>' : ''}
      <div class="section-heading sequence-heading"><h3>当前序列</h3><div class="sequence-actions"><span>${actions.length} 个动作</span><button class="text-button" id="clear-sequence" ${!actions.length || unavailable ? 'disabled' : ''}>清空</button></div></div>
      <div class="action-list">${actions.length ? actions.map((action,index) => `<div class="action-row"><span class="action-order">${String(index+1).padStart(2,'0')}</span><button class="action-main" data-edit="${index}" ${unavailable?'disabled':''}><span class="action-type-icon">${icon(action.type === 'keyboard'?'keyboard':action.type === 'delay'?'test':'plus')}</span><span class="action-text"><strong>${escapeHtml(actionLabel(action))}</strong><small>${actionTypes[action.type]}${action.type==='keyboard'?' · 按下并松开':''}</small></span></button><button class="icon-button" data-delete="${index}" aria-label="删除动作 ${index+1}" ${unavailable?'disabled':''}>${icon('trash')}</button></div>`).join('') : `<div class="empty-state">${icon('plus')}<strong>${escapeHtml(triggerName)}时，暂不执行额外动作</strong><p>${unavailable?'该输入完成验证后即可配置。':'添加快捷键、媒体控制或文字，组成自己的操作序列。'}</p></div>`}</div>
      <button id="add-action" class="add-action" ${unavailable?'disabled':''}>${icon('plus')}添加动作</button><p class="sequence-note">${actions.length ? '按顺序执行。点击动作可编辑。' : '每个输入、每种触发方式分别保存。'}</p>
      <div class="input-behavior">${icon('info')}<div><strong>原始手柄输入仍会传给系统与游戏</strong>配置动作会额外执行；游戏内仍可能同时响应按键。</div></div>
      <div class="editor-annotation">${icon('check')}<span>选择状态不会跟随手柄自动跳转。测试时可开启“按手柄选键”，找到要编辑的位置。</span></div>`;
    updateDiagram();
  }
  function selectInput(id) {
    if (!controls[id] || (id === 'share' && !state.share)) return;
    selected = id;
    trigger = triggersFor(id)[0][0];
    renderEditor();
  }
  $('#controller').addEventListener('click', event => {
    const key = event.target.closest('[data-key]'); if (key) selectInput(key.dataset.key);
  });
  $('#controller').addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const key = event.target.closest('[data-key]'); if (key) { event.preventDefault(); selectInput(key.dataset.key); }
  });
  $('#editor').addEventListener('click', event => {
    const btn = event.target.closest('button'); if (!btn || btn.disabled) return;
    if (btn.dataset.trigger) { trigger=btn.dataset.trigger; renderEditor(); $('#editor').querySelector(`[data-trigger="${trigger}"]`).focus({preventScroll:true}); }
    if (btn.id === 'add-action') openAction(null);
    if (btn.dataset.edit !== undefined) openAction(Number(btn.dataset.edit));
    if (btn.dataset.delete !== undefined) {
      const index = Number(btn.dataset.delete); const list = [...listFor()]; list.splice(index,1);
      state.profiles[state.profile][targetKey()] = list; save(); renderEditor(); $('#add-action').focus({preventScroll:true});
    }
    if (btn.id === 'clear-sequence') { state.profiles[state.profile][targetKey()] = []; save(); renderEditor(); $('#add-action').focus({preventScroll:true}); toast('已清空当前触发方式的动作'); }
    if (btn.id === 'selected-help') $('#notes-dialog').showModal();
  });
  $('#editor').addEventListener('input', event => {
    if (event.target.id !== 'threshold') return;
    state.thresholds[selected] = Number(event.target.value); $('#threshold-output').textContent=`${threshold()}%`;
    $('#threshold-note').textContent=kind()==='trigger' ? `扣至 ${threshold()}% 时触发，松回 ${threshold()-10}% 以下后重置。` : `偏移达到 ${threshold()}% 时触发，回到 ${state.deadzone}% 以内后重置。斜推可同时触发两个方向。`;
    save();
  });
  function renderActionFields(action) {
    const type = $('#action-type').value;
    const data = action?.type === type ? action : {value:type==='delay'?'200':type==='media'?'播放 / 暂停':type==='keyboard'?'Space':'',modifier:''};
    if (type === 'keyboard') $('#action-fields').innerHTML = `<label class="form-field">修饰键<select id="action-modifier">${['','⌘','⌥','⌃','⇧','⌘ + ⇧','⌃ + ⌥'].map(value=>`<option ${data.modifier===value?'selected':''} value="${value}">${value||'无修饰键'}</option>`).join('')}</select></label><label class="form-field">按键<select id="action-value">${['Space','Enter','Escape','Tab','Backspace','ArrowUp','ArrowDown','ArrowLeft','ArrowRight',...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(key=>`<option ${data.value===key?'selected':''}>${key}</option>`).join('')}</select></label>`;
    if (type === 'text') $('#action-fields').innerHTML = `<label class="form-field">文字内容<textarea id="action-value" maxlength="2000" required placeholder="输入要发送的文字">${escapeHtml(data.value)}</textarea></label>`;
    if (type === 'delay') $('#action-fields').innerHTML = `<label class="form-field">等待时间（毫秒）<input id="action-value" type="number" value="${escapeHtml(data.value)}" min="0" max="60000" step="10" required></label>`;
    if (type === 'media') $('#action-fields').innerHTML = `<label class="form-field">媒体操作<select id="action-value">${['播放 / 暂停','上一曲','下一曲','音量增加','音量减少','静音'].map(value=>`<option ${data.value===value?'selected':''}>${value}</option>`).join('')}</select></label>`;
  }
  function openAction(index) {
    editIndex = index;
    actionTarget = {profile:state.profile,key:targetKey()};
    const action = index === null ? null : listFor()[index];
    $('#action-dialog-title').textContent = index === null ? '添加动作' : '编辑动作';
    $('#action-type').value = action?.type || 'keyboard';
    renderActionFields(action); $('#action-dialog').showModal();
  }
  $('#action-type').addEventListener('change',()=>renderActionFields());
  $('#action-form').addEventListener('submit', event => {
    event.preventDefault();
    const action = {type:$('#action-type').value,value:$('#action-value').value};
    if (action.type === 'keyboard') action.modifier = $('#action-modifier').value;
    if (action.type === 'text' && !action.value.trim()) { $('#action-value').focus(); return; }
    const list = [...(state.profiles[actionTarget.profile][actionTarget.key] || [])];
    if (editIndex === null) list.push(action); else list[editIndex] = action;
    state.profiles[actionTarget.profile][actionTarget.key] = list;
    save(); $('#action-dialog').close(); renderEditor(); $('#add-action').focus({preventScroll:true});
  });
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click',()=>button.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click',event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom) dialog.close();
  }));
  $('#profile').value = state.profile;
  $('#profile').addEventListener('change',event=>{ state.profile=event.target.value; save(); renderEditor(); });
  $('#settings-button').addEventListener('click',()=>$('#settings-dialog').showModal());
  $('#device-entry').addEventListener('click',()=>$('#device-dialog').showModal());
  $('#xbox-card').addEventListener('click',()=>$('#device-dialog').close());
  $('#design-notes-button').addEventListener('click',()=>$('#notes-dialog').showModal());
  $('#tweaks-button').addEventListener('click',()=>$('#tweaks-dialog').showModal());
  $('#compact-diagram').addEventListener('change',event=>document.body.classList.toggle('control-compact',event.target.checked));
  $('#show-annotations').addEventListener('change',event=>document.body.classList.toggle('hide-annotations',!event.target.checked));
  $('#show-share').checked = state.share;
  $('#show-share').addEventListener('change',event=>{ state.share=event.target.checked; if (!state.share && selected==='share') selectInput('a'); updateDiagram(); save(); });
  $('#deadzone').value = state.deadzone;
  $('#deadzone-output').textContent = `${state.deadzone}%`;
  $('#deadzone').addEventListener('input',event=>{state.deadzone=Number(event.target.value);$('#deadzone-output').textContent=`${state.deadzone}%`;save();if(kind()==='axis')renderEditor();});

  // Read-only preview. No keyboard/mouse synthesis, HID writes or actuator access.
  const standardButtons = ['a','b','x','y','lb','rb','lt','rt','view','menu','ls','rs','dpad.up','dpad.down','dpad.left','dpad.right','guide'];
  function clearLive() {
    liveValues={}; lastPressed=new Set();
    document.querySelectorAll('.pressed').forEach(node=>node.classList.remove('pressed'));
    ['left-value','right-value','lt-value','rt-value'].forEach(id=>{document.getElementById(id).textContent='—';});
    $('#input-dot').classList.remove('live');
  }
  function poll(now) {
    if (!testing) return;
    frame=requestAnimationFrame(poll);
    if (now-lastPaint<32) return; lastPaint=now;
    let pads;
    try { pads=[...(navigator.getGamepads?.()||[])].filter(Boolean); }
    catch { stopTesting();toast('浏览器不允许读取手柄；仍可点击图形体验设计');return; }
    const pad=pads.find(item=>/xbox|045e|microsoft/i.test(item.id));
    if (!pad) {clearLive();$('#live-status').textContent=pads.length?'未识别到 Xbox 手柄，其他手柄不会套用本布局。':'请按一下 Xbox 手柄；浏览器尚未提供输入。';$('#input-status').textContent='等待 Xbox 输入';return;}
    if (pad.mapping!=='standard') {clearLive();$('#live-status').textContent='浏览器未提供标准布局，需使用原生 HID 适配。';$('#input-status').textContent='检测到设备 · 布局待适配';return;}
    liveValues={};
    standardButtons.forEach((id,index)=>{liveValues[id]=pad.buttons[index]?.value||0;});
    [['ls',0],['rs',2]].forEach(([name,index])=>{
      const x=pad.axes[index]||0,y=pad.axes[index+1]||0;
      liveValues[`${name}.left`]=Math.max(0,-x);liveValues[`${name}.right`]=Math.max(0,x);
      liveValues[`${name}.up`]=Math.max(0,-y);liveValues[`${name}.down`]=Math.max(0,y);
    });
    const pressed=new Set();
    for(const [id,value] of Object.entries(liveValues)) {
      const inputKind=controls[id]?.[3];
      const cutoff=inputKind==='axis'?(lastPressed.has(id)?state.deadzone:threshold(id))/100:inputKind==='trigger'?(threshold(id)-(lastPressed.has(id)?10:0))/100:.5;
      if(value>cutoff)pressed.add(id);
    }
    if(pressed.has('guide')&&!observedGuide) {observedGuide=true;$('#controller [data-key="guide"]').classList.remove('unverified');if(selected==='guide')renderEditor();}
    document.querySelectorAll('[data-key]').forEach(node=>node.classList.toggle('pressed',pressed.has(node.dataset.key)));
    const newInput=[...pressed].find(id=>!lastPressed.has(id));
    if(newInput&&$('#follow-input').checked&&!document.querySelector('dialog[open]')) selectInput(newInput);
    lastPressed=pressed;
    $('#input-dot').classList.add('live');$('#input-status').textContent='Xbox 输入已连接';$('#live-status').textContent=newInput?`收到输入：${controls[newInput][0]}`:'正在读取手柄 · 不执行映射';
    $('#left-value').textContent=`${(pad.axes[0]||0).toFixed(2)}, ${(pad.axes[1]||0).toFixed(2)}`;
    $('#right-value').textContent=`${(pad.axes[2]||0).toFixed(2)}, ${(pad.axes[3]||0).toFixed(2)}`;
    $('#lt-value').textContent=`${Math.round(liveValues.lt*100)}%`;$('#rt-value').textContent=`${Math.round(liveValues.rt*100)}%`;
  }
  function stopTesting() {
    testing=false;cancelAnimationFrame(frame);frame=null;clearLive();$('#test-input').classList.remove('active');$('#test-input').setAttribute('aria-pressed','false');$('#test-input').innerHTML=`${icon('test')}测试输入`;$('#live-panel').hidden=true;$('#input-status').textContent='输入测试未开启';
  }
  $('#test-input').addEventListener('click',()=>{
    if(testing){stopTesting();return;}
    if(!navigator.getGamepads){toast('当前浏览器不支持手柄输入，图形编辑仍可使用');return;}
    testing=true;$('#live-panel').hidden=false;$('#test-input').classList.add('active');$('#test-input').setAttribute('aria-pressed','true');$('#test-input').innerHTML=`${icon('test')}停止测试`;frame=requestAnimationFrame(poll);
  });
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){cancelAnimationFrame(frame);frame=null;clearLive();}
    else if(testing&&!frame)frame=requestAnimationFrame(poll);
  });
  window.addEventListener('pagehide',()=>cancelAnimationFrame(frame));
  window.addEventListener('pageshow',()=>{if(testing){cancelAnimationFrame(frame);frame=requestAnimationFrame(poll);}});

  // Direction regions use the same configured marker as physical buttons.
  const directionDots = {up:[0,-59],right:[59,0],down:[0,59],left:[-59,0]};
  document.querySelectorAll('.direction').forEach(node=>{
    const [x,y]=directionDots[node.dataset.key.split('.')[1]];
    const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');
    dot.setAttribute('class','mapped-dot');dot.setAttribute('cx',x);dot.setAttribute('cy',y);dot.setAttribute('r','4');node.append(dot);
  });
  // Reuse the same diagram for the device card; never maintain a second geometry.
  const thumbnail=$('#controller').cloneNode(true);
  thumbnail.removeAttribute('id');thumbnail.querySelectorAll('.callout,.callout-line').forEach(node=>node.remove());
  thumbnail.querySelectorAll('[tabindex]').forEach(node=>{node.removeAttribute('tabindex');node.removeAttribute('role');});
  thumbnail.querySelectorAll('.key .hit').forEach(node=>{node.setAttribute('fill','#343d48');node.setAttribute('stroke','#222d38');});
  thumbnail.querySelectorAll('.direction .hit').forEach(node=>{node.setAttribute('fill','#e8edf1');node.setAttribute('stroke','#ccd5dd');});
  thumbnail.querySelectorAll('.halo,.mapped-dot,#share-key').forEach(node=>node.remove());
  thumbnail.querySelectorAll('.key text').forEach(node=>{node.setAttribute('fill','#e9eef2');node.setAttribute('text-anchor','middle');node.setAttribute('dominant-baseline','central');node.setAttribute('font-family','sans-serif');node.setAttribute('font-size','14');});
  thumbnail.querySelectorAll('.chevron').forEach(node=>{node.setAttribute('fill','none');node.setAttribute('stroke','#8b9aa8');node.setAttribute('stroke-width','2');});
  thumbnail.setAttribute('viewBox','40 35 600 465');
  $('#mini-controller').src=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(thumbnail))}`;
  if(!storageAvailable)$('#save-state').textContent='无法保存 · 仅本次预览有效';
  renderEditor();
})();
