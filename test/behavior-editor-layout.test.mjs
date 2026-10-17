import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

test('behavior editor orders the current sequence, available heading, tabs, and choices', () => {
  const source = readFileSync(
    join(projectRoot, 'src', 'components', 'BehaviorEditor.tsx'),
    'utf8',
  )
  const editor = source.slice(
    source.indexOf('export function BehaviorEditor'),
    source.indexOf('type BehaviorEditorTab'),
  )
  const currentSequence = editor.indexOf('className="behavior-current-panel"')
  const availableBehavior = editor.indexOf('<h3>可选行为</h3>')
  const tabs = editor.indexOf('className="behavior-tabs"')
  const choices = editor.indexOf('className="behavior-action-grid"')

  assert.ok(currentSequence >= 0 && availableBehavior >= 0 && tabs >= 0 && choices >= 0)
  assert.ok(
    currentSequence < availableBehavior && availableBehavior < tabs && tabs < choices,
    'expected current sequence -> available behavior -> behavior tabs -> behavior choices',
  )
})

test('replace behavior exposes a dedicated single-key replacement flow', () => {
  const source = readFileSync(
    join(projectRoot, 'src', 'components', 'BehaviorEditor.tsx'),
    'utf8',
  )

  assert.match(source, /label="按键替换"/)
  assert.match(source, /trigger === 'replace' \? '设置替换按键'/)
  assert.match(source, /<strong>手动按键选择<\/strong>/)
  assert.match(source, /label="手动按键选择"/)
  assert.match(source, /capturing \? '等待按键输入…' : '键盘录入'/)
})

test('mapping trigger selector keeps all four trigger modes on one row', () => {
  const styles = readFileSync(join(projectRoot, 'src', 'styles.css'), 'utf8')
  assert.match(styles, /\.trigger-options \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/)
})
