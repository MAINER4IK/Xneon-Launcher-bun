import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { publicationNames } from '../../scripts/ci-pipeline.ts'
import { releaseChannelTargets } from '../../scripts/verify-signed-update-feed.ts'
import { releaseTargets } from '../../scripts/release-targets.ts'
import { releaseNotes } from '../../scripts/release-notes.ts'

test('оба канала собирают и подписывают Windows x64, Linux x64 и macOS arm64', async () => {
  for (const filename of ['release.yml', 'pre-release.yml']) {
    const workflow = Bun.YAML.parse(await fs.readFile(`.github/workflows/${filename}`, 'utf8'))
    const jobs = workflow.jobs
    assert.deepEqual(Object.keys(jobs), ['tests', 'build', 'build-linux', 'build-macos', 'release'])
    assert.deepEqual(jobs.build.strategy.matrix.include.map(row => row.target), ['win-x64'])
    assert.equal(jobs['build-linux'].env.TARGET_PLATFORM, 'linux')
    assert.equal(jobs['build-linux'].env.TARGET_ARCH, 'x64')
    assert.equal(jobs['build-macos'].env.TARGET_PLATFORM, 'macos')
    assert.equal(jobs['build-macos'].env.TARGET_ARCH, 'arm64')
    assert.deepEqual(jobs.release.needs, ['tests', 'build', 'build-linux', 'build-macos'])
    assert.equal(jobs.release.environment, 'pre2-signing')
    const sign = jobs.release.steps.find(step => step.name?.includes('Sign each published target'))
    assert.ok(sign, 'Каждый target подписывается в одном защищённом шаге')
    for (const target of releaseTargets) assert.ok(sign.run.includes(`native-${target.platform}-${target.arch}-`), target.platform)
    assert.ok(jobs.release.steps.some(step => step.run?.includes('verify-signed-update-feed.ts')))
  }
})

test('allowlist, подпись и release notes покрывают все опубликованные платформы', () => {
  for (const version of ['1.0.8', '1.0.8-pre1']) {
    const channel = version.includes('-') ? 'canary' : 'stable'
    const names = publicationNames(version)
    for (const file of [
      `xneon-launcher-${version}-win-x64-portable.zip`,
      `xneon-launcher-${version}-linux-x64-setup.tar.gz`,
      `xneon-launcher-${version}-mac-arm64.dmg`,
      `xneon-launcher-${version}-amd64.deb`,
      `xneon-launcher-${version}-x86_64.AppImage`,
      `${channel}-linux-x64-update.json`,
      `${channel}-macos-arm64-update-v2.json.sig`,
    ]) assert.ok(names.includes(file), file)
    assert.deepEqual(releaseChannelTargets(channel), releaseTargets.map(({ platform, arch }) => ({ channel, platform, arch })))
    const body = releaseNotes(version, ['fix: upstream'])
    assert.match(body, /### Windows/)
    assert.match(body, /### Linux/)
    assert.match(body, /### macOS/)
  }
})

test('Ubuntu-тесты не скачивают графический SDK; native-сборка подключает его отдельно', async () => {
  const setup = Bun.YAML.parse(await fs.readFile('.github/actions/setup/action.yml', 'utf8'))
  const runtime = setup.runs.steps.find(step => step.name === 'Linux test prerequisites')
  assert.ok(runtime)
  assert.match(runtime.run, /--no-install-recommends/)
  assert.match(runtime.run, /libsecret-1-0/)
  assert.doesNotMatch(runtime.run, /libgtk-3-dev|libwebkit2gtk-4\.1-dev|libayatana-appindicator3-dev/)
  const native = setup.runs.steps.find(step => step.name === 'Linux native build prerequisites')
  assert.ok(native.if.includes("inputs.linux-native-build == 'true'"))
  assert.match(native.run, /libwebkit2gtk-4\.1-dev/)
})