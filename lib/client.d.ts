/**
 * dsh-tabs 的**宿主契约**——本插件两个半边（`client.js` / `lib/host.js`）用到的每一个 DSH
 * 接缝，以及缺失时各自的行为。
 *
 * 这份文件是**声明**，不是实现：两个半边都是手写的纯 JS（无构建步骤），这里只是把它们
 * 依赖的宿主面固化下来，好让 DSH 升级时"哪个接缝可能没了"是一个可以逐条核对的问题，
 * 而不是一次猜测。README §4.4 是这条要求的出处。
 *
 * ## 版本范围
 *
 * 本包 `package.json` 的 peer 范围是 `>=0.2.0-rc.2`，含义是：**下面每一条都是在这个
 * 版本上核对过的**，更早的版本没有验证过（`COMPATIBILITY.md` 里 `0.1.7-rc.1` 那行因此
 * 写着「未验证」）。peer 全部标 `optional`：这些包由 dsh 安装树/profile 提供，不由本包
 * 安装，标成必装会让 pnpm 在装本包时去找它们。Host 半边的精确 Fetch 路由来自
 * `@deepseek-ai/dsh-client-connection` 的 Host 半边（`ctx.connection.fetch`），同样由
 * dsh 自身提供、不需要本包安装。
 *
 * ## 删过什么
 *
 * 到 `0.2.1-rc.2` 为止，尚未观察到下列任何接缝被删除或改名（`0.2.0-rc.2` 也逐条核对过）。
 * **这一栏目前是空的，不是因为查过历史，而是因为只有这两个版本被核对过**——每次跨版本
 * 升级后回填 `COMPATIBILITY.md` 时，如果发现某条被删/改名，记在这里。
 *
 * ## 接缝清单
 *
 * | 接缝 | 提供方 | 用途 | 缺失时的行为 |
 * |---|---|---|---|
 * | `shell.overlay` 槽位（`kind: 'list'`, `scope: 'root'`） | `@deepseek-ai/dsh-client-ui-layout` | 渲染横条（`id = 'dsh-tabs'`, `order = -1` 靠前） | 插件不激活（写在 `inject` 里），无副作用 |
 * | `useSessions`（`SnapshotSelectorHook<SessionListState>`） | `@deepseek-ai/dsh-client-ui-session` | 会话清单快照、标题、`retainedBy.mainView`（判定当前会话） | 整体 no-op：不渲染横条 + `console.warn` |
 * | `useSessionStatus`（`SnapshotSelectorHook<SessionStatusSnapshot>`） | `@deepseek-ai/dsh-client-ui-session` | 状态点：由快照里的 `pendingInteraction` / `running` / `completionUnread` 推出 `pending` / `running` / `unread` / `idle` 四个 kind（`idle` 画灰点；拿不到该会话的状态则**不画点**） | 不显示状态点（**不猜**状态） + `console.warn` |
 * | `uiWorkspace.openSession(target)` | `@deepseek-ai/dsh-client-ui-workspace` | 点标签切换会话 | 标签禁用 + `console.warn` |
 * | `uiWorkspace.startSession(workspaceId?)` | `@deepseek-ai/dsh-client-ui-workspace` | `＋` 新建会话（沿用 DSH 原生「复用或新建」策略） | `＋` 禁用 + `console.warn` |
 * | `[data-shell-overlay]` 官方 data 属性 | `@deepseek-ai/dsh-client-ui-layout` | 定位框架节点做布局避让 | `console.warn` + 有限重试，仍拿不到就**不渲染**（绝不静默重叠） |
 * | `ctx.effect(execute, label)` | `@deepseek-ai/cordis`（客户端 Context） | 同步客户端的启动/停止归插件 fiber 所有（卸载即停轮询、摘 focus 监听） | 直接启动并 `console.warn`（停用插件后轮询不会停） |
 * | `window.localStorage`（单个共享键 `dsh-tabs:state`） | 浏览器 | 本设备缓存共享集合（首屏、离线）；旧版按窗口分键的载荷只读一次做迁移 | 退化为内存态（刷新即丢） + `console.warn` |
 * | `window.fetch` | 浏览器 | 调本插件自己的同步端点（`STATE_API`） | 不联网，纯本地模式（不告警：浏览器一定有 fetch） |
 * | `window.addEventListener('focus')` | 浏览器 | 窗口重新获得焦点时立刻对齐一次宿主状态 | 退化为只靠轮询 |
 * | **精确 Fetch 路由 `/api/dsh-tabs/state`**（GET/POST，`requestBody: 'buffered'`） | 本插件 Host 半边 `lib/host.js`，经 `@deepseek-ai/dsh-client-connection` 的 `ctx.connection.fetch.register()` 注册 | 跨设备共享集合的读写；鉴权与 Host/Origin 校验由 Connection 完成（精确路由只放行 owner Peer） | 客户端收到 404/405 → 退回本设备本地模式 + 一次 `console.warn` |
 * | `ctx.inject(['connection'], cb)` | `@deepseek-ai/cordis`（Host Context） | Host 半边等 `connection` 服务到位后再注册路由；服务消失时自动注销 | 该半边 no-op（不注册路由、不写状态文件） |
 *
 * ## Host 半边的配置
 *
 * `apply(ctx, config)` 只认一个字段：`config.stateFile`（状态文件绝对路径，缺省
 * `$DSH_HOME/dsh-tabs/state.json`）。把它指向共享目录（如 NAS）可以让多个 DSH 实例共用
 * 一份集合；不配置时每个实例各自一份。该字段在 profile patch 里按行 id `dsh-tabs` 覆盖。
 *
 * ## 明确**没有**用、也不能用的东西
 *
 * - **`uiWorkspace.clearMain` 不是公开接缝。** 它在 `UiWorkspaceService` 上是 `private`，
 *   也不在 `UiWorkspace` 接口里（客户端 Service 目录同样没有它）。所以「关掉最后一个
 *   标签时清空主视图」在本插件里**做不到**：最后一个标签关闭后只移除标签，主视图保持
 *   不动。这是 P0-4 的降级路径，不是遗漏。理由见 README §4.1：TypeScript 的 `private`
 *   只在编译期存在，运行时 `(ctx.uiWorkspace).clearMain()` 确实能调到——但那正是
 *   「升级即坏」的写法，本插件不碰。
 * - **不用任何 DSH 的 CSS Module 类名匹配**（`[class*="centerCol"]` 这类）。避让只走
 *   官方 `[data-shell-overlay]` + 本插件自己的 `data-dsh-tabs` 属性与 `--dsh-tabs-h` 变量。
 * - **不 require 任何 `@deepseek-ai/dsh-client-*` 包**。客户端唯一的模块请求是 `react`，
 *   来自平台种子模块表（`PLATFORM_MODULES`），因此 `dsh.client.external` 为空。
 * - **Host 半边不用 `ctx.storageDomain` / Remote 方法。** 域表单要求 zod schema 与版本
 *   迁移（对「一个字符串数组」过重，且会把本包从 0 运行时依赖变成有依赖）；Remote 方法
 *   需要 Typert 生成物（要求构建步骤）。精确 Fetch 路由 + 自己的 JSON 文件是这两个约束
 *   下唯一都满足的落点。
 *
 * ## 类型
 *
 * 下面这些是从 `0.2.1-rc.2` 的安装树里抄下来的**形状**，用于本地对照；本包不做类型检查
 * （纯 JS、无构建），所以它们是文档而不是约束。
 */

/** 会话状态：某一时刻由宿主算好的、关于一条会话的独立 UI 事实。 */
export interface SessionStatus {
  /** 最近已知的运行态；在基线或事件确立之前是 `undefined`。 */
  readonly running: boolean | undefined;
  /** 当前排在最高优先级的、等待用户交互的请求。 */
  readonly pendingInteraction: { readonly key: string; readonly kind: string; readonly sessionId: string } | undefined;
  /** 主视图之外观察到的停止，是否仍在等待确认。 */
  readonly completionUnread: boolean;
}

/** 一条会话在清单快照里的行。只列本插件真的读的字段。 */
export interface SessionSummary {
  readonly id: string;
  /** 宿主投影出来的持久标题；投影之前没有。 */
  readonly title?: string;
  /** 给人看的标签：持久标题 → 项目目录名 → 会话 id。 */
  readonly displayTitle: string;
  readonly running: boolean;
  /** 本地持有计数。`mainView > 0` 就是「这条会话正显示在主区」。 */
  readonly retainedBy: Readonly<Partial<Record<string, number>>>;
  /** 尚未被使用过的新会话（`＋` 会复用它）。 */
  readonly blank: boolean;
}

/** 会话清单快照（`useSessions` 的取值）。 */
export interface SessionListState {
  /** 宿主清单顺序。 */
  readonly ids: string[];
  /** 每一行；`ids` 之外的键可能存在（保留但已不在宿主清单里的会话）。 */
  readonly byId: Readonly<Record<string, SessionSummary>>;
  readonly phase: string;
}

/**
 * `uiWorkspace` 上本插件用到的两个方法。
 *
 * 注意 `clearMain` / `replaceMain` / `archiveSession` 不在这里：`archiveSession` 存在但本插件
 * 不用（归档是会话管理器的事，README §3 非目标），`clearMain` 是 private（见上）。
 */
export interface UiWorkspaceSeam {
  /** 选中一条会话并把它的会话视图显示出来（一次 UI 导航动作）。 */
  openSession(target: string): void;
  /** 走 DSH 原生新建流程并导航过去；`workspaceId` 缺省时继承当前/最近的工作区。 */
  startSession(workspaceId?: string): void;
}

// ───────────────────────── 跨设备共享集合的线上形状（Host 半边 lib/host.js） ─────────────────────────

/**
 * 共享集合的权威状态。`seq` 是宿主单调序号，客户端只用它判断答复新旧。
 *
 * **协议版本 `v` 恒为 1**：新字段只增不改，宿主对未知/多余字段宽容。
 */
export interface TabsState {
  readonly v: number;
  /** 只在状态真的变化时 +1；重复 open / 关闭不存在的 id / 重复上报同一归属都不推进。 */
  readonly seq: number;
  /** 按首次打开顺序排列的会话 id。 */
  readonly tabs: readonly string[];
  /**
   * `{ 会话 id: workspaceId }`：**兜底**归属冗余，让「workspace 列表还没到 / 那个 workspace
   * 被删了」的设备仍能显示归属。归属的权威来源永远是客户端读到的
   * `useWorkspaces().items[].sessionIds`，**客户端列表优先，这份只在查不到时用**。
   *
   * 只含集合内、值合法的条目；宿主**总是**返回它（没有归属时是 `{}`），老宿主的应答可能
   * 完全没有这个字段——客户端两种都当「没有 fallback」。
   */
  readonly workspaceByTab?: Readonly<Record<string, string>>;
  readonly updatedAt: number;
}

/** 一次集合变更。op 按到达宿主的顺序幂等执行（后到者生效）。 */
export interface TabsOp {
  readonly op: 'open' | 'close';
  readonly id: string;
  /**
   * 只对 `open` 有意义：这条会话属于哪个 workspace（`WorkspaceView.workspaceId`）。
   * 可选——旧客户端不发；非字符串/空串/超长（与 `id` 同口径，上限 200）的值宿主**忽略而不报错**。
   * `close` 时宿主一并删掉该会话的归属。
   */
  readonly workspaceId?: string;
}

/**
 * 本设备缓存（`localStorage` 键 `dsh-tabs:state`）的载荷形状。
 * `workspaces` 与线上 `TabsState.workspaceByTab` 是同一张表；老缓存没有这个字段，按空表读。
 */
export interface TabsCache {
  readonly v: number;
  readonly seq: number;
  readonly at: number;
  readonly ids: readonly string[];
  readonly workspaces?: Readonly<Record<string, string>>;
}

/**
 * `client.js` 里 `createSync()` 交出来的同步客户端（渲染层唯一的入口）。
 *
 * - `snapshot()` **仍是数组**（`string[]` 会话 id），签名没变；
 * - `workspaces()` 是新增的兜底归属表；
 * - `open(id, workspaceId?)` 第二参数可选，旧调用 `open(id)` 照旧。
 */
export interface TabsSyncClient {
  /** 乐观视图：含尚未被宿主确认的本地操作。 */
  snapshot(): string[];
  /** 兜底归属表（拷贝，`{ [会话Id]: workspaceId }`，没有时是 `{}`）。宿主没给就一直是空表。 */
  workspaces(): Record<string, string>;
  /** 订阅集合或归属表的变化（本地操作与宿主推送都经这条路径）。 */
  subscribe(listener: () => void): () => void;
  /** 打开一条会话并上报归属（`workspaceId` 可缺省；非法值按不带来处理）。 */
  open(id: string, workspaceId?: string): void;
  close(id: string): void;
  start(): void;
  stop(): void;
}

/** POST 请求体。 */
export interface TabsCommand {
  readonly v: number;
  readonly ops: readonly TabsOp[];
}

/** 两个方法的应答。 */
export type TabsResponse =
  | { readonly ok: true; readonly changed?: boolean; readonly state: TabsState }
  | { readonly ok: false; readonly error: string };

/**
 * `ctx.connection.fetch` 上本插件 Host 半边用到的方法。
 *
 * 这是 DSH 的官方「精确 Fetch 路由」接缝：路由挂在共享 `/api` 通道上，分发前已经由
 * Connection 完成 Host/Origin 校验与浏览器 cookie 鉴权，且只放行 owner Peer。
 */
export interface ConnectionFetchSeam {
  register(route: {
    /** `/api` 之下的绝对路径。 */
    readonly path: string;
    readonly methods: readonly ('GET' | 'HEAD' | 'POST')[];
    readonly requestBody: 'buffered' | 'streaming';
    readonly fetch: (request: Request) => Promise<Response>;
  }): () => Promise<void>;
}
