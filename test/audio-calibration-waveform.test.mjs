import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer from 'react-test-renderer'
import * as gain from '../src/audioGain.ts'
const require = createRequire(import.meta.url), module = { exports: {} }
const source = ts.transpileModule(readFileSync(new URL('../src/components/AudioTestWaveform.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText
vm.runInNewContext(source, { module, exports: module.exports, require: name => name === '../audioGain' ? gain : require(name) })
const { AudioTestWaveform } = module.exports

test('waveform threshold positions stay fixed when gain changes and clipping remains visible', () => {
 const props = {points:[{t:1000,peak:.1},{t:1100,peak:.2}],now:1200,gain:0,forwarding:true,available:true}
 const r=Renderer.create(React.createElement(AudioTestWaveform,props))
 try {
  const threshold=()=>r.root.findAll(n=>n.type==='g'&&n.props.className?.startsWith('audio-calibration-threshold')).map(n=>n.findByType('line').props.y1)
  const before=threshold(), path=r.root.findByType('path').props.d
  assert.equal(before.length,3)
  assert.match(JSON.stringify(r.toJSON()),/削波风险 0 dBFS/)
  r.update(React.createElement(AudioTestWaveform,{...props,gain:6}))
  assert.notEqual(r.root.findByType('path').props.d,path)
  assert.deepEqual(threshold(),before)
  r.update(React.createElement(AudioTestWaveform,{...props,gain:20}))
  assert.ok(r.root.findAllByType('circle').some(n=>n.props.fill==='#be4545'))
  r.update(React.createElement(AudioTestWaveform,{...props,available:false}))
  assert.equal(r.root.findByType('path').props.d,'')
  assert.match(JSON.stringify(r.toJSON()),/连接遥控器后/)
 } finally { r.unmount() }
})
