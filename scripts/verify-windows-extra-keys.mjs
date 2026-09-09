import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

if (process.platform === 'win32') {
  const dll = readFileSync(new URL('../vendor/frida/frida-gadget.dll', import.meta.url))
  const expected = '6fca4007b2284c765a6c15c967a741f536b5865bf83867326a54029a3b752748'
  if (createHash('sha256').update(dll).digest('hex') !== expected) {
    throw new Error('Bundled Frida Gadget SHA-256 mismatch. Restore the pinned vendor/frida binary.')
  }
  console.log('Verified bundled Frida Gadget 17.15.3 (Windows x64).')
}
