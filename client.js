// dsh-synced-tabs 客户端半边：标签栏 + 左栏会话行的 workspace 左沿色条 + 「共享集合」同步客户端。
// 手写纯 JS，无构建、无 `@deepseek-ai/dsh-client-*` 模块请求，唯一模块请求是 `react`（平台种子模块表），
// 故 `dsh.client.external` 为空。**DSH 一个包只能有一个客户端 bundle**（`exports["./client"]` 是客户端模块
// 系统硬编码读取的唯一入口，见 dsh-client-modules `clientExportOf`），所以两块共用本文件、各自注册槽位。
// 状态模型：真相在宿主（`lib/host.js` 的 `/api/dsh-tabs/state`），本设备只持缓存；渲染读乐观视图，本地操作
// 先落界面再按队列补发；`seq` 只判断答复是否比缓存新。宿主契约见 `lib/client.d.ts`，硬约束见 `README.md` §4。
window.__ModuleLoader__.load({
  // 注册 id 必须等于**包名**：dsh-client-modules 的 boot graph 行键就是包名，加载器只认
  // `registration.id === row.id`；不一致时宿主报 "loaded without registering" 且整个 web bundle
  // 不激活。`dsh-tabs` 是改名前的包名——改名漏了这一处（2026-11-10）。
  id: 'dsh-synced-tabs',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const SLOT = 'shell.overlay'; // 唯一挂载点：官方浮层槽位。
    const CELL_ID = 'dsh-tabs'; // 槽位里的格子 id——用自己的 id 是「加一条」，复用别人的 id 才是「替换它」。
    const STATE_API = '/api/dsh-tabs/state'; // 宿主共享集合端点：Host 半边注册的精确 Fetch 路由（见 lib/host.js）。
    const CACHE_KEY = 'dsh-tabs:state'; // 本设备缓存的键：**跨窗口共享**，首屏与宿主暂时不可达时用它。
    const LEGACY_PREFIX = 'dsh-tabs:tabs:'; // 旧版「按窗口分键」的存储前缀；只在首次迁移时读一次，读完删掉。
    const TABS_VERSION = 1; // 存储/协议载荷版本；不认识版本的载荷一律当空集合（不猜）。
    const POLL_MS = 3000; // 轮询间隔：标签变更是低频事件，3s 足够让另一台设备「几乎立刻」跟上。
    const RETRY_MS = 200; // 布局避让：拿不到锚点时的重试节奏与上限；`FALLBACK_H` 是测量出真实高度前的占位。
    const RETRY_MAX = 5;
    const FALLBACK_H = '38px';
    // 窄屏断点（P2-2）：横条降级为「当前会话 + 抽屉按钮」，全部标签进抽屉。
    // CSS 的 `@media` 与 JS 的 `matchMedia` 共用这一个数——两处写死不同值会得到「横条变了、抽屉不开」这类半个功能。
    //
    // 767 而不是随手一个数：宿主自 0.2.2 起在 `innerWidth < 768` 时把侧边栏降级成**离屏抽屉**，
    // 唯一的入口是左上角 (12,11) 那颗 28px 浮动「打开侧边栏」按钮（源码 `SIDEBAR_AUTO_COLLAPSE` / `drawer`）。
    // 顶部横条会正压住它，实测点 (26,25) 命中的是我们的 `.dshtabs-dot`，侧边栏因此永远打不开。
    // 所以窄屏把横条整体挪到底部、顶部整条让给宿主；767 与宿主的 768 是同一个分界点。
    const NARROW_PX = 767;
    const NARROW_QUERY = '(max-width:' + NARROW_PX + 'px)';

    // ── 纯函数：离线测试的全部着力点 ──
    function warn(message) {
      console.warn('[dsh-synced-tabs] ' + message);
    }

    function once() { // 同一个原因只告警一次——降级路径不该刷屏。
      const seen = new Set();
      return (key, message) => {
        if (seen.has(key)) return;
        seen.add(key);
        warn(message);
      };
    }

    // 状态点类型，优先级 `等待交互 > 运行中 > 完成未读 > 空闲`。调用方只在**真的拿到状态**时才调它：
    // `status` 为空返回 `'idle'` 只是防御，那条路径上根本不画点（P0-6）。
    function statusKind(status) {
      if (!status) return 'idle';
      if (status.pendingInteraction) return 'pending';
      if (status.running) return 'running';
      if (status.completionUnread) return 'unread';
      return 'idle';
    }

    const STATUS_TEXT = { running: '运行中', pending: '等待你的回答', unread: '已完成未读', idle: '空闲' }; // 状态点的悬停说明：点只有 7px，语义必须能问出来（四个 kind 全覆盖）。

    // 抽屉按钮上的**聚合**状态点：一个标签的状态选出来了，多个标签必须收成一个，否则按钮上要画一串点。
    // 优先级与单标签的 `statusKind` **故意不同**：单标签回答「这条会话在干什么」（运行中就画运行中，
    // 哪怕它同时有未读完成）；聚合回答「哪一条在等我」，所以未读完成排在运行中前面——运行中的事还在
    // 自己跑，未读完成的才需要你去看。空闲不参与聚合：全是空闲就一个点都不画。
    const ATTENTION_ORDER = ['pending', 'unread', 'running'];

    function attentionKind(statuses, ids) {
      if (!statuses || typeof statuses.get !== 'function') return undefined;
      let best;
      for (const id of ids) {
        const status = statuses.get(id);
        if (!status) continue; // 没拿到状态就不猜（P0-6），也不参与聚合
        const kind = statusKind(status);
        const rank = ATTENTION_ORDER.indexOf(kind);
        if (rank < 0) continue;
        if (best === undefined || rank < ATTENTION_ORDER.indexOf(best)) best = kind;
      }
      return best;
    }

    function isId(id) { // 一条合法的会话 id：非空字符串、长度有上限（宿主对同一字段做同一套校验）。
      return typeof id === 'string' && id !== '' && id.length <= 200;
    }

    function sanitizeIds(list) { // 去重 + 丢掉非法项。集合的每一项都必须是一个会话 id。
      const ids = [];
      for (const id of list) if (isId(id) && ids.indexOf(id) < 0) ids.push(id);
      return ids;
    }

    function appendTab(ids, id) { // 追加语义：已存在就原样返回（不重排、不产生第二个标签）。
      return !id || ids.indexOf(id) >= 0 ? ids : ids.concat(id);
    }

    function removeTab(ids, id) {
      const at = ids.indexOf(id);
      return at < 0 ? ids : ids.slice(0, at).concat(ids.slice(at + 1));
    }

    // 把一批操作应用到集合上。**宿主侧有同一个函数**（lib/host.js 的 applyOps）：客户端做乐观更新、宿主做
    // 权威更新，两侧对 op 的幂等语义必须一致（改一处必须改两处）。`workspaces` 是会话 → workspaceId 的
    // **兜底**归属表（真相在 workspace 列表，见 createSync）：`open` 带合法 workspaceId 时记下、不带时保留，
    // `close` 删掉；返回新对象，不改入参。
    function applyOps(ids, ops, workspaces) {
      let next = ids;
      const nextWorkspaces = Object.assign({}, sanitizeWorkspaces(workspaces));
      for (const op of ops) {
        if (!op || typeof op !== 'object' || !isId(op.id)) continue;
        if (op.op === 'open') {
          const appended = appendTab(next, op.id);
          if (appended !== next) next = appended;
          if (isId(op.workspaceId) && workspaces[op.id] !== op.workspaceId) nextWorkspaces[op.id] = op.workspaceId;
        } else if (op.op === 'close') {
          next = removeTab(next, op.id);
          delete nextWorkspaces[op.id];
        }
      }
      return { ids: next, workspaces: nextWorkspaces, changed: next !== ids || !sameWorkspaces(workspaces, nextWorkspaces) };
    }

    // 收敛兜底归属表：只留 `{ 合法会话 id: 合法 workspaceId }`；缺字段（老缓存 / 老宿主）与写坏的载荷
    // 一律当空表——兜底信息丢了不是错误，不告警。
    function sanitizeWorkspaces(raw) {
      const table = {};
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return table;
      for (const id of Object.keys(raw)) if (isId(id) && isId(raw[id])) table[id] = raw[id];
      return table;
    }

    function sameWorkspaces(left, right) { // 两张归属表是否等价（键序无关）。
      const keys = Object.keys(left);
      if (keys.length !== Object.keys(right).length) return false;
      for (const key of keys) if (left[key] !== right[key]) return false;
      return true;
    }

    function sameList(left, right) {
      if (left.length !== right.length) return false;
      for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
      return true;
    }

    function activeSession(byId) { // 当前显示在主区的会话——与 DSH 自己的 `isMain()` 同口径：`retainedBy.mainView > 0`。
      if (!byId) return undefined;
      for (const id of Object.keys(byId)) {
        const row = byId[id];
        if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return id;
      }
      return undefined;
    }

    function closeTarget(ids, at) { // 关闭落点：右邻 → 左邻 → 无（`undefined`）。
      if (at < 0 || at >= ids.length) return undefined;
      return ids[at + 1] !== undefined ? ids[at + 1] : ids[at - 1];
    }

    function nextIndex(key, at, count) { // 键盘落点：`←/→` 环绕、`Home/End` 到两端；不认识的键返回 -1（调用方不拦截）。
      if (count <= 0) return -1;
      if (key === 'ArrowRight') return (at + 1 + count) % count;
      if (key === 'ArrowLeft') return (at - 1 + count) % count;
      if (key === 'Home') return 0;
      if (key === 'End') return count - 1;
      return -1;
    }

    // workspace 分组色：DSH 官方主题令牌。不按 id 哈希——6 个 workspace 必然撞色，这里要两两不同，且序列里
    // 没有红（红在 DSH 里表示错误）。deepseek 色阶只到 `900`，深海军蓝是 `blue-950`；写错会静默透明。
    function wsTint(count, index) {
      const tints = ['neutral-500', 'amber-500', 'blue-950', 'green-500', 'neutral-250', 'deepseek-450', 'neutral-700'];
      if (count > tints.length) index %= tints.length; // 超过 7 个才可能撞色：本机 6 个，不为它引入「加一个就全体换色」
      return 'var(--dsw-static-' + tints[index % tints.length] + ')';
    }

    function trackWorkspaces(items) { // workspace 列表 → `owner`（会话 id → workspaceId，先到先得）与 `rank`（workspaceId → 列表位置，定色相）。
      const owner = {};
      const rank = {};
      if (!Array.isArray(items)) return { owner, rank };
      for (const item of items) {
        if (!item || !isId(item.workspaceId)) continue;
        if (!isId(rank[item.workspaceId])) rank[item.workspaceId] = Object.keys(rank).length;
        for (const id of Array.isArray(item.sessionIds) ? item.sessionIds : []) if (isId(id) && !isId(owner[id])) owner[id] = item.workspaceId;
      }
      return { owner, rank };
    }
    function wsLabel(item) { // 徽章文案：优先工作区名，没有名才用路径最后一段；都没有就 `undefined`（不画徽章）。
      if (isId(item.title)) return item.title;
      const path = isId(item.path) ? item.path.replace(/\/+$/, '') : '';
      return path ? path.slice(path.lastIndexOf('/') + 1) : undefined;
    }

    function wheelTarget(list, event) { // 滚轮增量 → 横条该滚到的 `scrollLeft`；`undefined` = 这一下不由横条接管（横向手势 / 到端）。取舍见 README §7.6。
      if (!list) return undefined;
      const dy = Number(event.deltaY) || 0;
      const dx = Number(event.deltaX) || 0;
      // Shift+滚轮是浏览器原生的横向滚动、Ctrl+滚轮是缩放：都不该再由本横条叠一次。
      if (dy === 0 || Math.abs(dy) <= Math.abs(dx) || event.shiftKey || event.ctrlKey) return undefined;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? list.clientWidth || 400 : 1;
      const max = Math.max(0, list.scrollWidth - list.clientWidth);
      const target = Math.max(0, Math.min(max, list.scrollLeft + dy * unit));
      return target === list.scrollLeft ? undefined : target;
    }

    // 解码本设备的缓存载荷；任何异常/旧版本一律回落到「没有缓存」。`workspaces` 是后加的兜底归属表，
    // 老缓存没有它——按空表读，不算坏缓存。
    function decodeCache(raw) {
      if (typeof raw !== 'string' || raw === '') return undefined;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.v !== TABS_VERSION || !Array.isArray(parsed.ids)) return undefined;
        return {
          ids: sanitizeIds(parsed.ids),
          seq: Number.isInteger(parsed.seq) && parsed.seq >= 0 ? parsed.seq : 0,
          workspaces: sanitizeWorkspaces(parsed.workspaces),
        };
      } catch (_error) {
        return undefined;
      }
    }

    function decodeLegacy(raw) { // 解码旧版按窗口分键的载荷（`{ v: 1, at, ids }`）；只给迁移用。
      if (typeof raw !== 'string' || raw === '') return [];
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.v !== TABS_VERSION || !Array.isArray(parsed.ids)) return [];
        return sanitizeIds(parsed.ids);
      } catch (_error) {
        return [];
      }
    }

    // ── 存储：全部包在 try 里，坏了就退化成内存态 ──
    function safeStorage(kind) {
      try {
        const store = window[kind];
        if (!store) return undefined;
        store.setItem('dsh-tabs:probe', '1');
        store.removeItem('dsh-tabs:probe');
        return store;
      } catch (_error) {
        return undefined;
      }
    }

    function readCache(local) {
      if (!local) return undefined;
      try {
        return decodeCache(local.getItem(CACHE_KEY));
      } catch (_error) {
        return undefined;
      }
    }

    function writeCache(local, ids, seq, workspaces) {
      if (!local) return;
      try {
        local.setItem(CACHE_KEY, JSON.stringify({ v: TABS_VERSION, seq, at: Date.now(), ids, workspaces }));
      } catch (_error) {
        /* 写失败（配额满 / 存储被禁）就放弃持久化，绝不打断交互 */
      }
    }

    // 一次性迁移：把旧版「每个窗口一份」的标签并集成共享集合的种子，然后删掉旧键——
    // 老用户升级后第一次打开页面时，标签不该凭空消失。
    function migrateLegacy(local) {
      if (!local) return [];
      const seeded = [];
      const stale = [];
      try {
        for (let i = 0; i < local.length; i += 1) {
          const key = local.key(i);
          if (typeof key !== 'string' || key.indexOf(LEGACY_PREFIX) !== 0) continue;
          stale.push(key);
          for (const id of decodeLegacy(local.getItem(key))) if (seeded.indexOf(id) < 0) seeded.push(id);
        }
        for (const key of stale) local.removeItem(key);
      } catch (_error) {
        /* 见上 */
      }
      return seeded;
    }

    // ── 共享集合的同步客户端 ──

    function createSync(options) { // 建一个同步客户端：`{ local?（缺失时纯内存）, warnOnce?（同一原因只报一次）, fetch?（缺失时直接本地模式） }`。
      const local = options.local;
      const fetchImpl = options.fetch;
      const listeners = new Set();
      const cached = readCache(local);
      const migrated = cached ? [] : migrateLegacy(local);
      let ids = cached ? cached.ids : migrated;
      let seq = cached ? cached.seq : 0;
      let workspaces = cached ? cached.workspaces : {}; // 会话 → workspaceId 的**兜底**归属表（宿主冗余下来的那份）。真相是 workspace 列表。
      // 本机有旧版标签但还没有同步缓存 = 升级上来的第一次。只在「首次接触 + 宿主一个标签都没有」时认领，
      // 否则旧标签会被宿主的空集合盖掉；拿陈旧同步缓存去认领会把别的设备关掉的标签复活。

      const claimable = !cached && ids.length > 0;
      let contacted = false;
      // 迁移种子要立刻落缓存：否则「只迁移过一次、还没有任何操作」的页面刷新后会再迁移一次（旧键已删，读不到 = 标签凭空消失）。
      if (!cached && ids.length > 0) writeCache(local, ids, seq, workspaces);
      let pending = []; // 尚未被宿主接受的本地操作，按发生顺序补发。
      let mode = fetchImpl ? 'unknown' : 'local'; // local = 不做网络（宿主端点不可用 / 没有 fetch）；remote = 同步中。
      let chain = Promise.resolve(); // 所有网络请求串行，避免 GET 与 POST 互相覆盖。
      let timer = null;
      let started = false;
      let stopped = false;

      const snapshot = () => ids;
      const workspacesSnapshot = () => Object.assign({}, workspaces); // 兜底归属表（拷贝）：`{ [会话Id]: workspaceId }`。没有归属时是 `{}`，不是 `undefined`。

      function subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }

      function notify() {
        writeCache(local, ids, seq, workspaces);
        for (const listener of listeners) listener();
      }

      // 接受宿主的一份状态。不做「序号更老就丢弃」的判定：本客户端网络请求全部串行（`chain`），答复本来就
      // 按序到达；而宿主状态文件被删/重建时 seq 会从头开始，拿旧 seq 当闸门会让客户端永远拒绝新状态。
      function adopt(next) {
        if (!next || typeof next !== 'object' || !Array.isArray(next.tabs)) return;
        const tabs = sanitizeIds(next.tabs);
        const nextSeq = Number.isInteger(next.seq) && next.seq >= 0 ? next.seq : seq;
        // 老宿主不返回 `workspaceByTab`：按空表读，静默当作没有 fallback（不告警）。
        const nextWorkspaces = applyOps(tabs, [], next.workspaceByTab).workspaces;
        if (sameList(tabs, ids) && sameWorkspaces(workspaces, nextWorkspaces)) {
          if (nextSeq > seq) {
            seq = nextSeq;
            writeCache(local, ids, seq, workspaces);
          }
          return;
        }
        ids = tabs;
        workspaces = nextWorkspaces;
        seq = nextSeq;
        notify();
      }

      function queue(task) {
        chain = chain.then(task).catch(() => {});
        return chain;
      }

      function markLocal(message) {
        if (mode === 'local') return;
        mode = 'local';
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        options.warnOnce('sync', message);
      }

      async function call(method, body) {
        try {
          const init = { method, credentials: 'same-origin', cache: 'no-store' };
          if (body !== undefined) {
            init.headers = { 'content-type': 'application/json' };
            init.body = JSON.stringify(body);
          }
          const response = await fetchImpl(STATE_API, init);
          if (response.status === 404 || response.status === 405) {
            markLocal('宿主没有 dsh-tabs 的同步端点（host 半边未加载）：退回本设备本地模式。');
            return undefined;
          }
          if (!response.ok) {
            options.warnOnce('http-' + response.status, '同步端点返回 HTTP ' + response.status + '：暂时只保留本地标签。');
            return undefined;
          }
          const payload = await response.json();
          if (!payload || payload.ok !== true || !payload.state) {
            options.warnOnce('payload', '同步端点返回了无法识别的载荷：暂时只保留本地标签。');
            return undefined;
          }
          mode = 'remote';
          return payload;
        } catch (_error) {
          options.warnOnce('network', '连不上宿主同步端点：先只保留本地标签，恢复后会自动补发。');
          return undefined;
        }
      }

      async function refresh() {
        if (stopped || mode === 'local' || pending.length > 0) return;
        const payload = await call('GET');
        if (!payload || pending.length > 0) return;
        // 升级后的首次接触：宿主还是空的，就把本机旧标签认领上去（只做一次）。
        if (!contacted) {
          contacted = true;
          if (claimable && payload.state.tabs.length === 0) {
            for (const id of ids) pending.push({ op: 'open', id });
            schedule();
            return;
          }
        }
        adopt(payload.state);
      }

      async function flush() {
        let latest;
        while (!stopped && mode !== 'local' && pending.length > 0) {
          const batch = pending.slice();
          const payload = await call('POST', { v: TABS_VERSION, ops: batch });
          if (!payload) return;
          pending = pending.slice(batch.length);
          latest = payload;
        }
        if (!stopped && mode !== 'local' && latest && pending.length === 0) adopt(latest.state);
      }

      function syncNow() { // 一次「把本地与宿主对齐」的动作：有待补发的先补发，否则拉一次状态。
        if (stopped || mode === 'local') return chain;
        return queue(() => (pending.length > 0 ? flush() : refresh()));
      }

      function schedule() {
        if (stopped || mode === 'local') return;
        queue(flush);
      }

      function mutate(op) { // 本地操作：先乐观落到界面，再进补发队列。
        if (stopped) return;
        const result = applyOps(ids, [op], workspaces);
        if (!result.changed) return;
        ids = result.ids;
        workspaces = result.workspaces;
        notify();
        if (mode === 'local') return;
        pending.push(op);
        schedule();
      }

      function poll() {
        timer = setTimeout(() => {
          timer = null;
          if (stopped || mode === 'local') return;
          syncNow().then(() => {
            if (!stopped && mode !== 'local') poll();
          });
        }, POLL_MS);
      }

      const onFocus = () => {
        syncNow();
      };

      function start() {
        if (started || stopped) return;
        started = true;
        if (mode === 'local') return;
        if (typeof window.addEventListener === 'function') window.addEventListener('focus', onFocus);
        syncNow();
        poll();
      }

      function stop() {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (typeof window.removeEventListener === 'function') window.removeEventListener('focus', onFocus);
        listeners.clear();
      }

      const open = (id, workspaceId) => mutate({ op: 'open', id, workspaceId }); // `workspaceId` 可选：带的只是兜底归属（真相是 workspace 列表），非法值忽略。

      return {
        snapshot,
        workspaces: workspacesSnapshot,
        subscribe,
        open,
        close: (id) => mutate({ op: 'close', id }),
        start,
        stop,
      };
    }

    // ───── 样式：只走主题令牌，无硬编码色值；只选本插件自己的 data 属性 / 类名 ─────
    // 一条规则一行；`--dsw-*` 之外只有 transparent / currentColor / 色条色值（wsTint 的输出）。
    // 颜色必须写成 `var(--dsw-…)` 字面量：P0-8 的发布门禁就是按源码里的字面量核验的，别抽成拼接函数。
    const FOCUS = 'outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px';
    const CSS = [
      '[data-dsh-tabs]{box-sizing:border-box;padding-top:var(--dsh-tabs-h,38px)}',
      '.dshtabs{position:absolute;top:0;left:0;right:0;box-sizing:border-box;display:flex;align-items:center;gap:4px;padding:4px 8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);background:var(--dsw-specific-sidebar-fill);border-bottom:0.5px solid var(--dsw-alias-border-l2)}',
      '.dshtabs-list{display:flex;align-items:center;gap:4px;flex:1 1 auto;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;overscroll-behavior-x:contain}',
      '.dshtabs-list::-webkit-scrollbar{display:none}',
      '.dshtabs-tab{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:200px;padding:4px 6px 4px 10px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer}',
      '.dshtabs-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshtabs-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-active);box-shadow:inset 0 0 0 0.5px var(--dsw-alias-border-l2),inset 0 -2px 0 0 var(--dsw-alias-state-business-primary)}',
      '.dshtabs-tab:focus-visible{' + FOCUS + '}',
      '.dshtabs-tab[data-missing],.dshtabs-tab[aria-disabled="true"]{color:var(--dsw-alias-state-idle-primary)}',
      '.dshtabs-tab[aria-disabled="true"]{cursor:default}',
      '.dshtabs-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshtabs-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
      '.dshtabs-dot[data-kind="running"]{background:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));animation:dshtabs-pulse 1.4s ease-in-out infinite}',
      '.dshtabs-dot[data-kind="pending"]{background:var(--dsw-alias-state-warn-primary)}',
      '.dshtabs-dot[data-kind="unread"]{background:var(--dsw-alias-state-success-primary)}',
      // ── workspace 分组（P2-1）：色条是标签**左内侧**的独立竖边，与状态点是两个位置 ──
      // 绝不与状态点共用矩形：7px 的圆点里塞一条 2px 方线会变成「蓝底灰」这种重影，看久了眼花。
      // 没有 `data-ws` 的标签不画色条，外观与引入分组之前一致。
      '.dshtabs-wsbar{flex:none;width:2px;align-self:stretch;margin:3px 0;border-radius:1px;background:var(--dshtabs-ws)}',
      // 连成组：后面的成员只靠 4px（原来色条所占宽度）贴上去，色条自身不变宽也不断缝。
      '.dshtabs-tab[data-ws-join="true"]{margin-left:-10px}',
      '.dshtabs-ws{flex:none;max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 4px;border-radius:4px;font-size:11px;line-height:16px;opacity:.7;background:var(--dsw-alias-interactive-bg-hover)}',
      '@keyframes dshtabs-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
      '@media (prefers-reduced-motion:reduce){.dshtabs-dot[data-kind="running"]{animation:none}}',
      '.dshtabs-close{flex:none;width:18px;height:18px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;line-height:1;cursor:pointer;opacity:0}',
      '.dshtabs-tab:hover .dshtabs-close,.dshtabs-tab:focus-within .dshtabs-close,.dshtabs-tab[aria-selected="true"] .dshtabs-close{opacity:.7}',
      '.dshtabs-close:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover)}',
      // ── P2-2 窄屏：横条只剩「当前会话 + ≡N」，全部标签进抽屉 ──
      // 桌面端这些规则一条都不生效（菜单按钮 display:none、媒体查询不命中），外观与引入之前一致。
      '.dshtabs-menu{display:none;flex:none;align-items:center;gap:5px;height:26px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer}',
      '.dshtabs-menu:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshtabs-menu:focus-visible{' + FOCUS + '}',
      // 展开时按钮**自己变成按下态**：抽屉不再盖住横条，用户看得见「再点一次就收起」这个对称动作。
      '.dshtabs-menu[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
      '.dshtabs-menu-count{font-variant-numeric:tabular-nums}',
      // 当前会话不在集合里时的只读兜底标题（宽屏不显示）：外观与选中标签一致，但它不是标签。
      '.dshtabs-stray{display:none;flex:1 1 auto;min-width:0;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-interactive-bg-active);box-shadow:inset 0 0 0 0.5px var(--dsw-alias-border-l2),inset 0 -2px 0 0 var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}',
      // 遮罩与面板一律 `fixed`。**不写「退化成 absolute」的伪退路**：我们的面板是横条（`position:absolute`）
      // 的子节点，absolute 的包含块会变成那条 47px 高的横条，面板只会被压成一条——比 fixed 失效更糟。
      // 真遇到带 transform 的祖先（本机实测没有），正确解法是把面板挂到 body，而没有 portal 做不到；
      // 那时应该整块回滚，而不是留一条看起来在兜底、实际会更坏的路径。
      '.dshtabs-scrim{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1);z-index:60}',
      '.dshtabs-sheet{position:fixed;left:0;right:0;bottom:0;z-index:61;display:flex;flex-direction:column;max-height:64vh;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-top:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-panel) var(--dsw-radius-panel) 0 0;box-shadow:var(--dsw-elevation-panel);padding-bottom:calc(8px + env(safe-area-inset-bottom,0px));font-size:13px;line-height:20px}',
      '.dshtabs-sheet:focus{outline:none}', // 焦点落在面板上只是为了让 Esc 有接收者，不画聚焦环
      '.dshtabs-sheet-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px 8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.dshtabs-sheet-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      // 显式关闭：手机上「点遮罩」不是一个看得见的动作，面板得自带一个「收起」按钮。
      '.dshtabs-sheet-close{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:36px;margin:-8px -8px -8px 0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:16px;line-height:1;cursor:pointer}',
      '.dshtabs-sheet-close:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshtabs-sheet-close:focus-visible{' + FOCUS + '}',
      '.dshtabs-sheet-rows{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}',
      '.dshtabs-row{display:flex;align-items:stretch;border-top:0.5px solid var(--dsw-alias-border-l2)}',
      '.dshtabs-row[aria-current="true"]{background:var(--dsw-alias-interactive-bg-active)}',
      '.dshtabs-row-main{flex:1 1 auto;display:flex;align-items:center;gap:10px;min-width:0;min-height:56px;padding:9px 4px 9px 12px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dshtabs-row-main:focus-visible{' + FOCUS + '}',
      '.dshtabs-row-bar{flex:none;width:2px;height:30px;border-radius:1px;background:var(--dshtabs-ws)}',
      '.dshtabs-row-text{flex:1 1 auto;min-width:0;display:block}',
      '.dshtabs-row-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.dshtabs-row-meta{display:block;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshtabs-row-close{flex:none;align-self:center;width:44px;height:44px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;line-height:1;cursor:pointer}',
      '.dshtabs-row-close:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshtabs-row-close:focus-visible{' + FOCUS + '}',
      // 窄屏覆盖：**必须排在最后**——媒体查询与普通规则同优先级，靠源码顺序决胜。
      // 隐藏非当前标签（`display:none` 同时把它们移出可访问性树与 Tab 次序）、隐藏工作区徽章与 ×
      // （手机上一格约 260px，色条已经表达归属；× 移到抽屉行里，避免 28px 的误触）。
      // 写法是连续字符串拼接、不是内层数组：P0-8 的样式门禁按 `const CSS = [...]` 的字面量取证，
      // 内层再来一次「数组 + join」会把那段正则的边界抢走（门禁静默变成只检查半张表）。
      '@media (max-width:' + NARROW_PX + 'px){'
        // 横条整体挪到**底部**（P2-4）：宿主 0.2.2 起在 innerWidth<768 时把侧边栏降级成离屏抽屉，
        // 唯一入口是左上角 (12,11) 那颗浮动按钮；顶部横条会把它压死（实测该坐标最上层是我们的 `.dshtabs-dot`）。
        // 底部横条既把顶部整条让给宿主，也更接近手机的标签栏习惯。`[data-dsh-tabs]` 的避让从 padding-top 换到 padding-bottom。
        + '[data-dsh-tabs]{padding-top:0;padding-bottom:var(--dsh-tabs-h,38px)}'
        + '.dshtabs{top:auto;bottom:0;border-top:0.5px solid var(--dsw-alias-border-l2);border-bottom:0}'
        // 横条固定 48px、子项拉伸填满：手机上整条都是可点区域（原来的 32px 标签 + 26px 按钮低于 44px 触区）。
        // 高度加安全区（刘海屏/手势条），内容仍占 48px：border-box 下 height 含 padding-bottom。
        + '.dshtabs{height:calc(48px + env(safe-area-inset-bottom,0px));padding:0 8px env(safe-area-inset-bottom,0px);gap:6px}'
        + '.dshtabs-list{align-items:stretch}'
        + '.dshtabs-tab[aria-selected="true"]{flex:1 1 auto;max-width:none;align-self:stretch;padding:8px}'
        + '.dshtabs-stray{align-self:stretch;padding:8px}'
        + '.dshtabs-menu{align-self:stretch;height:auto;min-width:44px}'
        // 抽屉**不盖住横条**（P2-5）：面板与遮罩都从横条上沿往上长，横条保持可见可点。
        // 这样「再点一次 ≡N 收起」与「点重新回到当前会话」都是同一套可见控件，收回动作不再靠猜。
        + '.dshtabs-scrim{bottom:var(--dsh-tabs-h,48px)}'
        + '.dshtabs-sheet{bottom:var(--dsh-tabs-h,48px);max-height:calc(64vh - var(--dsh-tabs-h,48px))}'
        + '.dshtabs-tab:not([aria-selected="true"]){display:none}'
        + '.dshtabs-ws{display:none}'
        + '.dshtabs-close{display:none}'
        + '.dshtabs-menu{display:inline-flex}'
        + '.dshtabs-stray{display:inline-flex}'
        // 没有选中标签时整条列表都是空的（其余标签已被上一条隐藏），别让它继续占着 flex 份额，
        // 否则兜底标题只能拿到半条宽度。`:has` 不支持的浏览器只是少这条优化，布局仍然正确。
        + '.dshtabs-list:not(:has(.dshtabs-tab[aria-selected="true"])){display:none}'
        + '}',
    ].join('');

    const EMPTY = {};
    const EMPTY_LIST = [];
    const noopHook = () => undefined;

    // ── 软键盘（P2-6）：让键盘**压缩布局视口**，而不是把可视视口平移出去 ──
    // 背景（2026-11-09 真机实测，Android + Chromium，360×649）：默认 `interactive-widget=resizes-visual` 时，
    // 键盘只缩**可视视口**，布局视口仍是 649，浏览器把可视视口往上平移去露出输入框——页面只有 649 高，
    // 平移后底部露出「页面之外」的一片空白，位置正好在标签栏与键盘之间（用户原话：键盘上方有多余的空白）。
    // 把 viewport meta 加上 `interactive-widget=resizes-content` 后，布局视口跟着缩到 378，
    // `html/body/#root` 的 100% 一起缩，标签栏落到 330–378、紧贴键盘，空白消失。
    // 桌面无感（没有软键盘时该指令不生效）。只在宿主**没自己声明**时补，绝不覆盖宿主的写法。
    function withResizesContent(content) {
      const text = typeof content === 'string' ? content.trim() : '';
      if (/(^|[,\s])interactive-widget\s*=/.test(text)) return text; // 宿主已经表过态
      if (text === '') return 'interactive-widget=resizes-content';
      return text.replace(/\s*$/, '') + ', interactive-widget=resizes-content';
    }

    function ensureViewportMeta(doc) {
      const root = doc || (typeof document === 'undefined' ? null : document);
      if (!root || typeof root.querySelector !== 'function') return false;
      const meta = root.querySelector('meta[name="viewport"]');
      if (!meta || typeof meta.getAttribute !== 'function' || typeof meta.setAttribute !== 'function') return false;
      const current = meta.getAttribute('content');
      const next = withResizesContent(current);
      if (next === (current || '')) return false;
      meta.setAttribute('content', next);
      return true;
    }

    // ── 组件 ──
    function TabBar(props) {
      const deps = props.__tabs;
      const warnOnce = deps.warnOnce;
      const useList = typeof props.useSessions === 'function' ? props.useSessions : noopHook;
      const useStatus = typeof props.useSessionStatus === 'function' ? props.useSessionStatus : noopHook;
      // 缺 `useWorkspaces` 是**正常状态**（老宿主）：整条归属链路退化成原样，不告警。
      const useWs = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : noopHook;

      const byId = useList((state) => state.byId) || EMPTY;
      const statuses = useStatus((state) => state);
      const activeId = React.useMemo(() => activeSession(byId), [byId]);
      // 归属的唯一真相：`WorkspaceView.sessionIds`（`SessionSummary` 上没有 workspaceId，不能按 cwd 猜）。
      // 宿主还没 ready 时 `items` 是空的 → 两张表都空，后面的渲染自然退回原样。
      const wsItems = useWs((state) => state && state.items) || EMPTY_LIST;
      const wsIndex = React.useMemo(() => trackWorkspaces(wsItems), [wsItems]);

      // 集合来自同步客户端；本地操作与宿主推送都通过 subscribe → setIds 汇入同一条渲染路径。
      const [ids, setIds] = React.useState(deps.sync.snapshot());
      const [fallback, setFallback] = React.useState(deps.sync.workspaces);
      const [focusId, setFocusId] = React.useState(null);
      const [anchor, setAnchor] = React.useState('probing');
      const [sheetOpen, setSheetOpen] = React.useState(false); // P2-2：窄屏抽屉。宽屏下打开入口是 display:none，正常不会为 true。
      // 窄屏标志只用于**键盘语义**（横条外观由 CSS 媒体查询负责）。两者共用 NARROW_QUERY 这个来源。
      const [narrow, setNarrow] = React.useState(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
        const query = window.matchMedia(NARROW_QUERY);
        return !!(query && query.matches);
      });
      const [, forceRender] = React.useState(0);
      const barRef = React.useRef(null);
      const listRef = React.useRef(null);
      const menuRef = React.useRef(null);
      const sheetRef = React.useRef(null);

      // `uiWorkspace` 是异步出现的：等它到位时把横条重渲染一次，好让禁用态自动解除。
      React.useEffect(() => {
        const listener = () => forceRender((count) => count + 1);
        deps.workspace.listeners.add(listener);
        return () => deps.workspace.listeners.delete(listener);
      }, []);

      // 订阅共享集合：别的设备关掉/打开一条会话后，这里跟着重渲染（归属表变了也算）。
      React.useEffect(
        () =>
          deps.sync.subscribe(() => {
            setIds(deps.sync.snapshot());
            setFallback(deps.sync.workspaces());
          }),
        [],
      );

      // 优先级：本机 workspace 列表反查 > 宿主的兜底归属表 > 无归属（不画任何东西）。
      const wsOf = (id) => wsIndex.owner[id] || fallback[id];

      const workspace = deps.workspace.current;
      const canNavigate = !!workspace;

      // P0-11：把「缺了什么」说清楚，且同一条只说一次。
      React.useEffect(() => {
        if (typeof props.useSessions !== 'function') {
          warnOnce('sessions', 'useSessions 缺失：读不到会话清单，标签栏不渲染。');
        }
        if (typeof props.useSessionStatus !== 'function') {
          warnOnce('status', 'useSessionStatus 缺失：不显示状态点（不猜状态）。');
        }
        if (!canNavigate) {
          warnOnce('uiWorkspace', 'uiWorkspace 暂不可用：点标签切换与 ＋ 新建先禁用，服务出现后自动启用。');
        }
      }, [canNavigate, props.useSessions, props.useSessionStatus]);

      // 「打开过就占」：当前主区会话一定在标签集合里（P0-2 / P0-5）。
      // 本地立即生效，并经同步队列写到宿主 —— 另一台设备的标签栏也会出现它。
      // 顺手把归属冗余给宿主：别的设备 workspace 列表还没到时，靠这份兜底也能分组。
      React.useEffect(() => {
        if (activeId) deps.sync.open(activeId, wsIndex.owner[activeId]);
      }, [activeId, wsIndex]);

      // 软键盘（P2-6）：只在**这一条**上碰宿主的 viewport meta，且只在宿主没声明 `interactive-widget` 时补。
      // 不这么做的话，手机上开键盘时键盘与标签栏之间会露出一条「页面之外」的空白（真机实测见函数注释）。
      React.useEffect(() => {
        ensureViewportMeta();
      }, []);

      // 布局避让（P0-10）：官方 data 属性定位框架节点 → 打自己的属性 + CSS 变量。
      React.useEffect(() => {
        let frame = null;
        let timer = null;
        let tries = 0;
        let observer = null;

        const locate = () => {
          const own = barRef.current;
          const layer = own && own.closest ? own.closest('[data-shell-overlay]') : null;
          return layer ? layer.parentElement : null;
        };
        const publish = () => {
          const own = barRef.current;
          if (!frame || !own) return;
          const px = Math.round(own.getBoundingClientRect().height);
          if (px > 0) frame.style.setProperty('--dsh-tabs-h', px + 'px');
        };

        const attach = () => {
          frame = locate();
          if (!frame) {
            tries += 1;
            if (tries <= RETRY_MAX) {
              timer = setTimeout(attach, RETRY_MS);
              return;
            }
            warn('拿不到 [data-shell-overlay] 的框架节点，标签栏不渲染（绝不静默重叠到原生 UI 上）。');
            setAnchor('failed');
            return;
          }
          frame.setAttribute('data-dsh-tabs', '');
          frame.style.setProperty('--dsh-tabs-h', FALLBACK_H);
          setAnchor('ok');
          publish();
          if (typeof ResizeObserver === 'function') {
            observer = new ResizeObserver(publish);
            observer.observe(barRef.current);
          }
        };

        attach();
        return () => {
          if (timer) clearTimeout(timer);
          if (observer) observer.disconnect();
          if (frame) {
            frame.removeAttribute('data-dsh-tabs');
            frame.style.removeProperty('--dsh-tabs-h');
          }
        };
      }, []);

      // ── 抽屉（P2-2）：焦点、断点、定位自检。三个 effect 都只在开了抽屉之后才有事可做 ──

      // 焦点：打开时送进抽屉（优先落在当前会话那一行），关闭时还给 ≡ 按钮。
      // 不还给按钮的话，键盘用户按完 Esc 会掉回页面顶端，得重新 Tab 一圈才回得来。
      React.useEffect(() => {
        if (!sheetOpen) return undefined;
        const node = sheetRef.current;
        if (node) {
          const row = typeof node.querySelector === 'function' ? node.querySelector('.dshtabs-row[aria-current="true"] .dshtabs-row-main') : null;
          const target = row || node;
          if (target && typeof target.focus === 'function') target.focus();
        }
        return () => {
          const trigger = menuRef.current;
          // 宽屏下 ≡ 是 display:none：聚焦一个隐藏元素只会把焦点丢到 body。量得到布局就只在可见时归还。
          const usable = !trigger || typeof trigger.getClientRects !== 'function' || trigger.getClientRects().length > 0;
          if (trigger && usable && typeof trigger.focus === 'function') trigger.focus();
        };
      }, [sheetOpen]);

      // Esc 再挂一层在 document 上：真实浏览器里点面板内的不可聚焦区域（标题栏、空态、边距）会让
      // `activeElement` 掉回 body，此时面板上的 onKeyDown 收不到键——那是最容易按 Esc 起不到作用的时刻。
      // 面板自己的 onKeyDown 仍保留（键盘用户的常规路径，也是离线测试替身唯一能派发的那条）。
      React.useEffect(() => {
        if (!sheetOpen || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape' || event.key === 'Esc') setSheetOpen(false);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [sheetOpen]);

      // 断点变化：同步键盘语义用的 `narrow`，并在视口变宽时收抽屉。
      // 没有 matchMedia（老宿主）就不挂——那样抽屉只能靠 Esc/遮罩/选中关，键盘语义保持桌面那套，不会卡死。
      React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
        const query = window.matchMedia(NARROW_QUERY);
        if (!query || typeof query.addEventListener !== 'function') return undefined;
        const onChange = () => {
          setNarrow(query.matches);
          if (!query.matches) setSheetOpen(false); // 视口变宽就收抽屉：宽屏上不该留一块浮层
        };
        query.addEventListener('change', onChange);
        return () => query.removeEventListener('change', onChange);
      }, []);

      // 焦点落点：优先用户刚移过去的那个，其次当前会话，最后第一个。
      // **窄屏例外**：其余标签都是 `display:none`（不可聚焦），roving 只能落在唯一可见的那条上，
      // 否则 tablist 会把唯一的 Tab 停靠点交给一个看不见的标签，Delete/Enter 也会作用在看不见的那条。
      const focusable = focusId && ids.indexOf(focusId) >= 0 ? focusId : activeId;
      const rovingId = narrow
        ? activeId && ids.indexOf(activeId) >= 0
          ? activeId
          : ids[0]
        : focusable && ids.indexOf(focusable) >= 0
          ? focusable
          : ids[0];

      const activate = (id) => {
        const target = deps.workspace.current; // 调用时**重新读**：服务可能挂载之后才出现
        if (!target || id === activeId) return; // 没有服务、或点当前标签，都是 no-op（P0-3）
        target.openSession(id);
      };

      const close = (id) => {
        const at = ids.indexOf(id);
        if (at < 0) return;
        const landing = closeTarget(ids, at);
        const wasActive = id === activeId;
        deps.sync.close(id); // 乐观移除 + 同步到宿主：其它设备上的同名标签也会消失
        const target = deps.workspace.current;
        if (!wasActive || !target) return;
        if (landing !== undefined) {
          target.openSession(landing);
          return;
        }
        // 最后一个标签：`clearMain` 不是公开接缝，所以只移除标签，主视图不动（见 lib/client.d.ts）。
        warnOnce('clearMain', '最后一个标签已关闭：主视图保持不动（clearMain 不是公开接缝）。');
      };

      // 抽屉的三个动作：切换、关标签、新建。每个都在做完动作后收掉抽屉——动作已经完成还挡着面板没有意义。
      const closeSheet = () => setSheetOpen(false);
      const pick = (id) => {
        activate(id);
        closeSheet();
      };
      const closeFromSheet = (id) => {
        close(id);
        if (ids.length <= 1) closeSheet(); // 关的是最后一个标签：抽屉里什么都不剩，直接收
      };
      // Esc 收抽屉；Tab/Shift+Tab 在面板内环绕。`aria-modal` 只是声明，真正的模态行为得自己维持，
      // 否则焦点会跑到底下被遮住的宿主 UI 上去。没有 `document`（离线替身）就不做环绕，只保留 Esc。
      const onSheetKeyDown = (event) => {
        if (event.key === 'Escape' || event.key === 'Esc') {
          event.preventDefault();
          closeSheet();
          return;
        }
        if (event.key !== 'Tab' || typeof document === 'undefined' || !sheetRef.current) return;
        const node = sheetRef.current;
        if (typeof node.querySelectorAll !== 'function') return;
        const found = node.querySelectorAll('button,[role="button"]');
        const list = found && found.length ? Array.prototype.slice.call(found) : [];
        if (list.length === 0) return;
        const first = list[0];
        const last = list[list.length - 1];
        const current = document.activeElement;
        if (!event.shiftKey && current === last) {
          event.preventDefault();
          if (typeof first.focus === 'function') first.focus();
        } else if (event.shiftKey && (current === first || current === node)) {
          event.preventDefault();
          if (typeof last.focus === 'function') last.focus();
        }
      };

      const onKeyDown = (event) => {
        const at = ids.indexOf(rovingId);
        const closeKey = event.key === 'Delete' || event.key === 'Backspace';
        const activateKey = event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar';
        if (closeKey || activateKey) {
          if (at < 0) return;
          event.preventDefault();
          if (closeKey) close(ids[at]);
          else activate(ids[at]);
          return;
        }
        if (narrow) return; // 窄屏只有一条可见标签：方向键无处可去，放行给宿主，别在不存在的目标间搬焦点
        const next = nextIndex(event.key, at, ids.length);
        if (next < 0) return; // 不认识的键放行给宿主
        event.preventDefault();
        setFocusId(ids[next]);
        const nodes = listRef.current ? listRef.current.querySelectorAll('[role="tab"]') : null;
        if (nodes && nodes[next] && nodes[next].focus) nodes[next].focus();
      };

      // P1-2：竖向滚轮 → 横向滚动。只改 `scrollLeft`、不拦默认行为：外框是 `overflow:hidden`，
      // 竖向滚轮在横条上没有可滚的祖先，默认动作本来就是空（取舍与备选写法见 README §7.6）。
      const onWheel = (event) => {
        const target = wheelTarget(listRef.current, event);
        if (target !== undefined) listRef.current.scrollLeft = target;
      };

      // 全部 hook 调用完毕之后才允许早退，否则 hook 次序会被破坏。
      // 读不到会话清单 = 这个插件的前提没了：整体 no-op，而不是留一条空横条占着地方。
      if (typeof props.useSessions !== 'function') return null;
      if (anchor === 'failed') return null;

      // 一条标签要显示的三件事（标题 / 状态 / 归属）在横条和抽屉行里是同一套，抽出来只算一遍。
      const describe = (id) => {
        const row = byId[id];
        // 只有**真的拿到这条会话的状态**才画点；没有状态就不猜（P0-6）。
        const status = statuses && statuses.get ? statuses.get(id) : undefined;
        const ws = wsOf(id);
        // 兜底归属没有 title/path：徽章宁可不画，也不编一个出来。
        const item = ws ? wsItems.find((candidate) => candidate && candidate.workspaceId === ws) : undefined;
        return {
          row,
          label: row ? row.displayTitle || row.title || id : id,
          kind: status ? statusKind(status) : undefined,
          ws,
          item,
          badge: item ? wsLabel(item) : undefined,
        };
      };

      const tabs = ids.map((id, at) => {
        const info = describe(id);
        const { row, label, kind, ws, item } = info;
        // 归属：`wsOf` 已合成「列表反查 > 宿主兜底」。连组 = 与**前一个**标签同 workspace。
        const join = !!ws && at > 0 && wsOf(ids[at - 1]) === ws;
        return h(
          'button',
          {
            key: id,
            type: 'button',
            role: 'tab',
            className: 'dshtabs-tab',
            'aria-selected': id === activeId,
            'aria-disabled': canNavigate ? undefined : 'true',
            tabIndex: id === rovingId ? 0 : -1,
            title: label,
            'data-missing': row ? undefined : '',
            'data-kind': kind,
            'data-ws': ws,
            'data-ws-join': join,
            style: ws ? { '--dshtabs-ws': wsTint(wsItems.length, wsIndex.rank[ws]) } : undefined,
            onClick: () => activate(id),
            onAuxClick: (event) => {
              if (event.button !== 1) return; // 只认中键
              event.preventDefault();
              close(id);
            },
          },
          // 色条在前、状态点在后，两者各占一格：色条 = 属于哪个 workspace，点 = 会话状态，互不重叠。
          // 没有归属就没有色条（不给占位元素，标签自然窄一点，语义也不假）。
          ws ? h('span', { key: 'bar', className: 'dshtabs-wsbar', 'aria-hidden': 'true' }) : null,
          kind
            ? h('span', { key: 'dot', className: 'dshtabs-dot', 'data-kind': kind, title: STATUS_TEXT[kind], 'aria-hidden': 'true' })
            : null,
          h('span', { key: 'label', className: 'dshtabs-label' }, label),
          info.badge ? h('span', { key: 'ws', className: 'dshtabs-ws', title: item.path, 'aria-hidden': 'true' }, info.badge) : null,
          h(
            'span',
            {
              key: 'close',
              className: 'dshtabs-close',
              'aria-hidden': 'true',
              title: '关闭标签（会话保留）',
              onClick: (event) => {
                event.stopPropagation();
                close(id);
              },
            },
            '×',
          ),
        );
      });

      // 当前主区会话**不在**标签集合里时（典型：别的设备把它关掉了），窄屏会连一个标题都没有——
      // 横条只剩 ≡N 和 ＋，看起来像坏了。补一个只读的「当前会话」标签：不进 tablist、不可点、没有 ×，
      // 因为它本来就不在集合里，能做的只有「告诉你现在在哪个会话」。宽屏不显示（display:none）。
      const stray = activeId && ids.indexOf(activeId) < 0 ? describe(activeId) : undefined;
      const strayStyle = stray && stray.ws ? { '--dshtabs-ws': wsTint(wsItems.length, wsIndex.rank[stray.ws]) } : undefined;
      const strayNode = stray
        ? h(
            'span',
            { key: 'stray', className: 'dshtabs-stray', 'data-kind': stray.kind, style: strayStyle },
            stray.ws ? h('span', { key: 'bar', className: 'dshtabs-wsbar', 'aria-hidden': 'true' }) : null,
            stray.kind ? h('span', { key: 'dot', className: 'dshtabs-dot', 'data-kind': stray.kind, 'aria-hidden': 'true' }) : null,
            h('span', { key: 'label', className: 'dshtabs-label' }, stray.label),
          )
        : null;

      // 抽屉按钮上的聚合状态点：一眼看出「有没有事在等我」，替代掉窄屏下看不见的那一排状态点。
      const attention = attentionKind(statuses, ids);

      // 抽屉行：全宽、一行一个。标题最多两行，第二行给**状态文字**——触屏没有悬停，
      // 状态必须写出来，不能像桌面那样藏在 `title` 里。
      const sheetRows = ids.map((id) => {
        const info = describe(id);
        const meta = [info.kind ? STATUS_TEXT[info.kind] : undefined, info.badge].filter(Boolean).join(' · ');
        return h(
          'div',
          {
            key: id,
            className: 'dshtabs-row',
            'aria-current': id === activeId ? 'true' : undefined,
            'data-ws': info.ws,
            style: info.ws ? { '--dshtabs-ws': wsTint(wsItems.length, wsIndex.rank[info.ws]) } : undefined,
          },
          h(
            'button',
            {
              key: 'main',
              type: 'button',
              className: 'dshtabs-row-main',
              'aria-disabled': canNavigate ? undefined : 'true',
              onClick: () => pick(id),
            },
            info.ws ? h('span', { key: 'bar', className: 'dshtabs-row-bar', 'aria-hidden': 'true' }) : null,
            info.kind ? h('span', { key: 'dot', className: 'dshtabs-dot', 'data-kind': info.kind, 'aria-hidden': 'true' }) : null,
            h(
              'span',
              { key: 'text', className: 'dshtabs-row-text' },
              h('span', { key: 'title', className: 'dshtabs-row-title' }, info.label),
              meta ? h('span', { key: 'meta', className: 'dshtabs-row-meta' }, meta) : null,
            ),
          ),
          h(
            'button',
            {
              key: 'close',
              type: 'button',
              className: 'dshtabs-row-close',
              title: '关闭标签（会话保留）',
              'aria-label': '关闭标签（会话保留）',
              onClick: (event) => {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
                closeFromSheet(id);
              },
            },
            '×',
          ),
        );
      });

      const menu = h(
        'button',
        {
          key: 'menu',
          type: 'button',
          className: 'dshtabs-menu',
          ref: menuRef,
          title: '打开的会话（' + ids.length + '）',
          'aria-label': '打开的会话（' + ids.length + '）',
          'aria-haspopup': 'dialog',
          'aria-expanded': sheetOpen ? 'true' : 'false',
          onClick: () => setSheetOpen((open) => !open),
        },
        attention
          ? h('span', { key: 'agg', className: 'dshtabs-dot', 'data-kind': attention, 'aria-hidden': 'true' })
          : null,
        h('span', { key: 'count', className: 'dshtabs-menu-count', 'aria-hidden': 'true' }, '≡ ' + ids.length),
      );

      // 抽屉只在打开时进 DOM：不打开就没有遮罩、没有焦点陷阱的问题，也没有多出来的节点。
      const sheet = sheetOpen
        ? h(
            'div',
            { key: 'sheet-root', className: 'dshtabs-sheet-root' },
            h('div', { key: 'scrim', className: 'dshtabs-scrim', 'aria-hidden': 'true', onClick: closeSheet }),
            h(
              'div',
              {
                key: 'panel',
                className: 'dshtabs-sheet',
                ref: sheetRef,
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': '打开的会话',
                tabIndex: -1,
                onKeyDown: onSheetKeyDown,
              },
              h(
                'div',
                { key: 'head', className: 'dshtabs-sheet-head' },
                h('span', { key: 'title', className: 'dshtabs-sheet-title' }, '打开的会话'),
                h('span', { key: 'count' }, ids.length + ' 个 · 点击切换'),
                h(
                  'button',
                  {
                    key: 'close',
                    type: 'button',
                    className: 'dshtabs-sheet-close',
                    title: '收起',
                    'aria-label': '收起',
                    onClick: closeSheet,
                  },
                  '✕',
                ),
              ),
              h('div', { key: 'rows', className: 'dshtabs-sheet-rows' }, sheetRows),
            ),
          )
        : null;

      return h(
        'div',
        {
          ref: barRef,
          className: 'dshtabs',
          'data-dsh-tabs-bar': '',
          style: anchor === 'ok' ? undefined : { visibility: 'hidden' }, // 探测期隐藏：不重叠、不吃点击
        },
        [
          h('style', { key: 'css' }, CSS),
          // 抽屉入口放**左边**（P2-5）：手机单手握持时左下角比右下角好按，也和「左侧=导航/菜单」的习惯一致。
          // 宽屏下它仍是 `display:none`，挪位置对桌面端没有任何影响。
          ids.length > 0 ? menu : null, // 一个标签都没有时不画入口：没有内容的抽屉没有意义
          h(
            'div',
            {
              key: 'list',
              ref: listRef,
              className: 'dshtabs-list',
              role: 'tablist',
              'aria-label': '打开过的会话（跨设备共享）',
              onKeyDown,
              onWheel,
            },
            tabs,
          ),
          strayNode,
          sheet,
        ],
      );
    }

    // ── 插件体 ──

    return {
      inject: ['slots'],
      apply(ctx) {
        // **服务可用性是异步的**：本插件 apply 的这一刻别的客户端插件往往还没 provide，
        // `ctx.get(name)` 会老实返回 undefined（strict 默认只看 active 的提供者）。三类接缝三种接法：
        //   · `slots` 硬依赖 → 写进 inject，apply 只在它到位后才跑；
        //   · `uiWorkspace` 软依赖 → `ctx.inject` 等它出现，出现/消失各自重跑回调；
        //   · `sessions` / `uiSession` 不从这里读 —— 由槽位 standardProps 送进组件，见 TabBar。
        const workspace = { current: undefined, listeners: new Set() };
        const publish = () => {
          for (const listener of workspace.listeners) listener();
        };
        ctx.inject(['uiWorkspace'], (scoped) => {
          workspace.current = scoped.uiWorkspace;
          publish();
          return () => {
            workspace.current = undefined;
            publish();
          };
        });

        const warnOnce = once();
        const local = safeStorage('localStorage');
        if (!local) warn('Web Storage 不可用：标签只在本次页面内有效，刷新即丢。');

        const fetchImpl = typeof window.fetch === 'function' ? window.fetch.bind(window) : undefined;
        const sync = createSync({ local, fetch: fetchImpl, warnOnce });
        // 同步的启动/停止跟插件的 fiber 走：停用插件即停止轮询与 focus 监听（P0-12 零残留）。
        if (typeof ctx.effect === 'function') {
          ctx.effect(
            () => {
              sync.start();
              return () => sync.stop();
            },
            'dsh-tabs: 共享集合',
          );
        } else {
          sync.start();
          warnOnce('effect', 'ctx.effect 缺失：同步客户端没有生命周期归属，停用插件后轮询不会停。');
        }

        const deps = { workspace, warnOnce, sync };
        const Bound = (props) => h(TabBar, Object.assign({}, props, { __tabs: deps }));

        // 注册归插件的 fiber 所有：卸载时这个 inject 的 disposer 会把格子摘掉。
        ctx.slots.inject(SLOT, () => ctx.slots.register({ name: SLOT, id: CELL_ID, order: -1 }, Bound));

      },
    };
  },
});
