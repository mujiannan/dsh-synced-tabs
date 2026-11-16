# 架构与宿主契约

> 面向两类人：要改这个插件的人，和排查「它为什么没生效」的人。
> 安装与用法见 [README](../README.md)，逐 DSH 版本的实测结论见 [COMPATIBILITY.md](../COMPATIBILITY.md)，测试与发版见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 1. 两个半边

| 半边 | 文件 | 职责 |
|---|---|---|
| 客户端 | `client.js` | 渲染标签栏与抽屉；维护共享集合的本地副本；乐观更新、补发队列、轮询 |
| 宿主 | `index.js`、`lib/host.js` | 集合的唯一真相；状态文件；精确 Fetch 路由 `/api/dsh-tabs/state` |

数据流：用户操作 → 立即改界面与本机缓存 → 进 `pending` 队列 → `POST /api/dsh-tabs/state` →
宿主原子写 `$DSH_HOME/dsh-tabs/state.json`；其它设备在启动、每 3 秒、以及窗口 `focus` 时 `GET` 同一路由。

集合必须跨设备一致，所以真相放在宿主。纯客户端只能把标签存在 `localStorage` 里，天然按设备隔离：
电脑上关掉的会话，手机上仍然显示为开着。

客户端是单文件、无构建、无运行时依赖；宿主半边只依赖 DSH 的 Connection 服务。

## 2. 只挂官方接缝

允许的宿主接触面如下（`lib/client.d.ts` 是它的类型化版本）：

| 类别 | 使用 |
|---|---|
| 槽位 | `shell.overlay` |
| 数据 | `useSessions`、`useSessionStatus`、`useWorkspaces`（由槽位的 standardProps 送入组件） |
| 导航 | `uiWorkspace.openSession` |
| 主题 | `--dsw-*` 主题令牌 |
| 同步（客户端） | 本插件自己的精确路由、`window.fetch`、`focus` 事件、单个 `localStorage` 缓存键 |
| 同步（宿主） | `ctx.connection.fetch.register()`、自己的状态文件 |

不做的三件事：

- **不匹配 CSS Module 类名**（`[class*="centerCol"]` 之类）：hash 每次构建都变，类名也可能被上游改名，
  坏了还不报错。
- **不碰 private API**：`clearMain` 在宿主的 `UiWorkspaceService` 上是 private，运行时调得到也不碰，
  代价见 §6。
- **不往别人的 DOM 节点里塞东西**：只在自己的浮层里渲染。

布局避让用两段式：自己的节点 `.closest('[data-shell-overlay]')` 拿到框架节点 → 打上自己的
`data-dsh-tabs` 与 `--dsh-tabs-h` → 占位规则只用自己的选择器。`box-sizing:border-box` 必须写：
框架节点是 `grid` + `height:100%` + `overflow:hidden`，content-box 下加 padding 会把底部悄悄裁掉。
`--dsh-tabs-h` 由 `ResizeObserver` 量自己的真实高度写入，不写死数字。

失败必须可见：拿不到宿主服务就降级为 no-op 并 `console.warn`；端点 404/405 退回本设备本地模式，
**同一原因只告警一次**；恢复后按队列补发。

卸载必须零残留：`ctx.effect` 的 disposer 还原动过的一切——data 属性、CSS 变量、注入的 `<style>`、
事件监听。验收方式是装上再卸下，目标节点的属性集合与安装前一致。

## 3. 同步协议

**状态模型**（`lib/host.js`，落盘 `$DSH_HOME/dsh-tabs/state.json`）：

```json
{ "v": 1, "seq": 12, "tabs": ["session-a", "session-b"], "workspaceByTab": {}, "updatedAt": 1760000000000 }
```

- `tabs` 是**有序集合**（按首次打开顺序），是「哪些会话还没关」的唯一真相。
- `seq` 是宿主单调序号，只在状态真的变化时 +1；客户端只拿它判断一份答复是否比本地缓存新。
  **不用本机时钟比较先后**——手机和电脑的时钟都不可信。
- `workspaceByTab` 可选，跨设备兜底的归属信息，见 §4；老文件没有它是空表，协议版本仍是 1。
- 写入先写临时文件再 `rename`（原子替换）；目录 `0700`、文件 `0600`；读坏按空集合处理并告警。

**接口**（精确 Fetch 路由，鉴权由 Connection 的浏览器 cookie 完成，只放行 owner Peer）：

| 方法 | 请求 | 应答 |
|---|---|---|
| `GET` | — | `{ ok, state }` |
| `POST` | `{ v: 1, ops: [{ op: "open" \| "close", id, workspaceId? }] }` | `{ ok, changed, state }` |

**客户端规则**

1. **乐观更新**：先改界面与缓存，再进 `pending` 队列补发。
2. **串行**：GET 与 POST 走同一条 promise 链；一次 POST 携带整批 pending。
3. **采纳**：`seq` 更老的答复直接丢弃；pending 非空时不做 GET；POST 应答只在 pending 清空后整体采纳。
4. **时机**：启动一次、每 3 秒、窗口 `focus` 时立刻一次。
5. **降级**：没有 `fetch` 或端点 404/405 → 本设备本地模式（告警一次）；网络暂时失败 → 保留队列，
   下一次轮询/focus 补发。
6. **迁移**：旧版按窗口分键的载荷在首次启动时合并为种子，写成新的共享缓存键。

**冲突规则**：op 按到达宿主的顺序幂等执行，后到者生效。两台设备同时操作同一条会话时，后到达的动作赢；
关闭后又在另一台设备主动打开，会重新出现在集合末尾。这是唯一不需要共享时钟的规则。

**跨实例**：每个宿主实例默认一份状态。把 patch 行的 `stateFile` 指向共享路径可以互通，但两个实例同时写
同一个文件是「多写者」，一致性不在承诺内（写是原子替换，最坏丢一次合并，不会写坏文件）。

## 4. 标签语义

- 一个标签 = 本窗口打开过的一条会话，按首次打开顺序排列。
- **当前是哪个会话不存插件状态**：读宿主 `byId[*].retainedBy.mainView > 0`，与宿主的 `isMain()` 同口径。
  所以横条高亮、左栏高亮、主区会话三者不可能分叉。
- **新会话不堆标签**：宿主的 `＋` 会复用 `blank` 会话，连点也只有一条会话、一个标签。
- **关标签只关视图**：不删除、不归档、不停止会话。

**状态点**：四态 + 无点，优先级 `pending > running > unread > idle`；拿不到某条会话的状态时**不画点**，不猜。

| `data-kind` | 含义 | 令牌 |
|---|---|---|
| `pending` | 等待你的回答（审批 / plan / 提问） | `--dsw-alias-state-warn-primary` |
| `running` | 运行中（1.4s 脉冲，`prefers-reduced-motion` 下关闭） | `--dsw-alias-state-business-primary` |
| `unread` | 离开主视图期间完成 | `--dsw-alias-state-success-primary` |
| `idle` | 已拿到状态但以上都不成立 | `--dsw-alias-state-idle-primary` |

每个点都带 `title`（悬停说明）。7px 的圆点没有文字，颜色不是唯一的语义入口。

**workspace 归属**：权威来源是 `useWorkspaces()` 里 `WorkspaceView.sessionIds`；宿主侧 `workspaceByTab`
只在列表查不到时兜底。不要用 `cwd` 或目录名反推。颜色按 workspace 在列表中的位置取固定令牌序列，
不按 id 哈希（几个 workspace 就会撞色）。色条回答「属于哪个 workspace」，状态点回答「会话什么状态」，
两个信号各占一格。

**窄屏**（`max-width: 767px`，与宿主侧边栏抽屉的分界点对齐）：横条只显示当前会话并贴底，全部标签进
底部抽屉；`≡ N` 在横条左侧，抽屉不盖住横条；桌面端零变化。断点只有一个来源，CSS `@media` 与 JS
`matchMedia` 共用同一个常量。抽屉即时出现、没有动画，所以 `prefers-reduced-motion` 天然满足。

## 5. 一个包只能有一个客户端 bundle

DSH 的 `dsh-client-modules` 只读 `exports["./client"]`，`dsh.client` 没有第二个入口字段；同包跨文件也
没有可用的同步依赖形态：`@require` 不是 DSH 指令（浏览器直接 `SyntaxError`，插件会 `import failed`），
唯一受支持的 `require.async` 是异步的，而 `apply()` 同步注册槽位时拿不到组件。

所以客户端保持单文件。真要拆分，只能拆成两个插件包（各自的 bundle、patch 里挂两行），那是产品结构变更。

## 6. 已知边界

- **关掉最后一个标签**：主视图仍停在那条会话上（`clearMain` 不是公开接缝）。刷新后它按「主区会话一定
  在标签集合里」的不变量重新加回。要彻底收起一条会话，先切到别的会话再关它的标签。
- **多写者**：见 §3 末段。
- **桌面端**：`data-windows-titlebar` 不由 Web 侧任何代码写入；桌面端已有更高特异性的占位规则会盖过本
  插件，当前不支持，等宿主稳定后再定。
- **滚轮横滚**：只处理竖向占主导的滚轮，不拦默认行为、不与横向手势和 Shift/Ctrl 叠加。宿主若改成页面
  可纵向滚动，需要换原生监听（`passive:false`）并补一条实测。

## 7. 模块身份

三处必须一起改：`package.json` 的 `name`、`cordis.patch.yml` 的 `id`/`name`、`client.js` 里
`window.__ModuleLoader__.load({ id })` 的注册 id。漏掉第三处的表现是浏览器只有一句
`loaded without registering "<包名>"`，界面停在「Failed to load plugins」，而宿主半边照常跑——
看起来像前端坏了，实际是身份对不上。离线测试直接比对注册 id 与包名。

槽位与数据契约（`CELL_ID`、`data-dsh-tabs`、`--dsh-tabs-h`、`/api/dsh-tabs/state`、`state.json`）不是
模块身份，改名时必须保留，否则已部署实例的共享集合会丢。
