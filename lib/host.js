/**
 * dsh-synced-tabs 的 **Host 半边**：跨设备共享的「活跃会话集合」。
 *
 * 一句话：客户端标签不再是「本窗口 localStorage」，而是宿主上**一份**状态；
 * 任何设备的打开/关闭都写同一份，所有设备读同一份。这就是「分不清哪个是我关了的」
 * 的解法 —— 关闭变成宿主上的事实，而不是某个浏览器里的私事。
 *
 * ## 为什么需要 Host 半边
 *
 * 浏览器 localStorage 天然按 origin + 设备隔离，纯客户端插件**没有任何**跨设备共享的
 * 介质。DSH 的会话清单本身在宿主上，所以「哪些会话还没关」也必须落在宿主上。
 *
 * ## 用到的宿主接缝（与 `lib/client.d.ts` 对齐）
 *
 * - `ctx.connection.fetch.register()`：DSH 官方的「精确 Fetch 路由」注册口
 *   （`@deepseek-ai/dsh-client-connection` 的 Host 半边）。路由挂在 `/api` 通道上，
 *   和 `/api/file`、`/api/directoryPicker/*` 同一层：**只有 owner 浏览器 Peer 能访问**，
 *   鉴权由 Connection 的浏览��� cookie 完成，本插件不碰认证。
 * - 持久化：`$DSH_HOME/dsh-tabs/state.json`（一行 JSON，原子替换）。不走 `ctx.storageDomain`：
 *   域表单要求 zod 声明与 schema 版本迁移，对「一个字符串数组」是过重的依赖，
 *   而本插件的体量/依赖预算是 0 运行时依赖。
 *
 * ## 协议
 *
 * GET  `/api/dsh-tabs/state` → `{ ok: true, state: { v, seq, tabs, workspaceByTab, updatedAt } }`
 * POST `/api/dsh-tabs/state` ← `{ v: 1, ops: [{ op: 'open'|'close', id, workspaceId? }] }`
 *      → `{ ok: true, changed, state }`
 *
 * `workspaceByTab`（`{ 会话 id: workspaceId }`）只做**兜底**：归属的权威来源永远是客户端读到的
 * workspace 列表。老文件没有它是空表，op 不带 `workspaceId` 也照旧工作（协议版本仍是 1）。
 *
 * `seq` 是**宿主单调序号**，只在状态真的变化时 +1。它不参与排序，只用来让客户端判断
 * 一份答复是不是比本地缓存新 —— 客户端不拿自己的时钟比较，避免手机/电脑时钟偏差。
 *
 * ## 冲突规则
 *
 * ops 按到达顺序幂等执行（重复 open / 关闭不存在的 id 都是 no-op）。两台设备同时操作
 * 同一条会话时，后到达宿主的那个操作生效 —— 这是唯一不需要共享时钟的规则。
 * 关闭之后又在另一台设备主动打开，会重新出现在集合末尾：用户刚做的动作最后生效。
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** 精确路由路径。挂在 `/api` 下，由 Connection 的共享 Fetch 通道分发。 */
export const ROUTE_PATH = '/api/dsh-tabs/state';
/** 状态载荷版本；客户端与宿主必须一致，不认识就拒绝而不是猜。 */
export const PAYLOAD_VERSION = 1;
/** 集合上限：标签栏是给人看的，超过这个数说明状态已经坏了。 */
const MAX_TABS = 200;
/** 单个 id（会话 id、workspaceId 同一口径）的上限（DSH 的 id 远短于它，这里只是防滥用）。 */
const MAX_ID_LENGTH = 200;
/** 一次 POST 最多带多少个 op（批处理只用于把本地积压一次送达）。 */
const MAX_OPS = 500;
/** 请求体上限：正常载荷只有几百字节。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 默认状态文件：`$DSH_HOME/dsh-tabs/state.json`（DSH_HOME 未设置时是 `~/.dsh`）。 */
export function defaultStateFile() {
  const configured = process.env.DSH_HOME;
  const home =
    typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : join(homedir(), '.dsh');
  return join(home, 'dsh-tabs', 'state.json');
}

function emptyState() {
  return { v: PAYLOAD_VERSION, seq: 0, tabs: [], workspaceByTab: {}, updatedAt: 0 };
}

function validId(id) {
  return typeof id === 'string' && id !== '' && id.length <= MAX_ID_LENGTH;
}

/** 去重 + 丢掉非法项。 */
export function sanitizeTabs(list) {
  const tabs = [];
  for (const id of list) {
    if (validId(id) && tabs.indexOf(id) < 0 && tabs.length < MAX_TABS) tabs.push(id);
  }
  return tabs;
}

/**
 * 收敛 `workspaceByTab`：只留「在集合里 + workspaceId 合法」的条目。
 * 老文件没有这个字段、或者写坏了，一律当空表——兜底信息缺了不是错误。
 */
export function sanitizeWorkspaces(raw, tabs) {
  const table = {};
  if (!raw || typeof raw !== 'object') return table;
  for (const id of tabs) if (validId(raw[id])) table[id] = raw[id];
  return table;
}

/** 对外（GET / POST 应答）的状态：整份拷贝，`workspaceByTab` 总是存在（没有归属时是 `{}`）。 */
function publicState(current) {
  return {
    v: current.v,
    seq: current.seq,
    tabs: current.tabs.slice(),
    workspaceByTab: Object.assign({}, current.workspaceByTab),
    updatedAt: current.updatedAt,
  };
}

/** 把磁盘上的任何内容收敛成合法状态；损坏/旧版本按空集合处理，不抛错。 */
function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== PAYLOAD_VERSION) return emptyState();
  const tabs = sanitizeTabs(Array.isArray(raw.tabs) ? raw.tabs : []);
  return {
    v: PAYLOAD_VERSION,
    seq: Number.isInteger(raw.seq) && raw.seq >= 0 ? raw.seq : 0,
    tabs,
    workspaceByTab: sanitizeWorkspaces(raw.workspaceByTab, tabs),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  };
}

/**
 * 纯函数：把一批 op 应用到标签集合上（与客户端 applyOps 同口径）。
 * `open` 带合法 workspaceId 时记下归属（**只是归属变了也算变化**，要推进 seq 别的设备才看得到），
 * 不带时保留已有归属；`close` 时一并删掉。非法 workspaceId / 陌生 op 静默忽略。
 * `workspaceByTab` 形如 `{ 会话 id: workspaceId }`，缺省按空表。
 */
export function applyOps(tabs, ops, workspaceByTab) {
  const next = tabs.slice();
  const nextWorkspaces = sanitizeWorkspaces(workspaceByTab, next);
  let changed = false;
  for (const op of ops) {
    if (!op || typeof op !== 'object' || !validId(op.id)) continue;
    if (op.op === 'open') {
      const at = next.indexOf(op.id);
      if (at < 0) {
        if (next.length >= MAX_TABS) continue;
        next.push(op.id);
        changed = true;
      }
      if (!validId(op.workspaceId) || nextWorkspaces[op.id] === op.workspaceId) continue;
      nextWorkspaces[op.id] = op.workspaceId;
      changed = true;
    } else if (op.op === 'close') {
      const at = next.indexOf(op.id);
      if (at < 0) continue;
      next.splice(at, 1);
      delete nextWorkspaces[op.id];
      changed = true;
    }
  }
  return { tabs: next, workspaceByTab: nextWorkspaces, changed };
}

/**
 * 建一个状态存储。`options.file` 是状态文件绝对路径（缺省 `defaultStateFile()`），
 * `options.now` 是时钟注入（测试用）。
 */
export function createStore(options = {}) {
  const file = options.file || defaultStateFile();
  const now = options.now || Date.now;
  let state;
  let loading;
  let writeChain = Promise.resolve();

  async function load() {
    if (state) return state;
    if (!loading) {
      loading = (async () => {
        try {
          state = normalizeState(JSON.parse(await fs.readFile(file, 'utf8')));
        } catch (error) {
          if (error && error.code !== 'ENOENT') {
            console.warn('[dsh-tabs] 状态文件读不了，按空集合处理：' + file + '（' + (error.message || error) + '）');
          }
          state = emptyState();
        }
        return state;
      })();
    }
    return loading;
  }

  function persist(next) {
    writeChain = writeChain
      .then(async () => {
        await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
        const temporary = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
        await fs.writeFile(temporary, JSON.stringify(next) + '\n', { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporary, file);
      })
      .catch((error) => {
        console.warn('[dsh-tabs] 状态文件写入失败（改动只留在内存里）：' + (error.message || error));
      });
    return writeChain;
  }

  /** 读当前状态（拷贝，调用方改不到内部对象）。 */
  async function get() {
    await load();
    return publicState(state);
  }

  /** 应用一批 op；有变化才推进 seq 并落盘。 */
  async function mutate(ops) {
    // 注意：`load()` 的返回值不能在 await 之后当快照用——并发的 mutate 会依次推进 `state`，
    // 必须重新读一次可变引用，否则后到的那次会基于旧快照算，把前一次的改动吞掉。
    await load();
    const current = state;
    const result = applyOps(current.tabs, ops, current.workspaceByTab);
    if (result.changed) {
      state = {
        v: PAYLOAD_VERSION,
        seq: current.seq + 1,
        tabs: result.tabs,
        workspaceByTab: result.workspaceByTab,
        updatedAt: now(),
      };
      await persist(state);
    }
    return { changed: result.changed, state: publicState(state || current) };
  }

  return { file, get, mutate };
}

function jsonResponse(value, status) {
  return new Response(JSON.stringify(value), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * 路由处理函数。只认 GET / POST；鉴权与 Host/Origin 校验由 Connection 在路由分发之前完成
 * （精确路由的第一道检查就是 owner Peer，见 dsh-client-connection 的 createSharedFetchHandler）。
 *
 * @param {ReturnType<typeof createStore>} store
 */
export function createHandler(store) {
  return async function handle(request) {
    try {
      if (request.method !== 'POST') return jsonResponse({ ok: true, state: await store.get() });

      const text = await request.text();
      if (typeof text !== 'string' || text.length > MAX_BODY_BYTES) {
        return jsonResponse({ ok: false, error: 'payload-too-large' }, 413);
      }
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (_error) {
        return jsonResponse({ ok: false, error: 'invalid-json' }, 400);
      }
      if (
        !payload ||
        typeof payload !== 'object' ||
        payload.v !== PAYLOAD_VERSION ||
        !Array.isArray(payload.ops) ||
        payload.ops.length > MAX_OPS
      ) {
        return jsonResponse({ ok: false, error: 'invalid-payload' }, 400);
      }
      const result = await store.mutate(payload.ops);
      return jsonResponse({ ok: true, changed: result.changed, state: result.state });
    } catch (error) {
      console.warn('[dsh-tabs] 同步端点内部错误：' + (error && error.message ? error.message : error));
      return jsonResponse({ ok: false, error: 'internal' }, 500);
    }
  };
}

/**
 * Host 插件入口。
 *
 * `connection` 是异步出现的（与客户端侧 `uiWorkspace` 同一个道理），所以用 `ctx.inject`
 * 等它到位；服务消失时回调的 scoped ctx 释放，路由随之注销，回来时重新注册。
 *
 * @param {object} ctx - Cordis Host 上下文。
 * @param {{ stateFile?: string }} [config] - 可选：覆盖状态文件（例如指向共享目录）。
 */
export function apply(ctx, config) {
  const configured = config && typeof config.stateFile === 'string' ? config.stateFile.trim() : '';
  const store = createStore({ file: configured !== '' ? configured : defaultStateFile() });

  ctx.inject(['connection'], (scoped) => {
    scoped.connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: createHandler(store),
    });
  });
}
