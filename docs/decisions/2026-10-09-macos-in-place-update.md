# macOS 原地自更新：应用自己换掉自己并重开（2026-10-09）

状态：已实施（`packages/host/desktop`）

## 问题（用户 2026-10-09 反馈）

> 当前项目编译出的 macOS 程序每次更新时需要手动退出应用并手动拖动程序到应用程序文件夹中
> 替换原来的应用。

改造前 macOS 的交付口径只有一条（`electron-runtime.ts` 的 `installUpdate`）：把下载好的
DMG `shell.openPath(...)` 打开，然后弹一句"磁盘映像已打开。请用新版本替换「应用程序」里的
X，然后重新打开。"剩下的四步 —— 退出应用、拖进「应用程序」、覆盖旧版本、重新打开 ——
全部由用户手工完成。Windows 早就是"应用自己重启、安装程序接管"，macOS 缺的正是这一步。

## 现状取证

| 位置 | 事实 |
|---|---|
| `electron-runtime.ts:739`（改造前） | darwin 分支 = `shell.openPath(dmg)` + 一段"请自己拖"的提示；没有任何替换动作 |
| `updates.ts:1119`（`installReady`） | 交付前会复检"这份包确实属于当前更新源 + SHA-256 命中"，复检不过就撤掉 ready 状态 —— 不改 |
| `update-download.ts` | 只产出**已公证的 DMG**；Linux 的 AppImage 同样只能提示用户手动替换 |
| `tray-locale.ts`（`darwinOpenedDetail`） | 唯一一条 macOS 安装文案就是"请用新版本替换…"（中英各一句） |

## 决策

**在 macOS 上用"宿主退出 → 一个 detached 的 `/bin/sh` 帮手完成替换 → 帮手把应用重新
打开"取代"打开磁盘映像让用户拖"。** 回落路径逐字保留：做不到时仍然打开磁盘映像。

### 1. 三段时间线

```
宿主（旧版本）                              帮手（/bin/sh，detached，launchd 收留）
─────────────────────────────              ──────────────────────────────────────
① canInstallMacosInPlace（零副作用）
② 确认框（措辞与②的结论一致）
③ prepareMacosInPlaceUpdate：
   挂载 DMG（只读）→ 卷根唯一 .app →
   BundleID / 版本 / TeamID / 剩余空间
④ 写帮手脚本 + detached 起进程，等 'spawn'
⑤ requestQuit(0) ───────────────────────▶ ⑥ 等宿主 pid 退出（≤120s）
                                           ⑦ ditto 到 <同目录>/.<名>.update-<版本>.app
                                           ⑧ codesign --verify --strict 暂存件
                                           ⑨ mv 旧包→备份；mv 暂存件→目标
                                           ⑩ 卸影像、重开应用
                                           ⑪ 等新版写启动标记（≤30s）
                                              等到 ⇒ 删备份、记 ok
                                              等不到 ⇒ 回滚 + 重开旧版本、记 failed
```

### 2. 判据全部"在动用户文件之前"

- **签名校验在替换之前**（第 ⑧ 步）而不是之后：失败时用户的应用一个字节都没变。
- **新旧包必须同身份**（`CFBundleIdentifier`）、**同期待版本**（清单声明的版本）、
  **同签名团队**（`TeamIdentifier`）。三者任一不符即**抛错**，不是"换一种交付方式"：
  `codesign --verify` 对自签/临时签名同样通过，TeamID 才是这一层真正的**来源**判据
  （当前应用没有 TeamID 的开发版不强制 —— 否则开发流程被堵死）。
- **`mv` 而不是 `rm -rf` + 复制**：旧包改名成备份（同卷 rename，瞬时），失败可就地换回。
  暂存件也在**目标同目录**，于是最后一次落位是原子 rename，目标"消失"的窗口是微秒级。
- **挂载点只用 `rmdir`，绝不递归删除**：万一上一次的影像还挂着且卸载失败，递归删除会
  去删**卷里的内容**。非空就让 `hdiutil attach` 自己报错。
- 每一步失败的结论都写进**结果文件**；退出码 0/1 与之同义。

### 3. "成功"由新版本自己证明

帮手在重新打开应用之前**删掉**启动标记，然后等新版本把它写回来（`version=<目标版本>`）：
等到了才删备份，等不到就回滚。这不是为了好看 —— 没有这一步，"更新成功"只是"文件换好了"
的猜测，而一个新版本起不来时用户会同时失去新旧两个版本。删标记这一步是必须的：否则
**上一次**留下的同名标记会让帮手把"根本没起来"误判成成功。

标记由宿主在启动路径上尽早写（`electron-runtime.ts` 的 `mount()` 第一件事，
`writeMacosUpdateBootMarker`）。这条**跨版本契约**是本次改造唯一一个"未来版本必须继续
遵守"的约定，写在 `macos-update-install.ts` 的模块注释里。

### 4. 失败对用户可见（一次）

宿主下次启动时读结果文件（`readMacosUpdateOutcome`），判据是"记录的**目标版本**是不是
就是当前运行的版本"：

| 记录 | 当前版本 | 结论 |
|---|---|---|
| 任意 | = 目标版本 | 更新已生效 ⇒ 删备份、清记录（帮手被杀了也算生效） |
| `failed`/`running` | ≠ 目标版本 | 报一次失败（原因 + 日志路径 + 备份路径）⇒ 清记录 |
| `ok` | ≠ 目标版本 | 静默清理（例如用户后来手动降级） |

`running` 是"帮手没写完结果就被杀"的形态：`to === 当前版本` 时它是**成功**，否则按中断报错。

### 5. 回落面（与改造前逐字一致）

| 情形 | 行为 |
|---|---|
| 开发态（`app.isPackaged === false`） | 打开磁盘映像 |
| 可执行文件不在 `.app` 里 / 非 macOS | 打开磁盘映像 |
| App Translocation（从 DMG/下载目录直接运行） | 打开磁盘映像 |
| 目标目录或应用包不可写（root 安装、只读卷） | 打开磁盘映像 |
| 剩余空间放不下一份新副本 | 打开磁盘映像 |
| 影像挂不上 / 卷里不是一个应用 / 身份/版本/TeamID 对不上 | **失败**（`lastError = 'invalid-artifact'`） |

**不弹管理员授权**：需要提权才能替换的安装（root 所有）一律走回落，绝不出现密码框。

## 边界（不做）

- 不引入 `electron-updater`、不加 ZIP/blockmap 第二条载荷与发布路径、不做差分下载、
  不改服务端清单与 R2 布局 —— 2026-09-12 的决定继续成立
  （`docs/decisions/2026-09-12-client-update-resilience.md`）。
- 不改服务端、不改渠道面：脚本、日志、结果文件全部落在 `userData/updates/macos/`，
  随渠道隔离；文案走 `productName` 与既有中文文案表。
- 不做"静默重启"：安装始终由用户显式触发（对话框上还有一个「稍后」）。
- 不做自动降级回滚之外的失败自愈：新版本起不来才回滚；替换成功但随后崩溃不在本轮面内。

## 验证

- `packages/host/desktop/tests/macos-update-install.spec.ts`（39 例）：打包路径推导
  （最外层 `.app`）、五种"做不到"判据、身份/版本/TeamID/空间核对、影像里 0/1/多份应用的
  分类、暂存与备份的命名与清理边界（只删自家形状）、结果文件解析与三种结论、
  脚本静态契约（**先校验后动手**、两条回滚分支、失败码与文案表同源、路径零插值、
  调参白名单拒注入）、`spawn` 的 resolve/reject/late-error 三条路径。
- `packages/host/desktop/tests/macos-update-helper.integration.spec.ts`（5 例，
  **只在 macOS 上跑**，真 `/bin/sh` + 真 `ditto` + 真 `codesign`）：成功替换（含
  "替换后的包仍能通过签名校验"）、新版没起来 ⇒ 回滚、**旧启动标记不得被当成新版本启动**、
  签名不过 ⇒ 一个字节都不动、宿主没退出 ⇒ 一个字节都不动。
- `packages/host/desktop/tests/electron-runtime.spec.ts`（新增 9 例）：确认框措辞 =
  原地更新、**先等帮手起来再退出宿主**（`invocationCallOrder` 判据）、用户推迟 ⇒
  什么都不做、环境不支持 ⇒ 打开磁盘映像、准备阶段回落 ⇒ 打开磁盘映像、坏载荷 ⇒
  抛错且既不开映像也不退出、帮手起不来 ⇒ 不退出、启动写标记、失败提示一次并清记录、
  生效则删备份。
- `packages/host/desktop/tests/tray-locale.spec.ts`：新增文案的中英双语与"详情含
  日志/备份路径、无备份不留空行、未登记失败码原样回显"。
- 相关门禁：`corepack yarn workspace dsh-plugin-desktop typecheck|test`。

## 认账（未闭环）

- **`hdiutil create` 在本机砂箱里跑不了**（返回"操作不被允许"），所以"造一个 DMG 再挂"
  这一步进不了自动化用例；`tests/macos-update-helper.integration.spec.ts` 喂的是**解开的**
  应用包路径（帮手不关心它挂在哪）。作为补偿，2026-10-09 用**真实已公证 DMG**
  （`PicoAide-Harness-2.7.3-beta.2-mac.dmg`，147 MiB，内含 379 MiB 的应用）手工跑过一遍
  生产路径（`prepareMacosInPlaceUpdate` 用真 runner + 真帮手脚本，只把重启命令换成
  `/usr/bin/true`）：
  - 真 `hdiutil attach -nobrowse -readonly -noverify -mountpoint <userData>/updates/macos/image`
    挂载成功，卷根形态与假设一致（唯一 `.app` + `Applications` 符号链接 + 三个点文件）；
  - 真 `plutil`/`codesign -dv`/`du`/`statfs` 全部通过，计划里的路径与实际落点一致；
  - 帮手 `ditto --noqtn` 出 379 MiB 的副本后 `codesign --verify --strict` **通过**
    （"复制会丢签名"这个最大的未知项被否证），落位、卸载影像、按启动标记删备份全部按预期，
    全程 2.1 秒，替换后的包 `codesign --verify --strict` 报
    `valid on disk / satisfies its Designated Requirement`（含全部嵌套 helper）。

  仍未覆盖的是**下载 → 挂载 → 帮手 → 新版本真的接管窗口**这条完整链路（要一台真机点一次
  "安装更新"）。
- **自动回滚只覆盖"新版本进程没起来"**（30s 内没写标记）。起来了但随后崩溃、或被用户
  立刻退出，不在面内；备份此时已经删掉，恢复要靠重新下载 DMG。
- 帮手脚本是**字符串模板**（`macosUpdateHelperScript`），不是被类型系统检查的代码。
  静态契约由 `macos-update-install.spec.ts` 的文本判据 + 真机集成用例守住。
