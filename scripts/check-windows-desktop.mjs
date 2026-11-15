import { spawnSync } from 'node:child_process'

if (process.platform === 'win32' && !process.env.AXONKEY_ALLOW_ISOLATED_DESKTOP) {
  const probe = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -Namespace AxonkeyWin32 -Name DesktopProbe -MemberDefinition @'
[DllImport("kernel32.dll")]
public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")]
public static extern System.IntPtr GetThreadDesktop(uint threadId);
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
public static extern bool GetUserObjectInformationW(System.IntPtr hObj, int nIndex, System.Text.StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);
'@
$desk = [AxonkeyWin32.DesktopProbe]::GetThreadDesktop([AxonkeyWin32.DesktopProbe]::GetCurrentThreadId())
if ($desk -ne [System.IntPtr]::Zero) {
  $buf = [System.Text.StringBuilder]::new(128)
  $needed = 0
  if ([AxonkeyWin32.DesktopProbe]::GetUserObjectInformationW($desk, 2, $buf, $buf.Capacity * 2, [ref]$needed)) {
    [Console]::Out.Write($buf.ToString())
  }
}
`
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', probe],
    { encoding: 'utf8', timeout: 10_000 },
  )
  const desktop = result.status === 0 ? (result.stdout ?? '').trim() : ''
  if (desktop && desktop.toLowerCase() !== 'default') {
    process.stderr.write(
      [
        '',
        `[Axonkey] 检测到当前终端运行在隔离的 Windows 桌面 (${desktop}) 中（例如 Antigravity / Agent Hub 内置终端）。`,
        '在该桌面启动会导致：',
        '  1. 窗体与任务栏托盘图标无法出现在主桌面上；',
        '  2. 后台进程占用全局单实例锁、Vite 3001 端口和 Quarbor 设备通道，使主桌面也无法再打开 Axonkey。',
        '',
        '请按 Win+R 输入 wt（或从开始菜单打开独立的 PowerShell / Windows Terminal），切换到仓库目录后再运行 make dev。',
        '',
      ].join('\n'),
    )
    process.exit(1)
  }
}
