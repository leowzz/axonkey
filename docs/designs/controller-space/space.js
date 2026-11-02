/* Standalone design prototype. All commands operate on examples in this page. */
'use strict';
const $ = (id) => document.getElementById(id);
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const initialStates = () => ({
  wheel: { open: true, selected: 0, sub: false, subIndex: 0, launched: '', focus: false },
  media: { open: true, time: 442, duration: 1800, playing: false, volume: 48, chapter: 1 },
  spatial: { open: false, menuIndex: 0, selected: 0, grabbed: false, original: null, snap: false, windows: [
    { name: '灵感笔记', x: 8, y: 12, w: 39, h: 65 },
    { name: '参考资料', x: 51, y: 9, w: 38, h: 47 },
    { name: '任务清单', x: 55, y: 61, w: 34, h: 31 }
  ] },
  present: { open: false, menuIndex: 0, slide: 0, x: 50, y: 50, pointer: true, black: false, panX: 0, panY: 0 },
  studio: { open: false, menuIndex: 0, time: 37.4, duration: 120, playing: false, zoom: 1, markers: [], rangeStart: null, rangeEnd: null, checkpoint: 37.4 }
});
let states = initialStates();
let scene = 'wheel';
let deadzone = .18;
let gamepadEnabled = false;
let hardwareArmed = false;
let connectedIndex = null;
let lastButtons = [];
let nextRepeat = 0;
let lastDirection = '';
let lastFrame = 0;
let lastPaint = 0;
const keys = new Set();
const virtual = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 };
const hardware = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 };
const axes = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 };
const configs = [
  { id: 'wheel', letter: 'A', name: '快捷轮盘', tiny: '方向选择 · 即用即走', eyebrow: '01 / COMMAND RING', title: '把常用功能，放到拇指周围。', summary: '按一下唤出，推向一个方向，再确认。整个操作留在视线里。', priority: '推荐起点', useTitle: '离开键鼠，也能顺手做事', useBody: '靠在椅背上开应用、进入影音或切到演示。固定位置形成记忆；不必先记住一整套按键。', journey: ['唤出', '方向选择', '确认进入'], left: '方向选扇区', right: '此场景保留', lt: '保留', rt: '保留', a: '进入 / 打开', b: '返回 / 收起', x: null, y: null, lb: '前一项', rb: '后一项', dpad: '十字键逐项选', scope: '六向轮盘与一层应用子菜单可操作；打开应用只显示示例结果。', value: '日常开应用、切工作场景', analog: '方向选目标，中心死区避免误选。' },
  { id: 'media', letter: 'B', name: '沙发影音', tiny: '双扳机 · 变速浏览', eyebrow: '02 / SOFA CINEMA', title: '把快进的速度，握在手里。', summary: '轻扣慢找，深扣快扫。松开就停在想看的那一刻。', priority: '优先落地', useTitle: '电脑接电视后的第二套界面', useBody: '远距离看视频、听音乐。大字、少层级；连续调节进度与音量，找到位置后马上回到内容。', journey: ['选章节', '扳机找位置', '继续播放'], left: '左右选章节', right: '上下调音量', lt: '变速倒退', rt: '变速快进', a: '播放 / 暂停', b: '隐藏控制台', x: '重新开始', y: '显示控制台', lb: '上一章节', rb: '下一章节', dpad: '精确跳转 ±5 秒', scope: '进度和音量为页面示例。实际控制需要接入播放器；优先支持一个明确目标。', value: '看长视频、听播客、客厅控制', analog: '扳机深度决定正反速度，右杆连续调音量。' },
  { id: 'spatial', letter: 'C', name: '空间桌面', tiny: '抓取窗口 · 摆放吸附', eyebrow: '03 / SPATIAL DESKTOP', title: '像摆物件一样，整理窗口。', summary: '抓起来、挪过去、放下。轻扣 LT 精调，深扣 RT 贴边。', priority: '空间探索', useTitle: '从一堆窗口，走到一个工作区', useBody: '准备查资料、看文档或开会时，用两个摇杆同时控制位置和大小。先看摆放结果，再放下确认。', journey: ['选择窗口', '抓取摆放', '确认放下'], left: '选窗 / 移动', right: '左右宽 · 上下高', lt: '减速精调', rt: '贴边吸附', a: '抓取 / 放下', b: '取消本次摆放', x: '左右分屏', y: '恢复初始布局', lb: '前一个窗口', rb: '后一个窗口', dpad: '选窗 / 抓取后微移', scope: '操作的是三个示例窗口；真实摆放依赖操作系统窗口权限和可调整能力。', value: '多窗口整理、临时分屏', analog: '位移与尺寸分别交给双杆，扳机控制精度与吸附。' },
  { id: 'present', letter: 'D', name: '演示讲解', tiny: '移动光点 · 聚光放大', eyebrow: '04 / PRESENTER', title: '让观众，跟上你的指向。', summary: '拇指移动光点，食指渐进聚光；需要细看时再放大。', priority: '轻量验证', useTitle: '站着讲解，目光留在内容上', useBody: '演示方案、讲图表、做远程讲解。摇杆移动光点，不依赖陀螺仪；扳机让强调和放大都有连续变化。', journey: ['翻到内容', '指向重点', '聚光讲解'], left: '移动光点', right: '放大后平移', lt: '按深放大', rt: '按深聚光', a: '光点显隐', b: '恢复全景', x: '黑屏 / 继续', y: '光点回中', lb: '上一页', rb: '下一页', dpad: '左右翻页', scope: '三页示例内容可翻页；原生版需要对接演示软件或独立叠加层。', value: '演示、授课、讲图表', analog: '摇杆指向，扳机渐进聚光与放大。' },
  { id: 'studio', letter: 'E', name: '剪辑审片', tiny: '穿梭时间 · 精确打点', eyebrow: '05 / REVIEW DESK', title: '用双扳机，穿梭一条时间线。', summary: '快速找到片段，再慢下来逐帧看，留下一个准确标记。', priority: '专业拓展', useTitle: '把找素材，变成双手协同', useBody: '粗看用变速穿梭，细看用逐帧；右杆放大时间轴，左杆拖动播放头。适合审片和素材筛选。', journey: ['穿梭浏览', '放大逐帧', '标记片段'], left: '左右拖播放头', right: '左右缩放时间轴', lt: '反向穿梭', rt: '正向穿梭', a: '播放 / 暂停', b: '回到检查点', x: '添加标记', y: '设置入点 / 出点', lb: '前一标记', rb: '后一标记', dpad: '左右逐帧 · 30 fps', scope: '时间线、标记、入出点为示例；实际审片建议通过指定编辑器插件接入。', value: '素材初筛、审片、定位关键帧', analog: '扳机控制穿梭速度，双杆分工拖动与缩放。' }
];
const icons = {
  apps: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  media: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/>',
  spatial: '<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M8 16v4h13V9h-4"/>',
  present: '<rect x="3" y="3" width="18" height="13" rx="1"/><path d="m8 21 4-5 4 5M12 16v6"/>',
  studio: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M3 20h18M9 18v4m3-18v12"/>',
  focus: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/>'
};
const wheelItems = [ ['apps','应用'], ['media','影音'], ['spatial','窗口'], ['present','演示'], ['studio','审片'], ['focus','专注'] ];
const chapters = ['01 出发','02 海岸','03 黄昏','04 夜色'];
const chapterTimes = [0,360,840,1320];
const slides = [
  { label:'01 / A NEW WAY TO INTERACT', title:'让动作，自然地变成意图。', body:'从逐个配置按键，走向直接操作屏幕上的对象。', blocks:[['01','看见目标'],['02','连续调整'],['03','确认结果']] },
  { label:'02 / THREE KINDS OF CONTROL', title:'方向、速度、力度。', body:'三个连续维度，让同一个控件表达更多意图。', blocks:[['↗','摇杆 · 方向'],['0–1','扳机 · 力度'],['A','按钮 · 决定']] },
  { label:'03 / START WITH ONE SCENE', title:'从沙发上的那一刻开始。', body:'先把一段视频看得更舒服，再把相同的交互带到更多场景。', blocks:[['看','选中内容'],['找','变速浏览'],['停','回到当下']] }
];
const svg = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const timeText = (time) => `${String(Math.floor(time / 60)).padStart(2,'0')}:${String(Math.floor(time % 60)).padStart(2,'0')}`;
const frameText = (time) => `${timeText(time)}:${String(Math.floor(time * 30) % 30).padStart(2,'0')}`;
const status = (message) => { $('activity').textContent = message; };
const config = () => configs.find(item => item.id === scene);
const hints = (pairs) => `<div class="hint-bar">${pairs.map(([k,v]) => `<span><kbd>${k}</kbd>${v}</span>`).join('')}</div>`;
const label = (left,right) => `<div class="scene-label"><i></i>${left}</div><div class="scene-top-right">${right}</div>`;
const menuItems = () => scene === 'spatial' ? ['返回窗口','左右分屏','恢复初始布局'] : scene === 'present' ? ['继续讲解','光点回中','黑屏 / 继续'] : ['继续审片','添加标记','回到检查点'];
function modeMenu() {
  const s = states[scene];
  return s.open ? `<div class="mode-menu"><h3>${config().name}</h3>${menuItems().map((item,i) => `<button data-menu-item="${i}" class="${s.menuIndex===i?'selected':''}">${item}</button>`).join('')}<p>左杆 / 十字键选择 · A 确认 · B 返回</p></div>` : '';
}
function renderWheel() {
  const s = states.wheel;
  const subItems = ['浏览器','终端','文件'];
  return `${label('AXONKEY / QUICK SPACE','Menu 随时唤出')}
    <div class="desktop-ghost"><div class="ghost-window">WORKSPACE<strong>今天的工作台</strong>${'<div class="ghost-line"></div>'.repeat(4)}<div class="ghost-block"></div></div><div class="ghost-window">NOTES<strong>一些正在发生的想法</strong>${'<div class="ghost-line"></div>'.repeat(7)}</div></div>
    ${s.launched&&!s.open?`<div class="result-window"><small>应用打开结果 · 示例</small><h2>${s.launched}</h2><p>菜单已经收起，视线回到当前任务。<br>再按 Menu，可随时回到手柄空间。</p>${'<div class="ghost-line"></div>'.repeat(3)}</div>`:''}
    ${s.open?`<div class="wheel-wrap"><div class="wheel">
      ${wheelItems.map(([id,name],i) => { const a = (i*60-90)*Math.PI/180; return `<button class="wheel-item ${s.selected===i?'selected':''}" data-wheel="${i}" style="translate:${Math.cos(a)*133}px ${Math.sin(a)*133}px" aria-label="选择${name}" aria-pressed="${s.selected===i}">${svg(id)}<span>${name}</span></button>`; }).join('')}
      <div class="wheel-center"><small>QUICK SPACE</small><strong>${wheelItems[s.selected][1]}</strong><span>A 确认进入</span></div>
      ${s.sub?`<div class="wheel-submenu"><small>应用 / 常用目标</small>${subItems.map((item,i)=>`<button data-app="${i}" class="${s.subIndex===i?'selected':''}">${item}</button>`).join('')}</div>`:''}
    </div></div><p class="wheel-caption">${s.sub?'只保留一层子菜单，返回路径始终清楚。':'方向决定目标 · 回中保持选择 · A 才执行'}</p>`:
    !s.launched?`<div class="closed-state"><span class="scene-chip">${s.focus?'专注已开启 · 示例':'手柄空间已收起'}</span><h2>${s.focus?'给眼前的事情，留一点空间。':'需要时，再唤出来。'}</h2><p>Menu 或键盘 M 打开菜单</p><button class="primary" data-command="menu">唤出手柄空间</button></div>`:''}
    ${hints([['L','选择方向'],['A','进入'],['B','返回']])}`;
}
function renderMedia() {
  const s = states.media;
  return `<div class="media-atmosphere"></div>${label('SOFA CINEMA','示例影片 / 30:00')}<div class="media-volume">音量 <span id="volume">${s.volume}</span>%</div><div class="media-title"><small>A QUIET MOMENT</small><h2>慢下来，<br>听见海。</h2><p>演示片段 · 此页面不播放真实视频</p></div><div class="media-time"><strong id="big-time">${timeText(s.time)}</strong><span>把进度变成一种手感</span></div>
    <div class="media-deck" ${s.open?'':'hidden'}><div class="media-deck-top"><button class="play-button" data-command="a" aria-label="播放或暂停"><span id="media-play">${s.playing?'Ⅱ':'▶'}</span></button><div class="media-deck-title"><strong id="chapter-title">${chapters[s.chapter]}</strong><small>按深加速 · 松开回到原播放状态</small></div><div class="media-rate"><span id="media-rate">0.0×</span><small id="transport-mode">已暂停</small></div></div><div class="progress-line"><div id="media-progress" class="progress-fill"></div></div><div class="progress-labels"><span id="media-current">${timeText(s.time)}</span><span>30:00</span></div><div class="chapter-list">${chapters.map((name,i)=>`<button class="chapter ${s.chapter===i?'selected':''}" data-chapter="${i}">${name}</button>`).join('')}</div></div>
    <p class="media-hidden-tip" ${s.open?'hidden':''}>控制台已隐藏 · A 继续控制播放 · Menu 显示</p>${hints([['LT','倒退'],['RT','快进'],['R','音量'],['A','播放 / 暂停']])}`;
}
function renderSpatial() {
  const s = states.spatial;
  return `${label('SPATIAL DESKTOP','三个示例窗口 / 页面内预览')}<div class="display-bound"><div id="snap-grid" class="snap-grid"></div>${s.windows.map((win,i)=>`<button class="desk-window ${s.selected===i?'selected':''} ${s.selected===i&&s.grabbed?'grabbed':''}" id="window-${i}" data-window="${i}" aria-label="选择${win.name}" style="left:${win.x}%;top:${win.y}%;width:${win.w}%;height:${win.h}%;z-index:${s.selected===i?3:1}"><header><i></i><i></i><i></i><span>${win.name}</span></header><section><h3>${['让好想法有位置','收集值得留下的东西','接下来要做的事'][i]}</h3><p>${['工作区不必拥挤，<br>让内容各得其所。','把相关资料放在一起。','从最重要的一件开始。'][i]}</p>${'<div class="ghost-line"></div>'.repeat(i===2?1:2)}<div class="window-mini-blocks"><i></i><i></i><i></i></div></section></button>`).join('')}</div><div class="spatial-pill"><b id="grab-state">${s.grabbed?'已抓取':'已选中'}</b><span>${s.windows[s.selected].name}</span><span>${s.grabbed?'A 放下 · B 撤销':'A 抓取后可移动'}</span></div><div class="spatial-values"><span id="window-values"></span><span id="precision-mode">自由摆放</span></div>${hints([['L','移动'],['R','尺寸'],['LT','精调'],['RT','贴边']])}${modeMenu()}`;
}
function renderPresent() {
  const s = states.present, slide = slides[s.slide];
  return `${label('PRESENTER','示例演示 / '+String(s.slide+1).padStart(2,'0')+' · 03')}<div class="presentation-slide"><div class="slide-canvas" id="slide-canvas"><div class="slide-meta">${slide.label}</div><h2>${slide.title}</h2><p>${slide.body}</p><div class="slide-diagram">${slide.blocks.map(([a,b])=>`<div><b>${a}</b><span>${b}</span></div>`).join('')}</div></div><div class="spotlight" id="spotlight"></div><div class="laser-pointer" id="laser" ${s.pointer?'':'hidden'}></div><div class="black-screen" ${s.black?'':'hidden'}>黑屏休息 · X 返回讲解</div></div><div class="present-stat" id="zoom-value">1.00× · 全景</div>${hints([['LB / RB','翻页'],['RT','聚光'],['LT','放大'],['X','黑屏']])}${modeMenu()}`;
}
function renderStudio() {
  const s = states.studio;
  return `${label('REVIEW DESK','示例素材 / 30 FPS')}<div class="edit-preview"><div class="frame-label"><small>FRAME PREVIEW / DEMO</small><strong id="frame-time">${frameText(s.time)}</strong><span>沿途 · 素材 01</span></div></div><div class="edit-details"><small>SHUTTLE CONTROL</small><h2>找到值得留下的一帧。</h2><p>轻扣，慢慢看。<br>深扣，快速穿梭。<br>松开，再逐帧打点。</p><div class="edit-rate"><span id="studio-rate">0.0×</span> <small id="studio-mode">暂停</small></div></div><div class="timeline"><div class="timeline-toolbar"><button data-command="a" id="studio-play">▶ 播放</button><span id="zoom-label">时间轴 1.0×</span><span>V1 + A1</span></div><div class="timeline-content"><div class="timeline-ruler" id="timeline-ruler"></div><div class="track" id="clip-track"><div class="clip">01 出发</div><div class="clip">02 海岸</div><div class="clip">03 黄昏</div></div><div class="wave-track">${Array.from({length:100},(_,i)=>`<i style="height:${4+Math.abs(Math.sin(i*.79)*Math.cos(i*.23))*15}px"></i>`).join('')}</div><div id="timeline-markers"></div><div class="range-fill" id="range-fill" hidden></div><div class="playhead" id="playhead"></div></div></div><div class="studio-bottom"><span>标记 <b id="marker-count">${s.markers.length}</b> / <span id="last-marker">尚未打点</span></span><span id="range-label">Y 设置入点</span></div>${hints([['LT / RT','变速穿梭'],['← →','逐帧'],['X','标记'],['Y','入 / 出点']])}${modeMenu()}`;
}
function renderScene() {
  $('stage').className = `stage ${scene === 'wheel' ? 'wheel-scene' : scene}`;
  $('stage').innerHTML = ({wheel:renderWheel,media:renderMedia,spatial:renderSpatial,present:renderPresent,studio:renderStudio})[scene]();
  const s = states[scene];
  $('menu-toggle').textContent = s.open ? 'Menu · 收起菜单' : 'Menu · 唤出菜单';
  if(scene==='media') $('menu-toggle').textContent = s.open ? 'Menu · 隐藏控制台' : 'Menu · 显示控制台';
  updateScene();
}
function selectScene(id) {
  if(!configs.some(item=>item.id===id)) return;
  stopInputs();
  cancelGrab();
  states.media.playing = states.studio.playing = false;
  scene = id;
  const c = config();
  $('scenes').innerHTML = configs.map(item=>`<button class="scene-tab ${scene===item.id?'active':''}" data-scene="${item.id}" aria-pressed="${scene===item.id}"><span class="scene-letter">${item.letter}</span><span><strong>${item.name}</strong><small>${item.tiny}</small></span></button>`).join('');
  $('scene-eyebrow').textContent = c.eyebrow;
  $('scene-title').textContent = c.title;
  $('scene-summary').textContent = c.summary;
  $('priority').textContent = c.priority;
  $('use-title').textContent = c.useTitle;
  $('use-body').textContent = c.useBody;
  $('journey').innerHTML = c.journey.map((item,i)=>`${i?'<i>→</i>':''}<span>${item}</span>`).join('');
  ['left','right','lt','rt','lb','rb','dpad'].forEach(key=>$(key+'-role').textContent=c[key]);
  $('face-buttons').innerHTML = ['a','b','x','y'].map(key=>`<button class="face-button ${key}" data-command="${key}" ${c[key]?'':'disabled'}><kbd>${key.toUpperCase()}</kbd>${c[key]||'此场景保留'}</button>`).join('');
  $('lt').disabled = $('rt').disabled = scene==='wheel';
  document.querySelectorAll('.dpad [data-command="up"],.dpad [data-command="down"]').forEach(el=>el.disabled=['present','studio'].includes(scene));
  $('scope').textContent = c.scope;
  $('scene-select').value = scene;
  history.replaceState(null,'','#'+id);
  status(c.journey.join(' → '));
  renderScene();
}
function cancelGrab() {
  const s=states.spatial;
  if(s.grabbed && s.original) s.windows[s.selected] = {...s.original};
  s.grabbed=false; s.original=null;
}
function stopInputs() {
  keys.clear();
  [virtual,hardware,axes].forEach(input=>Object.keys(input).forEach(k=>input[k]=0));
  $('lt').value=$('rt').value=0;
  lastDirection=''; nextRepeat=0;
}
function safePause(message) {
  stopInputs();cancelGrab();hardwareArmed=false;
  states.media.playing = states.studio.playing = false;
  states.wheel.open = false; states.wheel.sub = false;
  states.present.black=false;
  renderScene(); status(message);
}
function setChapter(index) {
  const s=states.media;
  s.chapter=(index+chapters.length)%chapters.length;
  s.time=chapterTimes[s.chapter];s.open=true;
  renderScene();status('已切到 '+chapters[s.chapter]+' · 示例');
}
function selectWindow(index) {
  const s=states.spatial;
  if(s.grabbed){status('先 A 放下或 B 取消，再选择其他窗口');return;}
  s.selected=(index+3)%3;renderScene();status('已选中 '+s.windows[s.selected].name);
}
function addMarker() {
  const s=states.studio, frame=Math.round(s.time*30)/30;
  if(s.markers.some(t=>Math.abs(t-frame)<1/60)){status('这一帧已经有标记');return;}
  s.markers.push(frame);s.markers.sort((a,b)=>a-b);s.checkpoint=frame;
  updateScene();status('已添加标记 '+frameText(frame)+' · B 可回到这里');
}
function splitWindows() {
  cancelGrab();
  states.spatial.windows[0]={...states.spatial.windows[0],x:3,y:5,w:45,h:90};
  states.spatial.windows[1]={...states.spatial.windows[1],x:51,y:5,w:46,h:90};
  states.spatial.windows[2]={...states.spatial.windows[2],x:59,y:65,w:32,h:27};
  states.spatial.selected=0;renderScene();status('已预览左右分屏 · Y 恢复初始布局');
}
function moveSelection(amount) {
  const s=states[scene];
  if(scene==='wheel') {
    if(!s.open)return;
    if(s.sub)s.subIndex=(s.subIndex+amount+3)%3;else s.selected=(s.selected+amount+6)%6;
    renderScene();
  } else if(scene==='media') setChapter(s.chapter+amount);
  else if(s.open){s.menuIndex=(s.menuIndex+amount+3)%3;renderScene();}
  else if(scene==='spatial') selectWindow(s.selected+amount);
  else if(scene==='present'){s.slide=clamp(s.slide+amount,0,2);s.panX=s.panY=0;renderScene();status('第 '+(s.slide+1)+' 页 / 共 3 页');}
  else if(scene==='studio') {
    const t=amount<0?[...s.markers].reverse().find(t=>t<s.time-.02):s.markers.find(t=>t>s.time+.02);
    if(t!==undefined){s.time=t;s.playing=false;updateScene();status('跳到标记 '+frameText(t));}else status(amount<0?'前面没有标记，X 可以添加':'后面没有标记，X 可以添加');
  }
}
function command(name) {
  const s=states[scene];
  if(name==='menu') {
    if(scene==='spatial')cancelGrab();
    if(scene==='studio')s.playing=false;
    s.open=!s.open;
    if(scene==='wheel')s.sub=false;
    renderScene();status(s.open?'界面已唤出 · 左杆选择，A 确认':'界面已收起');return;
  }
  if(scene!=='wheel'&&scene!=='media'&&s.open) {
    if(['up','left','lb'].includes(name))moveSelection(-1);
    else if(['down','right','rb'].includes(name))moveSelection(1);
    else if(name==='b'){s.open=false;renderScene();}
    else if(name==='a') {
      const index=s.menuIndex;s.open=false;renderScene();
      if(index===1){if(scene==='spatial')splitWindows();if(scene==='present')command('y');if(scene==='studio')addMarker();}
      if(index===2){if(scene==='spatial')command('y');if(scene==='present')command('x');if(scene==='studio')command('b');}
    }
    return;
  }
  if(name==='lb'||name==='rb'){moveSelection(name==='lb'?-1:1);return;}
  if(scene==='wheel') {
    if(['up','left','down','right'].includes(name))moveSelection(['up','left'].includes(name)?-1:1);
    else if(name==='b'){if(s.sub)s.sub=false;else s.open=false;renderScene();status(s.sub?'返回应用列表':'已返回');}
    else if(name==='a'&&s.open){
      if(s.sub){s.launched=['浏览器','终端','文件'][s.subIndex];s.open=false;s.sub=false;renderScene();status('已模拟打开'+s.launched+'；没有启动外部应用');}
      else {const id=wheelItems[s.selected][0];if(id==='apps'){s.sub=true;s.subIndex=0;renderScene();status('选择一个常用应用，再按 A');}else if(id==='focus'){s.focus=!s.focus;s.launched='';s.open=false;renderScene();status(s.focus?'专注场景已开启 · 示例':'专注场景已关闭 · 示例');}else selectScene(id);}
    }
  } else if(scene==='media') {
    if(name==='a'){s.playing=!s.playing;status(s.playing?'开始播放示例时间轴':'已暂停');}
    if(name==='b'){s.open=false;renderScene();status('控制台已隐藏，播放状态保留');}
    if(name==='y'){s.open=true;renderScene();}
    if(name==='x'){s.time=0;s.chapter=0;renderScene();status('回到示例影片开头');}
    if(name==='left'||name==='right'){s.time=clamp(s.time+(name==='left'?-5:5),0,s.duration);status('跳转到 '+timeText(s.time));}
    if(name==='up'||name==='down'){s.volume=clamp(s.volume+(name==='up'?2:-2),0,100);status('音量 '+Math.round(s.volume)+'% · 示例');}
    updateScene();
  } else if(scene==='spatial') {
    if(name==='a') {
      if(s.grabbed){s.grabbed=false;s.original=null;status('已放下 '+s.windows[s.selected].name);}
      else{s.grabbed=true;s.original={...s.windows[s.selected]};status('已抓取 · 左杆移动、右杆改尺寸，B 可撤销');}
      renderScene();
    }
    if(name==='b'){if(s.grabbed){cancelGrab();renderScene();status('已撤销本次摆放，恢复抓取前的位置与尺寸');}else status('当前没有待确认的摆放');}
    if(name==='x')splitWindows();
    if(name==='y'){states.spatial=initialStates().spatial;renderScene();status('已恢复初始窗口布局');}
    if(['up','down','left','right'].includes(name)){
      if(!s.grabbed)moveSelection(['up','left'].includes(name)?-1:1);
      else{const w=s.windows[s.selected];if(name==='left')w.x--;if(name==='right')w.x++;if(name==='up')w.y--;if(name==='down')w.y++;boundWindow(w);updateScene();}
    }
  } else if(scene==='present') {
    if(name==='a')s.pointer=!s.pointer;
    if(name==='b'){stopInputs();s.black=false;s.pointer=true;s.panX=s.panY=0;status('已恢复全景与光点');}
    if(name==='x'){s.black=!s.black;status(s.black?'已黑屏 · X 继续讲解':'继续讲解');}
    if(name==='y'){s.x=s.y=50;s.panX=s.panY=0;status('光点已回到中央');}
    if(name==='left'||name==='right')moveSelection(name==='left'?-1:1);
    renderScene();
  } else if(scene==='studio') {
    if(name==='a'){s.playing=!s.playing;status(s.playing?'开始播放示例时间轴':'暂停，左右键可逐帧');}
    if(name==='b'){s.time=s.checkpoint;s.playing=false;status('已回到检查点 '+frameText(s.time));}
    if(name==='x')addMarker();
    if(name==='y'){
      if(s.rangeStart===null||s.rangeEnd!==null){s.rangeStart=s.time;s.rangeEnd=null;status('入点 '+frameText(s.time)+'；继续浏览后按 Y 设出点');}
      else{s.rangeEnd=Math.max(s.rangeStart,s.time);s.rangeStart=Math.min(s.rangeStart,s.time);status('已选中片段 '+frameText(s.rangeStart)+' — '+frameText(s.rangeEnd));}
    }
    if(name==='left'||name==='right'){s.playing=false;s.time=clamp((Math.round(s.time*30)+(name==='left'?-1:1))/30,0,s.duration);status('逐帧定位 '+frameText(s.time));}
    updateScene();
  }
}
function boundWindow(win) {win.w=clamp(win.w,20,94);win.h=clamp(win.h,25,94);win.x=clamp(win.x,2,98-win.w);win.y=clamp(win.y,2,98-win.h);}
function normalizeAxis(x,y) {
  const magnitude=Math.hypot(x,y);
  if(magnitude<deadzone)return [0,0];
  const output=(Math.min(magnitude,1)-deadzone)/(1-deadzone);
  return [x/magnitude*output,y/magnitude*output];
}
function repeatDirection(direction,now,action) {
  if(!direction){lastDirection='';return;}
  if(direction!==lastDirection){lastDirection=direction;nextRepeat=now+380;action();}
  else if(now>nextRepeat){nextRepeat=now+180;action();}
}
function processInput(dt,now) {
  const s=states[scene];
  if(scene==='wheel'){
    if(!s.open)return;
    if(s.sub){repeatDirection(Math.abs(axes.ly)>.45?(axes.ly>0?'down':'up'):'',now,()=>moveSelection(axes.ly>0?1:-1));}
    else if(Math.hypot(axes.lx,axes.ly)>.4){
      const angle=(Math.atan2(axes.ly,axes.lx)*180/Math.PI+90+360)%360;
      const selected=Math.round(angle/60)%6;
      const currentAngle=s.selected*60;
      const diff=Math.abs(((angle-currentAngle+540)%360)-180);
      if(selected!==s.selected&&diff>36){s.selected=selected;renderScene();}
    }
    return;
  }
  if(scene!=='media'&&s.open){repeatDirection(Math.abs(axes.ly)>.45?(axes.ly>0?'down':'up'):'',now,()=>moveSelection(axes.ly>0?1:-1));return;}
  if(scene==='media'){
    repeatDirection(Math.abs(axes.lx)>.55?(axes.lx>0?'right':'left'):'',now,()=>moveSelection(axes.lx>0?1:-1));
    s.volume=clamp(s.volume-axes.ry*dt*35,0,100);
    const rate=16*(axes.rt**2-axes.lt**2);
    const speed=axes.rt>.01||axes.lt>.01?rate:(s.playing?1:0);
    s.time=clamp(s.time+speed*dt,0,s.duration);
    if(s.time===s.duration)s.playing=false;
    s.chapter=chapterTimes.reduce((last,t,i)=>s.time>=t?i:last,0);
  } else if(scene==='spatial'){
    if(!s.grabbed){repeatDirection(Math.abs(axes.lx)>.55?(axes.lx>0?'right':'left'):'',now,()=>moveSelection(axes.lx>0?1:-1));return;}
    const win=s.windows[s.selected],precision=1-axes.lt*.9;
    win.x+=axes.lx*dt*40*precision;win.y+=axes.ly*dt*40*precision;
    win.w+=axes.rx*dt*30*precision;win.h+=axes.ry*dt*30*precision;
    boundWindow(win);
    // Snap engages once on crossing the threshold; it never traps a moving window.
    if(axes.rt>.65&&!s.snap){win.x=win.x+win.w/2<50?3:51;win.w=46;win.y=5;win.h=90;boundWindow(win);s.snap=true;status('已吸附到'+(win.x<50?'左':'右')+'半屏 · A 放下，B 撤销');}
    if(axes.rt<.35)s.snap=false;
  } else if(scene==='present'){
    if(s.black)return;
    s.x=clamp(s.x+axes.lx*dt*46,2,98);s.y=clamp(s.y+axes.ly*dt*46,2,98);
    if(axes.lt>.05){const limit=axes.lt*40;s.panX=clamp(s.panX-axes.rx*dt*35,-limit,limit);s.panY=clamp(s.panY-axes.ry*dt*35,-limit,limit);}
    else s.panX=s.panY=0;
  } else if(scene==='studio'){
    s.zoom=clamp(s.zoom+axes.rx*dt*2,1,8);
    const rate=16*(axes.rt**2-axes.lt**2);
    const speed=axes.rt>.01||axes.lt>.01?rate:(s.playing?1:0);
    s.time=clamp(s.time+(speed+axes.lx*16/s.zoom)*dt,0,s.duration);
    if(s.time===s.duration)s.playing=false;
  }
}
function updateScene() {
  const s=states[scene];
  if(scene==='media') {
    $('volume').textContent=Math.round(s.volume);
    $('big-time').textContent=$('media-current').textContent=timeText(s.time);
    $('media-progress').style.width=s.time/s.duration*100+'%';
    $('media-play').textContent=s.playing?'Ⅱ':'▶';
    const active=axes.lt>.01||axes.rt>.01,rate=16*(axes.rt**2-axes.lt**2);
    $('media-rate').textContent=(active?rate:s.playing?1:0).toFixed(1)+'×';
    $('transport-mode').textContent=active?'穿梭中':s.playing?'正在播放':'已暂停';
    $('chapter-title').textContent=chapters[s.chapter];
    document.querySelectorAll('.chapter').forEach((el,i)=>el.classList.toggle('selected',i===s.chapter));
  } else if(scene==='spatial') {
    s.windows.forEach((win,i)=>{const el=$('window-'+i);Object.assign(el.style,{left:win.x+'%',top:win.y+'%',width:win.w+'%',height:win.h+'%'});});
    const w=s.windows[s.selected];
    $('window-values').textContent=`位置 ${Math.round(w.x)}, ${Math.round(w.y)} · 尺寸 ${Math.round(w.w)} × ${Math.round(w.h)}%`;
    $('precision-mode').textContent=axes.lt>.1?'精调 '+Math.round((1-axes.lt*.9)*100)+'% 速度':s.snap?'已吸附半屏':'自由摆放';
    $('snap-grid').classList.toggle('active',axes.rt>.1&&s.grabbed);
  } else if(scene==='present') {
    $('laser').style.left=s.x+'%';$('laser').style.top=s.y+'%';
    $('spotlight').style.background=`radial-gradient(circle at ${s.x}% ${s.y}%,transparent 0,transparent ${55+axes.rt*35}px,rgba(20,30,40,${axes.rt*.78}) ${75+axes.rt*35}px)`;
    $('spotlight').style.opacity=axes.rt;
    const zoom=1+axes.lt*1.5;
    $('slide-canvas').style.transform=`translate(${s.panX}%,${s.panY}%) scale(${zoom})`;
    $('zoom-value').textContent=zoom.toFixed(2)+'× · '+(zoom>1.05?'右杆平移':'全景');
  } else if(scene==='studio') {
    $('frame-time').textContent=frameText(s.time);
    const active=axes.lt>.01||axes.rt>.01,rate=16*(axes.rt**2-axes.lt**2);
    $('studio-rate').textContent=(active?rate:s.playing?1:0).toFixed(1)+'×';
    $('studio-mode').textContent=active?'穿梭':s.playing?'播放':'暂停';
    $('studio-play').textContent=s.playing?'Ⅱ 暂停':'▶ 播放';
    $('zoom-label').textContent='时间轴 '+s.zoom.toFixed(1)+'×';
    const span=s.duration/s.zoom,start=clamp(s.time-span/2,0,s.duration-span);
    $('timeline-ruler').innerHTML=Array.from({length:5},(_,i)=>`<span>${timeText(start+span*i/4)}</span>`).join('');
    $('playhead').style.left=(s.time-start)/span*100+'%';
    $('clip-track').style.width=s.zoom*100+'%';$('clip-track').style.transform=`translateX(${-start/s.duration*100}%)`;
    $('timeline-markers').innerHTML=s.markers.filter(t=>t>=start&&t<=start+span).map(t=>`<span class="marker" style="left:${(t-start)/span*100}%" title="${frameText(t)}"></span>`).join('');
    $('marker-count').textContent=s.markers.length;
    $('last-marker').textContent=s.markers.length?'检查点 '+frameText(s.checkpoint):'尚未打点';
    $('range-label').textContent=s.rangeStart===null?'Y 设置入点':s.rangeEnd===null?'入点 '+frameText(s.rangeStart)+' · Y 设出点':frameText(s.rangeStart)+' — '+frameText(s.rangeEnd);
    const from=Math.max(s.rangeStart??0,start),to=Math.min(s.rangeEnd??s.time,start+span);
    $('range-fill').hidden=s.rangeStart===null||to<from;
    $('range-fill').style.left=(from-start)/span*100+'%';$('range-fill').style.width=Math.max(0,(to-from)/span*100)+'%';
  }
}
function updateInputUI() {
  ['left','right'].forEach((id,i)=>{
    const x=axes[i?'rx':'lx']*28,y=axes[i?'ry':'ly']*28;
    const el=$(id+'-stick');
    el.querySelector('.stick-thumb').style.transform=`translate(${x}px,${y}px)`;
    el.querySelector('.stick-label').style.transform=`translate(${x}px,${y}px)`;
  });
  ['lt','rt'].forEach(key=>{$(key+'-output').textContent=Math.round(axes[key]*100)+'%';if(document.activeElement!==$(key))$(key).value=axes[key]*100;});
}
function readHardware() {
  if(!gamepadEnabled)return;
  try {
    const pads=[...navigator.getGamepads()].filter(Boolean);
    const pad=connectedIndex===null?pads.find(p=>p.mapping==='standard'):pads.find(p=>p.index===connectedIndex&&p.mapping==='standard');
    if(!pad){
      if(connectedIndex!==null){connectedIndex=null;lastButtons=[];safePause('手柄已断开 · 连续操作已停止，重新唤出后继续');}
      $('connection-status').textContent=pads.length?'当前布局尚未适配 · 可用虚拟手柄':'等待手柄 · 在页面聚焦时按任意键';return;
    }
    if(connectedIndex===null){connectedIndex=pad.index;hardwareArmed=false;lastButtons=pad.buttons.map(b=>b.pressed);status('检测到 standard 手柄；先按 Menu 进入当前场景');}
    $('connection-status').textContent=hardwareArmed?'已读取手柄输入 · 仅控制本页':'手柄就绪 · Menu 开始操作';
    if(document.querySelector('dialog[open]')||!document.hasFocus()){lastButtons=pad.buttons.map(b=>b.pressed);return;}
    if(!hardwareArmed){
      if(pad.buttons[9]?.pressed&&!lastButtons[9]){hardwareArmed=true;states[scene].open=true;renderScene();status('已进入 '+config().name+' · B 返回');}
      lastButtons=pad.buttons.map(b=>b.pressed);return;
    }
    const [lx,ly]=normalizeAxis(pad.axes[0]||0,pad.axes[1]||0),[rx,ry]=normalizeAxis(pad.axes[2]||0,pad.axes[3]||0);
    Object.assign(hardware,{lx,ly,rx,ry,lt:pad.buttons[6]?.value||0,rt:pad.buttons[7]?.value||0});
    const mapping={0:'a',1:'b',2:'x',3:'y',4:'lb',5:'rb',9:'menu',12:'up',13:'down',14:'left',15:'right'};
    Object.entries(mapping).forEach(([i,name])=>{if(pad.buttons[i]?.pressed&&!lastButtons[i])command(name);});
    lastButtons=pad.buttons.map(b=>b.pressed);
  } catch {
    gamepadEnabled=false;connectedIndex=null;stopInputs();
    $('connection-status').textContent='浏览器未提供手柄读取 · 请用虚拟手柄';$('gamepad-connect').textContent='重试读取';
  }
}
function frame(now) {
  const dt=Math.min((now-lastFrame)/1000,.04);lastFrame=now;
  if(!document.hidden&&document.hasFocus()&&!document.querySelector('dialog[open]')) {
    if(navigator.getGamepads)readHardware();
    const keyboard={lx:(keys.has('d')?1:0)-(keys.has('a')?1:0),ly:(keys.has('s')?1:0)-(keys.has('w')?1:0),rx:(keys.has('l')?1:0)-(keys.has('j')?1:0),ry:(keys.has('k')?1:0)-(keys.has('i')?1:0),lt:keys.has('q')?0.55:0,rt:keys.has('e')?0.55:0};
    for(const key of Object.keys(axes))axes[key]=Math.abs(virtual[key])>.001?virtual[key]:Math.abs(keyboard[key])>.001?keyboard[key]:hardware[key];
    processInput(dt,now);
  }
  if(now-lastPaint>32){updateInputUI();updateScene();lastPaint=now;}
  requestAnimationFrame(frame);
}
function setupStick(id,xKey,yKey) {
  const el=$(id);let pointer=null;
  const update=(event)=>{const rect=el.getBoundingClientRect();let x=(event.clientX-rect.left-rect.width/2)/34,y=(event.clientY-rect.top-rect.height/2)/34;const length=Math.hypot(x,y);if(length>1){x/=length;y/=length;}[virtual[xKey],virtual[yKey]]=normalizeAxis(x,y);};
  el.addEventListener('pointerdown',event=>{pointer=event.pointerId;el.setPointerCapture(pointer);update(event);});
  el.addEventListener('pointermove',event=>{if(pointer===event.pointerId)update(event);});
  const release=()=>{virtual[xKey]=virtual[yKey]=0;pointer=null;};
  el.addEventListener('pointerup',release);el.addEventListener('pointercancel',release);el.addEventListener('lostpointercapture',release);
}
document.addEventListener('click',event=>{
  const el=event.target.closest('button');if(!el)return;
  if(el.dataset.scene)selectScene(el.dataset.scene);
  if(el.dataset.command)command(el.dataset.command);
  if(el.dataset.wheel!==undefined){states.wheel.selected=+el.dataset.wheel;renderScene();status('已选择'+wheelItems[states.wheel.selected][1]+' · A 确认');}
  if(el.dataset.app!==undefined){states.wheel.subIndex=+el.dataset.app;renderScene();status('已选择'+['浏览器','终端','文件'][states.wheel.subIndex]+' · A 打开');}
  if(el.dataset.chapter!==undefined)setChapter(+el.dataset.chapter);
  if(el.dataset.window!==undefined)selectWindow(+el.dataset.window);
  if(el.dataset.menuItem!==undefined){states[scene].menuIndex=+el.dataset.menuItem;command('a');}
  if(el.dataset.close)$(el.dataset.close).close();
});
document.addEventListener('keydown',event=>{
  if(event.metaKey||event.ctrlKey||event.altKey)return;
  if(document.querySelector('dialog[open]'))return;
  if(['INPUT','SELECT','TEXTAREA'].includes(event.target.tagName))return;
  const key=event.key.toLowerCase();
  if(['w','a','s','d','i','j','k','l','q','e'].includes(key)){event.preventDefault();keys.add(key);return;}
  const commands={enter:'a',escape:'b',u:'x',o:'y',m:'menu',arrowup:'up',arrowdown:'down',arrowleft:'left',arrowright:'right','[':'lb',']':'rb'};
  if(commands[key]){event.preventDefault();if(!event.repeat||key.startsWith('arrow'))command(commands[key]);}
  if(/^[1-5]$/.test(key)){event.preventDefault();selectScene(configs[+key-1].id);}
});
document.addEventListener('keyup',event=>keys.delete(event.key.toLowerCase()));
window.addEventListener('blur',()=>safePause('页面失去焦点 · 演示已暂停，连续输入已归零'));
document.addEventListener('visibilitychange',()=>{if(document.hidden)safePause('页面进入后台 · 演示已暂停');});
setupStick('left-stick','lx','ly');setupStick('right-stick','rx','ry');
['lt','rt'].forEach(key=>{
  const el=$(key);
  el.addEventListener('input',()=>{virtual[key]=+el.value/100;});
  el.addEventListener('pointerdown',event=>el.setPointerCapture(event.pointerId));
  const release=()=>{virtual[key]=0;el.value=0;};
  ['pointerup','pointercancel','lostpointercapture','keyup','blur'].forEach(type=>el.addEventListener(type,release));
});
$('menu-toggle').addEventListener('click',()=>command('menu'));
$('reset').addEventListener('click',()=>{stopInputs();states[scene]=initialStates()[scene];renderScene();status('已重置 '+config().name);});
$('open-notes').addEventListener('click',()=>{stopInputs();$('notes').showModal();});
$('tweaks-open').addEventListener('click',()=>{stopInputs();$('tweaks').showModal();});
$('scene-select').innerHTML=configs.map(c=>`<option value="${c.id}">${c.letter} · ${c.name}</option>`).join('');
$('scene-select').addEventListener('change',event=>selectScene(event.target.value));
$('deadzone').addEventListener('input',event=>{deadzone=+event.target.value/100;$('deadzone-output').textContent=event.target.value+'%';});
$('large-mode').addEventListener('change',event=>document.body.classList.toggle('large-mode',event.target.checked));
$('comparison').innerHTML=configs.map(c=>`<div class="comparison-row"><strong>${c.letter} · ${c.name}</strong><span>${c.value}</span><span>${c.analog}</span></div>`).join('');
$('gamepad-connect').addEventListener('click',()=>{
  if(!navigator.getGamepads){$('connection-status').textContent='浏览器未提供手柄 API · 可用虚拟手柄';return;}
  gamepadEnabled=!gamepadEnabled;connectedIndex=null;lastButtons=[];stopInputs();
  $('gamepad-connect').textContent=gamepadEnabled?'停止读取':'试用真手柄';
  $('connection-status').textContent=gamepadEnabled?'等待手柄 · 按任意键':'虚拟手柄 · 可直接试用';
  status(gamepadEnabled?'请保持页面聚焦，在已配对手柄上按任意键':'已停止手柄读取');
});
selectScene(configs.some(c=>c.id===location.hash.slice(1))?location.hash.slice(1):'wheel');
requestAnimationFrame(frame);
