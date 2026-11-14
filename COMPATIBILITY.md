# DSH 兼容性表

每测过一个 DSH 版本就在下面加一行。**没测过的版本写「未验证」**，不要推测。

| DSH 版本 | 结果 | 日期 | 备注 |
|---|---|---|---|
| `0.2.2-rc.2` | 日常使用无异常（未跑 P0 读数） | 2026-11-14 | WSL 站与 Windows 原生站同日升级到 `0.2.2-rc.2`（插件仍为 `0.4.1`）；此后约一天日常使用无异常（用户反馈）。**未跑**顶部那套 P0 逐项 DOM 读数，因此不记为「通过」；需要硬证据时按下文 P0 清单补测 |
| `0.2.1-rc.2` | 通过（P2-5 入口左移 + 抽屉不盖横条） | 2026-11-09 | 真实实例 8897 + headless Chrome（390×844，DPR 2，touch）：入口 `.dshtabs-menu` 矩形 **`x=8 y=797 w=45 h=47`**（横条最左、贴底边），当前标签从 `x=59` 起；点开后 `.dshtabs-sheet` **`y=462 h=334 bottom=796`**、`.dshtabs-scrim` **`h=796 bottom=796`**，两者都停在横条上沿（横条 796–844 保持可点，`elementFromPoint(195,820)` 命中 `dshtabs-tab`）；`aria-expanded` 由 `false → true` 且按钮背景变为 `interactive-bg-active`；头部的 `.dshtabs-sheet-close`（**44×36**）点击后面板消失、`aria-expanded=false`、焦点回到 `dshtabs-menu`。离线 `npm test` **74/74** |
| `0.2.1-rc.2` | 通过（P2-4 窄屏横条贴底） | 2026-11-09 | 真实实例 8897 + headless Chrome 143（CDP 390×844 与 1280×900）：窄屏 `.dshtabs` 矩形 **`x=0 y=796 w=390 h=48`（贴底，底边 = 视口底边）**、框架 `padding-top: 0px` / `padding-bottom: 48px`、`documentElement.scrollHeight = 844 = innerHeight`；1280px 下横条仍在顶部（`y=0 h=37`、`padding-top: 37px`、`padding-bottom: 0`），与改之前逐项一致。离线 `npm test` **71/71**。动机与宿主读数见下文 §「DSH 0.2.2 的响应式侧边栏」 |
| `0.2.2-rc.1` | 通过（P2-6 软键盘不再留空白） | 2026-11-10 | 真机 **Android 13 / vivo V2046A**（360×649, DPR 3）+ 诊断代理注入覆盖层：开键盘前 `ih=649`、横条 `y601 h48 b649`；点输入框开键盘后，未加 `interactive-widget` 时布局视口仍是 649、可视视口被平移，横条与键盘之间露出一条空白；插件补上 `interactive-widget=resizes-content` 后 → **`ih=378`、`html/body/#root=378`、横条 `y330 h48 b378`**，紧贴键盘、空白消失。离线 `npm test` **75/75** |
| `0.2.2-rc.1` | 通过（WSL 站：横条贴底 + 宿主抽屉开关可达） | 2026-11-09 | WSL 站升级到 0.2.2-rc.1 后同项复核（headless Chrome，390×844，DPR 2，touch）：`.dshtabs` **`x=0 y=796 w=390 h=48`**、`.dshtabs-menu` **`x=8`**（左下）、框架 `padding-top: 0` / `padding-bottom: 48px`、`scrollHeight = 844 = innerHeight`；宿主 `Open sidebar` 在 `(12,11)`，`elementFromPoint` 命中它自己的 svg（可点），点击后侧边栏 `x: -280 → 0`。两站（Windows 原生 + WSL）现在都跑 `0.2.2-rc.1` + 本插件 `0.3.2` |
| `0.2.2-rc.1` | 通过（P2-4 横条贴底 + 宿主抽屉开关可达） | 2026-11-09 | 真实实例（Windows 原生，DSH `0.2.2-rc.1` + better-sidebar `0.30.1` + 本插件 `0.3.1`）+ headless Chrome 143：390×844 下 `.dshtabs` 矩形 **`x=0 y=796 w=390 h=48`**、框架 `padding-top: 0` / `padding-bottom: 48px`、`documentElement.scrollHeight = 844 = innerHeight`；宿主左上角 `Open sidebar` 在 `(12,11)`，`elementFromPoint(26,25)` 现在命中**它自己的 svg**（不再是 `.dshtabs-dot`），点击后侧边栏 `x: -280 → 0` 抽屉正常拉出；1280×900 下横条仍在顶部（`y=0 h=37`）、`padding-top: 37px` / `padding-bottom: 0`、`scrollHeight = 900`。离线 `npm test` **71/71** |
| `0.2.1-rc.2` | 通过（P2-2 窄屏抽屉，客户端半边热更新） | 2026-11-09 | 真实实例 8897 + headless Chrome 143（CDP `Emulation.setDeviceMetricsOverride` 390×844 与 1280×900）：窄屏横条 **48px**（可点区域铺满整条）、框架 `--dsh-tabs-h: 48px`、非当前标签 `display:none`、标签上的 `×` 为 `display:none`、菜单按钮 `inline-flex`；抽屉 `position:fixed`、**遮罩矩形 `0,0,390,844`（没有被宿主祖先裁剪）**、行内 `标题 + 「状态 · workspace」` 与集合一致、当前行 `aria-current` 恰好 1 条；Esc 收起且焦点回到 `dshtabs-menu`，点遮罩同样收起；1280px 下横条 **37px**、标签全部可见、菜单 `display:none`、`×` 恢复 `display:block`。撤掉探针打开的会话后，窄屏进入「当前会话不在集合里」：可见标签 0，`.dshtabs-stray` 显示当前会话名、无 `×`、`.dshtabs-list` 为 `display:none`。同版按 P2-3 移除横条的 `＋` 与抽屉底部的新建入口（标签栏只做标签）。离线 `npm test` **70/70**。读数见下文 §「P2-2 窄屏抽屉」 |
| `0.2.1-rc.2` | 通过（P2-1 workspace 辨识，仅标签栏） | 2026-11-02 | 真实实例 8897 + headless Chrome：`dsh-synced-tabs` 在 boot graph 内；8 个标签各按 `WorkspaceView.sessionIds` 取到 workspace，左内侧 2px 色条 + `dshtabs-ws` 徽章（`alpha`、`title` = 完整路径），同组 `data-ws-join="true"` 首尾相接；状态点已与色条分置（此前的 `inset 2px` 重影已修）；横条仍 37px。离线 `npm test` 59/59。左栏装饰已移除，见下文 |
| `0.2.1-rc.2` | 通过（选中态强调 + 状态点悬停说明） | 2026-10-22 | 真实实例 8897 + headless Chrome 143：选中标签从 `#fff`-on-`#f9fafb`（几乎不可辨）改为 `interactive-bg-active` 填充 + 2px `state-business-primary` 底部强调条；横条 37px、框架 `padding-top:37px` 不变；离线 `npm test` 49/49。证据见下文 §「选中态强调」 |
| `0.2.1-rc.2` | 通过（P1-1 + P1-2 隔离/真实实例） | 2026-10-20 | P1-1 跨设备共享集合：精确 Fetch 路由 + `$DSH_HOME/dsh-tabs/state.json`（2026-10-18，45 条离线测试）。P1-2 滚轮横滚：真实实例 8/8 读数通过（2026-10-20，离线 `npm test` 48 条全绿）。两节的实测证据都在下面 |
| `0.2.1-rc.2` | 未验证 | 2026-10-17 | 只做了无头 Chrome 的只读 DOM 复核：横条 `top=0/h=37`、框架 `padding-top:37px` 且 `--dsh-tabs-h:37px`、三列 `top` 全 37、状态点 `data-kind="idle"`、刷新后标签恢复、控制台零 `[dsh-synced-tabs]` 警告（P0-1/9/10/11 与加载链路）；**交互项 P0-2/3/5/7/8/12 未测** |
| `0.2.0-rc.2` | 降级通过 | 2026-10-09 | 见下：P0-1…P0-12 逐条实测过；只有 P0-4「关最后一个标签」按 §三 的缺失接缝路径降级 |
| `0.1.7-rc.1` | 未验证 | — | 三个参考项目共同锚定的宿主契约下限，未来若要放宽 peer 范围需先在此版本实测 |

## DSH 0.2.2 的响应式侧边栏与顶部横条的冲突（2026-11-09）

宿主自 `0.2.2-rc.1` 起在 `dsh-client-ui-layout` 里加了响应式布局（源码常量 `SIDEBAR_AUTO_COLLAPSE = 1024`、
`drawer = viewport < 768`）。Windows 实例实测（headless Chrome，逐档改视口）：

| 视口宽 | 侧边栏 | `Open sidebar` 开关位置 | 顶部横条（48px）会不会盖住 |
|---|---|---|---|
| ≥ 1024 | 常驻 280px | `Collapse sidebar` @ (244,59) | 不会 |
| 768–1023 | 56px 图标轨道 | (10,55) | 不会（在横条下沿之外） |
| < 768 | 离屏抽屉 `x = -280` | **(12,11)** | **会** |

`< 768` 的那一档，横条正好压在开关上：`document.elementFromPoint(26,25)` 返回 `.dshtabs-dot`；
把横条临时隐藏后同一坐标返回 `button[aria-label="Open sidebar"]`，点它能把抽屉拉出来（`x: -280 → 0`，
Workspaces 树正常）。这就是「手机上侧边栏和 workspaces 全都不见了」的机制——不是宿主丢了 UI，是入口被压住。

因此插件的窄屏断点从 `560` 改成 `767`（与宿主 `< 768` 同界），并**把横条挪到屏幕底部**：顶部整条让给宿主。

## `0.2.1-rc.2` 的 P2-2 窄屏抽屉实测（2026-11-09）

验证环境：**真实实例 8897**（`~/.dsh` 现网，客户端半边随刷新热更新）+ headless Chrome 143，通过
CDP `Emulation.setDeviceMetricsOverride` 把视口压到手机尺寸（390×844，`mobile: true`，DPR 2）。
页面用本机 DSH 打印的带 token URL 取 cookie 后加载（token 不外泄、不写进本文件）。

| 读数 | 390×844（窄屏） | 1280×900（桌面） |
|---|---|---|
| `matchMedia('(max-width:767px)')` | true | false |
| 横条高度 | **48px** | **37px**（与改之前一致） |
| 框架 `--dsh-tabs-h` / `padding-top` | 48px / 48px（ResizeObserver 已同步） | — |
| 标签总数 / 可见数 | 4 / **1**（探针自己打开了 1 个会话；其余 `display:none`） | 3 / **3** |
| 可见标签的标题宽度 | 约 262px（≈20 个汉字） | 101px（≈7.8 字，与改之前一致） |
| 菜单按钮 `display` | `inline-flex` | `none` |
| 标签上的 `×` `display` | `none` | `block`（`opacity: 0`，与改之前一致） |

| 抽屉读数（390×844） | 值 |
|---|---|
| 计算样式 `position` | `fixed` |
| 遮罩矩形 | **`top=0 left=0 w=390 h=844`** —— 与视口完全重合，宿主祖先**没有**把它变成新的包含块 |
| 面板矩形 | `top=567 h=277`（贴底、宽度铺满） |
| `z-index` | 61（遮罩 60） |
| 行数 / 当前行 | 4 / 1，`aria-current="true"` |
| 行内文字 | 例：`迁移自建服务到虚拟机` + `运行中 · alpha`（状态与 workspace 都写成了文字） |
| 打开后的 `document.activeElement` | `dshtabs-row-main`（焦点落在当前会话那一行；找不到当前行才退回面板 `dshtabs-sheet`） |
| Esc 之后 | 面板消失，`activeElement.className === 'dshtabs-menu'`（焦点归还） |
| 点遮罩 | 收起 |

**兜底标题（实测中发现的洞）**：当前主区会话不在集合里时（另一台设备把它的标签关了），
`aria-selected` 一个都不匹配 → 窄屏会把所有标签隐藏。此时实测到：`visibleTabs: 0`，
`.dshtabs-stray` 显示当前会话名、无 `×`，且 `.dshtabs-list` 计算样式为 `display:none`
（让出整条宽度，兜底标题盒宽 281px）。离线测试另有一条用例覆盖同一时序。

> **测试副作用与已恢复**：无头页面加载后，客户端按 P0-2 不变量把「它自己主区的会话」加进共享集合，
> 因此每次加载都会给宿主多加一个标签。实测结束后通过 `POST /api/dsh-tabs/state` 下发 `close` 撤掉，
> 最终 `~/.dsh/dsh-tabs/state.json` 的 `tabs` 与操作前逐项相同（仅 `seq` 递增）。
> **没有在真机（手机）上复核观感**——无头只能证明布局、定位与交互接线，替代不了肉眼，见 README §7.9 末段。

## `0.2.1-rc.2` 的 P1-1 实测范围（2026-10-18）

验证环境：隔离 DSH 实例（`DSH_HOME=/tmp/dsh-tabs-e2e/home`、`127.0.0.1:18897`、bundles =
`dsh-base` + `dsh-web-app` + `dsh-synced-tabs`（link 安装）），两个 **cookie/存储隔离的 BrowserContext**
模拟两台设备；真实实例（60552 / 8897）与 `~/.dsh` 全程未被触碰。离线 `npm test` 45/45。

| 用例 | 实测证据 |
|---|---|
| 端点边界 | 无 cookie → 401；伪造 `Origin: evil` → 403；非法 JSON → 400；`{"v":2}` → 400；close 不存在的 id → `changed:false` 且 seq 不变；`state.json` 与 GET 逐字段一致 |
| 打开同步 | A 打开会话 → B 的 DOM 出现新标签 **381ms / 2923ms**（都在 3s 轮询内）；宿主 tabs 里该 id 恰好 1 次 |
| 去重 | B 再打开同一条 → 两侧无重复标签，seq 不变（`changed:false`） |
| 关闭同步 | B 点 × → A 侧标签消失 **2571ms**；GET 与 `state.json` 都是 `tabs: []`、seq +1 |
| 刷新恢复 | 两设备刷新 → 集合恢复 **2507ms / 2411ms**；宿主集合不变 |
| 重启恢复 | 停/启宿主进程 → `state.json` 原样读回（seq/tabs 不变）；两设备刷新后一致 |
| 降级（真实 404） | 用不带 Host 半边的插件副本跑另一个实例：带 cookie GET 状态路由 → 404；客户端只告警**恰好 1 条**「host 半边未加载」，标签在本设备照常工作、刷新仍在，不写状态文件 |
| focus 立刻拉取 | 合成 window `focus` 后 **4ms** 发出 GET |
| 已知边界 | 「关闭最后一个标签 + 刷新会回归」：主视图仍停在该会话，刷新时按 P0-2 不变量重新加入；见 README §4.8 末段 |

**真实实例生效验证（2026-10-18，本机 Web 实例 127.0.0.1:8897）**

- **Host 半边热加载**：用 HMR 的 profile 重组（往 `~/.dsh/profiles/web/cordis.patch.yml` 写一行再撤掉）
  把 linked package 的 Host 半边换新——**未重启进程**，带 cookie 的 `GET /api/dsh-tabs/state` 从 404
  变 200 并返回 `{"ok":true,"state":{...}}`；进程 pid/启动时间前后不变。部署纪律仍按「首次升级重启一次」
  写，热加载只作为开发期事实记录。
- **新客户端 bundle**：两个独立浏览器上下文从 `/plugins/??…,dsh-tabs/client.js,…&rev=…` 取到的
  bundle 含新关键字 `dsh-synced-tabs:state`（HTTP 200），横条挂载、pageerror=0、console 无 `[dsh-synced-tabs]` 警告。
- **跨设备**（只打开现存会话，不新建、不发消息、不打开进行中的会话）：A 打开 X → B 出现 **2541ms**；
  B 点 × 关闭 X → A 消失 **944ms**；两侧刷新恢复 **2471ms / 2358ms**；每一步 GET 与 `state.json`
  的 seq/tabs/updatedAt 逐字段一致。验证结束把集合清空（最终 `seq=6, tabs=[]`），不污染用户集合。
- 状态文件权限实测：目录 `700`、文件 `600`。

**未覆盖**：真实两台物理设备/跨网络、非 owner Peer、真实窗口 focus（无头 Chrome 两个 context 始终
visible，focus 用合成事件验证）、DSH 其他版本。

---

## `0.2.1-rc.2` 的 P1-2 实测范围（2026-10-20）

验证环境：**真实实例**（`127.0.0.1:8897`，Google Chrome 143.0.7499.169 headless，视口 1280×800，
宿主状态 13 条标签 → 横条渲染 14 个）。数据全部取自页面里的真实 DOM 读数与真实滚轮事件
（`Input.dispatchMouseEvent` 走浏览器输入管线），不是直接调插件函数。离线 `npm test` 48/48
（新增 3 条：竖向滚轮、单位/手势边界、不溢出）。

| 用例 | 实测证据 |
|---|---|
| 溢出成立 | `.dshtabs-list` `clientWidth=1234`、`scrollWidth=2422`（约 2 屏宽），最后一个标签 `left=2349` 在视口外 |
| 竖向滚轮 → 横滚 | 滚轮 `+240px`：`scrollLeft 0→240`；`−120px`：`240→120` |
| 到端夹紧 | 一次 `+2400px`：`scrollLeft=1188`（=2422−1234）；再滚 `+400px` 仍是 `1188` |
| 默认行为未被污染 | 每次滚轮后 `window.scrollY` 恒为 `0`（页面根不滚动，印证 §7.6 的「不拦默认」取舍） |
| 横向手势不叠加 | 合成 `deltaX=120, deltaY=10`：`scrollLeft 0→120`（只有原生一份，不是双倍） |
| Shift+滚轮不叠加 | Shift+`deltaY=240`：`0→240`；**加 `shiftKey` 判断前是 480**——这条是实测抓出来的回归点 |
| 代码确实上线 | 页面实际取到的 combo bundle（`rev=6a03142d77e4`）含 `onWheel` 与 `overscroll-behavior-x`；上一版 rev 是 `e773b2aa2dae` |
| 控制台 | `pageerror=0`、`[dsh-synced-tabs]` 警告 0、passive `preventDefault` 告警 0 |

**副作用（已还原）**：验证页面打开时按 P0-2 不变量把当时主视图的 blank 会话加进集合
（`seq 49→50`，多出 1 个标签）；验证结束后用同一条精确路由 `POST close` 撤掉（`seq→54`，
期间用户自己也关掉了几条，最终集合 10 条）。插件本身没有做任何额外写操作。

**未覆盖**：真实触控板横向手势（用合成 `deltaX` 代替）、Ctrl+滚轮缩放后的外观、Firefox 的
`deltaMode=1`（只用离线测试覆盖）、真实窗口的鼠标硬件差异、DSH 其他版本。

---

## `0.2.1-rc.2` 的选中态强调实测（2026-10-22）

验证环境：**真实实例**（`127.0.0.1:8897`，Google Chrome 143.0.7499.169 headless，视口 1440×813，
light 主题），读数全部来自页面里的 `getComputedStyle` 与截图，不是「看起来顺眼」。改动只发生在
`client.js` 的 CSS 常量里，客户端半边刷新即热更新（**未重启进程**）。

| 读数 | 改前 | 改后（light） | 改后（dark） |
|---|---|---|---|
| 横条底色 | `rgb(249,250,251)` | 同 | `rgb(27,27,28)` |
| 选中标签背景 | `rgb(255,255,255)` | `rgba(38,49,72,.1)`（复合后 ≈`#e4e6e9`） | `rgba(255,255,255,.14)`（复合后 ≈`#3b3b3d`） |
| 选中标签 box-shadow | `inset 0 0 0 .5px rgba(0,0,0,.1)` | 原描边 + `rgb(65,118,230) 0 -2px 0 0 inset` | 原描边 + `rgb(122,170,255) 0 -2px 0 0 inset` |
| 未选中标签 | 透明 + `label-secondary` | 不变 | 不变 |
| 标签尺寸 | 28px 高 | 28px 高（`inset` 不改盒子） | 同 |
| 横条 / 框架 padding-top | 37px / 37px | 37px / 37px | 37px / 37px |

- **代码确实上线**：页面里注入的 `<style>` 文本含 `interactive-bg-active` 与 `inset 0 -2px 0 0`（改前两者都不存在）。
- **状态点悬停说明**：`idle` 点 `title="空闲"`、`running` 点 `title="运行中"`；`pending`/`unread` 由离线测试覆盖
  （真实实例上没法等出这两个状态）。
- **深色一侧**：用 `body[data-ds-dark-theme]` 强制切换后读数（DSH 的主题开关就是这条属性，
  令牌解析路径等价；没有走设置面板）。深色下 `state-business-primary` 自动变成 `#7aaaff`。
- **对比度**：强调条 vs 横条底色，浅色 **4.05:1**、深色 **7.39:1**（WCAG 非文本 3:1 达标）；选中标签文字仍是
  `label-primary`（浅色 **15.1:1**、深色 **10.7:1**）；选中填充 vs 横条底色 1.20 / 1.54（改前 1.05 / 1.10）。
  由独立复核员按 WCAG 公式用 node 与 python 两套实现复算，结果一致。
- **离线测试**：`npm test` **49/49**（新增 1 条：四个 kind 都必须带悬停说明）。

**副作用（已还原）**：验证用的 headless 页面打开时按 P0-2 不变量把它的主视图会话加进了共享集合
（`seq 146→147`，多出 1 个标签）；验证结束后用同一条精确路由 `POST close` 撤掉。

**未覆盖**：真实浅色/深色设置面板切换、Windows 桌面端、DSH 其他版本。

---

## `0.2.0-rc.2` 的实测范围（2026-10-09）

同一天装了又卸、卸了又装，用的是**浏览器 Web UI**（`dsh --profile web`，非桌面端），
每次结论都取自页面里的 DOM/computed style 读数，不是「看起来对」。

**通过的项**

| 条目 | 实测证据 |
|---|---|
| P0-1 渲染 | 横条可见；`barTop=0`、`barBottom=37`；左栏/主区/右栏三列的 `getBoundingClientRect().top` 全是 37 —— 无一被遮挡 |
| P0-2 追加语义 | 从左栏打开会话后标签从 `["alpha"]` 变成 `["alpha","新开的会话标题"]`：追加、不重排、`aria-selected` 跟着走 |
| P0-3 点击切换 | 点第 1 个标签后选中态与 roving tabindex 一起移动；点当前标签无导航调用 |
| P0-5 新建 | 当前是 non-blank 会话时点 `＋` → 复用本工作区的 blank 会话并选中它（**不新增标签**，符合 DSH 自己的「复用或新建」策略）；当前已是 blank 时点 `＋` 是 no-op |
| P0-6 状态点 | 正在跑的会话：`data-kind="running"`、`background-color=rgb(65,118,230)`（`--dsw-alias-state-business-primary`）、`animation-name=dshtabs-pulse`；空闲会话灰点 + 无动画 |
| P0-7 键盘 | `ArrowRight` 把 roving tabindex 从 0 挪到 1、`Home` 挪回 0，且都不触发导航；焦点在 1 时 `Enter` 真的切了会话；`Delete` 关掉标签 |
| P0-8 主题 | 切换明暗后横条背景 `rgb(249,250,251)` ⇄ `rgb(27,27,28)`，选中标签文字色同步；样式里没有硬编码色值（离线测试静态断言） |
| P0-9 刷新恢复 | 刷新后标签集合与顺序原样恢复；跨窗口分键（`sessionStorage` 窗口 id + `localStorage` 分键）由离线测试覆盖 |
| P0-10 布局避让 | 框架节点上只有 `data-dsh-tabs` + `--dsh-tabs-h`；`box-sizing:border-box`、`padding-top:37px`、三列 top 全为 37；关掉所有标签后变量自动变成 `35px`（ResizeObserver 在跟） |
| P0-11 降级 | 只在人为抽掉接缝时告警；正常启动**没有任何** `[dsh-synced-tabs]` 警告 |
| P0-12 卸载零残留 | 停用 bundle + 刷新后：横条消失、`data-dsh-tabs` 与 `--dsh-tabs-h` 都没了、`padding-top` 回到 `0px`、注入的 `<style>` 计数回到 0、三列 top 回到 0；页面其余部分照常 |
| P0-13 测试门禁 | `npm test` 28 条全绿，零依赖（不需要安装任何东西） |
| P0-14 体量 | `client.js` 498 行、仓库内容 103KB（发布载荷 55KB）、运行时依赖 0、peer 只有官方三包 + react |

**降级的那一项**

- **P0-4「关最后一个标签」**：清单里写的落点是 `uiWorkspace.clearMain()`，但 `clearMain` 在
  `UiWorkspaceService` 上是 `private`，也不在 `UiWorkspace` 接口与客户端 Service 目录里
  （用 `cordis_inspect_query` 的 client `Service` 核过）。所以最后一个标签关闭后**只移除标签、
  主视图保持不动**，并打印一条说明。这是 §三 表里已经写好的缺失接缝行为，不是遗漏；
  详见 `lib/client.d.ts` 的「明确没有用、也不能用的东西」。

**顺带核实到的两件事**（会写回 README §5）

1. `plugin_manager` 的 `install_bundle` 走的是 **`dsh.profile.bundles`**，不是 profile patch 的
   `insert` 行。实测**不需要重启 dsh 进程**：装完 boot graph 就重组了，只要刷新页面。
2. 这台机器上 `pnpm` 装在 `~/.local/share/pnpm`，**不在 dsh 进程的 PATH 上**
   （dsh 的 PATH 只有 nvm bin + `/usr/local/bin` + `/usr/bin` + `/bin`），所以 `install_bundle`
   第一次以 `spawn pnpm ENOENT` 失败。已加一个转发 shim 到 nvm bin，见 README §5.1。

## 记录方式

- **结果**只写三种：`通过` / `降级通过`（说明降级了什么）/ `失败`（附 issue 编号）
- **备注**写清实测覆盖了什么：标签切换、状态点、刷新恢复、卸载残留、与哪些插件同时启用
- 升级 DSH 之后，第一件事是回来更新这张表；`通过` 的那一行不要改，新加一行

## 怎么测

1. 把本插件挂进 profile（见 README §5），刷新页面
2. 逐项对照 README §3 的 P0 清单手工过一遍
3. 跑一次「装上 → 卸下」检查 DOM 残留（README §4.2）
4. 把结果记进上表

离线那部分（不需要浏览器）直接跑：

```bash
npm test        # 或 node --test 'test/*.test.mjs'
```

---

## `0.2.1-rc.2` 的 P2-1 实测范围（2026-10-30）

验证环境：**真实实例**（`127.0.0.1:8897`，headless Chrome 143，视口 1600×1000，用页面自己的
`?token=` 换 cookie 进站）+ **隔离实例**（`DSH_HOME=/tmp/dsh-tabs-ws-e2e/home`、`127.0.0.1:18897`，
4 个自建 workspace）。两边的用户会话集合都没有被改动（只读 DOM，不点标签、不发消息）。

**离线**：`npm test` **59/59**（新增 3 条 P2-1 验收 + 清理门禁；`lib/host.js` 侧 18 条含 7 条新协议用例）。

### 标签栏（主路径，已验证）

| 读数 | 值（真实实例 8897） |
|---|---|
| `dsh-synced-tabs` 是否在 boot graph | 是（`__DSH_BOOT__.entries` 含 `dsh-synced-tabs`） |
| 标签的 `data-ws` | `<workspace-uuid>`（= `alpha` 的 workspaceId） |
| `--dshtabs-ws` 解析值 | `#5686fe`（= `--dsw-static-deepseek-450`） |
| 色条 computed `box-shadow` | `rgb(86, 134, 254) 2px 0px 0px 0px inset` |
| 徽章 | 文案 `alpha`，`title` = 该 workspace 的完整路径 |
| 横条高度 | **37px**（与 §7.7 一致，未因徽章变高） |
"| 色条与状态点 | 两个独立元素：`.dshtabs-wsbar`（2px，`align-self:stretch`）与 `.dshtabs-dot`（7px 圆，纯色）；第一版把两者叠在同一个 7px 矩形里，用户反馈「重影、眼花」，已撤 |

**4 个 workspace 的对比**（隔离实例，`wsTint(count, rank)` 按列表位置取色）：

| 标签 | 色条 computed 颜色 | 令牌 |
|---|---|---|
| alpha | `rgb(34, 197, 94)` | `--dsw-static-green-500` |
| beta | `rgb(23, 37, 84)` | `--dsw-static-blue-950` |
| gamma | `rgb(245, 158, 11)` | `--dsw-static-amber-500` |
| delta | `rgb(127, 130, 135)` | `--dsw-static-neutral-500` |

深色主题下四个读数**完全相同**（`static` 色阶不随主题变）。

### 令牌存在性（防「拼错即静默透明」）

7 个令牌逐个在真实浏览器里 `getComputedStyle` 解析，并**带两组对照**：
`--dsw-static-deepseek-950`（**不存在**）与 `--dsw-static-__no-such-token__` 都解析为
`rgba(0, 0, 0, 0)`——证明这个断言真能抓到拼错，不是空断言。

| 令牌 | 浅色 | 深色 |
|---|---|---|
| `neutral-500` | `rgb(127,130,135)` | 同 |
| `amber-500` | `rgb(245,158,11)` | 同 |
| `blue-950` | `rgb(23,37,84)` | 同 |
| `green-500` | `rgb(34,197,94)` | 同 |
| `neutral-250` | `rgb(220,220,220)` | 同 |
| `deepseek-450` | `rgb(86,134,254)` | 同 |
| `neutral-700` | `rgb(60,60,61)` | 同 |

**与侧栏底色（`--dsw-specific-sidebar-fill`）的对比度**（WCAG 非文本 3:1 口径，如实记录不达标的）：

| 令牌 | 浅色 | 深色 |
|---|---|---|
| `neutral-500` | 3.69 ✅ | 4.46 ✅ |
| `amber-500` | **2.06 ❌** | 8.01 ✅ |
| `blue-950` | 14.06 ✅ | **1.17 ❌** |
| `green-500` | **2.18 ❌** | 7.55 ✅ |
| `neutral-250` | **1.31 ❌** | 12.55 ✅ |
| `deepseek-450` | 3.22 ✅ | 5.11 ✅ |
| `neutral-700` | 10.54 ✅ | **1.56 ❌** |

色条因此带 0.5px `--dsw-alias-border-l2` 描边；描边保证「有一条线」（1.25–1.45:1 的边界可见性），
**不保证每个颜色都和底色可分**。这是既有取舍，写在 README §7.8，不是回归。

### 未覆盖（如实记录，不要当已通过）

- **「两个不同 workspace 同屏不同色」**：真实实例 8897 上读到的 8 个标签恰好都属于 `alpha`（颜色一致），
  多色对比只在隔离实例（4 个自建 workspace）与设计稿里验证过。
- **左栏装饰已移除**（2026-11-02）：曾经在 `sidebar.session.row.leading` / `.hover` 上画同色左沿与
  「工作区：<名字>」悬停卡。撤除原因不是缺陷，是产品判断——左栏已按 workspace 分组，色条零信息量且
  与标签色条同色会让人误以为两处有联动；且该槽位只在 `primaryStatus.state === 'idle'` 的行挂载
  （`SessionNodeItem` 非 idle 直接渲染状态点、不调 `renderSlot`），覆盖本就不全。**含该装饰的版本
  （`dsh-synced-tabs` `4c32da8`）的读数保留在上面的历史里，当前版本不再有这些 `data-dshtabs-ws-*` 属性。**
- **浅色/深色截图里的多色对比**：深色主题只做了 DOM 读数（`data-ds-dark-theme` 切换后重读）。
  当时的取证截图（浅色、深色各一张）随一轮性 `.scratch` 工作区一并清除，未入库；
  需要时按上表读数在同一隔离实例重跑即可复现，无需依赖历史图片。
