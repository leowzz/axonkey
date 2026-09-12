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
