import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager'

export async function writeClipboardText(text: string): Promise<void> {
  if ('__TAURI_INTERNALS__' in window) return writeText(text)
  return navigator.clipboard.writeText(text)
}

export async function readClipboardText(): Promise<string> {
  if ('__TAURI_INTERNALS__' in window) return readText()
  return navigator.clipboard.readText()
}
