# 自研「定时任务」退役，改用官方 Schedule（2026-10-18）

> 决策记录。事实面的入口：`packages/host/desktop/src/profile.ts`（bundle 层）、
> `packages/client/foot-menu`（唯一入口）、`packages/host/cron/RETIRED.md`（源码保留说明）。
> 前置：DSH 0.2.1-rc.2 升级（PR #183）。

## 背景

上游 0.2.1 把 `schedule` / `ui-schedule` 从可选 bundle 改为**每个 Web profile 默认装配**，
`standard`/`cordis`/`ptc` preset 声明四个 `schedule_*` 工具；本仓自研的
`@picoaide/dsh-cron`（Host 定时器 + 任务面板 + `cron_*` 工具）与它在功能上完全重叠，
UI 上出现两个「自动化任务」入口。

## 定案

1. **退役自研 cron**：从桌面 profile 的 `REQUIRED_BUNDLES`、`dependencies` 与启动行清单中
   移除 `@picoaide/dsh-cron` / `pico-cron`。Host 定时器、HTTP 路由、`cron_*` 工具、设置卡、
   右栏任务详情与任务面板不再加载。`packages/host/cron` 源码暂留一个版本（`RETIRED.md`），
   便于对照回滚，不得重新加入组合。
2. **采用官方 Schedule**：调度、任务存储、`schedule_*` 工具与任务页全部由
   `@deepseek-ai/dsh-schedule` / `dsh-client-ui-schedule` / `dsh-tool-schedule` 提供。
3. **入口不动位置**：自研 cron 原来在侧栏「更多」浮层的第一位（`picoFootMenu` order `-10`，
   文案「定时任务」）。现在由 `@picoaide/dsh-foot-menu` 内置一条同 order 的
   「自动化任务」条目（`id: schedules`），点击打开官方 `schedules` 面板；浮层里其他四项
   顺序不变。
4. **避免双入口**：官方在 `sidebar.panellist` 还会渲染一行「自动化任务」。foot-menu 用一个
   DOM effect 把该行隐藏（只匹配 `panelRow` + 官方中英文面板名），保留面板本身；这样同一
   功能只有「更多」里的一个入口，位置与改造前一致。

## 同步隐藏的官方入口（2026-10-18）

foot-menu 的同一个 DOM effect 还负责另外两处官方 chrome：

- **`sidebar.panellist` 的「插件」行**：本产品不暴露官方插件管理页；「自动化任务」行
  已在上一节隐藏。两行都按官方中英文 label 精确匹配，其他官方面板行不受影响。
- **官方账户菜单里的「登录 / 退出登录 / 意见反馈」**：只处理**同时含「设置」**的
  `[role="menu"]`（官方 AccountMenu），本产品自己的「更多」浮层与账户卡浮层不含「设置」
  项，不会被误伤。本产品的账户卡保留余额与退出登录；反馈走渠道配置入口。
  代价：会话过期时官方菜单不再提供重新登录，需要走登录页。

客户端 E2E 新增断言：`官方重复入口与账户菜单认证/反馈项已隐藏`（校验 panellist 行
不可见、账户菜单可见项只剩「设置」）。

## 默认启用的官方实验性 bundle（2026-10-18）

产品要求"官方实验性插件默认全部装好"：以下 8 个 bundle 已加入桌面 profile 的
`REQUIRED_BUNDLES` 与 `dependencies`，随构建分发、默认启用（row 实测 `state=2` ACTIVE）：

| 产品名 | bundle | 插入/替换的行 |
| --- | --- | --- |
| 语音输入 | `dsh-experimental-voice-input-bundle`（原有） | `speech-to-text`、`speech-to-text-sensevoice`、`api-speech-to-text`、`ui-voice-input` |
| 智能体团队 | `dsh-experimental-agent-team-profile` | 禁用 `tool-subagent*` 四行，插入 `agent-team`、`tool-agent-team`、`ui-agent-team` |
| 自动授权审查 | `dsh-experimental-auto-review` | `auto-review` |
| 思考过程机器翻译 | `dsh-experimental-cot-translation-bundle` | `translator`、`cot-translation`（provider `bing`，目标语言 auto） |
| 持久终端 | `dsh-experimental-terminal-bundle` | `optional-persistent-terminals` 组（registry / bash / pwsh / tool-terminal） |
| 会话搜索 | `dsh-experimental-session-search` | `optional-session-search` 组（sqlite 索引 `:memory:`，首次搜索时打开 + `tool-session-query`） |
| 随对话更新的标题 | `dsh-experimental-session-titles-bundle` | 禁用 `session-title-llm`，插入 `session-title-all-prompts-llm` |
| Ralph 循环 | `dsh-experimental-ralph-bundle` | `optional-ralph` 组（`workflow-ptc` + `tool-ralph`，`maxRounds: 64`） |

注意：

- 这些是**上游 experimental** 包，默认值随上游走；升级时需复核每一行的语义变化。
- `agent-team-profile` 会**禁用**上游的 `tool-subagent` / `tool-subagent-control` /
  `tool-subagent-list-agents` / `tool-subagent-fork` 四行，由 Agent Teams 工具接管；
  这是上游 bundle 的既定行为。
- `auto-review` 会对每次工具调用走一次 LLM 授权复核（Auto 权限预设下），默认启用后
  延迟与 token 成本会上升；`session-search` 用内存索引；`terminal` 保留常驻 shell 进程。
- 平台条件行 `optional-terminal-pwsh` 在非 Windows 上由上游 `disabled` 表达式关闭，
  这是正常状态（实测 `state=undefined, disabled=true`）。

## 数据与兼容

- 旧任务账本仍在数据根 `cron/ledger.json`（只读保留）。**官方 Schedule 不会自动导入**这些任务；
  需要继续运行的任务请在官方「自动化任务」页重建。这是本次退役的唯一数据面代价。
- `cron_*` 工具名不再存在；模型侧改用官方 `schedule_create` / `schedule_list` /
  `schedule_update` / `schedule_delete`。
- cron 的设置命名空间（补跑策略等）不再生效；相关行为由官方 Schedule 的默认语义接管。

## 验证

- `yarn check` 全量通过（32/32）。
- `packages/host/desktop` 测试：126 文件 / 1615 用例，0 失败；打包必需清单与覆盖棘轮已同步
  移除 cron 条目（下限 122 → 118）。
- 客户端 E2E：`「更多」浮层可展开且列出五个面板入口`（自动化任务 / 能力中心 / 连接器 /
  浏览器 / 应用中心）与 `官方自动化任务面板可打开（入口仍在「更多」原位）` 均通过。
