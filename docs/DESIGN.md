# dsh-synced-tabs

> **DeepSeek Harness（DSH）Web GUI 的会话标签栏插件**：把「打开过的会话」变成显式的活跃集合，并在同一宿主的多个设备间共享。
> 目标：把「当前窗口打开过的会话」变成一个**显式的活跃集合**，降低人在会话之间切换的注意力成本。
>
> **状态：P0 已落地并在本机实测；P1-1「跨设备共享活跃集合」与 P1-2「标签溢出时滚轮横向滚动」已实现
> （离线测试覆盖，实测结论见 [`COMPATIBILITY.md`](COMPATIBILITY.md)）**。P0 的实测证据来自
> `0.2.0-rc.2`（P0-1…P0-12 逐条有 DOM 读数；P0-4 的「关最后一个标签」按缺失接缝降级），
> `0.2.1-rc.2` 只做了无头 DOM 复核；P1-1/P1-2 在 `0.2.1-rc.2` 的隔离实例与真实实例上都实测过。
>
> 实现分两个半边、零依赖零构建：`client.js`（渲染 + 同步客户端）与 `lib/host.js`（宿主侧共享集合 +
> 精确 Fetch 路由）。**为什么不再是纯客户端插件**：标签集合原先只存在 `localStorage` 里，天然按设备
> 隔离——电脑上关掉的会话在手机上仍然显示为「开着」，见 §三 P1-1 与 §4.8。

---

## 一、为什么自己写（决策记录，2026-10-09）

**起因**：DSH Web GUI 的左栏是「平铺所有会话」的列表，没有「活跃会话」这一层语义。切换会话时要在
一长串历史里重新定位，人的注意力成本高。opencode 的会话标签栏好用，正是因为它把这一层显式化了。

**评估过三个现成的社区插件**（见 [§6 参考项目](#六参考项目)），都能用，但都不适合当长期依赖：

| 方案 | 做得好的地方 | 不选它当长期依赖的理由 |
|---|---|---|
| `dsh-session-tabbar` | 契约意识最好：`lib/client.d.ts` 写清宿主 API 契约、104 项离线断言、`prepublishOnly` 卡发版、卸载还原被改过的内联样式 | **作者不可验证**：源码仓库（`gitee.com/darren_ho/dsh-plugins`）在 Gitee 公开 API 下返回 `Not Found Project`；GitHub 无镜像也无同名仓库；npm 上只有 2026-09-30 一天发布的 3 个包；没有公开 issue 区 |
| `dsh-session-tabs` | **接缝最干净**：只挂官方 `[data-shell-overlay]`，用自有 data 属性 + 一个 CSS 变量占位，卸载自清理；零 DOM 类名匹配 | 仓库只有 **1 个 commit**（2026-10-04）、无版本契约（没声明 peer 范围）、未发布到 npm |
| `dsh-qol` | 作者最有历史（GitHub 2017 年建号、107 仓库、仍在日更），功能最全（Pin / 活跃优先排序 / 右键菜单） | 18 合 1 的大包：**3006 行 / 828KB / 30 个 DOM 结构锚点**；任一处失配的影响面不止标签栏 |

**决定性的前提**：DSH 本体仍是 developer preview（本机跑的是 `0.2.1-rc.2`；P0 实测证据来自
`0.2.0-rc.2`，升级后尚未复核，见 `COMPATIBILITY.md`），这条赛道上**不存在
「长期稳定」这个选项**。能控制的只有两件事——**接入面有多小**、**回滚有多快**。这两件事只有
自持代码才能保证，所以自己写，并且**把它当「可弃层」维护**：不叠别的功能，出问题就整块删掉。

---

## 二、目标

1. **降低切换成本** —— 打开过的会话变成一排标签，一次点击直达，不必回左栏历史里找。
2. **补上「活跃」语义** —— 标签自带状态点（运行中 / 等待交互 / 完成未读 / 空闲），一眼看出哪个会话在等人。
3. **跨设备一致** —— 标签集合是**宿主上的一份状态**：电脑上关掉的会话，手机上同时消失；换设备/换浏览器
   不再需要「猜哪个是我关过的」。
4. **可弃** —— 接入面就是 profile 里的一行 patch insert；删掉那一行 + 刷新页面即完全回滚（状态文件留着，
   重新启用即恢复）。
5. **不欠债** —— 宿主改版导致失配时，要么自动降级为 no-op 并留下日志，要么大声报错；**绝不静默半坏**。
6. **窄屏可用**（P2-2，2026-11-09）—— 手机上一屏只放得下 **1.7 个**标签、每个标签只有约 **8 个字**（真实实例实测），
   而悬浮提示在触屏上根本不存在。所以窄屏不再硬塞一排标签：横条只显示当前会话，全部标签进底部抽屉。

---

## 三、预期实现的功能

分三层。**第一个版本只做 P0**，P1 看用下来的实际需要，P2 不承诺。

### P0 —— 最小可用（已落地，逐条实测见 `COMPATIBILITY.md`）

- [x] 顶部会话标签栏：**一个标签 = 一条本窗口打开过的会话**，按打开顺序排列
- [x] 点击标签切换会话（`uiWorkspace.openSession`）；点击当前标签是 no-op
- [x] 关闭标签：`×` / 鼠标中键 / `Delete`；**只关视图，不删会话**；关闭后切到右侧邻居（无则左侧；都没有时**只移除标签**——`clearMain` 不是公开接缝，见 §4.1）
- [x] ~~`＋` 新建会话（走 DSH 原生新建流程，复用它的「复用或新建」策略）~~ —— **2026-11-09 移除（P2-3）**：
  DSH 本体就能新建会话，标签栏只做标签。见下方 P2-3。
- [x] 状态点：运行中（蓝 + 脉冲）/ 等待交互（琥珀）/ 完成未读（绿）/ 空闲（灰）；**查不到状态就不画点**，不猜；
  每个点都带悬停说明（`title`），语义与色值见 §7.7
- [x] 键盘可达：`tablist` / `tab` 语义 + roving tabindex + `←/→`（环绕）+ `Home/End` + `Enter/Space` + `Delete`
- [x] 主题跟随：颜色**只**走 DSH 主题令牌，不硬编码色值
- [x] 刷新后标签仍在（本机一份缓存 + 宿主共享集合；旧版按窗口分键的载荷会自动迁移，见 §4.8）

### P1 —— 有了更好

- [x] **跨设备共享活跃集合**（P1-1，已实现）：集合的真相在宿主，任何设备打开/关闭都会同步到其它设备；
  见 §4.8 的协议、冲突规则与降级路径
- [ ] 拖拽排序
- [ ] Pin：固定的标签置顶，且不被溢出淘汰
- [ ] 右键菜单：关闭 / 关闭其他 / 关闭全部
- [x] **标签溢出时滚轮横向滚动**（P1-2，已实现）：竖向滚轮转横向；`deltaMode` 折算行/页单位；
  横向手势与 Shift/Ctrl+滚轮不叠加；到端不动、不拦默认行为（取舍见 §7.6）
- [ ] 排序模式：标准（打开顺序）/ **活跃优先**（有状态点的排前，空闲排后）
- [x] **workspace 辨识**（P2-1，2026-10-30，原 P2「与 workspace 联动」）：标签带上所属 workspace 的
  颜色（左内侧 2px 色条，同组相连）与名字徽章；归属来自 `useWorkspaces()` 的
  `WorkspaceView.sessionIds`，宿主侧 `workspaceByTab` 只作跨设备兜底。**只作用于标签栏，不动左栏**。
  见 §7.8

### P2 —— 暂不承诺

- [ ] 把标签撕出去变成独立窗口（多窗口各自一套标签）
- [ ] **按 workspace 重排标签顺序**：本版只做「看得见归属」，不改打开顺序；重排会动 P0-1
  「一个标签 = 一条打开过的会话、按打开顺序」这条已验收语义，要做先改契约

### P2-2 —— 窄屏降级为「当前会话 + 抽屉」（已落地，2026-11-09）

- [x] `max-width:767px` 时横条只显示当前会话：标题可用宽度 **101px → 约 262px**（≈20 汉字）；非当前标签
  `display:none`（同时移出可访问性树与 Tab 次序），`×` 与工作区徽章也让位（色条仍然表达归属）
- [x] **P2-6（2026-11-10）开键盘时不再露出一条「页面之外」的空白**：Android + Chromium 默认
  `interactive-widget=resizes-visual`，键盘只缩**可视视口**，布局视口仍是 649；浏览器把可视视口往上平移
  去露出输入框，页面只有 649 高，平移后底部露出页面之外的空白（用户原话「键盘上方有多余的空白」）。
  插件在挂载时给宿主的 viewport meta 补 `interactive-widget=resizes-content`（**宿主自己声明过就一个字符都不改**），
  布局视口随键盘缩到 378，`html/body/#root` 的 100% 一起缩，横条落到 330–378、紧贴键盘。
  真机实测（360×649，Android）：补之前 `ih=649 / 横条底 649 + 空白`；补之后 `ih=378 / 横条 330–378`。
  桌面无感（没有软键盘时该指令不生效）。**这条属于宿主该做的事**，我们只是先补上；宿主一旦在
  `index.html` 自己写了 `interactive-widget`，这个补丁自动让位（正则检测到就跳过）
- [x] **P2-5（同日）抽屉入口挪到横条左侧、抽屉不再盖住横条**：手机单手够不着右下角那颗按钮，
  且展开后横条被面板整块盖住，只剩「点遮罩」这一个看不见的收回动作。改法：入口排到横条最左
  （`≡ N`，44px 宽、48px 高、贴底边）、抽屉与遮罩都从横条上沿往上长（`bottom: var(--dsh-tabs-h)`，
  面板 `max-height: calc(64vh - var(--dsh-tabs-h))`），横条在展开时保持可见可点、按钮进入按下态
  （`[aria-expanded="true"]` 高亮），再点一次即收起；面板头部另加一个显式「✕ 收起」（44×36 热区）。
  焦点仍落在当前会话那一行，收起后还给 `≡ N`
- [x] **P2-4（同日）窄屏横条挪到屏幕底部**：DSH 0.2.2 起，`innerWidth < 768` 时宿主把侧边栏降级成
  离屏抽屉（`x = -280`），唯一入口是左上角 `(12,11)` 那颗 28px 浮动「打开侧边栏」按钮。顶部横条
  正好压住它——实测该坐标 `elementFromPoint` 命中的是 `.dshtabs-dot`，点下去侧边栏永远打不开
  （宿主行为，非本插件 bug）。把横条贴底后顶部整条让给宿主，同时更接近手机的标签栏习惯。
  断点因此与宿主的抽屉分界点对齐：`NARROW_PX = 767`（= 宿主 `< 768`），`[data-dsh-tabs]` 的避让
  从 `padding-top` 换成 `padding-bottom`，并给贴底横条加减 `env(safe-area-inset-bottom)`
- [x] 横条右侧 `≡ N`（`aria-haspopup="dialog"` + `aria-label="打开的会话（N）"`）打开底部抽屉；
  按钮上带**聚合状态点**（等待回答 > 已完成未读 > 运行中；全空闲不画）
- [x] 抽屉：一行一个标签，标题最多两行，第二行写**状态文字 + workspace 名**（触屏没有悬停，状态必须写出来），
  右侧 `×` 只关标签不删会话；当前行 `aria-current`
- [x] 当前会话**不在集合里**（别的设备把它的标签关了）时，窄屏仍显示一个只读兜底标题，不出现"只剩 ≡N 的空条"
- [x] 交互：Esc / 遮罩 / 选中后收起；焦点进门时给面板、出门还回 `≡`；`role="dialog"` + `aria-modal` + Tab 环绕；
  **无动画**，所以 `prefers-reduced-motion` 天然满足
- [x] 桌面端零变化：菜单按钮 `display:none`、横条 37px、标签/徽章/关闭按钮全部与引入之前一致
- [x] 离线测试 **70/70**；真实实例实测读数见 [`COMPATIBILITY.md`](COMPATIBILITY.md)

### P2-3 —— 标签栏只做标签（2026-11-09）

- [x] 移除横条上的 `＋` 与抽屉底部的「＋ 新建会话」：新建会话是 **DSH 自己**的事（`＋`、快捷键、命令都行），
  插件不该在自己只有一层的接缝上再开一个入口——它只是转调 `uiWorkspace.startSession()`，多一个入口就是多一处
  需要跟着宿主改版走的地方。
- [x] 0 个标签时连抽屉入口都不渲染（`≡ 0` 的抽屉里没有内容可放）
- [x] 保留的仍是「标签本身」的东西：标题、状态点、workspace 色条与徽章、`×` 关标签、键盘导航。
  **不**保留任何"顺便帮你做点别的"的入口（新建/归档/搜索都不做，见非目标）
- [x] 测试相应改为断言「没有任何新建入口，且整个挂载期间不调用 `startSession`」（70/70）

### 非目标（明确不做）

- **不做**会话的归档 / 删除 / 全文搜索 —— 那是会话管理器类插件的事，本插件只管「视图」
- **不改**DSH 上游代码，不打补丁，不 fork 官方包
- ~~**不做**移动端专属布局改造（桌面优先，窄屏只保证不坏）~~ —— **2026-11-09 推翻**：P2-2 只做窄屏的
  **标签切换面**（横条降级 + 抽屉），不碰宿主的其它布局；「桌面优先」仍是默认，窄屏是显式设计过的降级。
  撤销条件：DSH 宿主自己给出移动端标签切换面，或实测证明窄屏下标签栏根本不该出现（那就退化成窄屏隐藏）。
- **不接管**左栏会话列表的既有行为
- **不做**跨 DSH 实例的自动同步：每个宿主实例一份状态（`$DSH_HOME/dsh-tabs/state.json`）。真要让
  WSL 与 Windows 两个实例互通，把 patch 行的 `stateFile` 指到同一共享路径即可，但「多写者」的一致性
  不在本版承诺范围内（见 §4.8 末段）

---

## 四、维护性要求（硬约束）

以下每一条都是**验收条件**，不是建议。做不到的 PR 必须先在 issue 里写清理由。

### 4.1 只挂官方接缝

允许的宿主接触面**仅限**：

| 类别 | 允许使用 |
|---|---|
| 槽位 | `shell.overlay`（插件渲染进这个官方浮层，不往别人的 DOM 节点里塞东西） |
| 数据 | `useSessions`、`useSessionStatus`（由槽位的 standardProps 送进组件） |
| 导航 | `uiWorkspace.openSession` / `startSession` |
| 主题 | `--dsw-*` 主题令牌 |
| 同步（客户端） | `window.fetch` 打本插件**自己的**精确 Fetch 路由；`window.addEventListener('focus')`；`window.localStorage` 的单个缓存键 |
| 同步（Host） | `ctx.inject(['connection'], …)` 等 Connection 到位；`ctx.connection.fetch.register()` 注册 `/api/dsh-tabs/state`；自己的状态文件 `$DSH_HOME/dsh-tabs/state.json` |

**精确 Fetch 路由是官方接缝**：`dsh-client-connection` 的 Host 半边把「精确 GET/HEAD/POST 路由」与
RPC 通道并列作为对外能力（`/api/file`、`/api/directoryPicker/*` 都走这一层）。分发之前，Connection
已经完成 Host/Origin 校验与浏览器 cookie 鉴权，且**只放行 owner Peer**——本插件不碰认证。

**Host 半边不挂 Remote 方法**：那需要 Typert 生成物（构建步骤），会破坏「零构建」；`ctx.storageDomain`
则需要 zod schema 与版本迁移，对「一个字符串数组」是过重的依赖。精确 Fetch 路由 + 自己的 JSON 文件，
是「零依赖零构建」约束下唯一都成立的落点。

**`uiWorkspace.clearMain` 不在允许列表里**：它在 `UiWorkspaceService` 上是 `private`，也不在
`UiWorkspace` 接口与客户端 Service 目录里。运行时 `(uiWorkspace).clearMain()` 确实调得到，但那正是
「升级即坏」的写法——本插件不碰，代价是关掉最后一个标签时主视图保持不动。

**禁止匹配 DSH 的 CSS Module 类名**（`[class*="centerCol"]` 这类）。CSS Module 的 hash 每次构建都变、
类名本身也可能被上游改名——这正是第三方方案里最先坏、且坏得最隐蔽的地方。

需要「避让布局」时，采用**官方 data 属性定位 + 自有属性/变量**的两段式：

```
自己的节点.closest('[data-shell-overlay]')  →  parentElement（框架节点）
  → 打上自己的 data-dsh-tabs 属性 + 一个 --dsh-tabs-h 变量
  → 占位规则选择器完全属于自己： [data-dsh-tabs]{ box-sizing:border-box; padding-top:var(--dsh-tabs-h) }
```

**`box-sizing:border-box` 不能省**：框架节点是 `display:grid; grid-template-rows:100%; height:100%`，
默认的 `content-box` 下加 `padding-top` 会让整块比视口高一个横条，而它是 `overflow:hidden`——
结果是底部被悄悄裁掉，且不会有任何报错。

`--dsh-tabs-h` 由 `ResizeObserver` 量自己横条的真实高度写入（初值 `38px`），所以字体大小、
标签增减都会自动跟上，而不是写死一个数字。

### 4.2 卸载零残留

`ctx.effect` 的 disposer 必须还原动过的一切：data 属性、CSS 变量、注入的 `<style>`、事件监听。
**验收方式**：装上再卸下，目标节点的属性集合与安装前一致。

### 4.3 失败要可见

- 拿不到宿主服务：**不抛异常、不半坏** —— 降级为 no-op 并 `console.warn` 说明缺了什么
- 布局避让拿不到锚点：**大声告警**（`console.warn` + 有限重试），绝不静默重叠到原生 UI 上
- 同步端点缺失（404/405）：退回本设备本地模式，**只告警一次**（同一原因不刷屏）；网络暂时失败也只在
  第一次告警，恢复后自动补发（`pending` 队列不丢操作）

### 4.4 宿主契约写进类型

`lib/client.d.ts` 必须写清：依赖哪些宿主 API、它们在**哪个 DSH 版本**提供、**哪一版删过什么**。
`package.json` 的 peer 范围显式声明（本包：`>=0.2.0-rc.2`），**不写「什么都兼容」**。

本包的 peer 全部标了 `peerDependenciesMeta.*.optional`：这些包由 dsh 的安装树/profile 提供，
**不由本包安装**，标成必装会让 pnpm 在装本包时去找它们（而 `react` 甚至不在 profile 的
node_modules 里——它来自浏览器侧的平台种子模块表）。

### 4.5 测试是发版门禁

- **离线行为测试**（不需要浏览器、不需要真 DSH、**不需要装任何东西**）：渲染、切换、关闭、
  键盘、降级、迁移与跨设备行为都要有断言。`npm test` 目前 43 条（客户端 32 + Host 半边 11）。
- 门禁：本包**不发布到 npm**（§7），所以 `prepublishOnly` 实际不会被 npm 触发；真正的门禁是
  「提交前跑 `npm test`」+ `COMPATIBILITY.md` 的实测行。`prepublishOnly` 仍然留着，将来若要发布即生效。
- **测试怎么做到零依赖**：`test/harness.mjs` 用 `node:vm` 跑**真实发布的 `client.js` 字节**，
  截下它注册的工厂，再用一个最小的 React 替身（`createElement` + `useState/useEffect/useMemo/useRef`）
  和一个小渲染器把组件挂起来，支持事件派发与重渲染。
  **它是测试替身，不是 React 的实现**——真实浏览器里的行为只由 `COMPATIBILITY.md` 的实测行负责，
  两者不能互相替代。

### 4.6 体量与依赖预算

| 项 | 预算 | 实际（2026-11-09） |
|---|---|---|
| 客户端代码 | **< 1200 行**（不含测试） | `client.js` **1178 行** |
| Host 半边 | **< 300 行** | `lib/host.js` **295 行** |
| 包体 | **< 200KB** | 仓库内容（不含 `.git`，`du -sb`）**232.3KB**（含 `.scratch` 之外的测试与文档）；`files` 声明的发布载荷 **169,428 字节（约 165KB）**（`files` 里含 README 与 COMPATIBILITY，不含测试目录） |
| 运行时依赖 | **0** | `dependencies` 不存在 |
| peer 依赖 | 只列 DSH 官方包 + `react` | 官方三包 + `react`，全部 optional（Host 半边不新增 peer） |

超预算要在 issue 里说明，不接受「顺手加的」。**2026-10-18 改过一次预算**：P1-1 跨设备同步把客户端从
500 提到 800、并新增 Host 半边 300；原 498/500 的余额显然装不下一个同步客户端（本地缓存、乐观更新、
补发队列、轮询、迁移、降级），而拆文件会破坏「单 client.js 零构建」的形态。决策与 alternatives
**P1-2 用掉了剩下的余额**：滚轮横滚
（纯函数 + 合成事件接线）花掉 21 行，客户端 793/800。**2026-10-22 选中态强调 + 状态点悬停说明**
用掉最后 2 行（一个 `STATUS_TEXT` 常量 + 一处 `title`），客户端 **795/800**——余额只剩 5 行，
下次再动客户端仍然是同一条规矩：**先决定删等价代码，还是再说明并改预算**。

**2026-10-30 第二次上调：800 → 900。** P2-1「workspace 辨识」加进来时客户端已 795/800，而它要同时改
两处（纯函数区的归属解析与配色、`TabBar` 的取数与渲染），落完 825 行（2026-11-02 撤掉左栏那部分后从
868 降到 825）。**这次先试过拆文件，结论是拆不了**：

- DSH **一个包只能有一个客户端 bundle**——`dsh-client-modules` 硬编码读 `exports["./client"]`
  （`clientExportOf`），`dsh.client` 里没有任何指向第二个入口的字段；
- 同包跨文件**没有可用的同步依赖形态**。`@require` 不是 DSH 的指令（也不是 JS 语法，浏览器直接
  `SyntaxError`），实测会让整个插件 `import failed`；唯一受支持的 `require.async("./client.<name>.js")`
  是**异步**的，`apply()` 同步注册槽位时拿不到组件，只会引入启动竞态；
- 可行但更重的路子是拆成**两个插件包**（各自一个 bundle、patch 里挂两行），属于产品结构变更，本版不做。

所以 900 是「一个包一个文件的物理上限」下的真实数，不是偷懒。复核手段也留了一道：测试里
`assert.equal(/^\s*@require/m.test(SOURCE), false)` 把这次踩过的坑钉成了门禁——**任何形如 `@require`
的写法都会被测试直接拦下**。

**2026-11-09 第三次上调：900 → 1200。** P2-2「窄屏降级为当前会话 + 抽屉」是一整层响应式 UI：横条降级、
底部抽屉、焦点管理、定位自检、聚合状态点，落完 1145 行（P2-3 又把新建入口删掉，回到 1111 行；P2-4 底部横条与安全区再加 11 行，**1122 行**）。这次同样先试过省，结论是省不掉：

- 拆文件依旧不行（上一条的三点没有变，`@require` 门禁还在）；
- 抽成「第二个插件包」属于产品结构变更，为一块窄屏 UI 不值得；
- 真正能删的只有注释，而那些注释正是这张表存在的理由（每一行都是踩过的坑）。

实测复核时又发现一个差 3 行的洞：「当前会话不在集合里」（别的设备把它的标签关了）时，窄屏会只剩
`≡N` 和 `＋`，看起来像坏了——补了只读兜底标题与对应测试。**1200 是这批能力的真实数**，P2-3 删掉新建入口后余额 89 行。

### 4.7 每次 DSH 升级后回填兼容表

见 [`COMPATIBILITY.md`](COMPATIBILITY.md)：一行一个 DSH 版本 + 实测结果 + 日期。
**没测过的版本写「未验证」**，不要用「应该没问题」糊过去。

### 4.8 跨设备同步：协议、冲突规则与降级

**状态模型**（Host 半边 `lib/host.js`）：

```json
{ "v": 1, "seq": 12, "tabs": ["session-a", "session-b"], "updatedAt": 1760000000000 }
```

- `tabs` 是**有序集合**（按首次打开顺序）。它是「哪些会话还没关」的唯一真相。
- `seq` 是宿主单调序号，**只在状态真的变化时 +1**。客户端只用它判断一份答复是不是比本地缓存新；
  **不拿本机时钟做比较**——手机和电脑的时钟不可信。
- 落盘 `$DSH_HOME/dsh-tabs/state.json`：先写临时文件再 `rename`（原子替换），目录 `0700`、文件 `0600`。
  读坏了按空集合处理并告警，不崩。

**接口**（精确 Fetch 路由 `/api/dsh-tabs/state`，只放行 owner 浏览器 Peer）：

| 方法 | 请求 | 应答 |
|---|---|---|
| `GET` | — | `{ ok: true, state }` |
| `POST` | `{ v: 1, ops: [{ op: "open" \| "close", id }] }` | `{ ok: true, changed, state }` |

**客户端规则**：

1. **乐观更新**：本地操作立即改界面、写缓存，再进 `pending` 队列补发。
2. **串行网络**：GET 与 POST 走同一条 promise 链，避免答复互相覆盖；一次 POST 携带整批 `pending`。
3. **采纳规则**：`seq` 更老的答复直接丢弃；有 `pending` 时不做 GET（避免把乐观结果冲掉）。POST 应答
   只有在 `pending` 已清空时才整体采纳（这样其它设备的变化会同一条答复一起到达）。
4. **对准时机**：启动时一次；每 `3s` 轮询一次；窗口 `focus` 时立刻一次。标签变更是低频事件，
   轮询足够「几乎立刻」，比引入长连接/新事件转发简单得多。
5. **降级**：没有 `fetch`、或端点 404/405 → 本设备本地模式（标签仍工作，只告警一次）；网络暂时失败 →
   保留 `pending`，下一次轮询/focus 自动补发。
6. **迁移**：旧版按窗口分键的 `dsh-synced-tabs:tabs:*` 载荷在首次启动时并集成种子，随即删除旧键并写成新的
   共享缓存 `dsh-synced-tabs:state`。

**冲突规则（只有一条）**：op 按**到达宿主的顺序**幂等执行——后到者生效。两台设备同时操作同一条会话时，
后到达的那个动作赢；关闭后又在另一台设备主动打开，会重新出现在集合末尾。这是唯一**不需要共享时钟**
的规则。

**跨实例（WSL / Windows）怎么办**：每个宿主实例默认一份状态。想互通就把 patch 行的 `stateFile` 指向
同一个共享路径；但两个实例同时写同一个文件是「多写者」，本版不承诺一致性（写是原子替换，最坏是丢掉
一次合并，不会写坏文件）。

**为什么不用归档代替「关闭」**：DSH 的 `archiveSession` 是宿主状态、天然跨设备，但它会改变会话语义
（归档会话拒绝继续执行、需要显式恢复），而标签关闭只是「我不再看它」。本插件不做会话管理器的事
（§三 非目标）。

**一个已知的边界（不是同步 bug）**：关掉**最后一个**标签时，主视图仍停在那条会话上（P0-4 的降级，
`clearMain` 不是公开接缝）；此时刷新页面，客户端按 P0-2 的不变量「主区会话一定在标签集合里」把它重新
加回集合并同步给其它设备。**要彻底收起一条会话，先切到别的会话再关它的标签。** 这条不变量是 P0 的
既定行为，跨设备只是把它暴露得更明显；如果将来 DSH 开放 `clearMain`，这条边界可以消掉。

---

## 五、接入与回滚

### 5.1 部署事实（2026-10-09 在本机核实，均为实测）

- **装插件不需要 Creator 模式。** `plugin_manager` 是 **agent 侧工具**，只在 Creator 预设启用
  （所以"让 agent 替你装"才需要它）；而 Web 侧栏的 **Plugins** 页（添加插件 → 包名 / git 地址 /
  tarball / 本地绝对路径 → 安装 → 立即启用）和 CLI `dsh plugin --profile web add <spec>`
  （本质是 pnpm 的包装）都与 preset 无关。
- **`plugin_manager` 的 `install_bundle` 走的是 `dsh.profile.bundles`，不是 profile patch 的
  `insert` 行。** 它把包加进 profile `package.json` 的 `dependencies`（`link:<绝对路径>`）与
  `dsh.profile.bundles`，并 `pnpm add` 出 `node_modules/<包名>` 软链。本插件**没有**往
  `~/.dsh/profiles/web/cordis.patch.yml` 写任何东西。
- **这条路线实测不需要重启 dsh 进程。** 装完后 boot graph 立刻重组（新页面请求里出现
  `dsh-synced-tabs` 行、`/plugins/??dsh-tabs/client.js&rev=…` 能取到 200），浏览器侧只要**刷新页面**。
  卸载（`set_bundle enabled=false`）同样只靠刷新。
- **本机曾有一个环境缺口**：`pnpm` 装在 `~/.local/share/pnpm`，不在 dsh 进程的 PATH 上
  （dsh 的 PATH 是 nvm bin + `/usr/local/bin` + `/usr/bin` + `/bin`），所以第一次 `install_bundle`
  以 `spawn pnpm ENOENT` 失败。修法是在 nvm bin 里放一个转发 shim
  （`~/.nvm/versions/node/<ver>/bin/pnpm` → `exec ~/.local/share/pnpm/pnpm "$@"`），删掉即回滚。
  任何依赖 `install_bundle` 的插件都吃这个缺口。
- **Host 半边在 DSH 启动时加载，客户端半边刷新页面即热更新。** 2026-10-18 之前本插件是纯客户端；
  加上 Host 半边之后，**第一次装/升级需要重启一次 DSH 进程**（重启 DSH 进程），
  之后改 `client.js` 仍只要刷新页面。已确认的开发期捷径：HMR 的 profile 重组会替换「linked package
  的文件已变化」的行，所以改完文件碰一下 profile patch 也能热加载 host 半边——但**部署纪律按重启写**，
  别把热加载当承诺。
- **同步端点的自检**：重启/加载后用带 cookie 的页面请求打 `GET /api/dsh-tabs/state`（浏览器控制台
  `await (await fetch('/api/dsh-tabs/state')).json()`）。返回 `{ok:true,state:{…}}` 才说明 Host 半边
  到位；404/405 说明只有客户端半边在跑（此时插件会自动降级为本设备本地模式）。

### 5.2 接入步骤

1. 让 agent 装：`plugin_manager` → `install_bundle`，target = 本仓库绝对路径
   （或 Web 侧栏 Plugins 页填本地绝对路径）
2. **刷新页面**（Ctrl+F5）；若是第一次带 Host 半边，再重启一次 DSH 进程
3. 验证：应用顶部出现一条横条，左栏/主区/右栏的 `top` 都等于横条高度（`COMPATIBILITY.md` 记了读数）
4. 验证跨设备：两个浏览器/设备打开同一宿主，一边打开或关闭标签，另一边（最多 3s 或切回窗口时）
   跟着变化；状态文件 `~/.dsh/dsh-tabs/state.json` 的 `tabs` 与界面一致

### 5.3 回滚

停用 bundle 再刷新即可，两种等价写法：

- `plugin_manager` → `set_bundle`，target = `dsh-synced-tabs`，enabled = false
- 或从 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里删掉 `dsh-synced-tabs` 一行

依赖（`dependencies` 里的 `link:` 与 `node_modules` 软链）可以留着——没有被选中它就不会被挂载。

**回滚不删状态文件**：`~/.dsh/dsh-tabs/state.json` 留着，重新启用时标签集合原样回来。想彻底清空就
删掉它（下次启动按空集合处理）；只想让某一台设备不再同步，把它的 `localStorage` 里
`dsh-synced-tabs:state` 删掉即可——它下次仍会从宿主重建。**只停用 Host 半边（例如把 `lib/host.js` 改坏）**
不会卡住界面：客户端拿不到端点就降级为本设备本地模式（告警一次）。

> **实测结论**（2026-10-09，`0.2.0-rc.2`）：停用 + 刷新后横条消失，框架节点上的
> `data-dsh-tabs`、`--dsh-tabs-h`、注入的 `<style>` 全部回收，`padding-top` 回到 `0px`——
> 即 §4.2 的「卸载零残留」，页面其余部分照常。

---

## 六、参考项目

三个都读过源码并按「轻量 / 可维护 / 长期稳定」量过，本插件的取舍直接来自它们：

| 项目 | 链接 | 我们**取**什么 | 我们**避**什么 |
|---|---|---|---|
| `dsh-session-tabbar` | [npm](https://www.npmjs.com/package/dsh-session-tabbar) | 契约写进 `.d.ts`；离线行为测试 + `prepublishOnly` 门禁；状态点用 `useSessionStatus`；卸载还原被改过的内联样式 | `[class*="centerCol"]` 前缀匹配 CSS Module 类名；把内联 `padding-top` 写进别人的布局节点 |
| `dsh-session-tabs` | [GitHub](https://github.com/thezavtrak-a11y/dsh-session-tabs) | **布局避让的两段式**（官方 data 属性 → 自己的属性 + CSS 变量）；标签先落本地存储、刷新可恢复；卸载自清理；`style[data-plugin-css=…]` 这种第一方写法 | 单 commit、无 peer 契约、无 npm 发布 —— 交付工程化不足；它把状态留在每个窗口的存储里，跨设备天然不同步 |
| `dsh-qol` | [npm](https://www.npmjs.com/package/dsh-qol) · [GitHub](https://github.com/john-walks-slow/dsh-qol) | 功能清单参考（Pin、活跃优先排序、右键菜单、滚轮横滚、新会话不占标签）；每项功能可独立开关的思路 | 18 合 1 的耦合方式；30 个 DOM 结构锚点；为了非标签栏功能把包做到 828KB |

上游与宿主契约的事实来源：

- DSH 本体：[github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- 我们用到的宿主包（在 `@deepseek-ai/dsh` 的依赖树里）：`dsh-client-ui-layout`（`shell.overlay` 槽位与框架节点）、`dsh-client-ui-session`（`useSessions` / `useSessionStatus`）、`dsh-client-ui-workspace`（`uiWorkspace.openSession` / `startSession`）

---

## 七、实现笔记（给下一个改动的人）

### 7.1 服务的可用性是**异步**的

`apply(ctx)` 跑的那一刻，别的客户端插件往往还没 `provide` 自己的服务，这时 `ctx.get(name)`
会老实返回 `undefined`（`strict` 默认只看 active 的提供者）——第一版就是在这里栽的：
探针把 `sessions` / `uiWorkspace` / `uiSession` 全判成缺失，插件在真实页面里直接降级成 no-op，
而离线测试全绿（替身环境里服务是齐的）。三类接缝三种接法：

| 接缝 | 接法 |
|---|---|
| `slots` | 写进插件自己的 `inject` —— 硬依赖，`apply` 只在它到位后才跑 |
| `uiWorkspace` | `ctx.inject(['uiWorkspace'], cb)` —— 软依赖，等它出现；出现/消失各自重跑回调 |
| `useSessions` / `useSessionStatus` | **不从 ctx 读** —— 由槽位的 standardProps 送进组件 |

### 7.2 会话与状态的真相只有一处

- **当前是哪个会话**：`byId[*].retainedBy.mainView > 0`，与 DSH 自己的 `isMain()` 同口径。
  插件不存「当前标签」，所以横条高亮、左栏高亮、主区会话三者**不可能**分叉。
- **「完成未读」何时清**：宿主算的。`completionUnread` 在会话成为 `mainView` 时被删掉——
  也就是说，点标签走 `openSession` 清未读，与点左栏走的是**同一条**路径，不需要本插件做任何事。
- **同一时刻只有一条会话是 main**：所以 `activeSession()` 找到第一条就够了。

### 7.3 `blank`：新会话为什么不会堆标签

`SessionSummary.blank` 标出「还没被用过的新会话」，DSH 的 `＋` 会**复用它**而不是再建一个。
所以「打开过就占标签」并不会让横条越堆越长——连点 `＋` 十次也只有一条会话、一个标签
（现场实测确认）。反过来说，「首条消息后才占标签」这种规则在本插件的允许接缝里也做得到
（`blank` 就在 `useSessions` 里），P0 没采用是因为它会让 `＋` 在点下去的那一刻什么都不发生。

### 7.4 为什么同步是「轮询 + 精确 Fetch 路由」，不是 Remote / 事件

三条路都核对过，只有一条同时满足本插件的硬约束（零依赖、零构建、只挂官方接缝）：

| 方案 | 为什么不选 |
|---|---|
| **Remote 方法**（`ctx.remote.$mount` + `/api/remote.mux`） | 需要 Typert **生成物**（编译期产物），本包没有构建步骤；客户端能力集合还是**构建期**固定的（`dsh-api-remotes` 只挂载显式 import 的贡献），第三方客户端插件没法在运行时挂一个新 namespace |
| **转发 Host 事件**（`ctx.remote.$on`） | `$on` 的合法键由 `api-remotes` 的 allowlist 固定，插件加不了自己的事件；且普通通知**不重放**，还得自己配查询基线 |
| **精确 Fetch 路由 + 轮询**（本插件） | 接缝是官方的、鉴权由 Connection 做完、零构建零依赖；代价是「最多 3s 延迟」——对「关闭标签」这种低频事件完全够用 |

轮询节奏：启动一次、每 `3s`、窗口 `focus` 时立刻。没有做长连接/SSE：多一套重连与背压逻辑，
换来的只是把 3s 降到毫秒级，不划算。

### 7.5 同步客户端的三个容易写错的地方

1. **`seq` 是宿主的，不是你本机的**。不要用 `Date.now()` 比较两台设备的操作先后——时钟会漂。
   客户端只做「更老的答复不覆盖更新的本地状态」。
2. **`pending` 队列不能在失败时清空**。网络失败一次就丢掉用户的关闭动作，表现是「关掉的标签
   过一会儿自己回来了」。失败只保留队列，下一次轮询/focus 重发；POST 应答只在 `pending` 清空后
   才整体采纳，否则会把还在队列里的本地操作冲掉。
3. **`refresh` 在 `pending` 非空时必须让路**。先 GET 后补发，GET 的老状态会把乐观结果冲掉，
   界面闪一下再回来——用户会以为标签自己长回去了。

### 7.6 滚轮横滚：只挪 `scrollLeft`，不拦默认行为

`wheelTarget()` 只认**竖向占主导**的滚轮：`deltaMode` 折算单位（0=像素、1=行×16、2=页×视口宽），
结果夹在 `[0, scrollWidth - clientWidth]`，然后由 `onWheel` 直接写 `list.scrollLeft`。三件事**刻意不做**：

- **不拦默认行为**。DSH 的外框是 `overflow:hidden`，竖向滚轮在横条上没有可滚的祖先，默认动作本来就是
  空（实测滚轮前后 `window.scrollY` 恒为 0）。所以走 React 的合成事件就够；**将来若要拦**（例如宿主
  改成页面可纵向滚动），必须换原生监听 + `passive:false`——React 合成事件的 wheel 监听是否被动
  取决于 React 版本，不能指望 `preventDefault()` 生效，否则表现是「标签滚了、页面也滚了」。
- **不接管横向手势与修饰键**。触控板横向平移、Shift+滚轮本来就以 `deltaX` 为主，浏览器会自己滚；
  再叠一次就是双倍速——**这条是实测抓到的**：没加 `shiftKey` 判断前，Shift+滚轮 240 会让横条走 480。
  同理 Ctrl+滚轮是缩放，也不该顺手横滚。
- **不改成可见滚动条**。`scrollbar-width:none` 是既有外观取舍（保持 38px 横条高度），本版不改；
  可发现性靠滚轮本身，加上键盘 `←/→` 时 `focus()` 自带的进入视口行为。

**已知边界**：如果宿主将来允许页面纵向滚动，上面的「不拦」会退化成「横条横滚 + 页面竖滚」同时发生；
按第一条改成原生监听即可，并在 `COMPATIBILITY.md` 补一条实测。

### 7.7 选中标签的强调与状态点语义（2026-10-22）

**为什么改**：用户反馈「当前选中 tab 的强调不够明显」。现场实测（light 主题）确认这不是错觉——
选中标签原样式是 `background:var(--dsw-alias-bg-layer-1)`，而这个令牌在浅色下等于 `#fff`，
横条本身是 `--dsw-specific-sidebar-fill`（`#f9fafb`），**两者只差 6/255**；唯一可见的区别是
0.5px 的 `inset` 描边（`rgba(0,0,0,.1)`）和文字色 `label-primary` vs `label-secondary`。

**改法（只动 CSS 一行，不新增交互）**：

```
.dshtabs-tab[aria-selected="true"]{
  color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-interactive-bg-active);
  box-shadow:inset 0 0 0 0.5px var(--dsw-alias-border-l2),inset 0 -2px 0 0 var(--dsw-alias-state-business-primary);
}
```

两条线索叠加，且都不是硬编码色值（P0-8 的「只用主题令牌」测试仍然绿）：

1. **填充**用 `--dsw-alias-interactive-bg-active`。它不是为标签栏发明的：DSH 自己在目录选择器
   （`rowSelected`）与 trajectory 表格（`tr[data-selected=true]`）里就用它表示「选中行」。
2. **底部 2px 强调条**用 `--dsw-alias-state-business-primary`（DSH 的交互蓝，重命名输入框、拖拽落点
   都用它）。`inset` 不改变盒子尺寸，所以横条高度仍是 37px、框架 `padding-top` 仍等于 37px。

实测（真实实例 8897，headless Chrome 143，2026-10-22）：

| 读数 | 改前（浅色） | 改后（浅色） | 改后（深色） |
|---|---|---|---|
| 横条底色 | `#f9fafb` | 同 | `#1b1b1c` |
| 选中标签背景 | `#fff` | `rgba(38,49,72,.1)` 复合后约 `#e4e6e9` | `rgba(255,255,255,.14)` 复合后约 `#3b3b3d` |
| 选中标签 box-shadow | `inset 0 0 0 .5px rgba(0,0,0,.1)` | 原描边 + `inset 0 -2px 0 0 #4176e6` | 原描边 + `inset 0 -2px 0 0 #7aaaff` |
| 未选中标签 | 透明 + `label-secondary` | 不变 | 不变 |
| 横条高 / 框架 padding-top | 37 / 37px | 37 / 37px | 37 / 37px |

强调条对横条底色的对比度：浅色 `#4176e6` vs `#f9fafb` ≈ **4.05:1**，深色 `#7aaaff` vs `#1b1b1c` ≈ **7.39:1**，
都高于 WCAG 非文本对比度 3:1；选中标签文字仍是 `label-primary`，浅色约 **15.1:1**、深色约 **10.7:1**。
填充本身（浅色 1.20:1 / 深色 1.54:1，改前分别是 1.05 / 1.10）刻意不追求高对比——它只用来把标签
「连到」内容区，辨认靠蓝色强调条。对比度由独立复核员按 WCAG 公式（node 与 python 双实现）复算，
与本节读数一致。

**状态点语义（这就是标签上那些圆点的全部含义）**。点的类型只看 §7.2 的三个宿主事实，
优先级 `等待交互 > 运行中 > 完成未读 > 空闲`；**拿不到某条会话的状态时根本不画点**（不猜）：

| `data-kind` | 何时出现（`statusKind`） | 颜色令牌 | 浅色 | 深色 | 动效 | 悬停说明 |
|---|---|---|---|---|---|---|
| `pending` | `status.pendingInteraction` 有值（审批 / plan review / 提问） | `--dsw-alias-state-warn-primary` | `#f59e0b` | `#f59e0b` | 无 | 等待你的回答 |
| `running` | `status.running === true` 且无等待交互 | `--dsw-alias-state-business-primary` | `#4176e6` | `#7aaaff` | 1.4s 透明度脉冲（`prefers-reduced-motion` 下关闭） | 运行中 |
| `unread` | `status.completionUnread === true`（离开主视图期间完成） | `--dsw-alias-state-success-primary` | `#22c55e` | `#22c55e` | 无 | 已完成未读 |
| `idle` | 拿到状态但以上都不成立 | `--dsw-alias-state-idle-primary` | `#d4d4d4` | `#545557` | 无 | 空闲 |
| （无点） | `statuses` 里没有这条会话 / `useSessionStatus` 整个缺失 | — | — | — | — | — |

**红点不在这张表里**：本插件从 P0 起就只映射 `running / pending / unread / idle` 四种 kind，三个 commit
的历史里都没有 `error` 分支，也从不使用 `--dsw-alias-state-error-primary`。红色是 DSH 自己 UI 的状态色，
当前版本里它出现在**工具行的退出码徽标**（`ExitCodeBadge`，仅 `terminalFailed` 时渲染）、**失败的对话轮次**
（`TurnErrorItem`）、**后台 Jobs 的 failed 行**、以及插件管理/市场/设置页的错误提示——**都不会出现在标签栏**。
左栏会话行的 `StateDot` 只有 `warning / ongoing / done / idle` 四态，也不会变红。
`running` 的令牌回退是 `--dsw-alias-brand-primary`——只有旧版宿主没有 `state-business-primary` 时才会
退化成黑/白点，也不会变红。

**「没有点」也算一种回答**：最常见的是跨设备共享集合里有一条本机会话清单里没有的会话（同一条还会命中
`data-missing` 的灰字文字色）——此时状态无从得知，插件不猜；`useSessionStatus` 整个缺失时同理。

**为什么点必须带 `title`**：7px 的圆点没有任何文字，用户只能靠颜色猜。`STATUS_TEXT` 把四个 kind 全部
映射成一句中文，挂在点元素上（`aria-hidden` 的点不进可访问性树，悬停说明是唯一的自解释入口）；
代价是 1 个常量 + 1 处属性，客户端因此到 795/800 行。

### 7.8 workspace 辨识：色条、徽章与「左栏只在 idle 行出现」（2026-10-30）

**要解决的问题**：标签开多了分不清哪条属于哪个 workspace。本机常态是 6 个 workspace
（`alpha` / `beta` / `gamma` / `delta` / …）的会话混在一条横条里。

**归属从哪来（唯一真相）**：`useWorkspaces()` 返回的 `WorkspaceSnapshot.items` 里，每个
`WorkspaceView` 带 `sessionIds`——这就是「这条会话属于哪个 workspace」。**不要用 `cwd` 猜，也不要按
目录 basename 反推**：`SessionSummary` 上根本没有 `workspaceId` 字段（`0.2.1-rc.2` 核过）。反查表由
`trackWorkspaces()` 一次算好：`owner`（先到先得，所以「Ungrouped」兜底不会抢走已归属的会话）与
`rank`（workspace 在列表里的位置，用来配颜色）。

**跨设备兜底**：手机端或另一台设备上，如果那条会话所属的 workspace 已被删、或 workspace 列表还没到，
`useWorkspaces()` 就查不到它。此时用宿主侧 `workspaceByTab`（`TabsState` 的可选字段，随共享集合一起
同步）补位。优先级写死为 **列表反查 > 宿主兜底**；两处都没有就不画（「不属于任何 workspace」是正常
状态，不告警）。协议**只增不改**：`workspaceByTab` / `TabsOp.workspaceId` 都可选，`v` 仍是 1，旧
`state.json`（例如本机那份 10 条 tabs、没有这个字段的文件）原样读、`seq` 不重置。

**颜色规则——固定令牌序列，不是哈希**：`wsTint(count, index)` 从
`['neutral-500','amber-500','blue-950','green-500','neutral-250','deepseek-450','neutral-700']`
按**列表位置**取色。为什么不是按 id 哈希：6 个 workspace 用哈希**必然撞色**（生日问题），而按位置取色
只要不超过 7 个就两两不同。为什么不进红色系：红在 DSH 里是错误语义（§7.7 那张表）。为什么用
`--dsw-static-*` 而不是 `hsl()` 硬算：它们是官方主题令牌，浅/深主题都在、不随主题翻转（`static` 色阶
两套主题同值），同时满足 P0-8「颜色只走主题令牌」。

> **踩过的坑**：最初写的是 `--dsw-static-deepseek-950`，**这个令牌不存在**（deepseek 只到 `900`，
> `#172554` 其实是 `--dsw-static-blue-950`）。后果是 CSS 变量解析失败 → 那条色条**静默变透明**，
> 不报任何错。现在 7 个令牌都经真实浏览器核对过（见 `COMPATIBILITY.md`）。

**标签上怎么画**：每个标签仍是**恰好 3 个 `span`**（状态点/色条、标题、×）——徽章是第 4 个 `span`，
只在有归属时存在。色条画在**状态点同一个矩形**里（`box-shadow: inset 2px 0 0`），没有状态点时才换成
一个透明的 `dshtabs-wsbar` 占位：这样「有状态点」和「没状态点」两种标签的左沿落在同一条竖线上，不会
因为多一个元素把标签撑宽、也不会让色条在有点的标签上消失。分组靠 `data-ws-join` + `margin-left:-6px`：
相邻且同 workspace 的标签首尾相接，换组就断开。

> **`data-ws-join` 必须写 `="true"`**：实测 React 18.3.1 对 `data-x={false}` **不删属性**，而是落成
> `data-x="false"`。所以 CSS 只能写 `[data-ws-join="true"]`；写成 `[data-ws-join]` 会匹配到**所有**标签。

**色条与状态点是两个信号，必须各占一格**。第一版为了不给标签加元素，把 2px 色条用
`box-shadow: inset 2px 0 0` 塞进 7px 的状态点里，结果圆点只剩 5px 可见、方头竖线和圆边重叠，看起来像
「蓝底灰」「蓝底绿」的重影——**用户直接反馈「眼花缭乱」**。现在色条是标签左内侧的独立竖边（2px，
`align-self: stretch`），状态点恢复纯色圆形，两者位置不同、语义不同：色条答「属于哪个 workspace」，
圆点答「会话什么状态」。代价是标签宽约 4px，接受。

**不做左栏**（2026-11-02 移除）。曾经在 `sidebar.session.row.leading` / `.hover` 两个槽位上画过同色左沿
和「工作区：<名字>」悬停卡，撤掉的理由有两条：① 左栏本来就用 workspace 分组标题排好了，色条**零信息
量**，却和标签色条同色，用户会以为两处有某种跳转关系（事实上没有），反而更乱；② 该槽位只在会话行主
状态是 `idle` 时挂载（官方 `SessionNodeItem` 里 `showStatus = primaryStatus.state !== 'idle'` 时直接渲染
状态点、不调 `renderSlot()`），本来就覆盖不全。本插件的名字就是 tabs，不该去动左栏。

**辨识度的诚实结论**：7 个令牌在两套主题下**并非都够 WCAG 非文本 3:1**（浅色下 `neutral-250` 只有
1.31:1、深色下 `blue-950` 1.17:1）。这是「6 色两两不同 + 不撞红 + 只走令牌」三条约束下的取舍，不是
疏漏；要彻底解决得引入自定义色板，那就破了 P0-8。

**接缝**：新用到的宿主面只有 `useWorkspaces`（全局 standardProps，selector 形态），已写进
`lib/client.d.ts`。功能全在同一个 `client.js` 里——DSH 一个包只能有一个客户端 bundle，同包跨文件没有
可用的同步依赖形态，理由见 §4.6。

---

### 7.9 窄屏与抽屉（P2-2，2026-11-09）

**为什么是换切换面，而不是把悬浮提示搬到手机上。** `title` 是「确认」通道（悬停 → 等一拍 → 看一个），
不是「辨认」通道。触屏没有 hover，浏览器也不会把 `title` 变成气泡。而实测的几何是：每个标签上限 200px，
其中 **99px 不用于显示标题**（色条 2 + 状态点 7 + 工作区徽章 ~31 + 关闭按钮 18 + 内边距与间隙 41），
390px 屏上横条内宽 344px → **一屏只看得见 1.7 个标签**。所以在手机上，「同时看见所有标签」和
「每个标签看得清」在横条里是几何冲突，没有折中解——只能换一个切换面。

**几个不能随手改的地方：**

1. **断点只有一个来源**（`NARROW_PX = 767`，= 宿主侧边栏抽屉的 `< 768` 分界点）。CSS 的 `@media` 与 JS 的
   `matchMedia` 都用它拼，两处各写一个数字会得到「横条降级了、抽屉不开」这种半个功能。测试里钉了这条。
   **改这个数之前先看宿主**：它同时决定横条贴顶还是贴底（贴底是为了让开宿主左上角的浮动按钮）。
2. **窄屏覆盖规则必须排在样式表最后**。媒体查询与普通规则同优先级，靠源码顺序决胜；
   把 `.dshtabs-menu{display:none}` 写在后面，窄屏就永远看不到入口。
3. **桌面端靠 `display:none` 而不是「不渲染」**。菜单按钮一直在 DOM 里，宽屏由 CSS 隐藏——
   这样只有一个渲染分支，不需要 JS 判断断点，也不会有首帧闪变。代价是宽屏下这个按钮对屏幕阅读器不可见
   （`display:none` 会移出可访问性树），这正是想要的。
4. **关闭按钮在窄屏让位**。`×` 常驻布局、只是 `opacity:0`（18px 的隐形成本）；手机上一格只有约 260px，
   而且 28px 高的标签远低于 44px 推荐触区，误触会被体验成「分不清」。所以窄屏关标签只在抽屉行里做。
5. **聚合状态点的优先级与单标签不同**。单标签回答「这条会话在干什么」，`running` 排在 `unread` 前；
   聚合回答「哪一条在等我」，所以 `unread` 排在 `running` 前（运行中的事还在自己跑，未读完成的才需要你去看）。
6. **只写 `position:fixed`，不写「退化成 absolute」的伪退路**。曾经写过：打开时量遮罩是否盖满视口，
   盖不住就切 `absolute`。复核时发现那条路本身是坏的——面板挂在 `position:absolute` 的**横条**下面，
   `absolute` 的包含块会变成那条几十像素高的横条，面板只会被压成一条；而且「宽度 ≥ `innerWidth`」这个判据
   在有经典滚动条的桌面窗口按定义差约 15px，会把正常情况误判进去，一旦误判本次会话就再也回不来。
   `fixed` 在真实宿主里实测覆盖整个视口（遮罩矩形 `0,0,390,844`）；真出现带 `transform` 的祖先，
   正确解法是把面板挂到 body——没有 portal 做不到，那时应该整块回滚，而不是留一条看起来在兜底、实际更坏的路。
7. **抽屉只在打开时进 DOM**。不打开就没有遮罩、没有焦点陷阱、没有多余节点；关掉即回收（§4.2 的零残留同样适用）。
8. **没有动画**。滑入/淡入会引入 `prefers-reduced-motion` 的分支和「关不干净」的中间态；
   一个即时出现的面板在手机上并不难看，也顺手绕过了 WCAG 2.2.2 的「可暂停」要求。
9. **实测抓到的那个洞**：当前主区会话不在标签集合里时（别的设备把它的标签关了），
   `aria-selected` 一个都不匹配 → 窄屏把所有标签都隐藏了 → 横条只剩 `≡N`（那时还有 `＋`，后来按 P2-3 也移除了）。
   现在补一个只读的 `.dshtabs-stray` 标题（不进 tablist、无 `×`），并把空列表 `display:none` 让出整条宽度。
   这条只有真机/真实例跑得出来，离线测试造不出这个时序——所以 COMPATIBILITY 的实测不能省。

**这一层怎么验。** 离线测试只能证明结构与状态（断点、计数、聚合优先级、抽屉开合、焦点归还），
证明不了 CSS 与定位——所以 COMPATIBILITY 里记的是真实实例 + 无头 Chrome 的读数（横条高度、`--dsh-tabs-h`、
非当前标签的 `display`、抽屉与遮罩的 `getBoundingClientRect`、`data-cover`）。两者不能互相替代。

### 7.10 改名 = 三处身份一起改，漏一处就是 web 启动失败（2026-11-10）

改名时容易只改「看得见的」包名与文档，漏掉**客户端注册 id**。dsh-client-modules 的 boot graph 行键是
包名（`reconcilePackage(packageName)`），加载器只认 `registration.id === row.id`；而 `client.js` 里
`window.__ModuleLoader__.load({id: …})` 的 id 是独立写的字符串。两者不一致时，浏览器侧只有一句
`loaded without registering "<包名>" via __ModuleLoader__.load`，整份 web bootstrap bundle 不激活
（界面是「Failed to load plugins」），而宿主半边照常在跑——看起来像前端坏了，实际是身份对不上。

三处一起改：`package.json` 的 `name`、`cordis.patch.yml` 的 `id`/`name`、`client.js` 的注册 `id`。
离线测试现在把注册 id 与 `package.json` 的 `name` 直接比对（`test/harness.mjs`），改漏会先红在 `npm test`。
`CELL_ID` / `data-dsh-tabs` / `--dsh-tabs-h` / `/api/dsh-tabs/state` / `state.json` 是槽位与数据契约，
不是模块身份，改名时**保留**（否则已部署实例的共享集合会丢）。

## 八、待定

- **许可证**：MIT
- **是否发布到 npm**：会发布，见 README 的安装一节
- **跨实例同步（WSL ↔ Windows）**：本版只做「一个宿主实例内、多设备共享」。真要做跨实例，
  下一步应该是把 `stateFile` 指向共享存储并定义一个多写者协议（目前是原子替换 + 丢一次合并），
  而不是把两份 `~/.dsh` 互相拷贝
- **与 DSH 桌面端的关系**：Electron 的窗口标题栏模式（Windows caption row）要不要支持，等 Web 版稳定后再定。
  有一条现在就能记下的技术事实：`data-windows-titlebar` 属性**不由 web 侧任何代码写入**
  （它只是被各处 CSS/JS 读），所以浏览器 Web UI 永远不会带这个属性；而桌面端已经有
  `[data-windows-titlebar] .frame{padding-top:…}` 这条特异性 (0,2,0) 的规则，
  会盖过本插件 `[data-dsh-tabs]` 的 (0,1,0) 占位规则——真要支持桌面端，占位规则得先解决这个特异性冲突。

---
