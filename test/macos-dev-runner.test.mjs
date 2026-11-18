import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
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
