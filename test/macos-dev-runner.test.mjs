import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const runner = join(root, 'scripts', 'macos-dev-runner.sh')

test('package.json routes tauri dev through the macOS bundle runner wrapper', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.tauri, 'node scripts/tauri.mjs')
  const wrapper = readFileSync(join(root, 'scripts', 'tauri.mjs'), 'utf8')
  assert.match(wrapper, /CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER/)
  assert.match(wrapper, /CARGO_TARGET_X86_64_APPLE_DARWIN_RUNNER/)
  assert.match(wrapper, /APPLE_SIGNING_IDENTITY/)
})

test(
  'macos-dev-runner stages and signs Axonkey.app and runs non-GUI binaries directly',
  { skip: process.platform !== 'darwin' },
  t => {
    const dir = mkdtempSync(join(tmpdir(), 'axonkey-dev-runner-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    const cliSource = join(dir, 'cli.c')
    const cliBin = join(dir, 'axonkey-cli')
    writeFileSync(
      cliSource,
      '#include <stdio.h>\nint main(int argc, char **argv) { printf("CLI_DIRECT:%d\\n", argc); return 0; }\n',
    )
    execFileSync('/usr/bin/clang', [cliSource, '-o', cliBin])
    const direct = spawnSync(runner, [cliBin, '--json'], { encoding: 'utf8' })
    assert.equal(direct.status, 0, direct.stderr)
    assert.match(direct.stdout, /CLI_DIRECT:2/)
    assert.equal(existsSync(join(dir, 'Axonkey.app')), false)

    const appSource = join(dir, 'app.m')
    const appBin = join(dir, 'axonkey')
    writeFileSync(
      appSource,
      [
        '#import <Foundation/Foundation.h>',
        '#include <stdio.h>',
        '#include <stdlib.h>',
        'int main(int argc, char **argv) {',
        '  const char *bid = [[[NSBundle mainBundle] bundleIdentifier] UTF8String] ?: "nil";',
        '  const char *rlog = getenv("RUST_LOG") ?: "unset";',
        '  fprintf(stdout, "BUNDLE_RUN bid=%s rust_log=%s argc=%d\\n", bid, rlog, argc);',
        '  fflush(stdout);',
        '  return 0;',
        '}',
      ].join('\n'),
    )
    execFileSync('/usr/bin/clang', ['-fobjc-arc', appSource, '-framework', 'Foundation', '-o', appBin])

    const bundled = spawnSync(runner, [appBin, '--probe'], {
      encoding: 'utf8',
      env: { ...process.env, APPLE_SIGNING_IDENTITY: '-', RUST_LOG: 'axonkey=info' },
    })
    assert.equal(bundled.status, 0, bundled.stderr)
    assert.match(bundled.stdout, /BUNDLE_RUN bid=com\.axonkey\.app rust_log=axonkey=info argc=2/)

    const appBundle = join(dir, 'Axonkey.app')
    assert.equal(existsSync(join(appBundle, 'Contents', 'Resources', 'icon.icns')), true)
    const plist = readFileSync(join(appBundle, 'Contents', 'Info.plist'), 'utf8')
    assert.match(plist, /<string>com\.axonkey\.app<\/string>/)
    assert.match(plist, /<key>NSAllowsLocalNetworking<\/key>/)
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appBundle])
  },
)

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForFile(path, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf8').trim()
      if (content) return content
    }
    await delay(40)
  }
  throw new Error(`timed out waiting for ${path}`)
}

test(
  'macos-dev-runner stops running Axonkey.app cleanly, allocates a fresh Mach-O inode on rebuild, and cleans up after SIGKILL',
  { skip: process.platform !== 'darwin' },
  async t => {
    const dir = mkdtempSync(join(tmpdir(), 'axonkey-dev-hotreload-'))
    const spawnedPids = new Set()
    t.after(() => {
      for (const pid of spawnedPids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true })
    })

    const appSource = join(dir, 'app.m')
    const appBin = join(dir, 'axonkey')
    writeFileSync(
      appSource,
      [
        '#import <Foundation/Foundation.h>',
        '#include <fcntl.h>',
        '#include <signal.h>',
        '#include <stdio.h>',
        '#include <string.h>',
        '#include <unistd.h>',
        'static char g_exit_file[1024];',
        'static void handle_sigterm(int sig) {',
        '  (void)sig;',
        '  if (g_exit_file[0]) {',
        '    int fd = open(g_exit_file, O_CREAT | O_WRONLY | O_TRUNC, 0644);',
        '    if (fd >= 0) {',
        '      const char msg[] = "CLEAN_SIGTERM\\n";',
        '      (void)write(fd, msg, sizeof(msg) - 1);',
        '      close(fd);',
        '    }',
        '  }',
        '  _exit(0);',
        '}',
        'int main(int argc, char **argv) {',
        '  if (argc >= 3 && strcmp(argv[1], "--hold") == 0) {',
        '    snprintf(g_exit_file, sizeof(g_exit_file), "%s/exit.txt", argv[2]);',
        '    signal(SIGTERM, handle_sigterm);',
        '    char pid_path[1024];',
        '    snprintf(pid_path, sizeof(pid_path), "%s/pid.txt", argv[2]);',
        '    FILE *fp = fopen(pid_path, "w");',
        '    if (fp) { fprintf(fp, "%d\\n", getpid()); fclose(fp); }',
        '    while (1) { usleep(20000); }',
        '  }',
        '  fprintf(stdout, "BUNDLE_REBUILT\\n");',
        '  fflush(stdout);',
        '  return 0;',
        '}',
      ].join('\n'),
    )
    execFileSync('/usr/bin/clang', ['-fobjc-arc', appSource, '-framework', 'Foundation', '-o', appBin])

    const env = { ...process.env, APPLE_SIGNING_IDENTITY: '-' }

    // 1. Simulate `tauri dev` killing the active runner with SIGKILL on file change:
    //    both the LaunchServices-spawned Axonkey.app and runner helpers must clean up.
    const holdDir1 = mkdtempSync(join(dir, 'hold1-'))
    const runner1 = spawn(runner, [appBin, '--hold', holdDir1], { env, stdio: 'ignore' })
    spawnedPids.add(runner1.pid)

    const v1Pid = Number(await waitForFile(join(holdDir1, 'pid.txt')))
    spawnedPids.add(v1Pid)
    assert.equal(isPidAlive(v1Pid), true)

    const appExec = join(dir, 'Axonkey.app', 'Contents', 'MacOS', 'axonkey')
    const firstInode = statSync(appExec).ino

    runner1.kill('SIGKILL')
    const sigkillExitMarker = await waitForFile(join(holdDir1, 'exit.txt'))
    assert.equal(sigkillExitMarker, 'CLEAN_SIGTERM')
    for (let i = 0; i < 30 && isPidAlive(v1Pid); i++) await delay(40)
    assert.equal(isPidAlive(v1Pid), false)

    // 2. Simulate an already-running Axonkey.app when a rebuild runner starts:
    //    runner must stop the live process cleanly BEFORE modifying the bundle and
    //    must replace Contents/MacOS/axonkey with a brand-new inode (never O_TRUNC in place).
    const holdDir2 = mkdtempSync(join(dir, 'hold2-'))
    execFileSync('/usr/bin/open', ['-n', join(dir, 'Axonkey.app'), '--args', '--hold', holdDir2])
    const v2Pid = Number(await waitForFile(join(holdDir2, 'pid.txt')))
    spawnedPids.add(v2Pid)
    assert.equal(isPidAlive(v2Pid), true)

    const rebuilt = spawnSync(runner, [appBin, '--probe'], { encoding: 'utf8', env })
    assert.equal(rebuilt.status, 0, rebuilt.stderr)
    assert.match(rebuilt.stdout, /BUNDLE_REBUILT/)
    assert.equal(readFileSync(join(holdDir2, 'exit.txt'), 'utf8').trim(), 'CLEAN_SIGTERM')
    assert.equal(isPidAlive(v2Pid), false)

    const secondInode = statSync(appExec).ino
    assert.notEqual(secondInode, firstInode, 'expected rebuilt bundle executable to allocate a fresh inode')
  },
)
