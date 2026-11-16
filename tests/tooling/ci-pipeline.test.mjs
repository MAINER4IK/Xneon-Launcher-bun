import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { loadReactModule } from '../helpers/react-module.mjs'
import { appIdentifier } from '../../electrobun/main/app-identity.ts'

const root = path.resolve(import.meta.dir, '../..')
const pipeline = () => import('../../scripts/ci-pipeline.ts')
const repository = 'MAINER4IK/Xneon-Launcher-bun'
test('обычный tag создаёт stable release, -preN создаёт prerelease; чужой repo/ref/version запрещены', async () => {
  const { releaseIdentity } = await pipeline()
  assert.deepEqual(releaseIdentity('refs/tags/v1.2.3', '1.2.3', repository), { tag: 'v1.2.3', version: '1.2.3', prerelease: false })
  assert.deepEqual(releaseIdentity('refs/tags/v1.2.3-pre2', '1.2.3-pre2', repository), { tag: 'v1.2.3-pre2', version: '1.2.3-pre2', prerelease: true })
  for (const args of [
    ['refs/heads/main', '1.2.3', repository], ['refs/tags/v1.2.4', '1.2.3', repository],
    ['refs/tags/v1.2.3', '1.2.3', 'fork/repo'], ['refs/tags/v1.2.3-pre0', '1.2.3-pre0', repository],
  ]) assert.throws(() => releaseIdentity(...args))
})

test('публикация допускает только native + NSIS + portable + подписи, checksums привязаны к точным байтам', async t => {
  const { publicationNames, checksumText, verifyChecksums } = await pipeline()
  const names = publicationNames('1.2.3')
  for (const name of ['xneon-launcher-1.2.3-win-x64.exe', 'xneon-launcher-1.2.3-win-x64-portable.zip', 'stable-win-x64-update-v2.json.sig', 'canary-win-x64-update-v2.json.sig', 'macos-arm64-XneonLauncher.dmg', 'linux-x64-XneonLauncher-Setup.tar.gz']) assert.ok(names.includes(name), name)
  assert.ok(!names.some(name => /latest|blockmap|\.deb$|\.rpm$|\.AppImage$/.test(name)))
  await fs.mkdir(path.join(root, '.tmp'), { recursive: true })
  const directory = await fs.mkdtemp(path.join(root, '.tmp/ci-hashes-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.writeFile(path.join(directory, 'file.zip'), 'original')
  await fs.writeFile(path.join(directory, 'SHA256SUMS.txt'), await checksumText(directory, ['file.zip']))
  await verifyChecksums(directory, ['file.zip'])
  await fs.appendFile(path.join(directory, 'file.zip'), 'tampered')
  await assert.rejects(verifyChecksums(directory, ['file.zip']), /checksum/i)
  await fs.writeFile(path.join(directory, 'extra'), 'unexpected')
  await assert.rejects(verifyChecksums(directory, ['file.zip']), /Unexpected/i)
})

test('единый workflow имеет корректный DAG, разделяет секреты и write permissions', async () => {
  assert.deepEqual((await fs.readdir(path.join(root, '.github/workflows'))).sort(), ['ci.yml'])
  const source = await fs.readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8')
  const workflow = Bun.YAML.parse(source)
  assert.ok(workflow.on.push.tags.includes('v*'))
  assert.ok(Object.hasOwn(workflow.on, 'pull_request'))
  assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'))
  assert.ok(!workflow.on.workflow_dispatch?.inputs, 'No scenario/promotion inputs')
  const jobs = workflow.jobs
  assert.deepEqual(Object.keys(jobs), ['tests', 'build', 'release'])
  const visit = (name, trail = []) => {
    assert.ok(jobs[name], 'Unknown dependency: ' + name)
    assert.ok(!trail.includes(name), 'Cycle: ' + [...trail, name])
    for (const dependency of [jobs[name].needs ?? []].flat()) visit(dependency, [...trail, name])
  }
  for (const [name, job] of Object.entries(jobs)) {
    visit(name)
    assert.ok(!job.uses, 'No reusable workflows')
    if (/\$\{\{[^}]*\bsecrets\./.test(JSON.stringify(job))) assert.equal(name, 'release')
    if (job.permissions?.contents === 'write') assert.equal(name, 'release')
  }
  assert.equal(jobs.release.environment, 'pre2-signing')
  assert.ok(jobs.release.if.includes("startsWith(github.ref, 'refs/tags/v')"))
  assert.deepEqual(jobs.release.needs, ['tests', 'build'])
  assert.equal(jobs.build.needs, 'tests')
  assert.ok(jobs.build.if.includes("github.event_name == 'workflow_dispatch'"))
  assert.equal(jobs.tests['runs-on'], 'ubuntu-24.04')
  assert.equal(jobs.tests['timeout-minutes'], 15)
  assert.ok(!jobs.tests.strategy, 'Fast tests run once, not on every OS')
  assert.ok(jobs.tests.steps.some(step => step.run === 'bun scripts/ci-pipeline.ts guard-tag' && step.if.includes('refs/tags/v')), 'Check tag ancestry before entering the protected job')
  assert.equal(jobs.build.strategy.matrix.include.length, 4)
  assert.ok(jobs.build.strategy.matrix.include.some(item => item.runner === 'macos-15-intel'))
  assert.equal(jobs.build.strategy['fail-fast'], false)
  assert.equal(jobs.build.strategy['max-parallel'], 3)
  assert.ok(jobs.build.steps.some(step => step.if === "runner.os != 'Linux'" &&
    step.run?.includes('tests/electrobun/platform-desktop.test.ts') &&
    step.run.includes('tests/electrobun/platform-secrets.test.ts') &&
    step.run.includes('tests/electrobun/platform-unix.test.ts') &&
    step.run.includes('PE metadata')), 'Windows/macOS native cases skipped on Ubuntu must run on their real targets')
  const releaseSteps = jobs.release.steps
  const secretSteps = releaseSteps.filter(step => JSON.stringify(step).includes('secrets.'))
  assert.equal(secretSteps.length, 1)
  assert.ok(!secretSteps[0].uses, 'Private key is scoped to the signing command only')
  const commands = releaseSteps.map(step => step.run ?? '')
  const check = commands.findIndex(command => command.includes('ci-pipeline.ts check'))
  const sign = commands.findIndex(command => command.includes('sign-update-feed.ts'))
  const verify = commands.findIndex(command => command.includes('verify-signed-update-feed.ts'))
  const assemble = commands.findIndex(command => command.includes('ci-pipeline.ts assemble'))
  const publish = releaseSteps.findIndex(step => step.uses === 'softprops/action-gh-release@v2')
  assert.ok(check >= 0 && check < sign && sign < verify && verify < assemble && assemble < publish)
  const publishStep = releaseSteps[publish]
  assert.equal(publishStep.with.prerelease, '${{ steps.release.outputs.prerelease == \'true\' }}')
  assert.ok(releaseSteps.some(step => step.uses === 'orhun/git-cliff-action@v4'))
})

test('повторная trusted Ed25519 verification не меняет checksums и отвергает подмену', async t => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const streams = new Map()
  const streamingBun = { file: name => {
    const file = Bun.file(name)
    return { size: file.size, stream: () => { streams.set(name, (streams.get(name) ?? 0) + 1); return file.stream() } }
  } }
  const checksums = loadReactModule(new URL('../../scripts/artifact-checksums.ts', import.meta.url), {}, { Bun: streamingBun, Buffer })
  const { verifySignedUpdateFeed } = loadReactModule(new URL('../../scripts/verify-signed-update-feed.ts', import.meta.url), {
    './artifact-checksums': checksums,
    '../electrobun/main/update-public-keys': { updatePublicKeys: { fixture: publicKey.export({ type: 'spki', format: 'pem' }) } },
    // Массивы из vm имеют другой prototype; проверяем те же элементы в одном realm.
    'node:assert/strict': { ...assert, deepEqual: (actual, expected, message) => assert.deepEqual(Array.from(actual), Array.from(expected), message) },
  }, { Bun: streamingBun, Buffer, process })
  await fs.mkdir(path.join(root, '.tmp'), { recursive: true })
  const directory = await fs.mkdtemp(path.join(root, '.tmp/ci-signatures-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.writeFile(path.join(directory, 'xneon-launcher-1.2.3-win-x64.exe'), 'fixture installer')
  for (const channel of ['stable', 'canary']) {
    const archive = Buffer.from('archive ' + channel)
    const hash = createHash('sha256').update(archive).digest('hex')
    const name = channel + '-win-x64-update-v2.json'
    const file = channel + '-win-x64-XneonLauncher.tar.zst'
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, identifier: appIdentifier, channel,
      version: '1.2.3', platform: 'win', arch: 'x64', hash: 'fixture123',
      artifact: { file, tarSize: 100, tarSha256: 'a'.repeat(64), downloadSize: archive.length, downloadSha256: hash } }))
    await fs.writeFile(path.join(directory, file), archive)
    await fs.writeFile(path.join(directory, name), bytes)
    await fs.writeFile(path.join(directory, name + '.sig'), JSON.stringify({ keyId: 'fixture', signature: sign(null, bytes, privateKey).toString('base64') }))
  }
  await verifySignedUpdateFeed(directory, '1.2.3')
  assert.equal(streams.size, 7)
  assert.ok([...streams.values()].every(count => count === 1), 'One read must serve signed digest and transport checksum within one verification')
  const originalChecksums = await fs.readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8')
  await verifySignedUpdateFeed(directory, '1.2.3')
  assert.ok([...streams.values()].every(count => count === 2), 'A new trust boundary must read the actual bytes again')
  assert.equal(await fs.readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8'), originalChecksums)
  await fs.writeFile(path.join(directory, 'SHA256SUMS.txt'), 'tampered')
  await assert.rejects(verifySignedUpdateFeed(directory, '1.2.3'), /checksum/i)
  await fs.writeFile(path.join(directory, 'SHA256SUMS.txt'), originalChecksums)
  const archivePath = path.join(directory, 'stable-win-x64-XneonLauncher.tar.zst')
  const originalArchive = await fs.readFile(archivePath)
  const changedArchive = Buffer.from(originalArchive)
  changedArchive[0] ^= 1
  await fs.writeFile(archivePath, changedArchive)
  await assert.rejects(verifySignedUpdateFeed(directory, '1.2.3'), 'Signed SHA256 must reject same-size changes')
  await fs.appendFile(archivePath, 'extra byte')
  await assert.rejects(verifySignedUpdateFeed(directory, '1.2.3'), 'Signed downloadSize must reject a different size')
  await fs.writeFile(archivePath, originalArchive)
  await fs.writeFile(path.join(directory, 'unexpected.zip'), 'extra')
  await assert.rejects(verifySignedUpdateFeed(directory, '1.2.3'), /Unexpected/)
  await fs.rm(path.join(directory, 'unexpected.zip'))
  await fs.appendFile(path.join(directory, 'stable-win-x64-update-v2.json'), ' ')
  await assert.rejects(verifySignedUpdateFeed(directory, '1.2.3'), /signature/)
})

test('release assembly связывает signed bytes с native выдачей и повторно проверяет весь allowlist', async t => {
  const { nativeArtifactNames } = await import('../../scripts/electrobun-artifacts.ts')
  const { checksumText } = await pipeline()
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const realmAssert = { ...assert, deepEqual: (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message) }
  const { verifySignedUpdateFeed } = loadReactModule(new URL('../../scripts/verify-signed-update-feed.ts', import.meta.url), {
    '../electrobun/main/update-public-keys': { updatePublicKeys: { fixture: publicKey.export({ type: 'spki', format: 'pem' }) } },
    'node:assert/strict': realmAssert,
  }, { Bun, Buffer, process })
  let inspections = 0
  const release = loadReactModule(new URL('../../scripts/ci-pipeline.ts', import.meta.url), {
    'node:assert/strict': realmAssert,
    './verify-signed-update-feed': { verifySignedUpdateFeed },
    // Реальные tar/PE/Mach-O/ELF проверки покрыты electrobun-packaging.test.mjs;
    // здесь изолируется orchestration, но криптография и файловый I/O настоящие.
    './electrobun-artifacts': { nativeArtifactNames, inspectElectrobunRelease: async (directory, options) => {
      inspections++
      const files = nativeArtifactNames(options)
      const expected = [...files, ...(options.requireChecksums ? ['SHA256SUMS.txt'] : [])]
      assert.deepEqual((await fs.readdir(directory)).sort(), expected.sort())
      if (options.requireChecksums) assert.equal(await fs.readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8'), await checksumText(directory, files))
      return { files }
    } },
  }, { Bun, Buffer, process, fetch: () => { throw new Error('Unexpected network access') } })
  await fs.mkdir(path.join(root, '.tmp'), { recursive: true })
  const directory = await fs.mkdtemp(path.join(root, '.tmp/ci-assembly-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const input = path.join(directory, 'input'), output = path.join(directory, 'output')
  const signed = path.join(input, 'windows-update-verified')
  await fs.mkdir(signed, { recursive: true })
  const sets = [
    { platform: 'win', arch: 'x64', channel: 'stable', nsis: true },
    { platform: 'linux', arch: 'x64', channel: 'stable' },
    { platform: 'macos', arch: 'arm64', channel: 'stable' },
    { platform: 'macos', arch: 'x64', channel: 'stable' },
    { platform: 'win', arch: 'x64', channel: 'canary' },
  ]
  for (const options of sets) {
    const source = path.join(input, `native-${options.platform}-${options.arch}-${options.channel}`)
    await fs.mkdir(source)
    const names = nativeArtifactNames({ ...options, version: '1.2.3' })
    for (const name of names) await fs.writeFile(path.join(source, name), 'native ' + name)
    if (options.platform === 'win') {
      const archive = await fs.readFile(path.join(source, names[2]))
      const original = { schemaVersion: 1, identifier: appIdentifier, channel: options.channel, platform: 'win', arch: 'x64', version: '1.2.3', hash: 'fixture123', artifact: { file: names[2], tarSize: 100, tarSha256: 'a'.repeat(64) } }
      await fs.writeFile(path.join(source, names[1]), JSON.stringify(original))
      const bytes = Buffer.from(JSON.stringify({ ...original, artifact: { ...original.artifact, downloadSize: archive.length, downloadSha256: createHash('sha256').update(archive).digest('hex') } }))
      await fs.writeFile(path.join(signed, names[1]), bytes)
      await fs.writeFile(path.join(signed, names[1] + '.sig'), JSON.stringify({ keyId: 'fixture', signature: sign(null, bytes, privateKey).toString('base64') }))
      await fs.copyFile(path.join(source, names[2]), path.join(signed, names[2]))
      if (options.nsis) await fs.copyFile(path.join(source, names.at(-1)), path.join(signed, names.at(-1)))
    }
    await fs.writeFile(path.join(source, 'SHA256SUMS.txt'), await checksumText(source, names))
  }
  const portable = path.join(input, 'native-win-x64-portable')
  await fs.mkdir(portable)
  const portableName = 'xneon-launcher-1.2.3-win-x64-portable.zip'
  await fs.writeFile(path.join(portable, portableName), 'separate portable fixture')
  await fs.writeFile(path.join(portable, 'SHA256SUMS.txt'), await checksumText(portable, [portableName]))
  const outsideSigned = path.join(directory, 'signed')
  await fs.rename(signed, outsideSigned)
  await release.checkCandidates(input, '1.2.3')
  assert.equal(inspections, 5)
  await fs.appendFile(path.join(portable, portableName), 'tamper')
  await assert.rejects(release.checkCandidates(input, '1.2.3'), /checksum/i)
  await fs.writeFile(path.join(portable, portableName), 'separate portable fixture')
  await fs.mkdir(path.join(input, 'unverified'))
  await assert.rejects(release.checkCandidates(input, '1.2.3'), /Unexpected/)
  await fs.rmdir(path.join(input, 'unverified'))
  await fs.rename(outsideSigned, signed)
  inspections = 0
  await verifySignedUpdateFeed(signed, '1.2.3')
  await release.assemblePublication(input, output, '1.2.3')
  assert.equal(inspections, 10)
  assert.equal((await fs.readdir(output)).length, 25)
  await release.verifyPublication(output, '1.2.3')
  await fs.writeFile(path.join(output, 'unverified.zip'), 'extra')
  await assert.rejects(release.verifyPublication(output, '1.2.3'), /Unexpected/)
  await fs.rm(path.join(output, 'unverified.zip'))
  await fs.appendFile(path.join(output, 'stable-win-x64-XneonLauncher.tar.zst'), 'tamper')
  const files = (await fs.readdir(output)).filter(file => file !== 'SHA256SUMS.txt')
  await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), await checksumText(output, files))
  await assert.rejects(release.verifyPublication(output, '1.2.3'))
  await fs.appendFile(path.join(signed, 'xneon-launcher-1.2.3-win-x64.exe'), 'substituted installer')
  const signedFiles = (await fs.readdir(signed)).filter(file => file !== 'SHA256SUMS.txt')
  await fs.writeFile(path.join(signed, 'SHA256SUMS.txt'), await checksumText(signed, signedFiles))
  await assert.rejects(release.assemblePublication(input, path.join(directory, 'substituted'), '1.2.3'), /Signing changed publication bytes/)
})

test('release guard поддерживает оба вида tags, запрещает moved tag, чужую ветку и перезапись релиза', async () => {
  const sha = 'a'.repeat(40)
  const env = { GITHUB_REPOSITORY: repository, GITHUB_REF: 'refs/tags/v1.2.3', GITHUB_SHA: sha, GH_TOKEN: 'fixture-not-a-secret' }
  let annotated = true, comparison = 'ahead', commit = sha, existing = 404
  const release = loadReactModule(new URL('../../scripts/ci-pipeline.ts', import.meta.url), {
    '../package.json': { version: '1.2.3' },
  }, { Bun, Buffer, process: { env }, fetch: async url => {
    const resource = url.split('/repos/' + repository + '/')[1]
    if (resource === 'releases/tags/v1.2.3') return { status: existing }
    const responses = {
      'git/ref/tags/v1.2.3': { object: { type: annotated ? 'tag' : 'commit', sha: commit } },
      ['git/tags/' + commit]: { object: { type: 'commit', sha: commit } },
      [`compare/${commit}...main`]: { status: comparison },
    }
    assert.ok(Object.hasOwn(responses, resource), resource)
    return { ok: true, json: async () => responses[resource] }
  } })
  await release.guardReleaseTag()
  annotated = false
  await release.guardReleaseTag()
  existing = 200
  await assert.rejects(release.guardReleaseTag(), /already exists/)
  existing = 404
  comparison = 'diverged'
  await assert.rejects(release.guardReleaseTag(), /reachable from main/)
  comparison = 'ahead'
  commit = 'b'.repeat(40)
  await assert.rejects(release.guardReleaseTag(), /moved/)
  commit = sha
  env.GITHUB_REPOSITORY = 'fork/repo'
  await assert.rejects(release.guardReleaseTag())
})

test('общие transport hashes потоковые, детерминированы и не принимают ссылки или недопустимые имена', async t => {
  const { artifactChecksums, checksumText, formatChecksums, verifyChecksums } = await import('../../scripts/artifact-checksums.ts')
  await fs.mkdir(path.join(root, '.tmp'), { recursive: true })
  const directory = await fs.mkdtemp(path.join(root, '.tmp/artifact-hashes-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.writeFile(path.join(directory, 'b.zip'), 'second')
  await fs.writeFile(path.join(directory, 'a.zip'), 'first')
  const expected = ['a.zip', 'b.zip'].map((file, index) => createHash('sha256').update(index ? 'second' : 'first').digest('hex') + '  ' + file).join('\n') + '\n'
  const entries = await artifactChecksums(directory, ['b.zip', 'a.zip'])
  assert.deepEqual(entries.map(item => [item.file, item.size]), [['a.zip', 5], ['b.zip', 6]])
  assert.equal(formatChecksums(entries), expected)
  assert.equal(await checksumText(directory, ['b.zip', 'a.zip']), expected)
  await fs.writeFile(path.join(directory, 'SHA256SUMS.txt'), expected)
  await verifyChecksums(directory, ['a.zip', 'b.zip'])
  for (const file of ['../outside', 'a\n.zip', 'a\\b.zip', '/absolute.zip']) await assert.rejects(checksumText(directory, [file]), /Invalid checksum path/)
  await assert.rejects(checksumText(directory, ['a.zip', 'a.zip']), /Duplicate/)
  await fs.writeFile(path.join(directory, 'empty.zip'), '')
  await assert.rejects(checksumText(directory, ['empty.zip']), /Invalid artifact/)
  await assert.rejects(checksumText(directory, ['missing.zip']))
  await fs.mkdir(path.join(directory, 'folder'))
  await assert.rejects(checksumText(directory, ['folder']), /Invalid artifact/)
  // Junction работает и без Windows Developer Mode; Unix получает symlink.
  await fs.symlink(path.join(directory, 'folder'), path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(checksumText(directory, ['linked']), /Invalid artifact/)
  await assert.rejects(verifyChecksums(directory, ['a.zip', 'b.zip']), /Unexpected/)
})
