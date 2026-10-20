import type { Platform } from '../appTypes'

// Lucide SVG shapes mirror the icons in BehaviorEditor. The designer needs image URLs.
const glyphShapes: Record<string, string> = {
  "RotateCcw": "<path d=\"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\"></path><path d=\"M3 3v5h5\"></path>",
  "Ban": "<circle cx=\"12\" cy=\"12\" r=\"10\"></circle><path d=\"m4.9 4.9 14.2 14.2\"></path>",
  "ArrowLeft": "<path d=\"m12 19-7-7 7-7\"></path><path d=\"M19 12H5\"></path>",
  "ArrowRight": "<path d=\"M5 12h14\"></path><path d=\"m12 5 7 7-7 7\"></path>",
  "ClipboardPaste": "<path d=\"M15 2H9a1 1 0 0 0-1 1v2c0 .6.4 1 1 1h6c.6 0 1-.4 1-1V3c0-.6-.4-1-1-1Z\"></path><path d=\"M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2M16 4h2a2 2 0 0 1 2 2v2M11 14h10\"></path><path d=\"m17 10 4 4-4 4\"></path>",
  "Trash2": "<path d=\"M3 6h18\"></path><path d=\"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6\"></path><path d=\"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2\"></path><line x1=\"10\" x2=\"10\" y1=\"11\" y2=\"17\"></line><line x1=\"14\" x2=\"14\" y1=\"11\" y2=\"17\"></line>",
  "Keyboard": "<path d=\"M10 8h.01\"></path><path d=\"M12 12h.01\"></path><path d=\"M14 8h.01\"></path><path d=\"M16 12h.01\"></path><path d=\"M18 8h.01\"></path><path d=\"M6 8h.01\"></path><path d=\"M7 16h10\"></path><path d=\"M8 12h.01\"></path><rect width=\"20\" height=\"16\" x=\"2\" y=\"4\" rx=\"2\"></rect>",
  "FolderOpen": "<path d=\"m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2\"></path>",
  "Globe": "<circle cx=\"12\" cy=\"12\" r=\"10\"></circle><path d=\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\"></path><path d=\"M2 12h20\"></path>",
  "Clock3": "<circle cx=\"12\" cy=\"12\" r=\"10\"></circle><polyline points=\"12 6 12 12 16.5 12\"></polyline>",
  "ArrowUp": "<path d=\"m5 12 7-7 7 7\"></path><path d=\"M12 19V5\"></path>",
  "ArrowDown": "<path d=\"M12 5v14\"></path><path d=\"m19 12-7 7-7-7\"></path>",
  "MousePointer2": "<path d=\"M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z\"></path>",
  "MoveUp": "<path d=\"M8 6L12 2L16 6\"></path><path d=\"M12 2V22\"></path>",
  "MoveDown": "<path d=\"M8 18L12 22L16 18\"></path><path d=\"M12 2V22\"></path>",
  "MoveLeft": "<path d=\"M6 8L2 12L6 16\"></path><path d=\"M2 12H22\"></path>",
  "MoveRight": "<path d=\"M18 8L22 12L18 16\"></path><path d=\"M2 12H22\"></path>",
  "Play": "<polygon points=\"6 3 20 12 6 21 6 3\"></polygon>",
  "SkipBack": "<polygon points=\"19 20 9 12 19 4 19 20\"></polygon><line x1=\"5\" x2=\"5\" y1=\"19\" y2=\"5\"></line>",
  "SkipForward": "<polygon points=\"5 4 15 12 5 20 5 4\"></polygon><line x1=\"19\" x2=\"19\" y1=\"5\" y2=\"19\"></line>",
  "Square": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"></rect>",
  "Volume2": "<path d=\"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z\"></path><path d=\"M16 9a5 5 0 0 1 0 6\"></path><path d=\"M19.364 18.364a9 9 0 0 0 0-12.728\"></path>",
  "Volume1": "<path d=\"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z\"></path><path d=\"M16 9a5 5 0 0 1 0 6\"></path>",
  "VolumeX": "<path d=\"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z\"></path><line x1=\"22\" x2=\"16\" y1=\"9\" y2=\"15\"></line><line x1=\"16\" x2=\"22\" y1=\"9\" y2=\"15\"></line>"
}

const actionGlyphs: Record<string, string> = {
  "original": "RotateCcw",
  "disabled": "Ban",
  "previousTab": "ArrowLeft",
  "nextTab": "ArrowRight",
  "textAndEnter": "ClipboardPaste",
  "deleteAllText": "Trash2",
  "customKey": "Keyboard",
  "openApp": "FolderOpen",
  "openWebsite": "Globe",
  "paste": "ClipboardPaste",
  "delay": "Clock3",
  "wheel": "MousePointer2",
  "wheelUp": "ArrowUp",
  "wheelDown": "ArrowDown",
  "wheelLeft": "ArrowLeft",
  "wheelRight": "ArrowRight",
  "mouseLeft": "MousePointer2",
  "mouseButton": "MousePointer2",
  "volumeControl": "Volume2",
  "mediaTrack": "SkipForward",
  "mouseRight": "MousePointer2",
  "cursorMove": "MousePointer2",
  "cursorUp": "MoveUp",
  "cursorDown": "MoveDown",
  "cursorLeft": "MoveLeft",
  "cursorRight": "MoveRight",
  "mediaPlayPause": "Play",
  "mediaPrevious": "SkipBack",
  "mediaNext": "SkipForward",
  "mediaStop": "Square",
  "volumeUp": "Volume2",
  "volumeDown": "Volume1",
  "volumeMute": "VolumeX",
  "key": "Keyboard"
}

export function createWorkflowActionIconUrls(platform: Platform): Record<string, string> {
  const keycaps: Record<string, string> = {
    escape: 'Esc', enter: 'Enter', space: 'Space',
    rightCtrl: 'Ctrl', rightAlt: platform === 'macos' ? 'Opt' : 'Alt',
    rightCommand: platform === 'macos' ? 'Cmd' : 'Win',
    arrowUp: '↑', arrowDown: '↓', arrowLeft: '←', arrowRight: '→',
    tab: 'Tab', backspace: 'Back', delete: 'Del', keyHome: 'Home', keyEnd: 'End',
    pageUp: 'PgUp', pageDown: 'PgDn',
  }
  const urls: Record<string, string> = {}
  const toUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  for (const [action, glyph] of Object.entries(actionGlyphs)) {
    urls[action] = toUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="#536f8a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><g transform="translate(4 4)">${glyphShapes[glyph]}</g></svg>`)
  }
  for (const [action, label] of Object.entries(keycaps)) {
    const size = label.length === 1 ? 17 : 12
    urls[action] = toUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 28"><rect x="1" y="1" width="46" height="25" rx="4" fill="#fff" stroke="#cbd1d6"/><path d="M5 26h38" stroke="#cbd1d6" stroke-width="2"/><text x="24" y="14" text-anchor="middle" dominant-baseline="central" font-family="monospace" font-size="${size}" fill="#46535e">${label}</text></svg>`)
  }
  return urls
}
