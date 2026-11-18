import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { publicationNames } from '../../scripts/ci-pipeline.ts'
import { releaseNotes } from '../../scripts/release-notes.ts'

test('оба канала временно собирают только Windows без ослабления signing gate', async () => {
  for (const filename of ['release.yml', 'pre-release.yml']) {
    const workflow = Bun.YAML.parse(await fs.readFile(`.github/workflows/${filename}`, 'utf8'))
    assert.deepEqual(workflow.jobs.build.strategy.matrix.include.map(row => row.target), ['win-x64'])
    assert.deepEqual(workflow.jobs.release.needs, ['tests', 'build'])
    assert.equal(workflow.jobs.release.environment, 'pre2-signing')
    assert.ok(workflow.jobs.release.steps.some(step => step.run?.includes('verify-signed-update-feed.ts')))
  }
})

test('allowlist и release notes не требуют отсутствующих Linux/macOS артефактов', () => {
  for (const version of ['1.0.8', '1.0.8-pre1']) {
    const names = publicationNames(version)
    assert.ok(names.includes(`xneon-launcher-${version}-win-x64-portable.zip`))
    assert.ok(!names.some(name => /linux|macos|\.dmg$|\.deb$|\.rpm$|\.AppImage$/.test(name)))
    const body = releaseNotes(version, ['fix: Windows release'])
    assert.match(body, /### Windows/)
    assert.doesNotMatch(body, /### macOS|### Linux|logo=apple|logo=linux/)
  }
})
