/**
 * dsh-synced-tabs 的离线测试底座。
 *
 * 目标（README §4.5 / issue #1 P0-13）：**不需要浏览器、不需要真 DSH 实例、不需要装任何东西**。
 * 所以这里不引 react / react-dom / jsdom，而是：
 *
 * 1. 用 `node:vm` 把**真正要发布的 `client.js` 字节**跑一遍（不是它的副本、也不是重写的等价物），
 *    从 `window.__ModuleLoader__` 上截下它注册的工厂；
 * 2. 用一个最小的 React 替身（`createElement` + `useState/useEffect/useMemo/useRef`）和一个小渲染器
 *    把工厂返回的组件挂起来，支持事件派发与重渲染。
 *
 * 这是**测试替身**，不是 React 的实现：它只保证本插件用到的那几个 hook 语义（状态跨渲染保持、
 * 依赖数组决定 effect 是否重跑、ref 在挂载时赋值）。真实浏览器里的行为由 `COMPATIBILITY.md`
 * 的实测行负责，两者不能互相替代。
 *
 * 之所以用 `runInThisContext` 而不是独立 vm context：独立 realm 造出来的数组/对象原型不属于
 * 本 realm，`assert.deepStrictEqual` 会因此失败；同 realm 跑没有这个坑。
 */
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '..', 'client.js'), 'utf8');
const LIB = join(HERE, '..', 'lib');
const PACKAGE_NAME = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).name;

const CLIENT_FIELDS = [
  'warn', 'once', 'statusKind', 'STATUS_TEXT', 'isId', 'sanitizeIds', 'appendTab', 'removeTab',
  'applyOps', 'sanitizeWorkspaces', 'sameWorkspaces', 'sameList', 'activeSession', 'closeTarget',
  'nextIndex', 'wsTint', 'trackWorkspaces', 'wsLabel', 'wheelTarget', 'decodeCache', 'decodeLegacy',
  'safeStorage', 'readCache', 'writeCache', 'migrateLegacy', 'createSync', 'FOCUS', 'CSS', 'EMPTY',
  'EMPTY_LIST', 'noopHook', 'TabBar',
];


/**
 * 把 `@require './x.js'` 还原成 DSH 客户端模块系统的语义。
 *
 * `@require` 是 **构建期的** 文件内联：被引用的模块在**引用它的那个模块的词法作用域里**求值
 * （共享 React / h / 常量 / 纯函数），`require`/`exports`/`module` 由引用方那个 factory 提供，
 * 结果按模块标识 memoize。所以这里做的是**源码级拼接**，不是运行时解析——测试跑的是真正会
 * 发布的那几份文件字节，只是先把它们按 DSH 的语义拼回一份可执行文本。
 */
export function stripDirectives(source) {
  return source.replace(/^[ \t]*@require\s+['"][^'"]+['"];?[ \t]*\n?/gm, '');
}

export function linkClient(left, right) {
  const text = right.replace(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g, (whole, quote, spec) => {
    if (!spec.endsWith('.js')) return whole;
    return '(__mod(' + quote + spec + quote + '))';
  });
  return left + '\n// ── @require ' + right.length + ' bytes ──\n' + text;
}

/** 按 DSH 语义拼出一份完整的主模块文本（入口 + 它 `@require` 的每个文件，逐个 memoize）。 */
export function bundleSource() {
  const seen = new Map();
  const visit = (source, fromDir) => {
    const deps = Array.from(source.matchAll(/^\s*@require\s+(['"])([^'"]+)\1;?\s*$/gm));
    let out = source;
    for (const [, quote, spec] of deps) {
      const abs = join(fromDir, spec);
      if (seen.has(abs)) continue;
      const text = visit(stripDirectives(readFileSync(abs, 'utf8')), dirname(abs));
      seen.set(abs, text);
      out = linkClient(out, text);
    }
    return out;
  };
  return visit(stripDirectives(SOURCE), join(HERE, '..'));
}

/** 一个够用的 Storage 替身（`length` / `key` / `getItem` / `setItem` / `removeItem`）。 */
export function memoryStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    key: (index) => Array.from(map.keys())[index] ?? null,
    getItem: (key) => (map.has(String(key)) ? map.get(String(key)) : null),
    setItem: (key, value) => {
      map.set(String(key), String(value));
    },
    removeItem: (key) => {
      map.delete(String(key));
    },
    clear: () => map.clear(),
    dump: () => Object.fromEntries(map),
  };
}

/** 框架节点替身：只实现插件真的碰的那几个成员。 */
export function fakeFrame() {
  const attributes = new Map();
  const properties = new Map();
  return {
    attributes,
    properties,
    setAttribute: (key, value) => attributes.set(key, String(value)),
    removeAttribute: (key) => attributes.delete(key),
    hasAttribute: (key) => attributes.has(key),
    getAttribute: (key) => (attributes.has(key) ? attributes.get(key) : null),
    style: {
      setProperty: (key, value) => properties.set(key, String(value)),
      removeProperty: (key) => properties.delete(key),
      getPropertyValue: (key) => properties.get(key) ?? '',
    },
  };
}

/** 把 `console.warn` 换成收集器；返回还原函数。 */
function captureConsoleWarn(sink) {
  const original = console.warn;
  console.warn = (...args) => {
    sink.push(args.map((a) => String(a)).join(' '));
  };
  return () => {
    console.warn = original;
  };
}

const EMPTY = {};

/** 最小 React 替身 + 渲染器。 */
function createRuntime(env) {
  const scopes = new Map();
  let current = null;
  let dirty = false;
  let tree = null;

  const scopeFor = (type) => {
    let scope = scopes.get(type);
    if (!scope) {
      scope = { hooks: [], cursor: 0, pending: [] };
      scopes.set(type, scope);
    }
    return scope;
  };

  const schedule = () => {
    dirty = true;
  };

  const React = {
    createElement(type, props, ...children) {
      const flat = [];
      for (const child of children) {
        if (Array.isArray(child)) flat.push(...child.flat(Infinity));
        else if (child !== null && child !== undefined && child !== false && child !== true) flat.push(child);
      }
      // React 对**单一**子节点的语义：只有一个子节点时 `props.children` 就是它本身（原文/元素），
      // 不是数组。测试替身跟着这条走，否则「一个文本子节点」在替身里永远是 `['x']`，
      // 和真实 React 对不上，断言只能迁就替身。多个子节点才是数组（多或零个都是数组）。
      const only = flat.length === 1 ? flat[0] : flat;
      return { type, props: Object.assign({}, props, { children: only }) };
    },
    useState(initial) {
      const scope = current;
      const at = scope.cursor++;
      if (scope.hooks.length <= at) scope.hooks[at] = typeof initial === 'function' ? initial() : initial;
      const set = (next) => {
        const value = typeof next === 'function' ? next(scope.hooks[at]) : next;
        if (!Object.is(value, scope.hooks[at])) {
          scope.hooks[at] = value;
          schedule();
        }
      };
      return [scope.hooks[at], set];
    },
    useRef(initial) {
      const scope = current;
      const at = scope.cursor++;
      if (scope.hooks.length <= at) scope.hooks[at] = { current: initial };
      return scope.hooks[at];
    },
    useMemo(factory, deps) {
      const scope = current;
      const at = scope.cursor++;
      const previous = scope.hooks[at];
      if (previous && deps && sameDeps(previous.deps, deps)) return previous.value;
      const value = factory();
      scope.hooks[at] = { value, deps };
      return value;
    },
    useEffect(effect, deps) {
      const scope = current;
      const at = scope.cursor++;
      const previous = scope.hooks[at];
      if (previous && deps && sameDeps(previous.deps, deps)) return;
      const record = { deps };
      scope.hooks[at] = record;
      scope.pending.push({ effect, previous, record });
    },
  };

  function sameDeps(left, right) {
    if (!left || left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) if (!Object.is(left[i], right[i])) return false;
    return true;
  }

  function hostNode(type, props) {
    const node = {
      type,
      props,
      children: [],
      closest: (selector) => (selector === '[data-shell-overlay]' ? env.layer : null),
      getBoundingClientRect: () => ({ height: env.barHeight }),
      style: { setProperty() {}, removeProperty() {} },
      /** 横向滚动的度量与位置：默认 0/0 表示「没有溢出」，只有显式配置的用例才会滚。 */
      scrollLeft: 0,
      clientWidth: env.listClientWidth || 0,
      scrollWidth: env.listScrollWidth || 0,
      focus() {
        env.focused = node;
      },
      querySelectorAll: (selector) => {
        const found = [];
        const walk = (item) => {
          if (!item || typeof item !== 'object') return;
          if (item.props && selector === '[role="tab"]' && item.props.role === 'tab') found.push(item);
          for (const child of item.children || []) walk(child);
        };
        for (const child of node.children) walk(child);
        return found;
      },
    };
    if (props.ref) props.ref.current = node;
    return node;
  }

  function renderVNode(vnode) {
    if (vnode === null || vnode === undefined || vnode === false || vnode === true) return null;
    if (Array.isArray(vnode)) return vnode.map(renderVNode).filter((item) => item !== null);
    if (typeof vnode !== 'object') return vnode;
    if (typeof vnode.type === 'function') {
      const scope = scopeFor(vnode.type);
      const outer = current;
      current = scope;
      scope.cursor = 0;
      let output;
      try {
        output = vnode.type(vnode.props);
      } finally {
        current = outer;
      }
      return renderVNode(output);
    }
    const node = hostNode(vnode.type, vnode.props);
    // `createElement` 对单个子节点存的是**标量**（真实 React 语义），这里补回数组：
    // `node.children` 永远是数组是这个替身的内部约定（`labelOf` / `badgeOf` / `querySelectorAll` 都依赖它）。
    const kids = vnode.props.children;
    node.children = (Array.isArray(kids) ? kids : kids === undefined || kids === null || kids === false ? [] : [kids])
      .map(renderVNode)
      .filter((item) => item !== null);
    return node;
  }

  function runEffects() {
    let ran = 0;
    let pendingScopes = Array.from(scopes.values()).filter((scope) => scope.pending.length > 0);
    while (pendingScopes.length > 0 && ran < 40) {
      for (const scope of pendingScopes) {
        const batch = scope.pending;
        scope.pending = [];
        for (const item of batch) {
          if (item.previous && typeof item.previous.cleanup === 'function') item.previous.cleanup();
          const cleanup = item.effect();
          item.record.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
          ran += 1;
        }
      }
      if (dirty) {
        dirty = false;
        tree = renderVNode(React.createElement(env.Component, env.props));
      }
      pendingScopes = Array.from(scopes.values()).filter((scope) => scope.pending.length > 0);
    }
  }

  return {
    React,
    mount(Component, props) {
      env.Component = Component;
      env.props = props;
      dirty = false;
      tree = renderVNode(React.createElement(Component, props));
      runEffects();
      if (dirty) {
        dirty = false;
        tree = renderVNode(React.createElement(Component, props));
        runEffects();
      }
      return {
        get tree() {
          return tree;
        },
        /** 派发一次事件，然后把因此产生的重渲染与 effect 都跑完。 */
        act(run) {
          const result = run();
          if (dirty) {
            dirty = false;
            tree = renderVNode(React.createElement(Component, props));
          }
          runEffects();
          return result;
        },
        /** 外部数据源变了：强制重渲染并跑完 effect（模拟宿主推送新快照）。 */
        rerender() {
          dirty = false;
          tree = renderVNode(React.createElement(Component, props));
          runEffects();
        },
        /** 卸载：跑所有已注册 effect 的 cleanup（P0-12 靠它断言零残留）。 */
        unmount() {
          for (const scope of scopes.values()) {
            for (const hook of scope.hooks) {
              if (hook && typeof hook.cleanup === 'function') hook.cleanup();
            }
          }
        },
      };
    },
  };
}

/**
 * 建一个测试环境：跑一遍真实的 `client.js`、装好替身、`apply` 插件、把组件挂起来。
 *
 * @param {object} [options]
 * @param {object} [options.sessions] `useSessions` 要返回的 `byId`（缺省空）。
 * @param {Map} [options.statuses] `useSessionStatus` 要返回的状态表。
 * @param {object[]} [options.workspaces] `useWorkspaces().items` 要返回的 workspace 行
 *   （`{ workspaceId, title, sessionIds }`）：会话归属的唯一权威来源。
 * @param {boolean} [options.withoutWorkspaceHooks] 模拟 `useWorkspaces` / `useSessionList` 两个全局 hook 都缺失。
 * @param {object} [options.uiWorkspace] 传 `null` 表示宿主没有这个服务。
 * @param {boolean} [options.withoutSessionService] 模拟 `ctx.get('sessions')` 缺失。
 * @param {boolean} [options.withoutAnchor] 模拟拿不到 `[data-shell-overlay]`。
 * @param {boolean} [options.withoutStatusService] 模拟 `ctx.get('uiSession')` 缺失。
 * @param {object} [options.localStorage] 复用已有存储（测跨实例恢复）。
 * @param {object} [options.sessionStorage] 同上。
 * @param {string} [options.tabsRaw] 直接往该窗口的 localStorage 键里塞这份原始载荷。
 * @param {string} [options.windowId] 固定窗口身份（缺省 `w-test`），让存储键可预测。
 * @param {boolean} [options.noStorage] 模拟 Web Storage 被禁。
 * @param {number} [options.listClientWidth] 标签栏可视宽度（缺省 0 = 没有横向溢出）。
 * @param {number} [options.listScrollWidth] 标签栏内容宽度（缺省 0 = 没有横向溢出）。
 * @param {boolean} [options.narrow] `matchMedia(NARROW_QUERY)` 是否命中（缺省 false = 桌面语义）。
 */
export function createEnv(options = {}) {
  const warnings = [];
  const restore = captureConsoleWarn(warnings);
  const frame = fakeFrame();
  const layer = { parentElement: frame };
  const local = options.noStorage ? undefined : options.localStorage ?? memoryStorage();
  const session = options.noStorage ? undefined : options.sessionStorage ?? memoryStorage();
  const windowId = options.windowId ?? 'w-test';
  if (session) session.setItem('dsh-tabs:window', windowId);
  if (options.tabsRaw !== undefined && local) local.setItem('dsh-tabs:tabs:' + windowId, options.tabsRaw);
  if (options.cacheRaw !== undefined && local) local.setItem('dsh-tabs:state', options.cacheRaw);

  const calls = { openSession: [], startSession: 0 };
  const workspace =
    options.uiWorkspace === null
      ? undefined
      : Object.assign(
          {
            openSession: (id) => calls.openSession.push(id),
            startSession: () => {
              calls.startSession += 1;
            },
          },
          options.uiWorkspace,
        );

  const registered = [];
  const slots = {
    inject: (key, callback) => {
      const disposer = callback();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    register: (row, component) => {
      registered.push({ row, component });
      return () => {
        const at = registered.findIndex((item) => item.component === component);
        if (at >= 0) registered.splice(at, 1);
      };
    },
  };

  // `uiWorkspace` 走 ctx.inject 的**异步**语义：服务没到位时回调根本不跑（真实 Cordis 就是
  // 这样：等依赖 active 了才跑，依赖变了就重跑）；到位时用带该服务的 scoped ctx 跑回调。
  let pendingWorkspace = null;
  let workspaceProvided = options.uiWorkspace !== null && !options.lateWorkspace;
  const provideWorkspace = () => {
    if (options.uiWorkspace === null || workspaceProvided) return;
    workspaceProvided = true;
    const callback = pendingWorkspace;
    pendingWorkspace = null;
    if (callback) callback({ uiWorkspace: workspace });
  };
  // `ctx.effect` 的真实语义：同步执行一次，返回的 cleanup 归插件 fiber 所有（卸载/停用时调用）。
  // 同步客户端用它启动/停止轮询，所以替身必须收集 cleanup，才能断言「卸载零残留」。
  const effectCleanups = [];
  const ctx = {
    slots,
    effect: (execute) => {
      const cleanup = execute();
      if (typeof cleanup === 'function') effectCleanups.push(cleanup);
    },
    inject: (deps, callback) => {
      if (!deps.includes('uiWorkspace')) return { dispose() {} };
      if (workspaceProvided) callback({ uiWorkspace: workspace });
      else pendingWorkspace = callback;
      return { dispose() {} };
    },
    get: (name) => {
      if (name === 'slots') return slots;
      if (name === 'uiWorkspace') return workspaceProvided ? workspace : undefined;
      return undefined;
    },
  };

  // 一个替身 window：除了存储，还要有 fetch 与事件监听——同步客户端用 `window.fetch` 打宿主
  // 端点、用 `window.addEventListener('focus')` 在窗口重新获得焦点时立刻拉一次状态。
  const windowListeners = new Map();
  const previousWindow = globalThis.window;
  let bundle;
  const fakeWindow = {
    __ModuleLoader__: {
      load: (value) => {
        bundle = value;
      },
    },
    localStorage: local,
    sessionStorage: session,
    fetch: options.fetch,
    // `matchMedia`：窄屏逻辑（键盘语义）要读它。替身里由 `options.narrow` 决定是否命中，
    // 变更事件不派发——测试只关心「首屏是窄屏/宽屏」两种稳定状态。
    matchMedia: (query) => ({
      media: String(query),
      matches: options.narrow === true,
      addEventListener() {},
      removeEventListener() {},
    }),
    addEventListener: (type, listener) => {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(listener);
    },
    removeEventListener: (type, listener) => {
      const set = windowListeners.get(type);
      if (set) set.delete(listener);
    },
  };
  globalThis.window = fakeWindow;
  try {
    runInThisContext(bundleSource(), { filename: 'client.js' });
  } finally {
    // 组件渲染与交互期间插件仍会读 window（存储、fetch、事件），所以不还原；
    // 只把注册口换成空实现，避免后续误注册。
    fakeWindow.__ModuleLoader__ = { load() {} };
  }
  if (!bundle) throw new Error('client.js 没有通过 window.__ModuleLoader__.load 注册工厂');
  if (bundle.id !== PACKAGE_NAME) {
    throw new Error(
      '注册的模块 id 必须等于包名：' + bundle.id + ' ≠ ' + PACKAGE_NAME +
        '（dsh-client-modules 的 boot graph 行键就是包名，不一致会让 web 启动报 loaded without registering）',
    );
  }

  if (options.withoutAnchor) layer.parentElement = null;

  const env = {
    warnings,
    frame,
    layer,
    local,
    session,
    calls,
    registered,
    barHeight: options.barHeight ?? 38,
    listClientWidth: options.listClientWidth ?? 0,
    listScrollWidth: options.listScrollWidth ?? 0,
    Component: null,
    props: {},
    focused: null,
  };
  const runtime = createRuntime(env);

  // `@require` 拼进来的模块都在这一个工厂的词法作用域里求值；`require('./x.js')` 只认本包
  // 相对路径并 memoize（对应 DSH 客户端模块系统的同包依赖语义），其余交给平台种子表。
  const modules = new Map();
  const loadModule = (specifier) => {
    if (modules.has(specifier)) return modules.get(specifier);
    const exports = {};
    modules.set(specifier, exports);
    const abs = join(HERE, '..', specifier.replace(/^\.\//, ''));
    const source = readFileSync(abs, 'utf8');
    const fields = CLIENT_FIELDS.map((name) => '"' + name + '": ' + name).join(', ');
    const text =
      '(function (require, exports, module) {\n' +
      'const ' + CLIENT_FIELDS.join(', ') + ';\n' +
      'try {\n' +
      stripDirectives(source) +
      '\n} finally {\nObject.assign(module.exports, {' + fields + '});\n}\n})';
    const fn = runInThisContext(text, { filename: specifier });
    const module = { exports };
    fn((name) => requireModule(name), exports, module);
    modules.set(specifier, module.exports);
    return module.exports;
  };
  const requireModule = (name) => {
    if (name === 'react') return runtime.React;
    if (String(name).startsWith('./') || String(name).startsWith('../')) return loadModule(name);
    throw new Error('未在平台模块表里的请求：' + name);
  };
  const plugin = bundle.factory(requireModule);
  plugin.apply(ctx);

  const holder = {
    byId: options.sessions ?? EMPTY,
    statuses: options.statuses ?? new Map(),
    // workspace 快照的 `items`：DSH 的会话归属就在 `WorkspaceView.sessionIds` 里。
    workspaces: options.workspaces ?? [],
  };

  return {
    warnings,
    frame,
    local,
    session,
    calls,
    registered,
    plugin,
    env,
    holder,
    /** 换掉会话清单快照（模拟宿主推送）——调用方随后要 `handle.rerender()`。 */
    setSessions(byId) {
      holder.byId = byId;
    },
    /** 换掉状态表（模拟宿主推送）。 */
    setStatuses(statuses) {
      holder.statuses = statuses;
    },
    /** 换掉 workspace 列表（模拟宿主推送）——调用方随后要 `handle.rerender()`。 */
    setWorkspaces(items) {
      holder.workspaces = items;
    },
    /** 模拟 `uiWorkspace` 迟到：服务现在才 provide，挂起的回调应当被跑起来。 */
    provideWorkspace,
    /** 在本环境的 window 上派发一个事件（同步客户端只在 `focus` 上刷新）。 */
    fireWindowEvent(type) {
      const set = windowListeners.get(type);
      if (set) for (const listener of Array.from(set)) listener({ type });
    },
    /** 挂载已注册的组件；返回句柄（`tree` / `act` / `rerender` / `unmount`）。 */
    mount(props = {}) {
      const entry = registered[0];
      if (!entry) throw new Error('插件没有注册任何槽位占用者（可能降级为 no-op 了）');
      return runtime.mount(entry.component, {
        useSessions: options.withoutSessionService ? undefined : (select) => select({ byId: holder.byId }),
        useSessionStatus: options.withoutStatusService
          ? undefined
          : (select) => select(holder.statuses),
        useWorkspaces:
          options.withoutWorkspaceHooks === true
            ? undefined
            : (select) => select({ items: holder.workspaces, archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }),
        ...props,
      });
    },
    /** 结束本环境：跑插件 fiber 的 cleanup（停轮询）并还原 `console.warn` 与 `globalThis.window`。 */
    dispose: () => {
      for (const cleanup of effectCleanups.splice(0).reverse()) {
        try {
          cleanup();
        } catch (_error) {
          /* 替身不该因为 cleanup 失败而中断 */
        }
      }
      restore();
      if (globalThis.window === fakeWindow) globalThis.window = previousWindow;
    },
  };
}

/**
 * 假宿主：一个内存版 `/api/dsh-tabs/state`，语义与 `lib/host.js` 对齐（幂等 op + seq）。
 * 它让「两台设备」可以在同一个进程里共享一个宿主——离线测试也能覆盖跨设备行为。
 *
 * `workspaces` 是**通道 2** 的替身：`{ [会话 id]: workspaceId }`，对应真宿主的
 * `WorkspaceView.sessionIds` 归属表。协议带不带 `workspaceId` 都能跑——带的话它落在
 * `state.workspaceByTab` 里，并可通过 `workspaces()` 读回。
 *
 * @param {{ tabs?: string[], workspaces?: Record<string, string> }} [options]
 */
export function fakeServer(options = {}) {
  const workspaces = Object.assign({}, options.workspaces);
  let state = { v: 1, seq: 0, tabs: (options.tabs ?? []).slice(), workspaceByTab: {}, updatedAt: 0 };
  const calls = [];
  const response = (value, status = 200) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => value,
  });
  const apply = (ops) => {
    let tabs = state.tabs.slice();
    let changed = false;
    for (const op of ops) {
      if (!op || typeof op.id !== 'string' || op.id === '') continue;
      if (op.op === 'open' && tabs.indexOf(op.id) < 0) {
        tabs = tabs.concat(op.id);
        changed = true;
      } else if (op.op === 'close' && tabs.indexOf(op.id) >= 0) {
        tabs = tabs.filter((id) => id !== op.id);
        changed = true;
      }
    }
    return { tabs, changed };
  };
  return {
    calls,
    fetch: async (url, init = {}) => {
      const method = init.method || 'GET';
      calls.push({ url: String(url), method, body: init.body });
      if (method === 'POST') {
        const payload = JSON.parse(init.body);
        const result = apply(payload.ops);
        if (result.changed) state = { v: 1, seq: state.seq + 1, tabs: result.tabs, workspaceByTab: state.workspaceByTab, updatedAt: Date.now() };
        return response({ ok: true, changed: result.changed, state });
      }
      return response({ ok: true, state });
    },
    tabs: () => state.tabs.slice(),
    /** 通道 2：真宿主里由 `WorkspaceView.sessionIds` 反查得到。 */
    workspaces: () => Object.assign({}, workspaces),
    setTabs(tabs) {
      state = { v: 1, seq: state.seq + 1, tabs: tabs.slice(), workspaceByTab: state.workspaceByTab, updatedAt: Date.now() };
    },
  };
}

/** 让出若干轮事件循环：同步客户端的网络应答都是 Promise，断言前要等它们落定。 */
export async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** 从渲染树里取出标签栏的内部节点。 */
export function bar(tree) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && node.props['data-dsh-tabs-bar'] !== undefined) found.push(node);
    for (const child of node.children || []) walk(child);
  };
  walk(tree);
  return found[0];
}

/** 取出所有 `role="tab"` 的标签节点。 */
export function tabs(tree) {
  const root = bar(tree);
  return root ? root.querySelectorAll('[role="tab"]') : [];
}

/** 取出 tablist 容器（键盘事件的挂载点）。 */
export function tablist(tree) {
  const root = bar(tree);
  if (!root) return undefined;
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && node.props.role === 'tablist') found.push(node);
    for (const child of node.children || []) walk(child);
  };
  for (const child of root.children) walk(child);
  return found[0];
}

/** 取一个标签的可见文案。 */
export function labelOf(tab) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && node.props.className === 'dshtabs-label') found.push(node);
    for (const child of node.children || []) walk(child);
  };
  for (const child of tab.children) walk(child);
  return found[0] ? found[0].children.join('') : undefined;
}

/** 造一条会话清单行。 */
export function row(id, extra = {}) {
  return Object.assign(
    {
      id,
      displayTitle: id,
      running: false,
      retainedBy: {},
      blank: false,
    },
    extra,
  );
}
