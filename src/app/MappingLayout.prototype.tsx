// Throwaway: three mapping layouts on /?prototype=mapping-layout&variant=A|B|C.
// Compare profile-first, editor-first, and matrix-first navigation. All edits stay in memory.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AppWindow, ArrowDown, ArrowLeft, ArrowRight, Check, ChevronDown,
  Command, Copy, Download, Layers, MoreHorizontal,
  Mouse, Plus, Redo2, Search, Settings2, SlidersHorizontal, Sparkles, Star,
  Timer, Trash2, Undo2, Upload, X,
} from 'lucide-react'
import { AppHeader } from '../components/AppHeader'
import { buttons, iconFor } from '../appConfig'
import './MappingLayout.prototype.css'

type Variant = 'A' | 'B' | 'C'
type Trigger = '单击' | '双击' | '长按'
type Step = { name: string; detail: string; kind: 'key' | 'delay' | 'preset' | 'text' }
type Profile = { id: string; name: string; app: string; color: string; mark: string }
type Mappings = Record<string, Step[]>
const profiles: Profile[] = [
  { id: 'global', name: '通用配置', app: '所有应用', color: '#60758a', mark: '全' },
  { id: 'figma', name: '设计工作', app: 'Figma', color: '#7762bd', mark: 'F' },
  { id: 'safari', name: '网页浏览', app: 'Safari', color: '#2789b5', mark: 'S' },
  { id: 'code', name: '代码编辑', app: 'Visual Studio Code', color: '#397eae', mark: 'V' },
  { id: 'iina', name: '影音控制', app: 'IINA', color: '#c18545', mark: 'I' },
]
const variants: Record<Variant, { name: string; note: string }> = {
  A: { name: '配置优先', note: '应用配置常驻左侧 · 三种触发同时可见 · 行为库按需打开' },
  B: { name: '编辑优先', note: '按键列表 + 单触发编辑 + 常驻行为库 · 推荐作为默认布局' },
  C: { name: '总表优先', note: '整份配置集中浏览 · 选中单元格后编辑 · 适合检查与整理映射' },
}
const triggers: Trigger[] = ['单击', '双击', '长按']
const categories = ['常用', '最近使用', '键盘', '文本', '鼠标', '媒体', '系统', '应用与网站', 'Figma 预置', '自定义分组']
const catalog: Record<string, Step[]> = {
  常用: [
    { name: '按键 / 组合键', detail: '录入快捷键', kind: 'key' },
    { name: '等待', detail: '300 毫秒', kind: 'delay' },
    { name: '粘贴文本', detail: '输入固定内容', kind: 'text' },
    { name: '打开应用', detail: '选择本机应用', kind: 'preset' },
    { name: '返回 / 关闭', detail: 'Esc', kind: 'key' },
    { name: '复制', detail: '⌘ C', kind: 'key' },
    { name: '粘贴', detail: '⌘ V', kind: 'key' },
    { name: '播放 / 暂停', detail: '媒体控制', kind: 'preset' },
  ],
  最近使用: [{ name: '复制', detail: '⌘ C', kind: 'key' }, { name: '等待', detail: '300 毫秒', kind: 'delay' }],
  键盘: ['按键 / 组合键', '右 Control', '右 Option', '右 Command', '上一标签页', '下一标签页', '截图'].map((name) => ({ name, detail: '键盘操作', kind: 'key' })),
  文本: ['粘贴文本', '输入文本并回车', '删除全部文本'].map((name) => ({ name, detail: '文本操作', kind: 'text' })),
  鼠标: ['鼠标单击', '鼠标双击', '向上滚动', '向下滚动', '移动光标'].map((name) => ({ name, detail: '鼠标操作', kind: 'preset' })),
  媒体: ['播放 / 暂停', '上一曲', '下一曲', '增大音量', '减小音量', '静音'].map((name) => ({ name, detail: '媒体控制', kind: 'preset' })),
  系统: ['显示桌面', '任务视图', '锁定屏幕', '切换输入法'].map((name) => ({ name, detail: '系统操作', kind: 'preset' })),
  应用与网站: [{ name: '打开应用', detail: '选择本机应用', kind: 'preset' }, { name: '打开网站', detail: '输入网址', kind: 'preset' }],
  'Figma 预置': ['缩放到选区', '适应画布', '复制为 PNG', '导出选中图层', '切换布局网格'].map((name) => ({ name, detail: 'Figma 快捷操作', kind: 'preset' })),
  自定义分组: [{ name: '复制并发送', detail: '组合行为 · 3 个步骤', kind: 'preset' }, { name: '会议准备', detail: '组合行为 · 2 个步骤', kind: 'preset' }],
}
const mouseKeys = ['顶部上滑', '顶部下滑', '左侧前进', '左侧后退', '右侧上滑', '右侧下滑']
const mappingKey = (profile: string, key: string, trigger: Trigger) => `${profile}/${key}/${trigger}`
const seeded: Mappings = {}
for (const p of profiles) {
  seeded[mappingKey(p.id, 'confirm', '单击')] = p.id === 'figma' ? [
    { name: '复制', detail: '⌘ C', kind: 'key' }, { name: '等待', detail: '120 毫秒', kind: 'delay' },
  ] : [{ name: '确认 / 回车', detail: 'Enter', kind: 'key' }]
  seeded[mappingKey(p.id, 'voice', '单击')] = [{ name: '右 Option', detail: '右 Opt', kind: 'key' }]
  seeded[mappingKey(p.id, 'back', '单击')] = [{ name: '返回 / 关闭', detail: 'Esc', kind: 'key' }]
  seeded[mappingKey(p.id, 'volumeUp', '单击')] = [{ name: '增大音量', detail: '音量 +', kind: 'preset' }]
  seeded[mappingKey(p.id, 'volumeDown', '单击')] = [{ name: '减小音量', detail: '音量 −', kind: 'preset' }]
  seeded[mappingKey(p.id, 'confirm', '双击')] = [{ name: '粘贴', detail: '⌘ V', kind: 'key' }]
  if (p.id === 'figma') seeded[mappingKey(p.id, 'confirm', '长按')] = [{ name: '缩放到选区', detail: 'Shift 2', kind: 'preset' }]
}

function IconButton({ title, onClick, children, disabled = false }: { title: string; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return <button type="button" className="mp-icon" aria-label={title} title={title} onClick={onClick} disabled={disabled}>{children}</button>
}
function AppMark({ profile }: { profile: Profile }) { return <span className="mp-app-mark" style={{ background: profile.color }}>{profile.mark}</span> }
function StepIcon({ step }: { step: Step }) { return step.kind === 'delay' ? <Timer size={17} /> : step.kind === 'text' ? <Layers size={17} /> : step.kind === 'preset' ? <Sparkles size={17} /> : <Command size={17} /> }

export function MappingLayoutPrototype() {
  const [variant, setVariant] = useState<Variant>(() => (new URLSearchParams(location.search).get('variant') as Variant) in variants ? new URLSearchParams(location.search).get('variant') as Variant : 'B')
  const [profileId, setProfileId] = useState('figma')
  const [device, setDevice] = useState<'remote' | 'mouse'>('remote')
  const [keyId, setKeyId] = useState('confirm')
  const [trigger, setTrigger] = useState<Trigger>('单击')
  const [mappings, setMappings] = useState<Mappings>(seeded)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [category, setCategory] = useState('常用')
  const [search, setSearch] = useState('')
  const [profileOpen, setProfileOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [toast, setToast] = useState('')
  const [editing, setEditing] = useState<{ index: number; step: Step; trigger: Trigger } | null>(null)
  const [history, setHistory] = useState<Mappings[]>([])
  const [future, setFuture] = useState<Mappings[]>([])
  const profile = profiles.find(p => p.id === profileId)!
  const keys = device === 'remote' ? buttons.map(b => ({ id: b.id as string, label: b.label, icon: iconFor(b.icon, 16) })) : mouseKeys.map((label, i) => ({ id: `mouse-${i}`, label, icon: <Mouse size={16} /> }))
  const selectedKey = keys.find(k => k.id === keyId) ?? keys[0]
  const sequence = (t: Trigger) => mappings[mappingKey(profileId, selectedKey.id, t)] ?? []
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2200) }
  const change = (t: Trigger, steps: Step[]) => {
    setHistory(h => [...h, mappings]); setFuture([])
    setMappings(m => ({ ...m, [mappingKey(profileId, selectedKey.id, t)]: steps }))
  }
  const chooseProfile = (id: string) => { setProfileId(id); setProfileOpen(false); setEditing(null) }
  const chooseVariant = (v: Variant) => {
    setVariant(v); setLibraryOpen(false); setEditing(null); setMenuOpen(false); setProfileOpen(false)
    const url = new URL(location.href); url.searchParams.set('variant', v); historyReplace(url)
  }
  const cycle = (offset: number) => chooseVariant((['A', 'B', 'C'] as Variant[])[(['A', 'B', 'C'].indexOf(variant) + offset + 3) % 3])
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('input,textarea,select,button,[contenteditable="true"]')) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); cycle(event.key === 'ArrowRight' ? 1 : -1) }
      if (event.key === 'Escape') { setLibraryOpen(false); setEditing(null); setProfileOpen(false); setMenuOpen(false) }
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [variant])
  const add = (step: Step) => { change(trigger, [...sequence(trigger), { ...step }]); notify(`已添加到${selectedKey.label} · ${trigger}`) }
  const undo = () => { if (!history.length) return; setFuture(f => [mappings, ...f]); setMappings(history[history.length - 1]); setHistory(history.slice(0, -1)) }
  const redo = () => { if (!future.length) return; setHistory(h => [...h, mappings]); setMappings(future[0]); setFuture(future.slice(1)) }

  const devicePicker = <select className="mp-device-select" aria-label="映射设备" value={device} onChange={e => { const d = e.target.value as typeof device; setDevice(d); setKeyId(d === 'remote' ? 'confirm' : 'mouse-0') }}><option value="remote">小米 RC003</option><option value="mouse">系统鼠标</option></select>
  const historyActions = <div className="mp-history"><IconButton title="撤销" onClick={undo} disabled={!history.length}><Undo2 size={16} /></IconButton><IconButton title="重做" onClick={redo} disabled={!future.length}><Redo2 size={16} /></IconButton></div>
  const profileButton = <div className="mp-profile-wrap"><button type="button" className="mp-profile-switch" aria-expanded={profileOpen} onClick={() => { setProfileOpen(!profileOpen); setMenuOpen(false) }}><AppMark profile={profile} /><span><strong>{profile.name}</strong><small>{profile.app}</small></span><ChevronDown size={14} /></button>{profileOpen && <div className="mp-profile-pop"><div className="mp-pop-title">编辑配置文件</div>{profiles.map(p => <button type="button" key={p.id} onClick={() => chooseProfile(p.id)}><AppMark profile={p} /><span>{p.name}<small>{p.app}</small></span>{p.id === profileId && <Check size={15} />}</button>)}<button type="button" onClick={() => notify('可为应用添加多份配置；此原型演示五份配置')}><Plus size={16} /> 新建配置文件</button></div>}</div>
  const moreMenu = <div className="mp-menu-wrap"><IconButton title="配置文件操作" onClick={() => { setMenuOpen(!menuOpen); setProfileOpen(false) }}><MoreHorizontal size={19} /></IconButton>{menuOpen && <div className="mp-more-menu">{[[Settings2, '管理应用关联'], [Copy, '复制配置'], [Download, '导入配置'], [Upload, '导出配置'], [Trash2, '恢复默认映射']].map(([Icon, name]) => { const I = Icon as typeof Copy; return <button type="button" key={String(name)} onClick={() => { setMenuOpen(false); notify(`${name}：此处预留配置管理入口`) }}><I size={15} />{String(name)}</button> })}</div>}</div>
  const context = <div className="mp-context">{profileButton}<span className="mp-context-meta"><AppWindow size={14} /> {profile.id === 'global' ? '未匹配应用时使用' : `适用于 ${profile.app}`}<span className="mp-auto">自动切换</span></span><span className="mp-spacer" /><span className="mp-saved"><Check size={13} /> 已保存</span>{moreMenu}</div>
  const triggerTabs = <div className="mp-trigger-tabs" role="tablist" aria-label="触发方式">{triggers.map(t => <button type="button" role="tab" aria-selected={trigger === t} key={t} className={trigger === t ? 'selected' : ''} onClick={() => setTrigger(t)}>{t}<span className={sequence(t).length ? 'mp-dot mapped' : 'mp-dot'} /></button>)}</div>
  const inputList = <aside className="mp-input-list"><div className="mp-pane-top">{devicePicker}</div><div className="mp-key-list">{keys.map(k => <button type="button" key={k.id} aria-pressed={selectedKey.id === k.id} className={selectedKey.id === k.id ? 'selected' : ''} onClick={() => { setKeyId(k.id); setEditing(null) }}>{k.icon}<span>{k.label}</span>{triggers.some(t => mappings[mappingKey(profileId, k.id, t)]?.length) && <span className="mp-key-dot" />}</button>)}</div><div className="mp-device-foot"><span className="mp-dot mapped" /> RC003 已连接 <Settings2 size={13} /></div></aside>
  const openLibrary = (t: Trigger) => {
    setTrigger(t)
    setLibraryOpen(true)
    if (variant === 'B') document.querySelector<HTMLInputElement>('.mp-search input')?.focus()
  }

  const stepList = (t: Trigger, vertical: boolean) => <div className={`mp-steps ${vertical ? 'vertical' : ''}`}>{sequence(t).length ? sequence(t).map((step, i) => <div className="mp-step-wrap" key={`${i}-${step.name}`}>
    {i > 0 && <div className="mp-connector"><ArrowDown size={14} /></div>}
    <div className="mp-step"><button type="button" className="mp-step-main" onClick={() => { setTrigger(t); setEditing({ index: i, step: { ...step }, trigger: t }) }}><span className={`mp-step-glyph ${step.kind}`}><StepIcon step={step} /></span><span><strong>{step.name}</strong><small>{step.detail}</small></span></button><IconButton title={`删除${t}第${i + 1}步`} onClick={() => change(t, sequence(t).filter((_, j) => i !== j))}><X size={13} /></IconButton></div>
  </div>) : <div className="mp-empty"><span className="mp-empty-ring" /><span>尚未配置</span></div>}
    <button type="button" className="mp-add-step" onClick={() => openLibrary(t)}><Plus size={15} /> 添加行为</button>
  </div>

  const library = (drawer = false) => {
    const results = search.trim() ? Object.values(catalog).flat().filter((s, i, all) => all.findIndex(x => x.name === s.name) === i && `${s.name}${s.detail}`.toLowerCase().includes(search.toLowerCase())) : catalog[category]
    return <aside className={`mp-library ${drawer ? 'drawer' : ''}`} aria-label="行为库"><div className="mp-library-heading"><strong>行为库</strong>{drawer ? <IconButton title="关闭行为库" onClick={() => setLibraryOpen(false)}><X size={17} /></IconButton> : <IconButton title="管理行为分组" onClick={() => notify('行为分组可在此管理、排序或导入')}><SlidersHorizontal size={16} /></IconButton>}</div>
      <label className="mp-search"><Search size={15} /><input aria-label="搜索行为" placeholder="搜索行为或预置…" value={search} onChange={e => setSearch(e.target.value)} />{search && <button aria-label="清空搜索" onClick={() => setSearch('')}><X size={13} /></button>}</label>
      <div className="mp-library-body"><nav className="mp-categories" aria-label="行为分组">{categories.map(c => <button type="button" key={c} className={category === c && !search ? 'selected' : ''} onClick={() => { setCategory(c); setSearch('') }}>{c === '常用' ? <Star size={13} /> : c === 'Figma 预置' ? <Sparkles size={13} /> : null}{c}</button>)}</nav>
        <div className="mp-results"><div className="mp-result-title">{search ? '搜索结果' : category}</div>{results.map(step => <button type="button" className="mp-action" key={step.name} onClick={() => add(step)}><StepIcon step={step} /><span><strong>{step.name}</strong><small>{step.detail}</small></span><Plus size={13} /></button>)}{!results.length && <p className="mp-search-empty">没有匹配的行为</p>}</div>
      </div><div className="mp-library-foot">添加到 <strong>{selectedKey.label} · {trigger}</strong></div>
    </aside>
  }

  return <div className={`app-shell mapping-prototype mp-variant-${variant}`}>
    <AppHeader activePage="mapping" hasUpdate={false} enabled={enabled} onBrandClick={() => notify('Axonkey · 布局原型')} onNavigate={() => notify('当前预览按键映射页面')} onToggleEnabled={() => setEnabled(!enabled)} />
    <main className="mp-main">
      {variant === 'A' ? <div className="mp-layout-a">
        <aside className="mp-profiles-rail"><div className="mp-pane-top"><strong>配置文件</strong><IconButton title="新增应用配置" onClick={() => notify('为应用新建配置文件')}><Plus size={17} /></IconButton></div><div className="mp-profile-sections"><small>通用</small>{profiles.slice(0, 1).map(p => <button type="button" className={profileId === p.id ? 'selected' : ''} key={p.id} onClick={() => chooseProfile(p.id)}><AppMark profile={p} /><span>{p.name}<small>{p.app}</small></span></button>)}<small>按应用自动切换</small>{profiles.slice(1).map(p => <button type="button" className={profileId === p.id ? 'selected' : ''} key={p.id} onClick={() => chooseProfile(p.id)}><AppMark profile={p} /><span>{p.app}<small>{p.name}</small></span></button>)}</div><button type="button" className="mp-profile-manage" onClick={() => notify('应用关联、优先级与配置管理')}><Settings2 size={15} /> 管理配置文件</button></aside>
        <section className="mp-a-workspace"><div className="mp-a-context"><AppMark profile={profile} /><strong>{profile.name}</strong><span className="mp-context-meta">{profile.app} · 自动切换</span><span className="mp-spacer" /><span className="mp-saved"><Check size={13} /> 已保存</span>{moreMenu}</div>
          <div className="mp-key-strip"><div>{devicePicker}</div><div className="mp-key-strip-buttons">{keys.map(k => <button type="button" key={k.id} className={selectedKey.id === k.id ? 'selected' : ''} aria-label={k.label} title={k.label} onClick={() => setKeyId(k.id)}>{k.icon}<span>{k.label}</span></button>)}</div></div>
          <div className="mp-editor-heading"><div><h2>{selectedKey.label}</h2><span>三种触发方式</span></div>{historyActions}<button type="button" className="mp-button" onClick={() => { setLibraryOpen(!libraryOpen) }}><Layers size={15} /> 行为库</button></div>
          <div className="mp-three-lanes">{triggers.map(t => <section className={`mp-lane ${trigger === t ? 'active' : ''}`} key={t}><button type="button" className="mp-lane-title" onClick={() => setTrigger(t)}><span className="mp-lane-dot" />{t}<MoreHorizontal size={15} /></button>{stepList(t, true)}</section>)}</div>
        </section>
      </div> : variant === 'B' ? <div className="mp-layout-b">{context}<div className="mp-b-columns">{inputList}<section className="mp-focused-editor"><div className="mp-editor-heading"><div><h2>{selectedKey.label}</h2></div>{historyActions}</div>{triggerTabs}<div className="mp-focused-sequence"><div className="mp-sequence-label"><span className="mp-dot mapped" /> {trigger}时执行</div>{stepList(trigger, true)}</div><div className="mp-editor-foot"><button type="button" onClick={() => { change(trigger, [...(mappings[mappingKey('global', selectedKey.id, trigger)] ?? [])]); notify('已使用通用映射') }}><Layers size={14} /> 使用通用映射</button><span>自动保存</span></div></section>{library()}</div></div> : <div className="mp-layout-c">{context}<div className="mp-c-body"><section className="mp-matrix-pane"><div className="mp-matrix-toolbar">{devicePicker}<span className="mp-spacer" /><button type="button" className="mp-text-button" onClick={() => notify('显示全部按键；可扩展为仅看已配置')}><SlidersHorizontal size={14} /> 全部按键</button></div><div className="mp-matrix-scroll"><table className="mp-matrix"><thead><tr><th>按键</th>{triggers.map(t => <th key={t}>{t}</th>)}</tr></thead><tbody>{keys.map(k => <tr key={k.id}><th><span>{k.icon}{k.label}</span></th>{triggers.map(t => { const steps = mappings[mappingKey(profileId, k.id, t)] ?? []; return <td key={t}><button type="button" className={keyId === k.id && trigger === t ? 'selected' : ''} onClick={() => { setKeyId(k.id); setTrigger(t); setEditing(null) }}>{steps.length ? <><span>{steps[0].name}</span><small>{steps.length > 1 ? `${steps.length} 个步骤` : steps[0].detail}</small></> : <span className="mp-unset">—</span>}</button></td>})}</tr>)}</tbody></table></div></section><aside className="mp-inspector"><div className="mp-editor-heading"><div><h2>{selectedKey.label}</h2><span>{trigger}</span></div>{historyActions}</div>{triggerTabs}<div className="mp-inspector-sequence">{stepList(trigger, true)}</div><div className="mp-inspector-foot"><button type="button" className="mp-button" onClick={() => { change(trigger, []); notify('此触发方式的行为已清除') }} disabled={!sequence(trigger).length}><Trash2 size={14} /> 清除此项</button></div></aside></div></div>}
      {libraryOpen && variant !== 'B' && <div className="mp-drawer-backdrop" onClick={() => setLibraryOpen(false)}><div onClick={e => e.stopPropagation()}>{library(true)}</div></div>}
    </main>
    <footer className="mp-prototype-dock"><div className="mp-dock-info"><span>布局原型 · 模拟数据</span><p>{variants[variant].note}</p></div><div className="mp-switcher"><IconButton title="上一个方案" onClick={() => cycle(-1)}><ArrowLeft size={17} /></IconButton>{(['A', 'B', 'C'] as Variant[]).map(v => <button type="button" className={v === variant ? 'selected' : ''} aria-pressed={v === variant} key={v} onClick={() => chooseVariant(v)}><b>{v}</b> {variants[v].name}{v === 'B' && <span>推荐</span>}</button>)}<IconButton title="下一个方案" onClick={() => cycle(1)}><ArrowRight size={17} /></IconButton></div></footer>
    {toast && <div className="mp-toast"><Check size={14} />{toast}</div>}
    {editing && <div className="mp-modal-backdrop" onClick={() => setEditing(null)}><form className="mp-edit-dialog" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); change(editing.trigger, sequence(editing.trigger).map((s, i) => i === editing.index ? editing.step : s)); setEditing(null) }}><div><h2>编辑行为</h2><IconButton title="关闭编辑" onClick={() => setEditing(null)}><X size={18} /></IconButton></div><label>名称<input autoFocus value={editing.step.name} onChange={e => setEditing({ ...editing, step: { ...editing.step, name: e.target.value } })} /></label><label>快捷键 / 参数<input value={editing.step.detail} onChange={e => setEditing({ ...editing, step: { ...editing.step, detail: e.target.value } })} /></label><button type="submit" className="mp-primary">完成</button></form></div>}
  </div>
}

function historyReplace(url: URL) { window.history.replaceState(null, '', url) }
