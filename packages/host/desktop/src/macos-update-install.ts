/**
 * macOS 原地自更新：用已下载、已按清单 SHA-256 校验过的 DMG 里的 `.app`，替换**正在运行的
 * 那一个**应用包，并在替换完成后把应用重新打开。
 *
 * ## 为什么要这一段
 *
 * 2026-10-09 之前 macOS 的交付口径只有"打开磁盘映像"：用户点「安装更新」后，DMG 挂上来，
 * 剩下的事只能自己做 —— 退出应用、把新版本拖进「应用程序」、覆盖旧版本、再打开。用户
 * 反馈的原话就是"每次更新都要手动退出并手动拖过去"。Windows 早就是"应用自己重启 →
 * 安装程序接管"，macOS 缺的正是这一步。
 *
 * ## 形状（三段时间线）
 *
 * ```
 * 宿主进程（正在运行的旧版本）                帮手进程（/bin/sh，detached）
 * ─────────────────────────────              ────────────────────────────────
 * 1. 便宜的前置判据（见 canInstallMacosInPlace）
 * 2. 挂上 DMG（只读）+ 核对身份/版本/TeamID
 * 3. 写帮手脚本、detached 起进程（等到 'spawn'）
 * 4. requestQuit(0) ─────────────────────▶  5. 等宿主 pid 退出（上限 120s）
 *                                            6. ditto 到暂存路径（与目标同卷）
 *                                            7. codesign --verify --strict 暂存件
 *                                            8. mv 旧包 → 备份；mv 暂存件 → 目标
 *                                            9. 卸载 DMG、重新打开应用
 *                                           10. 等新版写启动标记（上限 30s）
 *                                              等到 ⇒ 删备份（承认成功）
 *                                              等不到 ⇒ 回滚 + 重新打开旧版本
 * ```
 *
 * 判据一律**在动用户文件之前**：第 7 步不过就只有一个暂存目录被删掉，第 8 步失败会
 * 把备份改回原名。任何一步失败的结论都写进**结果文件**，宿主下次启动时读它决定要不要
 * 弹一次失败提示（见 {@link readMacosUpdateOutcome}）。
 *
 * ## 口径（不做的事）
 *
 * - **不弹管理员授权**：目标目录不可写（root 安装、只读宗卷、App Translocation）就整套
 *   回落成"打开磁盘映像让用户自己拖"——与改造前的行为逐字一致，只是多了一行日志。
 * - **不换载荷**：仍然只吃已公证的 DMG。不引入 ZIP/blockmap 第二条打包与发布路径
 *   （2026-09-12 的决定仍然成立，见 docs/decisions/2026-09-12-client-update-resilience.md）。
 * - **不做差分下载**、不碰服务端清单与 R2 布局。
 *
 * @module dsh-plugin-desktop/macos-update-install
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * 命令执行边界：返回**合并后的 stdout + stderr**，非零退出抛错。
 *
 * 合并是必须的：`codesign -dv` 与 `codesign --verify` 的结论都写在 **stderr** 上，
 * 而 `plutil -convert json -o -` 的结论写在 stdout 上。分成两条流会让"读签名里的
 * TeamIdentifier"这类调用拿不到东西。
 */
export type MacosCommandRunner = (command: string, args: readonly string[]) => string

/** 生产用命令边界：`spawnSync` + 合并输出 + 非零即抛。 */
export const runMacosCommand: MacosCommandRunner = (command, args) => {
  const result = spawnSync(command, [...args], { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}: ${output.trim()}`)
  }
  return output
}

/**
 * 「原地更新做不到」的原因。全部落在**回落**上（打开磁盘映像，用户自己拖），
 * 只有日志与失败提示会用到它 —— 因此这里不区分"哪种做不到"，只要求可诊断。
 */
export type MacosInPlaceFallbackReason =
  | 'unsupported-platform'
  | 'not-packaged'
  | 'unrecognized-bundle'
  | 'read-only-location'
  | 'unwritable-location'
  | 'insufficient-space'

/** 一次原地更新的执行计划：路径全部由宿主算好，帮手只按 argv 执行。 */
export interface MacosInPlaceUpdatePlan {
  /** 当前应用包（要被替换的那一个）。 */
  readonly bundlePath: string
  /** 磁盘映像挂载点（已挂上；帮手负责卸载）。 */
  readonly mountPoint: string
  /** 影像里那个新的应用包。 */
  readonly sourcePath: string
  /** 暂存路径（与 `bundlePath` 同目录 ⇒ 同卷 ⇒ `mv` 是原子 rename）。 */
  readonly stagingPath: string
  /** 旧包备份路径（替换失败或新版起不来时回滚到它）。 */
  readonly backupPath: string
  /** 随包身份（诊断用；替换前后必须一致的那一项）。 */
  readonly bundleIdentifier: string
}

/** 准备结论：要么给出计划，要么说明为什么只能回落。 */
export type MacosInPlacePreparation =
  | { readonly kind: 'prepared'; readonly plan: MacosInPlaceUpdatePlan }
  | { readonly kind: 'fallback'; readonly reason: MacosInPlaceFallbackReason }

/** {@link canInstallMacosInPlace} 的输入面（全部来自宿主进程，没有副作用）。 */
export interface MacosInPlacePrecondition {
  /** `process.platform`。 */
  readonly platform: NodeJS.Platform
  /** `app.isPackaged`。 */
  readonly isPackaged: boolean
  /** 当前进程的可执行文件绝对路径（`process.execPath`）。 */
  readonly executablePath: string
}

/** {@link prepareMacosInPlaceUpdate} 的输入面。 */
export interface MacosInPlacePrepareOptions extends MacosInPlacePrecondition {
  /** 已下载并校验过的 DMG 绝对路径。 */
  readonly installerPath: string
  /** 目标版本（可带前导 `v`）。 */
  readonly version: string
  /** 应用私有目录（挂载点、脚本、日志、结果文件都落在这里）。 */
  readonly userDataPath: string
  /** 命令执行边界；缺省 = 真实 `spawnSync`。 */
  readonly run?: MacosCommandRunner
  /** 追加一行诊断（默认丢弃）。 */
  readonly log?: (message: string) => void
}

/** 应用包的身份：替换前后必须一致的那几项。 */
export interface MacAppIdentity {
  /** `CFBundleIdentifier`。 */
  readonly identifier: string
  /** `CFBundleShortVersionString`。 */
  readonly version: string
  /** `CFBundleExecutable`。 */
  readonly executable: string
  /** 签名里的 TeamIdentifier；未签名/临时签名时为 undefined。 */
  readonly teamIdentifier: string | undefined
}

/** 帮手脚本 + 它的 argv（宿主 spawn 时逐项传入，脚本内不插值任何路径）。 */
export interface MacosUpdateHelper {
  /** 脚本落盘路径。 */
  readonly scriptPath: string
  /** 解释器（恒为 `/bin/sh`）。 */
  readonly command: string
  /** 传给解释器的完整 argv（含脚本路径与全部位置参数）。 */
  readonly args: readonly string[]
  /** 结果文件：帮手用它告诉下一次启动"成了没有、为什么没成"。 */
  readonly resultPath: string
  /** 日志文件：出问题时唯一的现场。 */
  readonly logPath: string
  /** 启动标记：新版启动时写，帮手等它来决定"成功"还是"回滚"。 */
  readonly bootMarkerPath: string
}

/** 结果文件里的一次更新尝试（`key=value` 行，见 {@link readMacosUpdateOutcome}）。 */
export interface MacosUpdateRecord {
  /** `ok` = 新版确认启动；`failed` = 未替换/已回滚；`running` = 帮手没写完就被杀。 */
  readonly status: 'ok' | 'failed' | 'running'
  /** 最后写入的阶段：`waiting`/`staging`/`verifying`/`swapping`/`done`/`rolling-back`。 */
  readonly phase: string
  /** 失败原因码（成功时空串）。 */
  readonly reason: string
  /** 更新前运行的版本。 */
  readonly fromVersion: string
  /** 尝试更新的目标版本。 */
  readonly toVersion: string
  /** 目标应用包路径。 */
  readonly targetPath: string
  /** 备份路径（回滚用）。 */
  readonly backupPath: string
  /** 日志路径。 */
  readonly logPath: string
}

/** 上一次更新尝试对**本次启动**的结论。 */
export type MacosUpdateOutcome =
  /** 目标版本就是当前运行的版本 ⇒ 更新已生效：删备份、清记录。 */
  | { readonly kind: 'applied'; readonly backupPath: string; readonly logPath: string }
  /** 目标版本不是当前版本，而记录说没成 ⇒ 报一次失败：清记录、留备份与日志。 */
  | { readonly kind: 'failed'; readonly record: MacosUpdateRecord }

/** 原地更新相关的全部落点（都在应用私有目录下，随渠道隔离）。 */
export interface MacosUpdatePaths {
  /** 脚本：`<userData>/updates/macos/apply-update.sh`。 */
  readonly scriptPath: string
  /** 日志：`<userData>/updates/macos/apply-update.log`。 */
  readonly logPath: string
  /** 结果：`<userData>/updates/macos/last-apply.txt`。 */
  readonly resultPath: string
  /** 启动标记：`<userData>/updates/macos/booted.txt`。 */
  readonly bootMarkerPath: string
  /** 挂载点：`<userData>/updates/macos/image`。 */
  readonly mountPoint: string
}

/**
 * 应用私有目录下的固定落点。
 * @param userDataPath - `app.getPath('userData')`。
 * @returns 五个绝对路径。
 */
export function macosUpdatePaths(userDataPath: string): MacosUpdatePaths {
  const root = join(userDataPath, 'updates', 'macos')
  return {
    scriptPath: join(root, 'apply-update.sh'),
    logPath: join(root, 'apply-update.log'),
    resultPath: join(root, 'last-apply.txt'),
    bootMarkerPath: join(root, 'booted.txt'),
    mountPoint: join(root, 'image'),
  }
}

/**
 * 从可执行文件路径推出 `.app` 包根。
 *
 * 取**最外层**的 `.app` 段：Electron 的渲染/GPU 子进程跑在
 * `<X.app>/Contents/Frameworks/<X> Helper.app/…`，若取最内层会去替换那个 helper。
 * @param executablePath - 绝对路径（`process.execPath`）。
 * @returns `.app` 绝对路径；不是绝对路径或不含 `.app` 段时为 undefined。
 */
export function macAppBundlePath(executablePath: string): string | undefined {
  if (!executablePath.startsWith('/')) return undefined
  const parts = executablePath.split('/')
  const index = parts.findIndex(part => part.endsWith('.app'))
  // 段 0 恒为空串（绝对路径），因此 index ≤ 0 说明没有 `.app` 段。
  if (index <= 0) return undefined
  return parts.slice(0, index + 1).join('/')
}

/**
 * 便宜的**原地更新**前置判据：只看进程自身的事实，不碰磁盘、不跑命令。
 *
 * 与 {@link prepareMacosInPlaceUpdate} 分开是为了"问用户之前就知道能不能做"——
 * 做不到时说辞必须是旧的"磁盘映像已打开，请自己拖"，做到时才是新的
 * "会自动重启并替换"。判据在这里不成立时，准备阶段一定也不会成立（反之不然：
 * 挂载、身份、磁盘空间要挂了才知道）。
 * @param precondition - 平台 / 是否打包 / 可执行文件路径。
 * @returns 做不到的原因；undefined = 可以继续准备。
 */
export function canInstallMacosInPlace(
  precondition: MacosInPlacePrecondition,
): MacosInPlaceFallbackReason | undefined {
  if (precondition.platform !== 'darwin') return 'unsupported-platform'
  if (!precondition.isPackaged) return 'not-packaged'
  const bundlePath = macAppBundlePath(precondition.executablePath)
  if (bundlePath === undefined) return 'unrecognized-bundle'
  // App Translocation：从 DMG/下载目录直接运行的应用会被 Gatekeeper 拷到随机只读路径
  // 再启动（`/private/var/folders/…/AppTranslocation/<uuid>/d/X.app`）。那份副本的
  // 宗卷是只读的、且下一次运行就换路径 ⇒ 替换它没有任何意义。
  if (bundlePath.includes('/AppTranslocation/')) return 'read-only-location'
  if (!isWritableDirectory(dirname(bundlePath))) return 'unwritable-location'
  if (!isWritableDirectory(bundlePath)) return 'unwritable-location'
  return undefined
}

/**
 * 准备一次原地更新：挂上 DMG、核对影像里的应用就是"同一个应用的新版本"。
 *
 * 成功时**影像保持挂载**（帮手要用它，并在做完后卸载），计划里的路径全部算好。
 * 影像本身有问题（挂不上、里面没有应用、身份/版本/TeamID 对不上）**抛错**：那不是
 * "换一种交付方式"，而是"这份载荷不能用"，交由协调器变成用户可见的失败。
 * @param options - 见 {@link MacosInPlacePrepareOptions}。
 * @returns `prepared`（含计划）或 `fallback`（含原因）。
 */
export async function prepareMacosInPlaceUpdate(
  options: MacosInPlacePrepareOptions,
): Promise<MacosInPlacePreparation> {
  const run = options.run ?? runMacosCommand
  const log = options.log ?? (() => {})
  const blocker = canInstallMacosInPlace(options)
  if (blocker !== undefined) return { kind: 'fallback', reason: blocker }
  const bundlePath = macAppBundlePath(options.executablePath)
  if (bundlePath === undefined) return { kind: 'fallback', reason: 'unrecognized-bundle' }
  const version = normalizeVersion(options.version)
  const paths = macosUpdatePaths(options.userDataPath)
  const current = readMacAppIdentity(run, bundlePath)
  if (current.version === version) throw new Error(`dsh-plugin-desktop: ${version} is already installed`)

  // 上一次留下的挂载点/暂存件先清干净：挂载点必须存在且为空，`hdiutil attach` 才肯用。
  clearMacosUpdateLeftovers(bundlePath, paths.mountPoint, run, log)
  // **只用 `rmdir`（空目录才行），绝不在挂载点路径上做递归删除**：万一上一次的影像
  // 还挂着（且卸载失败），递归删除会去删**卷里的内容**。卷是只读挂载所以它只会失败，
  // 但让"删不干净就报错"比"依赖卷是只读的"更结实。非空 ⇒ 交给 attach 自己报错。
  try {
    rmdirSync(paths.mountPoint)
  } catch {
    // 不存在（首次）或非空（残留挂载）：两种都继续往下走。
  }
  mkdirSync(paths.mountPoint, { recursive: true })

  let mounted = false
  try {
    run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noverify', '-mountpoint', paths.mountPoint, options.installerPath])
    mounted = true
    const sourcePath = singleApplicationInImage(paths.mountPoint)
    const source = readMacAppIdentity(run, sourcePath)
    assertSameApplication(current, source, version)
    // 空间判据在**挂载之后**（要先看到新副本有多大），但仍在**动用户文件之前**。
    if (!hasSpaceForUpdate(run, sourcePath, dirname(bundlePath))) {
      detachImage(run, paths.mountPoint, log)
      mounted = false
      return { kind: 'fallback', reason: 'insufficient-space' }
    }
    const sidecars = updateSidecarPaths(bundlePath, version)
    return {
      kind: 'prepared',
      plan: {
        bundlePath,
        mountPoint: paths.mountPoint,
        sourcePath,
        stagingPath: sidecars.stagingPath,
        backupPath: sidecars.backupPath,
        bundleIdentifier: current.identifier,
      },
    }
  } catch (cause) {
    if (mounted) detachImage(run, paths.mountPoint, log)
    try {
      rmdirSync(paths.mountPoint)
    } catch {
      // 同上：挂载点非空/仍挂着时不递归删。
    }
    throw cause
  }
}

/**
 * 把帮手脚本落盘并算出它的 argv。
 *
 * 脚本内容**不插值任何路径**（见 {@link macosUpdateHelperScript}）：路径一律走位置参数，
 * 于是 `/Applications/My App.app` 这类带空格、引号、`$` 的路径不需要转义，也不会被
 * shell 二次解释。这里只负责写文件与拼 argv。
 * @param options - 计划、私有目录、目标版本、宿主 pid，以及可选的等待/重启调参。
 * @returns 帮手脚本与 argv。
 */
export function writeMacosUpdateHelper(options: {
  readonly plan: MacosInPlaceUpdatePlan
  readonly userDataPath: string
  readonly version: string
  readonly pid: number
  readonly fromVersion: string
  /** 只在测试里用：见 {@link MacosUpdateHelperTuning}。生产一律用缺省。 */
  readonly tuning?: Partial<MacosUpdateHelperTuning>
}): MacosUpdateHelper {
  const paths = macosUpdatePaths(options.userDataPath)
  mkdirSync(dirname(paths.scriptPath), { recursive: true })
  writeFileSync(paths.scriptPath, macosUpdateHelperScript(options.tuning), { encoding: 'utf8', mode: 0o700 })
  return {
    scriptPath: paths.scriptPath,
    command: '/bin/sh',
    args: [
      paths.scriptPath,
      String(options.pid),
      options.plan.bundlePath,
      options.plan.sourcePath,
      options.plan.stagingPath,
      options.plan.backupPath,
      options.plan.mountPoint,
      paths.resultPath,
      paths.logPath,
      normalizeVersion(options.version),
      paths.bootMarkerPath,
      normalizeVersion(options.fromVersion),
    ],
    resultPath: paths.resultPath,
    logPath: paths.logPath,
    bootMarkerPath: paths.bootMarkerPath,
  }
}

/**
 * detached 起帮手，并等到内核确认 spawn 成功。
 *
 * **必须等到 `spawn`**：宿主紧接着就要退出，若帮手还没起来就退出，用户会得到一个
 * "应用关了、什么都没发生、也没有重新打开"的现场。这正是 Windows 分支
 * （`launchWindowsUpdateInstaller`）已有的口径。
 * @param helper - {@link writeMacosUpdateHelper} 的返回值。
 * @param onLateError - spawn 成功**之后**的错误（比如刚起来就被杀）；只记日志。
 * @returns spawn 成功即 resolve。
 */
export async function spawnMacosUpdateHelper(
  helper: MacosUpdateHelper,
  onLateError: (error: Error) => void = () => {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(helper.command, [...helper.args], { detached: true, stdio: 'ignore', shell: false })
    } catch (cause) {
      reject(cause)
      return
    }
    const fail = (cause: Error): void => { reject(cause) }
    child.once('error', fail)
    child.once('spawn', () => {
      child.off('error', fail)
      child.once('error', onLateError)
      child.unref()
      resolve()
    })
  })
}

/**
 * 读应用包身份。
 * @param run - 命令边界。
 * @param bundlePath - `.app` 绝对路径。
 * @returns 身份四元组；`plutil` 读不到时抛错。
 */
export function readMacAppIdentity(run: MacosCommandRunner, bundlePath: string): MacAppIdentity {
  const raw = run('plutil', ['-convert', 'json', '-o', '-', join(bundlePath, 'Contents', 'Info.plist')])
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const identifier = typeof parsed.CFBundleIdentifier === 'string' ? parsed.CFBundleIdentifier : ''
  const version = typeof parsed.CFBundleShortVersionString === 'string' ? parsed.CFBundleShortVersionString : ''
  const executable = typeof parsed.CFBundleExecutable === 'string' ? parsed.CFBundleExecutable : ''
  if (identifier === '' || version === '' || executable === '') {
    throw new Error(`dsh-plugin-desktop: ${bundlePath} does not look like an application bundle`)
  }
  return { identifier, version, executable, teamIdentifier: readTeamIdentifier(run, bundlePath) }
}

/**
 * 读签名里的 TeamIdentifier。
 *
 * 未签名或临时签名（`codesign -s -`）会输出 `TeamIdentifier=not set`，命令也可能直接
 * 非零退出 —— 两种都返回 undefined，由调用方决定"没有 TeamID"算不算不合格
 * （见 {@link assertSameApplication}：只有**当前**应用有 TeamID 时才强制一致）。
 * @param run - 命令边界。
 * @param bundlePath - `.app` 绝对路径。
 * @returns TeamIdentifier，或 undefined。
 */
export function readTeamIdentifier(run: MacosCommandRunner, bundlePath: string): string | undefined {
  let output: string
  try {
    output = run('codesign', ['-dv', '--verbose=4', bundlePath])
  } catch {
    return undefined
  }
  const matched = /^TeamIdentifier=(.+)$/mu.exec(output)?.[1]?.trim()
  if (matched === undefined || matched === '' || matched === 'not set') return undefined
  return matched
}

/**
 * 影像里的应用包：卷根下**有且只有一个** `.app`。
 *
 * electron-builder 的 DMG 卷根是 `<产品名>.app` + 指向 `/Applications` 的符号链接，
 * 因此必须用 `lstatSync` 判目录（`statSync` 会把那个符号链接也认成目录）。
 * @param mountPoint - 卷根绝对路径。
 * @returns 唯一的 `.app` 绝对路径。
 */
export function singleApplicationInImage(mountPoint: string): string {
  const entries = readdirSync(mountPoint)
  const applications = entries.filter((entry) => {
    if (!entry.endsWith('.app')) return false
    try {
      return lstatSync(join(mountPoint, entry)).isDirectory()
    } catch {
      return false
    }
  })
  const only = applications[0]
  if (only === undefined) {
    throw new Error(`dsh-plugin-desktop: the update disk image contains no application bundle (${mountPoint})`)
  }
  if (applications.length > 1) {
    throw new Error(`dsh-plugin-desktop: the update disk image contains ${String(applications.length)} application bundles`)
  }
  return join(mountPoint, only)
}

/**
 * 影像里的应用必须与当前应用**同身份、期待版本、同签名团队**。
 * @param current - 正在运行的应用包身份。
 * @param source - 影像里的应用包身份。
 * @param expectedVersion - 清单声明的目标版本（已去 `v`）。
 */
export function assertSameApplication(
  current: MacAppIdentity,
  source: MacAppIdentity,
  expectedVersion: string,
): void {
  if (source.identifier !== current.identifier) {
    throw new Error(
      `dsh-plugin-desktop: the update image holds ${source.identifier}, not ${current.identifier}`,
    )
  }
  if (source.version !== normalizeVersion(expectedVersion)) {
    throw new Error(
      `dsh-plugin-desktop: the update image holds ${source.version}, expected ${normalizeVersion(expectedVersion)}`,
    )
  }
  // TeamIdentifier 是这一层唯一真正的**来源**判据（codesign --verify 对自签/临时签名
  // 同样通过）。只有当前应用**有** TeamID 时才强制一致 —— 开发版/临时签名的应用
  // 本来就取不到 TeamID，不能因此把开发流程堵死。
  if (current.teamIdentifier !== undefined && source.teamIdentifier !== current.teamIdentifier) {
    throw new Error(
      `dsh-plugin-desktop: the update image is signed by ${source.teamIdentifier ?? 'no team'}, not ${current.teamIdentifier}`,
    )
  }
}

/**
 * 暂存/备份路径：与目标**同目录**，因此 `mv` 是同卷 rename（原子、瞬间完成）。
 *
 * 用点开头是为了不在「应用程序」里多出两个可见图标（替换过程中它们只存在几秒）。
 * @param bundlePath - 当前应用包绝对路径。
 * @param version - 目标版本（已去 `v`）。
 * @returns 暂存与备份路径。
 */
export function updateSidecarPaths(
  bundlePath: string,
  version: string,
): { readonly stagingPath: string; readonly backupPath: string } {
  const directory = dirname(bundlePath)
  const name = basename(bundlePath)
  return {
    stagingPath: join(directory, `.${name}.update-${normalizeVersion(version)}.app`),
    backupPath: join(directory, `.${name}.backup-${normalizeVersion(version)}.app`),
  }
}

/**
 * 清掉上一次留下的暂存件/备份/挂载点。
 *
 * 幂等、只碰**同目录下点开头的自家命名**，因此不会误删用户的任何东西。宿主启动时与
 * 准备阶段各调一次：崩在半路的更新不该在「应用程序」里留下永久垃圾，也不该让下一次
 * 挂载因为挂载点非空而失败。
 * @param bundlePath - 当前应用包绝对路径。
 * @param mountPoint - 影像挂载点（残留时先卸载）。
 * @param run - 命令边界（用于卸载残留挂载点）。
 * @param log - 诊断输出。
 */
export function clearMacosUpdateLeftovers(
  bundlePath: string,
  mountPoint: string,
  run: MacosCommandRunner,
  log: (message: string) => void = () => {},
): void {
  // 挂载点不存在 ⇒ 上一次根本没有挂过影像：不要每次启动都去 spawn 一个 `hdiutil`
  // 并记一行"卸载失败"的假错误（这条路径在每个 macOS 进程的启动路径上）。
  if (existsSync(mountPoint)) detachImage(run, mountPoint, log)
  const directory = dirname(bundlePath)
  const prefix = `.${basename(bundlePath)}.`
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    // 只删「本应用的暂存/备份」这一种形状：.<名字>.update-<版本>.app / .<名字>.backup-<版本>.app
    if (!/\.(?:update|backup)-[^/]+\.app$/u.test(entry)) continue
    try {
      rmSync(join(directory, entry), { recursive: true, force: true })
      log(`removed leftover ${entry}`)
    } catch {
      // 删不掉不是错误：它只占空间，不影响这次更新。
    }
  }
}

/**
 * 尽力卸载影像（失败只记日志：残留挂载点会被下一次准备阶段清掉）。
 *
 * 挂载点**根本不存在**时直接跳过：这不是"卸载失败"。真机上就有这一条噪声路径 ——
 * 准备阶段在 `assertSameApplication` 上拒掉一个版本不符的安装包时先抛错，`finally`
 * 里的清理再去 detach 那个已经被 `hdiutil attach` 自己回收掉（或压根没建起来）的挂载点，
 * 日志里就会多出一行 `hdiutil: detach failed - 无此文件或目录`，看起来像更新坏了。
 */
export function detachImage(run: MacosCommandRunner, mountPoint: string, log: (message: string) => void = () => {}): void {
  if (!existsSync(mountPoint)) return
  try {
    run('hdiutil', ['detach', mountPoint])
  } catch (cause) {
    // 竞态下"刚好被别人卸载掉"同样不是错误：判据是挂载点还在不在，不是 detach 的退出码。
    if (!existsSync(mountPoint)) return
    log(`could not detach ${mountPoint}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/**
 * 写启动标记：新版启动时**第一件事**。
 *
 * 帮手脚本在替换完成后等这个文件（并核对里面的版本号）才承认"更新成功"，等不到就回滚。
 * 标记必须在新版进程的启动路径上尽早写：越晚写，帮手等待窗口越可能误判成"没起来"。
 * @param userDataPath - `app.getPath('userData')`。
 * @param version - 当前运行版本。
 * @param stamp - 时间戳（便于诊断）。
 */
export function writeMacosUpdateBootMarker(userDataPath: string, version: string, stamp: string): void {
  const paths = macosUpdatePaths(userDataPath)
  try {
    mkdirSync(dirname(paths.bootMarkerPath), { recursive: true })
    writeFileSync(paths.bootMarkerPath, `version=${normalizeVersion(version)}\nat=${stamp}\n`, 'utf8')
  } catch {
    // 写不了标记只会让帮手回滚一次已经装好的更新（并在结果里留痕），不是崩溃点。
  }
}

/**
 * 读结果文件。
 * @param userDataPath - `app.getPath('userData')`。
 * @returns 记录；没有文件或文件损坏时为 undefined。
 */
export function readMacosUpdateRecord(userDataPath: string): MacosUpdateRecord | undefined {
  const paths = macosUpdatePaths(userDataPath)
  let raw: string
  try {
    raw = readFileSync(paths.resultPath, 'utf8')
  } catch {
    return undefined
  }
  const fields = new Map<string, string>()
  for (const line of raw.split('\n')) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    fields.set(line.slice(0, separator), line.slice(separator + 1))
  }
  const status = fields.get('status')
  const version = fields.get('version')
  if (status !== 'ok' && status !== 'failed' && status !== 'running') return undefined
  if (version === undefined || version === '') return undefined
  return {
    status,
    phase: fields.get('phase') ?? '',
    reason: fields.get('reason') ?? '',
    fromVersion: fields.get('from') ?? '',
    toVersion: version,
    targetPath: fields.get('target') ?? '',
    backupPath: fields.get('backup') ?? '',
    logPath: fields.get('log') ?? '',
  }
}

/** 删掉结果文件（一次更新只提示一次）。 */
export function clearMacosUpdateRecord(userDataPath: string): void {
  try {
    unlinkSync(macosUpdatePaths(userDataPath).resultPath)
  } catch {
    // 已经不在（或没有权限）都没关系：提示一次就够，重复提示才是问题。
  }
}

/**
 * 把结果文件翻译成**本次启动**该做的事。
 *
 * 判据是"记录的**目标版本**是不是就是当前运行的版本"，而不是记录里的状态码：
 * - 目标是当前版本 ⇒ 更新已经生效（无论帮手有没有走到最后一步）⇒ 删备份、清记录；
 * - 目标不是当前版本、记录说 `failed`/`running` ⇒ 没生效（回滚了或帮手被杀了）
 *   ⇒ 报一次失败、清记录、**保留备份**（用户/支持还可以手工换回去）；
 * - 目标不是当前版本、记录说 `ok` ⇒ 换过一次又被人手动降级，静默清记录。
 * @param userDataPath - `app.getPath('userData')`。
 * @param currentVersion - 当前运行版本。
 * @returns 结论；没有记录时为 undefined。
 */
export function readMacosUpdateOutcome(
  userDataPath: string,
  currentVersion: string,
): MacosUpdateOutcome | undefined {
  const record = readMacosUpdateRecord(userDataPath)
  if (record === undefined) return undefined
  const current = normalizeVersion(currentVersion)
  if (record.toVersion === current) {
    return { kind: 'applied', backupPath: record.backupPath, logPath: record.logPath }
  }
  if (record.status === 'failed' || record.status === 'running') return { kind: 'failed', record }
  return { kind: 'applied', backupPath: '', logPath: record.logPath }
}

/** 删掉备份目录（更新被当前版本确认之后才调用）。 */
export function removeMacosUpdateBackup(backupPath: string, log: (message: string) => void = () => {}): void {
  if (backupPath === '') return
  try {
    rmSync(backupPath, { recursive: true, force: true })
  } catch (cause) {
    log(`could not remove the update backup ${backupPath}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** 去掉前导 `v`（清单里的版本两种形态都出现过）。 */
export function normalizeVersion(version: string): string {
  return version.replace(/^v/u, '')
}

/** 目录可写判据（不存在或不可写都算"不能动"）。 */
function isWritableDirectory(path: string): boolean {
  try {
    accessSync(path, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 目标卷剩余空间是否够放"新的一份应用"。
 *
 * 换掉旧包**之前**必须先有这个新副本，所以判据是"剩余 ≥ 新副本大小"，不是"剩余 ≥ 增量"。
 * 算不出来（`du`/`statfs` 形态意外）时**放行**：宁可让 `ditto` 用真实的 ENOSPC 失败
 * （那条路径会回滚并留日志），也不要因为解析不到数字就把原本能更新的用户挡在门外。
 * @param run - 命令边界。
 * @param sourcePath - 影像里的应用包。
 * @param targetDirectory - 目标所在目录（暂存件也落在这里）。
 * @returns 余量是否够。
 */
export function hasSpaceForUpdate(
  run: MacosCommandRunner,
  sourcePath: string,
  targetDirectory: string,
): boolean {
  const used = parseKilobytes(run('du', ['-sk', sourcePath]))
  if (used === undefined) return true
  let available: number | undefined
  try {
    const stats = statfsSync(targetDirectory)
    available = (stats.bavail * stats.bsize) / 1024
  } catch {
    available = undefined
  }
  if (available === undefined) return true
  // 5% 余量给 ditto 的元数据/资源叉，另加 64 MiB 防止把卷写到满。
  return available >= used * 1.05 + 65_536
}

/** `du -sk` 输出首列的 KB 数。 */
function parseKilobytes(output: string): number | undefined {
  const first = output.trim().split(/\s+/u)[0]
  if (first === undefined) return undefined
  const value = Number.parseInt(first, 10)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * 帮手脚本的调参面。
 *
 * 三项都是**进程外部边界**，生产恒取下面的三个缺省常量；只有测试会传别的值，
 * 目的是让整条替换流程能在"不真的启动一个应用、不等满 30 秒"的前提下跑完
 * （`tests/macos-update-helper.integration.spec.ts`）。
 */
export interface MacosUpdateHelperTuning {
  /** 替换完成后重新打开应用用的命令（绝对路径）。 */
  readonly relaunchCommand: string
  /** 等宿主退出的滴答数（1 滴答 = 0.5s）。 */
  readonly exitWaitTicks: number
  /** 等新版本写启动标记的滴答数（1 滴答 = 0.5s）。 */
  readonly bootWaitTicks: number
}

/**
 * 帮手脚本本体：**路径零插值**，只有三个调参走白名单校验后的逐字替换。
 *
 * 位置参数（宿主按此顺序以 argv 传入）：
 * ```
 * $1  宿主 pid（等它退出，上限见 `exitWaitTicks`）
 * $2  当前应用包（要被替换的那一个）
 * $3  影像里的新应用包
 * $4  暂存路径（与 $2 同目录 ⇒ 同卷 ⇒ mv 是原子 rename）
 * $5  旧包备份路径（与 $2 同目录）
 * $6  影像挂载点
 * $7  结果文件
 * $8  日志文件
 * $9  目标版本
 * $10 启动标记文件
 * $11 更新前版本
 * ```
 *
 * 规矩：外部命令一律写绝对路径（帮手继承的环境不保证 PATH 完好）；每一步失败都先
 * "把用户的东西恢复原状"再写结果；**不动用户文件之前先校验签名**。
 * @param tuning - 调参（缺省 = 生产值）。
 * @returns 可直接落盘的 `/bin/sh` 脚本全文。
 */
export function macosUpdateHelperScript(tuning: Partial<MacosUpdateHelperTuning> = {}): string {
  const relaunch = tuning.relaunchCommand ?? DEFAULT_RELAUNCH_COMMAND
  const exitTicks = tuning.exitWaitTicks ?? DEFAULT_EXIT_WAIT_TICKS
  const bootTicks = tuning.bootWaitTicks ?? DEFAULT_BOOT_WAIT_TICKS
  // 这三项会**逐字进脚本**（其余路径都走位置参数），因此先按白名单校验：命令必须是
  // 绝对路径且只含安全字符，两个等待必须是正整数。校验失败即抛 —— 生产用的是下面
  // 三个常量，只有测试会传值，所以这条断言实际上是"测不了坏的脚本"的保证。
  if (!/^\/[A-Za-z0-9._/-]+$/u.test(relaunch)) {
    throw new Error(`dsh-plugin-desktop: unsafe macOS update relaunch command ${relaunch}`)
  }
  if (!Number.isInteger(exitTicks) || exitTicks <= 0 || !Number.isInteger(bootTicks) || bootTicks <= 0) {
    throw new Error('dsh-plugin-desktop: macOS update wait budgets must be positive integers')
  }
  const script = HELPER_TEMPLATE
    .replaceAll('@@RELAUNCH@@', relaunch)
    .replaceAll('@@EXIT_WAIT_TICKS@@', String(exitTicks))
    .replaceAll('@@EXIT_WAIT_SECONDS@@', String(Math.round(exitTicks / 2)))
    .replaceAll('@@BOOT_WAIT_TICKS@@', String(bootTicks))
    .replaceAll('@@BOOT_WAIT_SECONDS@@', String(Math.round(bootTicks / 2)))
  // fail-closed：模板里新增占位符却忘了替换 ⇒ 脚本里会留下 `@@…@@`。宁可在生成处当场
  // 抛错，也不要落一个半成品脚本到用户的更新目录里（`replaceAll` 漏一个就是这种形态）。
  if (script.includes('@@')) throw new Error('dsh-plugin-desktop: the macOS update helper template has an unreplaced placeholder')
  return script
}

/** 生产的重启命令（`open <app>` 交给 LaunchServices，能处理已经运行/已注册的情形）。 */
export const DEFAULT_RELAUNCH_COMMAND = '/usr/bin/open'

/** 等宿主退出的上限（单位 = 0.5s 滴答，240 ⇒ 120s）。 */
export const DEFAULT_EXIT_WAIT_TICKS = 240

/** 等新版本写启动标记的上限（单位 = 0.5s 滴答，60 ⇒ 30s）。 */
export const DEFAULT_BOOT_WAIT_TICKS = 60

const HELPER_TEMPLATE = `#!/bin/sh
# PicoAide Harness macOS 原地更新帮手。
# 由宿主在退出前用 detached 方式拉起（/bin/sh <脚本> <参数…>），宿主退出后由 launchd 收留。
# 参数见宿主侧 macosUpdateHelperScript 的文档；脚本内**不插值任何路径**。
# 退出码：0 = 已替换并确认启动；1 = 未替换（旧版本已重新打开或仍在运行）。
set -u

PID="$1"
TARGET="$2"
SOURCE="$3"
STAGING="$4"
BACKUP="$5"
MOUNT="$6"
RESULT="$7"
LOG_FILE="$8"
VERSION="$9"
BOOT_FILE="\${10}"
FROM_VERSION="\${11}"

log() { /usr/bin/printf '%s %s\\n' "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG_FILE" 2>/dev/null || true; }
record() {
  # $1=status $2=phase $3=reason
  /usr/bin/printf 'status=%s\\nphase=%s\\nreason=%s\\nversion=%s\\nfrom=%s\\ntarget=%s\\nbackup=%s\\nlog=%s\\n' \\
    "$1" "$2" "$3" "$VERSION" "$FROM_VERSION" "$TARGET" "$BACKUP" "$LOG_FILE" > "$RESULT" 2>/dev/null || true
}
relaunch() { @@RELAUNCH@@ "$1" >/dev/null 2>&1 || true; }

record running waiting ""
log "helper start: pid=$PID version=$VERSION target=$TARGET"

# 1) 等宿主退出。@@EXIT_WAIT_TICKS@@ × 0.5s = @@EXIT_WAIT_SECONDS@@s 上限：超时就什么都不动
# （应用还在跑，替换它会把正在运行的那个换瘸）。
waited=0
while /bin/kill -0 "$PID" 2>/dev/null; do
  if [ "$waited" -ge @@EXIT_WAIT_TICKS@@ ]; then
    log "host $PID did not exit within @@EXIT_WAIT_SECONDS@@s; giving up without touching any file"
    record failed waiting application-still-running
    exit 1
  fi
  /bin/sleep 0.5
  waited=$((waited + 1))
done
log "host exited after \${waited} x 0.5s"

# 2) 复制新版本到暂存路径（与目标同目录 ⇒ 之后是原子 rename）。
record running staging ""
/bin/rm -rf "$STAGING" "$BACKUP" >>"$LOG_FILE" 2>&1 || true
if ! /usr/bin/ditto --noqtn "$SOURCE" "$STAGING" >>"$LOG_FILE" 2>&1; then
  log "copy failed: $SOURCE -> $STAGING"
  /bin/rm -rf "$STAGING" >>"$LOG_FILE" 2>&1 || true
  record failed staging copy-failed
  relaunch "$TARGET"
  exit 1
fi

# 3) 校验暂存件（主程序 + 密封资源）。这一步不过，绝不动用户正在用的那个包。
record running verifying ""
if ! /usr/bin/codesign --verify --strict "$STAGING" >>"$LOG_FILE" 2>&1; then
  log "staged bundle failed code signature verification"
  /bin/rm -rf "$STAGING" >>"$LOG_FILE" 2>&1 || true
  record failed verifying verification-failed
  relaunch "$TARGET"
  exit 1
fi

# 4) 落位：旧包改名成备份（可回滚），暂存件原子改名成应用。
record running swapping ""
if ! /bin/mv "$TARGET" "$BACKUP" >>"$LOG_FILE" 2>&1; then
  log "could not move the current bundle aside"
  /bin/rm -rf "$STAGING" >>"$LOG_FILE" 2>&1 || true
  record failed swapping swap-failed
  relaunch "$TARGET"
  exit 1
fi
if ! /bin/mv "$STAGING" "$TARGET" >>"$LOG_FILE" 2>&1; then
  log "could not move the new bundle into place; restoring the backup"
  /bin/mv "$BACKUP" "$TARGET" >>"$LOG_FILE" 2>&1 || true
  /bin/rm -rf "$STAGING" >>"$LOG_FILE" 2>&1 || true
  record failed swapping rollback-restored
  relaunch "$TARGET"
  exit 1
fi
log "replaced $TARGET"
/usr/bin/xattr -dr com.apple.quarantine "$TARGET" >>"$LOG_FILE" 2>&1 || true
/bin/rm -f "$BOOT_FILE" >>"$LOG_FILE" 2>&1 || true

# 5) 先把新版本打开，再收尾（卸载影像）。顺序有讲究：卸载影像可能是秒级，而用户此刻
#    正盯着"应用已经关了"的空白期 —— 让他先看到图标在跳，而不是白等。
relaunch "$TARGET"
/usr/bin/hdiutil detach "$MOUNT" >>"$LOG_FILE" 2>&1 || true
waited=0
while [ "$waited" -lt @@BOOT_WAIT_TICKS@@ ]; do
  if [ -f "$BOOT_FILE" ] && /usr/bin/grep -q "version=$VERSION" "$BOOT_FILE" 2>/dev/null; then
    /bin/rm -rf "$BACKUP" >>"$LOG_FILE" 2>&1 || true
    record ok done ""
    log "version $VERSION confirmed running; backup removed"
    exit 0
  fi
  /bin/sleep 0.5
  waited=$((waited + 1))
done

# 6) 新版没起来：把新包挪开、备份换回原位、重新打开旧版本。
log "version $VERSION did not start within @@BOOT_WAIT_SECONDS@@s; rolling back"
BROKEN="$STAGING.broken"
if /bin/mv "$TARGET" "$BROKEN" >>"$LOG_FILE" 2>&1 && /bin/mv "$BACKUP" "$TARGET" >>"$LOG_FILE" 2>&1; then
  /bin/rm -rf "$BROKEN" >>"$LOG_FILE" 2>&1 || true
  record failed rolling-back application-did-not-start
  relaunch "$TARGET"
  exit 1
fi
log "rollback failed: $TARGET still holds the new version, backup kept at $BACKUP"
record failed rolling-back rollback-failed
exit 1
`

/** 生产脚本（缺省调参下的 {@link macosUpdateHelperScript} 结果）。 */
export const MACOS_UPDATE_HELPER_SOURCE = macosUpdateHelperScript()
