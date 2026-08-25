import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('macOS audio package is built from pinned BlackHole source', () => {
  const build = read('scripts/build-macos-audio-driver.sh')
  assert.match(build, /BLACKHOLE_TAG="v0\.7\.1"/)
  assert.match(build, /BLACKHOLE_COMMIT="e2b22aaaba4e507a097131704bf96dabc004d9cf"/)
  assert.match(build, /PRODUCT_BUNDLE_IDENTIFIER="com\.hd838a\.MiRemoteV2ch"/)
  assert.doesNotMatch(build, /remote-mic-app/)
})

test('installer scripts only own the dedicated HAL driver path', () => {
  for (const path of [
    'packaging/macos-audio/install/preinstall',
    'packaging/macos-audio/install/postinstall',
    'packaging/macos-audio/uninstall/postinstall',
  ]) {
    const script = read(path)
    assert.match(script, /Library\/Audio\/Plug-Ins\/HAL\/MiRemoteV2ch\.driver/)
    assert.match(script, /com\.hd838a\.MiRemoteV2ch/)
    assert.doesNotMatch(script, /BlackHole2ch\.driver/)
    assert.doesNotMatch(script, /Remote Mic\.app|SayAll\.app/)
  }
})

test('macOS build embeds packages and requires Installer signing for signed releases', () => {
  const config = JSON.parse(read('src-tauri/tauri.macos.conf.json'))
  assert.deepEqual(config.bundle.resources, ['resources/macos'])
  assert.equal(config.bundle.macOS.infoPlist, 'Info.macos.plist')
  assert.match(read('scripts/package-macos-audio-driver.sh'), /REQUIRE_SIGNED_INSTALLER/)
  assert.match(read('scripts/build-macos.mjs'), /REQUIRE_SIGNED_INSTALLER/)
  assert.match(read('src-tauri/tauri.conf.json'), /npm run build:tauri/)
  assert.match(read('scripts/verify-macos-audio-resources.mjs'), /MiRemoteV2ch-Install\.pkg/)

  const releaseWorkflow = read('.github/workflows/build-tag.yml')
  assert.match(releaseWorkflow, /MACOS_INSTALLER_CERTIFICATE:/)
  assert.match(releaseWorkflow, /MACOS_INSTALLER_CERTIFICATE_PASSWORD:/)
  assert.match(releaseWorkflow, /MACOS_INSTALLER_SIGNING_IDENTITY:/)
  assert.match(releaseWorkflow, /security import "\$certificate_path"/)
  assert.match(releaseWorkflow, /security delete-keychain/)
})

test('runtime installation and forwarding do not reference the reference repository', () => {
  const backend = read('src-tauri/src/lib.rs')
  const nativeAudio = read('src-tauri/native/macos_audio.m')
  assert.match(backend, /\/usr\/sbin\/installer -pkg/)
  assert.match(nativeAudio, /AB5E0003-5A21-4F05-BC7D-AF01F617B664/)
  assert.match(nativeAudio, /MiRemoteV2ch_UID/)
  assert.doesNotMatch(`${backend}\n${nativeAudio}`, /remote-mic-app/)
})

test('macOS battery reporting reuses the RC003 audio peripheral', () => {
  const nativeAudio = read('src-tauri/native/macos_audio.m')
  assert.match(nativeAudio, /AKBatteryServiceUUIDString = @"180F"/)
  assert.match(nativeAudio, /AKBatteryLevelUUIDString = @"2A19"/)
  assert.match(nativeAudio, /discoverServices:@\[_serviceUUID, _batteryServiceUUID\]/)
  assert.match(nativeAudio, /readValueForCharacteristic:characteristic/)
  assert.match(nativeAudio, /axonkey_macos_audio_battery_level/)
})
