import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

test('behavior editor places the current sequence before tabs and choices', () => {
  const source = readFileSync(
    join(projectRoot, 'src', 'components', 'BehaviorEditor.tsx'),
    'utf8',
  )
  const editor = source.slice(
    source.indexOf('export function BehaviorEditor'),
    source.indexOf('type BehaviorEditorTab'),
  )
  const currentSequence = editor.indexOf('className="behavior-current-panel"')
  const tabs = editor.indexOf('className="behavior-tabs"')
  const choices = editor.indexOf('className="behavior-actions"')

  assert.ok(currentSequence >= 0 && tabs >= 0 && choices >= 0)
  assert.ok(
    currentSequence < tabs && tabs < choices,
    'expected current sequence -> behavior tabs -> behavior choices',
  )
})
