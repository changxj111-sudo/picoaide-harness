/**
 * macOS 原地自更新的纯逻辑判据。
 *
 * 覆盖三件事：
 * 1. **什么时候能原地更新**（{@link canInstallMacosInPlace}）——判据错了的后果是
 *    在只读/translocated 的位置上尝试替换，或者在能做的时候让用户回去手动拖；
 * 2. **准备阶段**（挂载 + 身份/版本/TeamID/空间）——影像里的东西不是同一个应用时必须抛错，
 *    而不是"换一种交付方式"；
 * 3. **帮手脚本的契约**（位置参数顺序、先校验后动手、回滚分支、失败码与文案表同源）。
 */
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MACOS_UPDATE_HELPER_SOURCE,
  assertSameApplication,
  canInstallMacosInPlace,
  clearMacosUpdateLeftovers,
  clearMacosUpdateRecord,
  hasSpaceForUpdate,
  macAppBundlePath,
  macosUpdateHelperScript,
  macosUpdatePaths,
  normalizeVersion,
  prepareMacosInPlaceUpdate,
  readMacAppIdentity,
  readMacosUpdateOutcome,
  readMacosUpdateRecord,
  readTeamIdentifier,
  removeMacosUpdateBackup,
  singleApplicationInImage,
  spawnMacosUpdateHelper,
  updateSidecarPaths,
  writeMacosUpdateBootMarker,
  writeMacosUpdateHelper,
  type MacAppIdentity,
  type MacosCommandRunner,
} from '../src/macos-update-install.ts'
import { desktopUpdateDialogCopy } from '../src/tray-locale.ts'

/**
 * 子进程边界替身：本文件里的 `spawnMacosUpdateHelper` 判据只看"什么时候 resolve /
 * reject / unref"。缺省的命令执行边界（`runMacosCommand`）也是 `spawnSync`，一并给上，
 * 免得模块导入期就拿到 undefined。
 */
const childProcess = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }))
vi.mock('node:child_process', () => childProcess)

const temporary: string[] = []

/**
 * `chmod` 之后 `accessSync(W_OK)` 是否真的会失败。
 *
 * 以 root 跑的容器里（CI 的 ubuntu gate job 就是一例）权限位对 root 不起作用，
 * "目录不可写"这个现象根本造不出来 —— 那两条用例必须跳过，而不是假红。
 */
const CAN_MAKE_UNWRITABLE = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'dsh-macos-update-probe-'))
  try {
    chmodSync(probe, 0o500)
    try {
      accessSync(probe, fsConstants.W_OK)
      return false
    } catch {
      return true
    }
  } finally {
    try {
      chmodSync(probe, 0o700)
    } catch {
      // 探测目录的权限位恢复失败只影响清理。
    }
    rmSync(probe, { recursive: true, force: true })
  }
})()

/** 一个真实的临时目录（准备阶段的 fs 判据用真 fs，命令边界才替身）。 */
function makeTempDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-macos-update-'))
  temporary.push(path)
  return path
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** 写一个最小的、`plutil` 读得懂的 Info.plist。 */
function writeInfoPlist(bundlePath: string, identifier: string, version: string, executable = 'App'): void {
  mkdirSync(join(bundlePath, 'Contents'), { recursive: true })
  writeFileSync(
    join(bundlePath, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleExecutable</key><string>${executable}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>`,
    'utf8',
  )
}

/** plist 文件 → `plutil -convert json -o -` 会吐出的 JSON。 */
function plistJson(plistPath: string): string {
  const raw = readFileSync(plistPath, 'utf8')
  const value = (key: string): string => new RegExp(`<key>${key}</key><string>([^<]*)</string>`, 'u').exec(raw)?.[1] ?? ''
  return JSON.stringify({
    CFBundleIdentifier: value('CFBundleIdentifier'),
    CFBundleExecutable: value('CFBundleExecutable'),
    CFBundleShortVersionString: value('CFBundleShortVersionString'),
  })
}

interface FakeCommands {
  readonly run: MacosCommandRunner
  readonly calls: { readonly command: string; readonly args: readonly string[] }[]
  /** `hdiutil attach` 时把影像内容"挂"出来的钩子。 */
  onAttach?: (mountPoint: string) => void
  /** 这些命令名会被当作失败（抛错）。 */
  readonly failing: Set<string>
  /** 按包路径给出签名团队（默认两边都是同一个团队）。 */
  teamsFor: (bundlePath: string) => string | undefined
  kilobytes: number
}

/** 一个记录调用并按 `hdiutil attach` 钩子"挂载"影像的命令替身。 */
function fakeCommands(): FakeCommands {
  const state: FakeCommands = {
    calls: [],
    failing: new Set<string>(),
    teamsFor: () => 'TEAM123456',
    kilobytes: 1024,
    run: (command, args) => {
      state.calls.push({ command, args })
      if (state.failing.has(command)) throw new Error(`${command} failed (injected)`)
      if (command === 'plutil') return plistJson(args[args.length - 1] ?? '')  // 末位参数就是 plist 路径
      if (command === 'codesign') {
        return `Identifier=ai.test.app\nTeamIdentifier=${state.teamsFor(args[args.length - 1] ?? '') ?? 'not set'}\n`
      }
      if (command === 'du') return `${String(state.kilobytes)}\t${args[args.length - 1] ?? ''}\n`
      if (command === 'hdiutil') {
        const attachIndex = args.indexOf('-mountpoint')
        if (attachIndex >= 0) state.onAttach?.(args[attachIndex + 1] ?? '')
        return ''
      }
      return ''
    },
  }
  return state
}

/** 搭一个"当前应用 + 影像里的新应用"现场，返回两边路径。 */
function stageFixture(options: {
  readonly currentVersion?: string
  readonly nextVersion?: string
  readonly sourceIdentifier?: string
} = {}): {
  root: string
  current: string
  source: string
  commands: FakeCommands
} {
  const root = makeTempDirectory()
  const current = join(root, 'Applications', 'PicoAide Harness.app')
  const source = join(root, 'Volume', 'PicoAide Harness.app')
  writeInfoPlist(current, 'ai.deepseek.dsh.desktop', options.currentVersion ?? '1.0.0')
  writeInfoPlist(source, options.sourceIdentifier ?? 'ai.deepseek.dsh.desktop', options.nextVersion ?? '1.1.0')
  const commands = fakeCommands()
  commands.onAttach = (mountPoint) => {
    mkdirSync(mountPoint, { recursive: true })
    const mounted = join(mountPoint, 'PicoAide Harness.app')
    rmSync(mounted, { recursive: true, force: true })
    mkdirSync(join(mounted, 'Contents'), { recursive: true })
    writeFileSync(join(mounted, 'Contents', 'Info.plist'), readFileSync(join(source, 'Contents', 'Info.plist')))
  }
  return { root, current, source, commands }
}

describe('macAppBundlePath', () => {
  it('takes the outermost .app so nested helpers are never the replacement target', () => {
    expect(macAppBundlePath('/Applications/PicoAide Harness.app/Contents/MacOS/PicoAide Harness'))
      .toBe('/Applications/PicoAide Harness.app')
    expect(macAppBundlePath(
      '/Applications/X.app/Contents/Frameworks/X Helper.app/Contents/MacOS/X Helper',
    )).toBe('/Applications/X.app')
  })

  it('returns undefined when there is no bundle to replace', () => {
    expect(macAppBundlePath('/usr/local/bin/node')).toBeUndefined()
    expect(macAppBundlePath('relative/X.app/Contents/MacOS/X')).toBeUndefined()
    expect(macAppBundlePath('/X.app')).toBe('/X.app')
  })
})

describe('normalizeVersion', () => {
  it('strips exactly one leading v', () => {
    expect(normalizeVersion('v2.8.3-beta.1')).toBe('2.8.3-beta.1')
    expect(normalizeVersion('2.8.3')).toBe('2.8.3')
    expect(normalizeVersion('vv2')).toBe('v2')
  })
})

describe('canInstallMacosInPlace', () => {
  const packed = { platform: 'darwin' as const, isPackaged: true, executablePath: '/Applications/X.app/Contents/MacOS/X' }

  it('accepts a packaged macOS app in a writable location', () => {
    const root = makeTempDirectory()
    const bundle = join(root, 'X.app')
    mkdirSync(join(bundle, 'Contents'), { recursive: true })
    expect(canInstallMacosInPlace({ ...packed, executablePath: join(bundle, 'Contents', 'MacOS', 'X') })).toBeUndefined()
  })

  it('refuses every environment that cannot be replaced in place', () => {
    expect(canInstallMacosInPlace({ ...packed, platform: 'linux', executablePath: '/Applications/X.app/Contents/MacOS/X' }))
      .toBe('unsupported-platform')
    expect(canInstallMacosInPlace({ ...packed, isPackaged: false })).toBe('not-packaged')
    expect(canInstallMacosInPlace({ ...packed, executablePath: '/usr/local/bin/dsh' })).toBe('unrecognized-bundle')
    expect(canInstallMacosInPlace({
      ...packed,
      executablePath: '/private/var/folders/xx/AppTranslocation/9AB1/d/X.app/Contents/MacOS/X',
    })).toBe('read-only-location')
  })

  it.skipIf(!CAN_MAKE_UNWRITABLE)('refuses a bundle whose directory the user cannot write (root install / read-only volume)', () => {
    const root = makeTempDirectory()
    const bundle = join(root, 'X.app')
    mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    chmodSync(root, 0o500)
    try {
      expect(canInstallMacosInPlace({ ...packed, executablePath: join(bundle, 'Contents', 'MacOS', 'X') }))
        .toBe('unwritable-location')
    } finally {
      chmodSync(root, 0o700)
    }
  })

  it.skipIf(!CAN_MAKE_UNWRITABLE)('refuses a bundle that is itself read-only even when its directory is writable', () => {
    const root = makeTempDirectory()
    const bundle = join(root, 'X.app')
    mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    chmodSync(bundle, 0o500)
    try {
      expect(canInstallMacosInPlace({ ...packed, executablePath: join(bundle, 'Contents', 'MacOS', 'X') }))
        .toBe('unwritable-location')
    } finally {
      chmodSync(bundle, 0o700)
    }
  })
})

describe('readMacAppIdentity', () => {
  it('reads identifier, version, executable and the signing team', () => {
    const root = makeTempDirectory()
    const bundle = join(root, 'X.app')
    writeInfoPlist(bundle, 'ai.test.app', '3.2.1')
    expect(readMacAppIdentity(fakeCommands().run, bundle)).toEqual({
      identifier: 'ai.test.app',
      version: '3.2.1',
      executable: 'App',
      teamIdentifier: 'TEAM123456',
    })
  })

  it('treats an unsigned or ad-hoc bundle as having no team instead of failing', () => {
    const root = makeTempDirectory()
    const bundle = join(root, 'X.app')
    writeInfoPlist(bundle, 'ai.test.app', '3.2.1')
    const unsigned = fakeCommands()
    unsigned.failing.add('codesign')
    expect(readTeamIdentifier(unsigned.run, bundle)).toBeUndefined()
    const adHoc = fakeCommands()
    adHoc.teamsFor = () => undefined
    expect(readTeamIdentifier(adHoc.run, bundle)).toBeUndefined()
    expect(readMacAppIdentity(unsigned.run, bundle).teamIdentifier).toBeUndefined()
  })

  it('rejects something that is not an application bundle', () => {
    const root = makeTempDirectory()
    const bundle = join(root, 'X.app')
    mkdirSync(join(bundle, 'Contents'), { recursive: true })
    writeFileSync(join(bundle, 'Contents', 'Info.plist'), '<plist version="1.0"><dict/></plist>', 'utf8')
    expect(() => readMacAppIdentity(fakeCommands().run, bundle)).toThrow(/does not look like an application bundle/u)
  })
})

describe('singleApplicationInImage', () => {
  it('finds the one bundle and ignores the /Applications symlink beside it', () => {
    const mount = makeTempDirectory()
    mkdirSync(join(mount, 'PicoAide Harness.app'), { recursive: true })
    // electron-builder 的 DMG 卷根就是"应用 + 指向 /Applications 的符号链接"：
    // 用 statSync 判目录会把那个链接也算进来，于是"不止一个应用"。
    symlinkSync('/Applications', join(mount, 'Applications'))
    writeFileSync(join(mount, '.DS_Store'), '', 'utf8')
    expect(singleApplicationInImage(mount)).toBe(join(mount, 'PicoAide Harness.app'))
  })

  it('fails loudly when the image holds no application or more than one', () => {
    const empty = makeTempDirectory()
    expect(() => singleApplicationInImage(empty)).toThrow(/contains no application bundle/u)
    const many = makeTempDirectory()
    mkdirSync(join(many, 'A.app'))
    mkdirSync(join(many, 'B.app'))
    expect(() => singleApplicationInImage(many)).toThrow(/contains 2 application bundles/u)
  })
})

describe('assertSameApplication', () => {
  const current: MacAppIdentity = {
    identifier: 'ai.deepseek.dsh.desktop',
    version: '1.0.0',
    executable: 'App',
    teamIdentifier: 'TEAM123456',
  }

  it('accepts the same application at the expected version', () => {
    expect(() => assertSameApplication(current, { ...current, version: '1.1.0' }, 'v1.1.0')).not.toThrow()
  })

  it('refuses a different application, a different version, or a different signing team', () => {
    expect(() => assertSameApplication(current, { ...current, identifier: 'com.other.app' }, '1.1.0'))
      .toThrow(/holds com.other.app, not ai.deepseek.dsh.desktop/u)
    expect(() => assertSameApplication(current, { ...current, version: '1.0.9' }, '1.1.0'))
      .toThrow(/holds 1.0.9, expected 1.1.0/u)
    expect(() => assertSameApplication(current, { ...current, version: '1.1.0', teamIdentifier: 'OTHERTEAM' }, '1.1.0'))
      .toThrow(/signed by OTHERTEAM, not TEAM123456/u)
    // 当前应用有 TeamID、影像里的没有 ⇒ 一样拒绝（自签/临时签名冒充不了有团队的包）。
    expect(() => assertSameApplication(current, { ...current, version: '1.1.0', teamIdentifier: undefined }, '1.1.0'))
      .toThrow(/signed by no team, not TEAM123456/u)
  })

  it('does not require a team when the running build has none (development builds)', () => {
    const dev: MacAppIdentity = { ...current, teamIdentifier: undefined }
    expect(() => assertSameApplication(dev, { ...dev, version: '1.1.0', teamIdentifier: undefined }, '1.1.0'))
      .not.toThrow()
  })
})

describe('updateSidecarPaths', () => {
  it('puts staging and backup next to the target so the swap is a rename', () => {
    expect(updateSidecarPaths('/Applications/My App.app', 'v2.0.0')).toEqual({
      stagingPath: '/Applications/.My App.app.update-2.0.0.app',
      backupPath: '/Applications/.My App.app.backup-2.0.0.app',
    })
  })
})

describe('clearMacosUpdateLeftovers', () => {
  it('removes only this application\'s staging/backup siblings and detaches the image', () => {
    const root = makeTempDirectory()
    const bundle = join(root, 'X.app')
    writeInfoPlist(bundle, 'ai.test.app', '1.0.0')
    mkdirSync(join(root, '.X.app.update-9.9.9.app'))
    mkdirSync(join(root, '.X.app.backup-9.9.9.app'))
    mkdirSync(join(root, '.Other.app.update-9.9.9.app'))
    mkdirSync(join(root, 'neighbour'))
    // 挂载点存在 = 上一次真的挂过影像 ⇒ 先卸载；不存在时不该 spawn `hdiutil`（这条路径
    // 在**每个** macOS 进程的启动路径上，每次多一个进程 + 一行假错误不可接受）。
    const mountPoint = join(root, 'image')
    mkdirSync(mountPoint)
    const commands = fakeCommands()

    clearMacosUpdateLeftovers(bundle, mountPoint, commands.run)

    expect(existsSync(join(root, '.X.app.update-9.9.9.app'))).toBe(false)
    expect(existsSync(join(root, '.X.app.backup-9.9.9.app'))).toBe(false)
    expect(existsSync(join(root, '.Other.app.update-9.9.9.app'))).toBe(true)
    expect(existsSync(join(root, 'neighbour'))).toBe(true)
    expect(existsSync(bundle)).toBe(true)
    expect(commands.calls).toContainEqual({ command: 'hdiutil', args: ['detach', mountPoint] })

    // 反向对照：没有挂载点就不该有任何命令。
    const quiet = fakeCommands()
    clearMacosUpdateLeftovers(bundle, join(root, 'never-mounted'), quiet.run)
    expect(quiet.calls).toEqual([])
  })
})

describe('prepareMacosInPlaceUpdate', () => {
  it('mounts the image, verifies identity and returns a rename-based plan', async () => {
    const { root, current, commands } = stageFixture()
    const preparation = await prepareMacosInPlaceUpdate({
      platform: 'darwin',
      isPackaged: true,
      executablePath: join(current, 'Contents', 'MacOS', 'App'),
      installerPath: join(root, 'update.dmg'),
      version: 'v1.1.0',
      userDataPath: join(root, 'userData'),
      run: commands.run,
    })

    expect(preparation.kind).toBe('prepared')
    if (preparation.kind !== 'prepared') throw new Error('unreachable')
    const paths = macosUpdatePaths(join(root, 'userData'))
    expect(preparation.plan).toEqual({
      bundlePath: current,
      mountPoint: paths.mountPoint,
      sourcePath: join(paths.mountPoint, 'PicoAide Harness.app'),
      stagingPath: join(root, 'Applications', '.PicoAide Harness.app.update-1.1.0.app'),
      backupPath: join(root, 'Applications', '.PicoAide Harness.app.backup-1.1.0.app'),
      bundleIdentifier: 'ai.deepseek.dsh.desktop',
    })
    expect(commands.calls.map(call => call.command)).toContain('hdiutil')
    const attach = commands.calls.find(call => call.command === 'hdiutil' && call.args[0] === 'attach')
    expect(attach?.args).toEqual(['attach', '-nobrowse', '-readonly', '-noverify', '-mountpoint', paths.mountPoint, join(root, 'update.dmg')])
    // 成功时影像**保持挂载**（帮手要用）：挂载之后不能再有 detach（挂载之前的那一次
    // 是清残留挂载点）。
    const attachIndex = commands.calls.indexOf(attach as never)
    expect(commands.calls.slice(attachIndex + 1).some(call => call.command === 'hdiutil' && call.args[0] === 'detach')).toBe(false)
  })

  it('unmounts the image when it decides to fall back after mounting it', async () => {
    const { root, current, commands } = stageFixture()
    commands.kilobytes = Number.MAX_SAFE_INTEGER
    const preparation = await prepareMacosInPlaceUpdate({
      platform: 'darwin',
      isPackaged: true,
      executablePath: join(current, 'Contents', 'MacOS', 'App'),
      installerPath: join(root, 'update.dmg'),
      version: '1.1.0',
      userDataPath: join(root, 'userData'),
      run: commands.run,
    })
    expect(preparation).toEqual({ kind: 'fallback', reason: 'insufficient-space' })
    // 回落之后影像必须被卸载（这次不会再有帮手上场）。
    expect(commands.calls).toContainEqual({
      command: 'hdiutil',
      args: ['detach', macosUpdatePaths(join(root, 'userData')).mountPoint],
    })
  })

  it('falls back before touching the disk when the environment cannot be updated in place', async () => {
    const { root, current, commands } = stageFixture()
    const preparation = await prepareMacosInPlaceUpdate({
      platform: 'darwin',
      isPackaged: false,
      executablePath: join(current, 'Contents', 'MacOS', 'App'),
      installerPath: join(root, 'update.dmg'),
      version: '1.1.0',
      userDataPath: join(root, 'userData'),
      run: commands.run,
    })
    expect(preparation).toEqual({ kind: 'fallback', reason: 'not-packaged' })
    expect(commands.calls).toEqual([])
  })

  it.each<[string, { sourceIdentifier?: string; nextVersion?: string }]>([
    ['a different application', { sourceIdentifier: 'com.other.app' }],
    ['a different version', { nextVersion: '1.0.5' }],
  ])('refuses %s in the image and unmounts it', async (_label, overrides) => {
    const { root, current, commands } = stageFixture(overrides)
    await expect(prepareMacosInPlaceUpdate({
      platform: 'darwin',
      isPackaged: true,
      executablePath: join(current, 'Contents', 'MacOS', 'App'),
      installerPath: join(root, 'update.dmg'),
      version: '1.1.0',
      userDataPath: join(root, 'userData'),
      run: commands.run,
    })).rejects.toThrow(/dsh-plugin-desktop/u)
    expect(commands.calls).toContainEqual({
      command: 'hdiutil',
      args: ['detach', macosUpdatePaths(join(root, 'userData')).mountPoint],
    })
  })

  it('refuses an image signed by another team', async () => {
    const { root, current, commands } = stageFixture()
    // 影像里的包签名团队与当前应用不同：`codesign --verify` 对自签/临时签名同样通过，
    // TeamIdentifier 才是这一层真正的来源判据。
    commands.teamsFor = path => (path.includes('/macos/image/') ? 'OTHERTEAM' : 'TEAM123456')
    await expect(prepareMacosInPlaceUpdate({
      platform: 'darwin',
      isPackaged: true,
      executablePath: join(current, 'Contents', 'MacOS', 'App'),
      installerPath: join(root, 'update.dmg'),
      version: '1.1.0',
      userDataPath: join(root, 'userData'),
      run: commands.run,
    })).rejects.toThrow(/signed by OTHERTEAM, not TEAM123456/u)
  })

  it('refuses when the target version is already installed', async () => {
    const { root, current, commands } = stageFixture({ currentVersion: '1.1.0' })
    await expect(prepareMacosInPlaceUpdate({
      platform: 'darwin',
      isPackaged: true,
      executablePath: join(current, 'Contents', 'MacOS', 'App'),
      installerPath: join(root, 'update.dmg'),
      version: '1.1.0',
      userDataPath: join(root, 'userData'),
      run: commands.run,
    })).rejects.toThrow(/already installed/u)
  })
})

describe('hasSpaceForUpdate', () => {
  it('requires room for a full second copy', () => {
    const root = makeTempDirectory()
    const huge = fakeCommands()
    huge.kilobytes = Number.MAX_SAFE_INTEGER
    expect(hasSpaceForUpdate(huge.run, root, root)).toBe(false)
    const tiny = fakeCommands()
    tiny.kilobytes = 1
    expect(hasSpaceForUpdate(tiny.run, root, root)).toBe(true)
  })

  it('lets the copy fail on its own when the size cannot be read', () => {
    const root = makeTempDirectory()
    const broken = fakeCommands()
    broken.kilobytes = Number.NaN
    expect(hasSpaceForUpdate(broken.run, root, root)).toBe(true)
  })
})

describe('macosUpdateHelperScript', () => {
  it('verifies the staged bundle before moving the user\'s application aside', () => {
    const script = MACOS_UPDATE_HELPER_SOURCE
    const verify = script.indexOf('/usr/bin/codesign --verify --strict "$STAGING"')
    const firstMove = script.indexOf('/bin/mv "$TARGET" "$BACKUP"')
    expect(verify).toBeGreaterThan(0)
    expect(firstMove).toBeGreaterThan(verify)
  })

  it('keeps a rollback for every step that can destroy the installed application', () => {
    const script = MACOS_UPDATE_HELPER_SOURCE
    // 落位失败 ⇒ 备份换回原名；新版起不来 ⇒ 新包挪开、备份换回原名。
    expect(script.match(/\/bin\/mv "\$BACKUP" "\$TARGET"/gu)).toHaveLength(2)
    expect(script).toContain('/bin/rm -rf "$BROKEN"')
    // 一个字节都不动就放弃的两条：宿主没退出、暂存件签名不过。
    expect(script).toContain('application-still-running')
    expect(script).toContain('verification-failed')
  })

  it('never interpolates a path into the script', () => {
    const script = MACOS_UPDATE_HELPER_SOURCE
    // 全部位置参数：脚本里出现的是变量引用，而不是宿主的路径。
    for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      expect(script).toContain(index <= 9 ? `"$${String(index)}"` : `"\${${String(index)}}"`)
    }
    expect(script).not.toContain('@@')
  })

  it('only interpolates the tuned values, and refuses unsafe ones', () => {
    const tuned = macosUpdateHelperScript({ relaunchCommand: '/usr/bin/true', bootWaitTicks: 4, exitWaitTicks: 6 })
    expect(tuned).toContain('relaunch() { /usr/bin/true "$1"')
    expect(tuned).toContain('-ge 6 ]; then')
    expect(tuned).toContain('-lt 4 ]; do')
    expect(() => macosUpdateHelperScript({ relaunchCommand: '/bin/sh -c "rm -rf /"' })).toThrow(/unsafe/u)
    expect(() => macosUpdateHelperScript({ relaunchCommand: 'open' })).toThrow(/unsafe/u)
    expect(() => macosUpdateHelperScript({ bootWaitTicks: 0 })).toThrow(/positive integers/u)
  })

  it('keeps every failure code the script writes in the localized copy table', () => {
    const codes = new Set(
      [...MACOS_UPDATE_HELPER_SOURCE.matchAll(/record failed \S+ (\S+)/gu)].map(match => match[1] ?? ''),
    )
    expect(codes.size).toBeGreaterThanOrEqual(7)
    for (const locale of ['en', 'zh'] as const) {
      const copy = desktopUpdateDialogCopy(locale)
      for (const code of codes) {
        // 表里没有的码会原样回显（可诊断），但"脚本里有、文案里没登记"就是漏翻译：
        // 这里要求它至少不是原码。
        expect(copy.darwinUpdateFailureReason(code), `${locale} is missing a reason for ${code}`).not.toBe(code)
        expect(copy.darwinUpdateFailureReason(code)).not.toBe('')
      }
    }
  })
})

describe('writeMacosUpdateHelper', () => {
  it('writes the script under userData and passes every path as a positional argument', () => {
    const userDataPath = makeTempDirectory()
    const helper = writeMacosUpdateHelper({
      plan: {
        bundlePath: '/Applications/My App.app',
        mountPoint: '/tmp/mnt',
        sourcePath: '/Volumes/X/My App.app',
        stagingPath: '/Applications/.My App.app.update-2.0.0.app',
        backupPath: '/Applications/.My App.app.backup-2.0.0.app',
        bundleIdentifier: 'ai.test.app',
      },
      userDataPath,
      version: 'v2.0.0',
      pid: 4242,
      fromVersion: 'v1.0.0',
    })
    const paths = macosUpdatePaths(userDataPath)
    expect(helper.command).toBe('/bin/sh')
    expect(helper.args).toEqual([
      paths.scriptPath,
      '4242',
      '/Applications/My App.app',
      '/Volumes/X/My App.app',
      '/Applications/.My App.app.update-2.0.0.app',
      '/Applications/.My App.app.backup-2.0.0.app',
      '/tmp/mnt',
      paths.resultPath,
      paths.logPath,
      '2.0.0',
      paths.bootMarkerPath,
      '1.0.0',
    ])
    // 脚本逐字等于生产脚本：路径没有以任何形式被拼进去。
    expect(readFileSync(paths.scriptPath, 'utf8')).toBe(MACOS_UPDATE_HELPER_SOURCE)
    expect(readFileSync(paths.scriptPath, 'utf8')).not.toContain('My App.app')
  })
})

describe('spawnMacosUpdateHelper', () => {
  /** 一个只会记监听器的手柄替身。 */
  function fakeChild(): {
    child: { once: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }
    listeners: Map<string, (...args: unknown[]) => void>
  } {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const child = {
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener)
        return child
      }),
      off: vi.fn(() => child),
      unref: vi.fn(),
    }
    return { child, listeners }
  }

  it('resolves only after the kernel confirms the spawn, and detaches the child', async () => {
    const { child, listeners } = fakeChild()
    childProcess.spawn.mockReturnValueOnce(child)

    let settled = false
    const pending = spawnMacosUpdateHelper({
      scriptPath: '/tmp/apply.sh',
      command: '/bin/sh',
      args: ['/tmp/apply.sh'],
      resultPath: '/tmp/result',
      logPath: '/tmp/log',
      bootMarkerPath: '/tmp/boot',
    }).then(() => { settled = true })

    expect(childProcess.spawn).toHaveBeenLastCalledWith(
      '/bin/sh',
      ['/tmp/apply.sh'],
      { detached: true, stdio: 'ignore', shell: false },
    )
    await Promise.resolve()
    // spawn 事件到达之前绝不能 resolve：宿主紧接着就要退出。
    expect(settled).toBe(false)
    listeners.get('spawn')?.()
    await pending
    expect(settled).toBe(true)
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('rejects when the helper cannot be started at all', async () => {
    const { child, listeners } = fakeChild()
    childProcess.spawn.mockReturnValueOnce(child)
    const pending = spawnMacosUpdateHelper({
      scriptPath: '/tmp/apply.sh',
      command: '/bin/sh',
      args: ['/tmp/apply.sh'],
      resultPath: '/tmp/result',
      logPath: '/tmp/log',
      bootMarkerPath: '/tmp/boot',
    })
    listeners.get('error')?.(new Error('blocked'))
    await expect(pending).rejects.toThrow('blocked')
    expect(child.unref).not.toHaveBeenCalled()
  })

  it('routes a failure that happens after a successful spawn to the logger', async () => {
    const { child, listeners } = fakeChild()
    childProcess.spawn.mockReturnValueOnce(child)
    const late = vi.fn()
    const pending = spawnMacosUpdateHelper({
      scriptPath: '/tmp/apply.sh',
      command: '/bin/sh',
      args: ['/tmp/apply.sh'],
      resultPath: '/tmp/result',
      logPath: '/tmp/log',
      bootMarkerPath: '/tmp/boot',
    }, late)
    listeners.get('spawn')?.()
    await pending
    // spawn 之后再注册的错误监听：只记日志，不影响已经 resolve 的交接。
    listeners.get('error')?.(new Error('killed'))
    expect(late).toHaveBeenCalledWith(expect.objectContaining({ message: 'killed' }))
  })
})

describe('update bookkeeping', () => {
  it('round-trips the helper result file and hands the caller a conclusion', () => {
    const userDataPath = makeTempDirectory()
    writeMacosUpdateBootMarker(userDataPath, 'v2.0.0', '2026-10-09T00:00:00.000Z')
    expect(readFileSync(macosUpdatePaths(userDataPath).bootMarkerPath, 'utf8')).toBe('version=2.0.0\nat=2026-10-09T00:00:00.000Z\n')

    // 没有结果文件 ⇒ 什么都不做。
    expect(readMacosUpdateRecord(userDataPath)).toBeUndefined()
    expect(readMacosUpdateOutcome(userDataPath, '1.0.0')).toBeUndefined()

    const resultPath = macosUpdatePaths(userDataPath).resultPath
    mkdirSync(join(userDataPath, 'updates', 'macos'), { recursive: true })
    writeFileSync(resultPath, [
      'status=failed', 'phase=rolling-back', 'reason=application-did-not-start',
      'version=2.0.0', 'from=1.0.0', 'target=/Applications/X.app',
      'backup=/Applications/.X.app.backup-2.0.0.app', 'log=/tmp/log', '',
    ].join('\n'), 'utf8')
    expect(readMacosUpdateRecord(userDataPath)).toEqual({
      status: 'failed',
      phase: 'rolling-back',
      reason: 'application-did-not-start',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      targetPath: '/Applications/X.app',
      backupPath: '/Applications/.X.app.backup-2.0.0.app',
      logPath: '/tmp/log',
    })
    const outcome = readMacosUpdateOutcome(userDataPath, '1.0.0')
    expect(outcome?.kind).toBe('failed')

    // 目标版本就是当前版本 ⇒ 更新已生效（帮手没写完也算），删备份。
    expect(readMacosUpdateOutcome(userDataPath, 'v2.0.0')).toEqual({
      kind: 'applied',
      backupPath: '/Applications/.X.app.backup-2.0.0.app',
      logPath: '/tmp/log',
    })

    clearMacosUpdateRecord(userDataPath)
    expect(existsSync(resultPath)).toBe(false)
    clearMacosUpdateRecord(userDataPath)
  })

  it('reports an interrupted attempt (helper killed before it wrote a status)', () => {
    const userDataPath = makeTempDirectory()
    mkdirSync(join(userDataPath, 'updates', 'macos'), { recursive: true })
    writeFileSync(macosUpdatePaths(userDataPath).resultPath, 'status=running\nphase=swapping\nversion=2.0.0\nfrom=1.0.0\n', 'utf8')
    const outcome = readMacosUpdateOutcome(userDataPath, '1.0.0')
    expect(outcome).toMatchObject({ kind: 'failed', record: { reason: '', phase: 'swapping' } })
    // 版本对上了 ⇒ 是"帮手被杀在替换之后"，更新其实生效了，不该报失败。
    expect(readMacosUpdateOutcome(userDataPath, '2.0.0')?.kind).toBe('applied')
  })

  it('ignores a damaged result file', () => {
    const userDataPath = makeTempDirectory()
    mkdirSync(join(userDataPath, 'updates', 'macos'), { recursive: true })
    writeFileSync(macosUpdatePaths(userDataPath).resultPath, 'status=weird\nversion=\n', 'utf8')
    expect(readMacosUpdateRecord(userDataPath)).toBeUndefined()
  })

  it('removes the backup and tolerates a missing one', () => {
    const root = makeTempDirectory()
    const backup = join(root, '.X.app.backup-2.0.0.app')
    mkdirSync(backup)
    removeMacosUpdateBackup(backup)
    expect(existsSync(backup)).toBe(false)
    expect(() => removeMacosUpdateBackup(join(root, 'gone'))).not.toThrow()
    expect(() => removeMacosUpdateBackup('')).not.toThrow()
  })
})
