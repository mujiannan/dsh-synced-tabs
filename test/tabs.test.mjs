/**
 * dsh-tabs 的离线行为测试。
 *
 * 全部断言跑在**真实发布的 `client.js`** 上（见 `harness.mjs`：它用 `node:vm` 执行源码本身，
 * 再拿一个最小渲染器把组件挂起来），不需要浏览器、不需要真 DSH 实例、不需要装依赖。
 *
 * 覆盖 issue #1 §四 的清单：空集合渲染、追加语义、关闭落点、关闭不删会话、键盘、存储恢复、
 * 降级 no-op、卸载零残留。每条用例都注明它对应哪个 P0 验收条目。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bar, createEnv, fakeServer, labelOf, memoryStorage, row, settle, tablist, tabs } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '..', 'client.js'), 'utf8');

/** 跑一个用例并把环境收干净。 */
function withEnv(options, run) {
  const environment = createEnv(options);
  try {
    return run(environment);
  } finally {
    environment.dispose();
  }
}

/** 一条正显示在主区的会话。 */
const shown = (id, extra) => row(id, Object.assign({ retainedBy: { mainView: 1 } }, extra));

/**
 * 模拟「用户从别处打开了会话 id」：宿主清单变了，然后组件重渲染。
 *
 * 关键是**同一时刻只有一条会话被主视图持有**（`retainedBy.mainView > 0`）——这正是 DSH 的
 * `isMain()` 口径，也是「当前是哪个会话」的唯一判据。
 */
function openInMain(environment, handle, id, extra) {
  const byId = {};
  for (const [key, value] of Object.entries(environment.holder.byId)) {
    byId[key] = Object.assign({}, value, { retainedBy: {} });
  }
  byId[id] = shown(id, extra);
  environment.setSessions(byId);
  handle.rerender();
}

/** 点某个标签。 */
function click(handle, tab) {
  handle.act(() => tab.props.onClick({ button: 0, stopPropagation() {}, preventDefault() {} }));
}

/** 在 tablist 上敲一个键。 */
function press(handle, key) {
  let defaultPrevented = false;
  handle.act(() =>
    tablist(handle.tree).props.onKeyDown({
      key,
      preventDefault() {
        defaultPrevented = true;
      },
    }),
  );
  return defaultPrevented;
}

/** 点某个标签上的 × ——按类名找，不靠子节点下标（有状态点时下标会变）。 */
function closeTab(handle, index) {
  const tab = tabs(handle.tree)[index];
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && node.props.className === 'dshtabs-close') found.push(node);
    for (const child of node.children || []) walk(child);
  };
  walk(tab);
  assert.ok(found[0], '标签上应该有 × 关闭入口');
  handle.act(() => found[0].props.onClick({ stopPropagation() {}, button: 0 }));
}

/** 取一个标签上的状态点节点（没有就是 undefined）。 */
function dotOf(tab) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && node.props.className === 'dshtabs-dot') found.push(node);
    for (const child of node.children || []) walk(child);
  };
  walk(tab);
  return found[0];
}

/** 标签文案列表——大多数断言的读法。 */
function titles(handle) {
  return tabs(handle.tree).map((tab) => tab.props.title);
}

// ───────────────────────── 渲染与追加语义（P0-1 / P0-2 / P0-5） ─────────────────────────

test('P0-1 / P2-3：没有打开过的会话时，横条不渲染任何标签，也不留「新建会话」入口', () => {
  withEnv({}, (environment) => {
    const handle = environment.mount();
    assert.equal(tabs(handle.tree).length, 0, '空集合不应渲染任何标签');
    assert.ok(bar(handle.tree), '横条本身要渲染出来');
    assert.equal(firstByClass(bar(handle.tree), 'dshtabs-menu'), undefined, '0 个标签时不画抽屉入口（没有内容可放）');
    // P2-3：标签栏只做标签。新建会话是 DSH 自己的事，这里不留任何入口。
    assert.equal(firstByClass(bar(handle.tree), 'dshtabs-new'), undefined, '不该有 ＋ 新建会话按钮');
  });
});

test('P0-2：打开过的会话成为标签，顺序 = 打开顺序，重复打开不产生第二个', () => {
  withEnv({}, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    openInMain(environment, handle, 'B');
    openInMain(environment, handle, 'C');
    assert.deepEqual(
      tabs(handle.tree).map((tab) => tab.props.title),
      ['A', 'B', 'C'],
    );

    // 回到 A：不追加、不重排，只是 active 换了。
    openInMain(environment, handle, 'A');
    assert.deepEqual(
      tabs(handle.tree).map((tab) => tab.props.title),
      ['A', 'B', 'C'],
      '同一会话重复打开不应产生第二个标签，也不应重排',
    );
  });
});

test('P0-3：点标签切换会话；点当前标签是 no-op', () => {
  withEnv({}, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    openInMain(environment, handle, 'B');

    const [, tabB] = tabs(handle.tree);
    click(handle, tabB); // B 已经是当前
    assert.deepEqual(environment.calls.openSession, [], '点当前标签不应触发任何导航');

    const [tabA] = tabs(handle.tree);
    click(handle, tabA);
    assert.deepEqual(environment.calls.openSession, ['A']);
  });
});

test('P2-3：标签栏只做标签——不提供新建会话，也不去碰宿主的新建流程', () => {
  withEnv({}, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    assert.equal(environment.calls.startSession, 0, '整个挂载期间不该调用 startSession');
    const byTitle = firstByClass(bar(handle.tree), 'dshtabs-new');
    assert.equal(byTitle, undefined, '横条上没有新建入口');
  });
});

// ───────────────────────── 关闭语义（P0-4） ─────────────────────────

test('P0-4：关闭落点 = 右邻 → 左邻 → 无', () => {
  withEnv({}, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    openInMain(environment, handle, 'B');
    openInMain(environment, handle, 'C');
    openInMain(environment, handle, 'B'); // 当前是 B，位置在中间

    // 中间：关 B → 请求切到右邻 C；宿主随后把 C 变成主视图（真实链路就是这样）。
    closeTab(handle, 1);
    assert.deepEqual(environment.calls.openSession, ['C'], '中间标签关闭后落到右邻');
    assert.deepEqual(titles(handle), ['A', 'C'], '被关掉的标签不能自己长回来');
    openInMain(environment, handle, 'C');

    // 最右：当前是 C，关 C → 无右邻，取左邻 A
    environment.calls.openSession.length = 0;
    closeTab(handle, 1);
    assert.deepEqual(environment.calls.openSession, ['A'], '最右标签关闭后落到左邻');
    assert.deepEqual(titles(handle), ['A']);
    openInMain(environment, handle, 'A');

    // 唯一：关 A → 没有邻居，只移除标签、不导航，主视图保持不动
    environment.calls.openSession.length = 0;
    closeTab(handle, 0);
    assert.deepEqual(environment.calls.openSession, [], '唯一标签关闭后不应导航');
    assert.equal(tabs(handle.tree).length, 0);
    assert.match(environment.warnings.join('\n'), /clearMain/, '这条降级路径必须留下可见说明');
  });
});

test('P0-4：关闭后台标签不改变当前会话', () => {
  withEnv({}, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    openInMain(environment, handle, 'B');
    openInMain(environment, handle, 'C'); // 当前是 C

    const [tabA] = tabs(handle.tree);
    void tabA;
    closeTab(handle, 0);

    assert.deepEqual(environment.calls.openSession, [], '关后台标签不应把用户拽走');
    assert.deepEqual(titles(handle), ['B', 'C']);
  });
});

test('P0-4：中键关闭与 × 同效，且只关视图不删会话', () => {
  withEnv({}, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    openInMain(environment, handle, 'B');

    const [tabA] = tabs(handle.tree);
    handle.act(() => tabA.props.onAuxClick({ button: 1, preventDefault() {} }));
    assert.equal(tabs(handle.tree).length, 1, '中键应关掉 A');

    // 「只关视图」的证据：会话清单快照里 A 还在。
    assert.ok(environment.holder.byId.A, '关闭标签后会话必须仍在清单里');
    assert.ok(environment.holder.byId.B);
  });
});

test('P0-4：指向已不在清单里的会话的标签置灰保留、仍可关闭', () => {
  withEnv({ tabsRaw: JSON.stringify({ v: 1, at: Date.now(), ids: ['gone', 'A'] }) }, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    const list = tabs(handle.tree);
    assert.deepEqual(list.map((tab) => tab.props.title), ['gone', 'A']);
    assert.equal(list[0].props['data-missing'], '', '缺失会话的标签要置灰保留而不是消失');
    assert.equal(list[1].props['data-missing'], undefined);

    closeTab(handle, 0);
    assert.deepEqual(
      titles(handle),
      ['A'],
      '置灰的标签必须仍然关得掉',
    );
  });
});

// ───────────────────────── 状态点（P0-6） ─────────────────────────

test('P0-6：运行中 / 等待交互 / 完成未读 三种状态各自映射，优先级正确', () => {
  const statuses = new Map([
    ['run', { running: true, pendingInteraction: undefined, completionUnread: false }],
    ['wait', { running: true, pendingInteraction: { key: 'k', kind: 'approval', sessionId: 'wait' }, completionUnread: false }],
    ['done', { running: false, pendingInteraction: undefined, completionUnread: true }],
    ['idle', { running: false, pendingInteraction: undefined, completionUnread: false }],
  ]);
  withEnv({ statuses }, (environment) => {
    const handle = environment.mount();
    for (const id of ['run', 'wait', 'done', 'idle']) openInMain(environment, handle, id);
    const kinds = Object.fromEntries(
      tabs(handle.tree).map((tab) => [tab.props.title, tab.props['data-kind']]),
    );
    assert.deepEqual(kinds, { run: 'running', wait: 'pending', done: 'unread', idle: 'idle' });
  });
});

test('P0-6：查不到这条会话的状态时不画点，也不猜成空闲', () => {
  withEnv({ statuses: new Map() }, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    assert.equal(dotOf(tabs(handle.tree)[0]), undefined, '没有状态就不该画点');
    assert.equal(tabs(handle.tree)[0].props['data-kind'], undefined);
  });
});

test('P0-6：状态来源整体缺失时同样不画点', () => {
  withEnv({ withoutStatusService: true }, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    assert.equal(dotOf(tabs(handle.tree)[0]), undefined);
  });
});

test('P0-6：每个状态点都能被问出含义（7px 的圆点必须带悬停说明）', () => {
  const statuses = new Map([
    ['run', { running: true, pendingInteraction: undefined, completionUnread: false }],
    ['wait', { running: false, pendingInteraction: { key: 'k', kind: 'approval', sessionId: 'wait' }, completionUnread: false }],
    ['done', { running: false, pendingInteraction: undefined, completionUnread: true }],
    ['idle', { running: false, pendingInteraction: undefined, completionUnread: false }],
  ]);
  withEnv({ statuses }, (environment) => {
    const handle = environment.mount();
    for (const id of ['run', 'wait', 'done', 'idle']) openInMain(environment, handle, id);
    const said = Object.fromEntries(
      tabs(handle.tree).map((tab) => [tab.props.title, dotOf(tab).props.title]),
    );
    assert.deepEqual(said, { run: '运行中', wait: '等待你的回答', done: '已完成未读', idle: '空闲' });
  });
});

// ───────────────────────── 键盘（P0-7） ─────────────────────────

test('P0-7：tablist / tab 语义与 roving tabindex', () => {
  withEnv({}, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    openInMain(environment, handle, 'B');

    const list = tablist(handle.tree);
    assert.ok(list, '横条里要有 role="tablist"');
    assert.equal(list.props['aria-label'].length > 0, true);
    const items = tabs(handle.tree);
    assert.deepEqual(items.map((tab) => tab.props.role), ['tab', 'tab']);
    // 唯一可 Tab 到达的是当前标签。
    assert.deepEqual(items.map((tab) => tab.props.tabIndex), [-1, 0]);
    assert.deepEqual(items.map((tab) => tab.props['aria-selected']), [false, true]);
  });
});

test('P0-7：←/→ 环绕、Home/End 移动焦点', () => {
  withEnv({}, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    openInMain(environment, handle, 'B');
    openInMain(environment, handle, 'C');

    press(handle, 'ArrowRight'); // 当前 C → 环绕到 A
    assert.equal(tabs(handle.tree)[0].props.tabIndex, 0);
    assert.equal(tabs(handle.tree)[2].props.tabIndex, -1);

    press(handle, 'ArrowLeft'); // A → 环绕到 C
    assert.equal(tabs(handle.tree)[2].props.tabIndex, 0);

    press(handle, 'Home');
    assert.equal(tabs(handle.tree)[0].props.tabIndex, 0);

    press(handle, 'End');
    assert.equal(tabs(handle.tree)[2].props.tabIndex, 0);

    // 方向键只移动焦点，不该顺手切换会话。
    assert.deepEqual(environment.calls.openSession, [], '方向键不应触发导航');
  });
});

test('P0-7：Enter 激活、Delete 关闭；且只拦截自己认识的键', () => {
  withEnv({}, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    openInMain(environment, handle, 'B'); // 当前 B，末位可 Tab 到

    press(handle, 'Home'); // 焦点移到 A
    assert.equal(press(handle, 'Enter'), true, 'Enter 应被拦截并激活');
    assert.deepEqual(environment.calls.openSession, ['A']);

    assert.equal(press(handle, 'Delete'), true, 'Delete 应被拦截并关闭');
    assert.deepEqual(
      tabs(handle.tree).map((tab) => tab.props.title),
      ['B'],
    );

    assert.equal(press(handle, 'a'), false, '不认识的键必须放行给宿主');
  });
});

// ───────────────────────── 溢出时的滚轮横滚（P1-2） ─────────────────────────

/** 让标签栏「溢出」：可视 300px、内容 1200px，6 个标签。 */
function overflowEnv(options = {}) {
  const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
  const sessions = {};
  for (const id of ids) sessions[id] = row(id);
  return createEnv(
    Object.assign(
      {
        sessions,
        cacheRaw: JSON.stringify({ v: 1, seq: 0, ids }),
        listClientWidth: 300,
        listScrollWidth: 1200,
      },
      options,
    ),
  );
}

/** 在横条上滚一次轮子：`onWheel` 就是浏览器里 React 会调用的那个合成事件。 */
function wheel(handle, event) {
  handle.act(() =>
    tablist(handle.tree).props.onWheel(
      Object.assign({ deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false }, event),
    ),
  );
}

test('P1-2：竖向滚轮把溢出的标签栏横向滚动', () => {
  const environment = overflowEnv();
  try {
    const handle = environment.mount();
    const list = tablist(handle.tree);
    assert.equal(tabs(handle.tree).length, 6, '6 个标签都在 DOM 里（溢出靠滚动看到）');
    assert.equal(list.clientWidth, 300);

    wheel(handle, { deltaY: 120 });
    assert.equal(list.scrollLeft, 120, '竖向滚轮 → 向右滚 deltaY');

    wheel(handle, { deltaY: -40 });
    assert.equal(list.scrollLeft, 80, '反向滚轮 → 往回滚');

    wheel(handle, { deltaY: 1200 });
    assert.equal(list.scrollLeft, 900, '夹在最大值 (1200-300)');

    wheel(handle, { deltaY: 120 });
    assert.equal(list.scrollLeft, 900, '到最右就不再动');
  } finally {
    environment.dispose();
  }
});

test('P1-2：横向手势与行模式单位各有明确边界', () => {
  const environment = overflowEnv();
  try {
    const handle = environment.mount();
    const list = tablist(handle.tree);

    wheel(handle, { deltaX: 120, deltaY: 10 });
    assert.equal(list.scrollLeft, 0, '横向占主导的触控板手势交给浏览器，不叠加');

    wheel(handle, { deltaY: 3, deltaMode: 1 });
    assert.equal(list.scrollLeft, 48, '行模式按 16px/行折算（Firefox）');

    wheel(handle, { deltaY: 240, shiftKey: true });
    assert.equal(list.scrollLeft, 48, 'Shift+滚轮由浏览器原生横滚，不叠加');

    wheel(handle, { deltaY: 240, ctrlKey: true });
    assert.equal(list.scrollLeft, 48, 'Ctrl+滚轮是缩放，横条不动');

    list.scrollLeft = 0;
    wheel(handle, { deltaY: -120 });
    assert.equal(list.scrollLeft, 0, '已经在最左，反向滚轮不动');
  } finally {
    environment.dispose();
  }
});

test('P1-2：没有溢出时滚轮完全交给浏览器（不接管、不抛错）', () => {
  const environment = overflowEnv({ listScrollWidth: 300 });
  try {
    const handle = environment.mount();
    const list = tablist(handle.tree);
    wheel(handle, { deltaY: 240 });
    assert.equal(list.scrollLeft, 0, '内容装得下时横条不接管滚轮');
  } finally {
    environment.dispose();
  }
});

// ───────────────────────── 存储与迁移（P0-9 → P1-1 共享集合） ─────────────────────────

test('P0-9：写入 → 重新构造 → 恢复顺序', () => {
  const local = memoryStorage();
  const session = memoryStorage();
  withEnv({ localStorage: local, sessionStorage: session }, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    openInMain(environment, handle, 'B');
    openInMain(environment, handle, 'C');
  });

  // 第二实例：同一份 localStorage（等价于刷新页面）。
  withEnv({ localStorage: local, sessionStorage: session }, (environment) => {
    const handle = environment.mount();
    assert.deepEqual(
      tabs(handle.tree).map((tab) => tab.props.title),
      ['A', 'B', 'C'],
      '刷新后标签集合与顺序都要恢复',
    );
  });
});

test('P1-1：同一浏览器的不同窗口共享同一集合（不再按窗口分键）', () => {
  const local = memoryStorage();
  const windowA = memoryStorage();
  const windowB = memoryStorage();

  withEnv({ localStorage: local, sessionStorage: windowA, windowId: 'wa' }, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
  });
  withEnv({ localStorage: local, sessionStorage: windowB, windowId: 'wb' }, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'B');
  });

  withEnv({ localStorage: local, sessionStorage: memoryStorage(), windowId: 'wc' }, (environment) => {
    const handle = environment.mount();
    assert.deepEqual(titles(handle), ['A', 'B'], '两个窗口的标签合成同一份共享集合');
  });
});

test('P0-9：旧版按窗口分键的标签一次性迁移成共享集合，并清掉旧键', () => {
  const local = memoryStorage();
  local.setItem('dsh-tabs:tabs:wa', JSON.stringify({ v: 1, at: Date.now(), ids: ['A', 'B'] }));
  local.setItem('dsh-tabs:tabs:wb', JSON.stringify({ v: 1, at: Date.now(), ids: ['B', 'C'] }));
  withEnv({ localStorage: local, sessionStorage: memoryStorage() }, (environment) => {
    const handle = environment.mount();
    assert.deepEqual(titles(handle), ['A', 'B', 'C'], '并集 + 保持旧顺序');
  });
  assert.equal(local.getItem('dsh-tabs:tabs:wa'), null, '迁移完旧键要清掉');
  assert.equal(local.getItem('dsh-tabs:tabs:wb'), null);
  assert.ok(local.getItem('dsh-tabs:state'), '迁移结果要落成新的共享缓存');
});

test('P0-9：缓存 / 旧载荷损坏、版本不认识，都从空集合开始且不抛错', () => {
  for (const raw of ['{ 这不是 JSON', 'null', '[]', '{"v":99,"ids":["A"]}', '{"v":1,"ids":"A"}', '{"v":1,"ids":[1,2]}', '']) {
    withEnv({ cacheRaw: raw }, (environment) => {
      const handle = environment.mount();
      assert.equal(tabs(handle.tree).length, 0, '缓存载荷 ' + raw + ' 应回落到空集合');
    });
    withEnv({ tabsRaw: raw }, (environment) => {
      const handle = environment.mount();
      assert.equal(tabs(handle.tree).length, 0, '旧载荷 ' + raw + ' 应回落到空集合');
    });
  }
});

// ───────────────────────── 布局避让与卸载残留（P0-10 / P0-12） ─────────────────────────

test('P0-10：避让只用自己的 data 属性 + CSS 变量，卸载后完全还原', () => {
  withEnv({ barHeight: 41 }, (environment) => {
    const handle = environment.mount();
    assert.equal(environment.frame.getAttribute('data-dsh-tabs'), '', '框架节点要被打上自己的 data 属性');
    assert.equal(environment.frame.style.getPropertyValue('--dsh-tabs-h'), '41px', '高度要按实测写进自己的变量');

    handle.unmount();
    assert.equal(environment.frame.hasAttribute('data-dsh-tabs'), false, '卸载后 data 属性必须移除');
    assert.equal(environment.frame.style.getPropertyValue('--dsh-tabs-h'), '', '卸载后 CSS 变量必须移除');
  });
});

test('P0-10：拿不到锚点时先告警、有限重试，重试耗尽后不渲染（绝不静默重叠）', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withEnv({ withoutAnchor: true }, (environment) => {
    const handle = environment.mount();
    // 重试窗口内：还没放弃，但已经隐藏（不可见 = 不重叠、不吃点击）。
    assert.equal(handle.tree.props.style.visibility, 'hidden');
    assert.equal(environment.warnings.length, 0, '重试期间不该提前报警');

    // 每次 tick 只推进一跳；下一次重试是在上一跳的回调里排的，所以要逐跳推进。
    for (let i = 0; i < 6; i += 1) t.mock.timers.tick(200);
    handle.rerender();
    assert.equal(handle.tree, null, '重试耗尽后必须整体不渲染');
    assert.match(environment.warnings.join('\n'), /data-shell-overlay/);
    assert.match(environment.warnings.join('\n'), /绝不静默重叠/);
    assert.equal(environment.frame.hasAttribute('data-dsh-tabs'), false, '没锚点就不该动框架节点');
  });
});

test('P0-8：样式只用主题令牌，没有硬编码色值', () => {
  const cssString = /const CSS = \[([\s\S]*?)\]\.join\(''\)/.exec(SOURCE);
  assert.ok(cssString, '应该能在源码里定位到 CSS 常量');
  const css = cssString[1];
  const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g);
  assert.equal(hex, null, '不该出现十六进制色值：' + hex);
  const functional = css.match(/\b(rgb|rgba|hsl|hsla|oklch|lab|lch|color-mix)\(/g);
  assert.equal(functional, null, '不该出现颜色函数：' + functional);
  const named = css.match(/:\s*(black|white|red|green|blue|amber|gray|grey|silver|orange|yellow)\b/gi);
  assert.equal(named, null, '不该出现具名颜色：' + named);
  assert.ok(css.includes('--dsw-'), '颜色必须来自主题令牌');
});

// ───────────────────────── 降级（P0-11） ─────────────────────────

test('P0-11：useSessions 缺失 → 整体 no-op（连横条都不留），不抛异常，并说清缺了什么', () => {
  withEnv({ withoutSessionService: true }, (environment) => {
    const handle = environment.mount();
    assert.equal(handle.tree, null, '读不到会话清单时不该留一条空横条占地方');
    assert.equal(environment.frame.hasAttribute('data-dsh-tabs'), false);
    const said = environment.warnings.join('\n');
    assert.match(said, /useSessions/);
  });
});

test('P0-11：uiWorkspace 缺失 → 标签与 ＋ 都是禁用态，页面其余部分正常', () => {
  withEnv({ uiWorkspace: null }, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    const [tabA] = tabs(handle.tree);
    assert.equal(tabA.props['aria-disabled'], 'true', '没有 uiWorkspace 时标签要是禁用态');
    click(handle, tabA);
    assert.deepEqual(environment.calls.openSession, [], '禁用态下不该尝试导航');
    assert.match(environment.warnings.join('\n'), /uiWorkspace/);
  });
});

test('P0-11：uiWorkspace 迟到 → 出现后自动解除禁用，且不必重新挂载', () => {
  withEnv({ lateWorkspace: true }, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    assert.equal(tabs(handle.tree)[0].props['aria-disabled'], 'true', '服务未到位时标签先禁用');

    environment.provideWorkspace();
    handle.rerender();
    assert.equal(tabs(handle.tree)[0].props['aria-disabled'], undefined, '服务到位后标签要可点');

    click(handle, tabs(handle.tree)[0]);
    assert.deepEqual(environment.calls.openSession, [], 'A 就是当前会话，点了也不该导航');
  });
});

test('P0-11：状态来源缺失 → 不显示状态点，其余照常', () => {
  withEnv({ withoutStatusService: true }, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    assert.equal(tabs(handle.tree).length, 1, '标签本身仍要渲染');
    assert.equal(dotOf(tabs(handle.tree)[0]), undefined);
    assert.match(environment.warnings.join('\n'), /useSessionStatus/);
  });
});

test('P0-11：Web Storage 被禁 → 退化为内存态，不抛异常', () => {
  withEnv({ noStorage: true }, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    openInMain(environment, handle, 'B');
    assert.deepEqual(
      tabs(handle.tree).map((tab) => tab.props.title),
      ['A', 'B'],
      '没有存储时标签仍应在本次会话内工作',
    );
    assert.match(environment.warnings.join('\n'), /Web Storage/);
  });
});

// ───────────────────────── 跨设备共享集合（P1-1） ─────────────────────────

/** 建一个「活的」环境：createEnv 会启动同步客户端，mount 之后才是可交互的页面。 */
function liveEnv(options) {
  const environment = createEnv(options);
  const handle = environment.mount();
  return { environment, handle };
}

test('P1-1：A 打开 → B 出现；B 关闭 → A 消失（同一个宿主上的两台设备）', async () => {
  const server = fakeServer();
  const sessions = { A: row('A'), B: row('B') };
  const a = liveEnv({ fetch: server.fetch, localStorage: memoryStorage(), sessions });
  const b = liveEnv({ fetch: server.fetch, localStorage: memoryStorage(), sessions });
  try {
    openInMain(a.environment, a.handle, 'A');
    await settle();
    assert.deepEqual(server.tabs(), ['A'], 'A 的打开要落到宿主');

    b.environment.fireWindowEvent('focus');
    await settle();
    b.handle.rerender();
    assert.deepEqual(titles(b.handle), ['A'], 'B 的标签栏要看到 A 上打开的会话');

    closeTab(b.handle, 0);
    await settle();
    assert.deepEqual(server.tabs(), [], 'B 的关闭要落到宿主');

    a.environment.fireWindowEvent('focus');
    await settle();
    a.handle.rerender();
    assert.deepEqual(titles(a.handle), [], 'A 的标签栏要把 B 关掉的标签移除');
  } finally {
    b.environment.dispose();
    a.environment.dispose();
  }
});

test('P1-1：本地缓存丢了也不丢集合——首屏从宿主恢复', async () => {
  const server = fakeServer({ tabs: ['X', 'Y'] });
  const environment = createEnv({
    fetch: server.fetch,
    localStorage: memoryStorage(),
    sessions: { X: row('X'), Y: row('Y') },
  });
  try {
    const handle = environment.mount();
    await settle();
    handle.rerender();
    assert.deepEqual(titles(handle), ['X', 'Y'], '空缓存时要从宿主取到共享集合');
  } finally {
    environment.dispose();
  }
});

test('P1-1：升级后首次接触空宿主时，把旧版标签认领上去（迁移不丢标签）', async () => {
  const server = fakeServer();
  const local = memoryStorage();
  local.setItem('dsh-tabs:tabs:w-a', JSON.stringify({ v: 1, at: Date.now(), ids: ['A'] }));
  local.setItem('dsh-tabs:tabs:w-b', JSON.stringify({ v: 1, at: Date.now(), ids: ['B'] }));
  const environment = createEnv({ fetch: server.fetch, localStorage: local, sessions: { A: row('A'), B: row('B') } });
  try {
    const handle = environment.mount();
    await settle();
    handle.rerender();
    assert.deepEqual(server.tabs(), ['A', 'B'], '空宿主时要把旧版标签认领上去');
    assert.deepEqual(titles(handle), ['A', 'B'], '界面上标签不丢');
  } finally {
    environment.dispose();
  }
});

test('P1-1：拿着陈旧缓存不回填——别的设备关掉全部标签后不会复活', async () => {
  const server = fakeServer();
  server.setTabs([]); // 宿主被另一台设备改过（seq > 0），当前是空集合
  const environment = createEnv({
    fetch: server.fetch,
    cacheRaw: JSON.stringify({ v: 1, seq: 5, at: Date.now(), ids: ['A'] }),
    sessions: { A: row('A') },
  });
  try {
    const handle = environment.mount();
    await settle();
    handle.rerender();
    assert.deepEqual(server.tabs(), [], '陈旧缓存不该把已关闭的标签写回去');
    assert.deepEqual(titles(handle), [], '界面以宿主为准');
  } finally {
    environment.dispose();
  }
});

test('P1-1：宿主没有同步端点 → 降级为本设备本地模式，只告警一次，标签照常工作', async () => {
  let calls = 0;
  const environment = createEnv({
    fetch: async () => {
      calls += 1;
      return { status: 404, ok: false, json: async () => ({}) };
    },
    sessions: { A: row('A'), B: row('B') },
  });
  try {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    openInMain(environment, handle, 'B');
    await settle();
    environment.fireWindowEvent('focus');
    await settle();

    assert.deepEqual(titles(handle), ['A', 'B'], '没有宿主端点时标签仍要在本设备工作');
    assert.equal(calls, 1, '发现 404 后不再打网络');
    const said = environment.warnings.filter((line) => /host 半边未加载/.test(line));
    assert.equal(said.length, 1, '同一个降级原因只告警一次');
  } finally {
    environment.dispose();
  }
});

test('P1-1：一次网络失败不丢操作；窗口重新获得焦点时补发', async () => {
  const server = fakeServer();
  let failures = 0;
  const fetch = (url, init = {}) => {
    if ((init.method || 'GET') === 'POST' && failures < 2) {
      failures += 1;
      return Promise.reject(new Error('offline'));
    }
    return server.fetch(url, init);
  };
  const environment = createEnv({ fetch, sessions: { A: row('A') } });
  try {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    await settle();

    assert.equal(failures, 2, '两次自动补发都失败了（预置两次失败）');
    assert.deepEqual(server.tabs(), [], '失败的写没有到宿主');
    assert.deepEqual(titles(handle), ['A'], '界面上仍是乐观结果');
    assert.match(environment.warnings.join('\n'), /连不上宿主同步端点/);

    environment.fireWindowEvent('focus');
    await settle();
    assert.deepEqual(server.tabs(), ['A'], '恢复后补发成功');
  } finally {
    environment.dispose();
  }
});

// ───────────────────────── 体量预算（P0-14） ─────────────────────────

test('P0-14：单文件 < 1200 行、宿主半边 < 300 行、包体 < 200KB、运行时依赖 0', () => {
  // 2026-11-09 第三次上调：900 → 1200（理由见 README §4.6）。P2-2「窄屏降级为当前会话 + 抽屉」
  // 是一整层响应式 UI（横条降级、抽屉面板、焦点管理、定位自检），没有可省的等价物；
  // 拆文件这条路 2026-10-30 已经实测堵死（`@require` 不是 DSH 机制），所以只能上调预算。
  const lines = SOURCE.split('\n').length;
  assert.ok(lines < 1200, `client.js 应 < 1200 行，实际 ${lines} 行`);
  const hostLines = readFileSync(join(HERE, '..', 'lib', 'host.js'), 'utf8').split('\n').length;
  assert.ok(hostLines < 300, `lib/host.js 应 < 300 行，实际 ${hostLines} 行`);

  const manifest = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies, undefined, '运行时依赖必须为 0');
  assert.deepEqual(Object.keys(manifest.peerDependencies).sort(), [
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-session',
    '@deepseek-ai/dsh-client-ui-workspace',
    'react',
  ]);
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    assert.notEqual(range, '*', `${name} 不应写「什么都兼容」`);
  }
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.external, undefined, 'react 来自平台种子表，不该声明 external');
});

test('P0-14：客户端只请求平台种子表里的模块', () => {
  const requests = Array.from(SOURCE.matchAll(/require\((['"])([^'"]+)\1\)/g)).map((match) => match[2]);
  assert.deepEqual(requests, ['react'], '唯一允许的模块请求是 react');
  assert.equal(/\bimport\s[^;]*\bfrom\b/.test(SOURCE), false, '不该出现静态 import（纯客户端半边是 CJS 工厂形态）');
  assert.equal(/^\s*@require/m.test(SOURCE), false, '@require 不是 DSH 客户端模块系统的语法，不能用（见 README §4.6）');
});

// ───────────────────────── 工作区分辨（P2-1，2026-10-30） ─────────────────────────
//
// 问题：标签一多，就看不出某个标签属于哪个 workspace（现在左栏 6 个 workspace 混在一起）。
// 契约（三路并行实现之前先在 Lead 手里定死，实现方只承诺这三条）：
//
// 1. **归属的单一来源是 `useWorkspaces().items` 的 `WorkspaceView.sessionIds`**。`SessionSummary`
//    上没有 `workspaceId`（0.2.1-rc.2 核实），所以不能用 `cwd` 猜、不能按 basename 反推。
// 2. 同一 workspace 的**相邻**标签画一条 2px 的左侧色条（`data-ws` 相同即相邻），颜色取
//    `wsTint(workspaceId, 列表位置)`——不是按 id 哈希，是为了让 6 个 workspace **两两不同色**
//    （6 色相 × 哈希碰撞不可避免），并且**永不落到红色系**（红在 DSH 里表示错误）。
// 3. 新协议字段**只增不改**：`workspaceByTab` / `TabsOp.workspaceId` 都是可选的，
//    旧载荷、旧宿主、没有 workspace 服务时一律退化成本版行为，不报警、不丢标签。

/** 两个 workspace，各两行。 */
function twoWorkspaces() {
  return [
    {
      workspaceId: 'ws-soho',
      title: 'soho',
      path: '/repos/alpha',
      sessionIds: ['A', 'B'],
      createdAt: '',
      updatedAt: '',
    },
    {
      workspaceId: 'ws-lv',
      title: 'lv',
      path: '/repos/client-lv',
      sessionIds: ['C', 'D'],
      createdAt: '',
      updatedAt: '',
    },
  ];
}

/** 点某个标签上的 workspace 徽章（按类名找）。 */
function badgeOf(tab) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && node.props.className === 'dshtabs-ws') found.push(node);
    for (const child of node.children || []) walk(child);
  };
  for (const child of tab.children || []) walk(child);
  return found[0];
}

test('P2-1：workspace 不同的相邻标签之间断开色条，同 workspace 的相邻标签连成一条', () => {
  const workspaces = twoWorkspaces();
  withEnv({ workspaces, sessions: { A: row('A'), B: row('B'), C: row('C'), D: row('D') } }, (environment) => {
    const handle = environment.mount();
    for (const id of ['A', 'B', 'C', 'D']) openInMain(environment, handle, id);
    const list = tabs(handle.tree);
    assert.deepEqual(
      list.map((tab) => tab.props['data-ws']),
      ['ws-soho', 'ws-soho', 'ws-lv', 'ws-lv'],
      '每条标签都要带上自己的 workspace id（data 属性，不新增 DOM 节点）',
    );
    // 连成组 = 与前一个同类时不留缝；组的第一条才是「组首」。
    assert.deepEqual(
      list.map((tab) => tab.props['data-ws-join']),
      [false, true, false, true],
      '相邻且同 workspace 的标签才连起来',
    );
    // 换组的边界上，色条只出现在组首（断开的写法见 CSS），所以这里断言两个组各有一个组首。
    assert.deepEqual(list.map((tab) => (tab.props['data-ws-join'] ? -1 : 1)), [1, -1, 1, -1]);
  });
});

test('P2-1：workspace 徽章显示工作区名，悬停说明带完整路径；没有归属时不画徽章', () => {
  // 会话标题下面还要能一眼看出「属于哪个项目」，所以按 workspace 名给一个短徽章。
  // 归属取自 WorkspaceView.sessionIds，`label` 取 `title`；同一 workspace 的标签共享同一个徽章。
  const workspaces = twoWorkspaces();
  withEnv(
    { workspaces, sessions: { A: row('A'), B: row('B'), C: row('C'), orphan: row('orphan') } },
    (environment) => {
      const handle = environment.mount();
      for (const id of ['A', 'orphan', 'C']) openInMain(environment, handle, id);
      const byTitle = Object.fromEntries(
        tabs(handle.tree).map((tab) => [tab.props.title, tab]),
      );
      assert.equal(badgeOf(byTitle.A).props.children, 'soho');
      assert.equal(badgeOf(byTitle.A).props.title, '/repos/alpha');
      assert.equal(badgeOf(byTitle.C).props.children, 'lv');
      assert.equal(badgeOf(byTitle.orphan), undefined, '不在任何 workspace 里的会话不该有徽章');
    },
  );
});

test('P2-1：没有 workspace 信息时退化成原样渲染，绝不丢标签也不告警', () => {
  // 两种缺失：宿主还没有 workspace 快照（`items: []`）、或整组 hook 都不在。
  for (const options of [{}, { withoutWorkspaceHooks: true }]) {
    withEnv({ ...options, sessions: { A: row('A') } }, (environment) => {
      const handle = environment.mount();
      openInMain(environment, handle, 'A');
      const list = tabs(handle.tree);
      assert.deepEqual(list.map((tab) => tab.props.title), ['A'], '标签必须还在');
      assert.equal(list[0].props['data-ws'], undefined, '没有归属就不写 data-ws');
      assert.equal(badgeOf(list[0]), undefined, '也不该编一个徽章出来');
      assert.equal(environment.warnings.length, 0, '降级路径不告警（缺 workspace 是正常状态）');
    });
  }
});

// ─────────────────── 窄屏降级：当前会话 + 抽屉（P2-2） ───────────────────

/** 按类名找第一个节点（替身没有 CSS 选择器引擎，只能自己走树）。 */
function firstByClass(tree, className) {
  let found;
  const walk = (node) => {
    if (found || !node || typeof node !== 'object') return;
    if (node.props && node.props.className === className) {
      found = node;
      return;
    }
    for (const child of node.children || []) walk(child);
  };
  walk(tree);
  return found;
}

/** 按类名收集所有节点。 */
function allByClass(tree, className) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && node.props.className === className) found.push(node);
    for (const child of node.children || []) walk(child);
  };
  walk(tree);
  return found;
}

const menuOf = (tree) => firstByClass(tree, 'dshtabs-menu');
const sheetOf = (tree) => firstByClass(tree, 'dshtabs-sheet');

/** 点开抽屉。 */
function openSheet(handle) {
  handle.act(() => menuOf(handle.tree).props.onClick({}));
}

test('P2-2：横条自带「≡ N」入口，数量与 dialog 语义都对', () => {
  withEnv({ sessions: { A: row('A'), B: row('B'), C: row('C') } }, (environment) => {
    const handle = environment.mount();
    for (const id of ['A', 'B', 'C']) openInMain(environment, handle, id);
    const menu = menuOf(handle.tree);
    assert.ok(menu, '抽屉入口必须一直在 DOM 里（窄屏才显示，宽屏由 CSS 隐藏）');
    assert.equal(menu.props['aria-haspopup'], 'dialog');
    assert.equal(menu.props['aria-expanded'], 'false');
    assert.equal(menu.props['aria-label'], '打开的会话（3）', '数量要进可访问名，不能只靠 ≡ 3 的字形');
    assert.equal(allByClass(handle.tree, 'dshtabs-menu-count')[0].children.join(''), '≡ 3');
    assert.equal(menu.props.title, '打开的会话（3）', '宽屏鼠标也能问出这个按钮是什么（虽然宽屏不显示它）');
  });
});

test('P2-2：聚合状态点 —— 等待交互 > 已完成未读 > 运行中；全是空闲就一个点都不画', () => {
  const statuses = new Map([
    ['wait', { running: true, pendingInteraction: { key: 'k', kind: 'approval', sessionId: 'wait' }, completionUnread: false }],
    ['done', { running: false, pendingInteraction: undefined, completionUnread: true }],
    ['run', { running: true, pendingInteraction: undefined, completionUnread: false }],
    ['idle', { running: false, pendingInteraction: undefined, completionUnread: false }],
  ]);
  // 三种顺序打开：聚合结果只由「最高优先级」决定，与标签次序无关。
  for (const order of [['done', 'run', 'wait'], ['wait', 'done', 'run'], ['run', 'wait', 'done']]) {
    withEnv({ statuses, sessions: { wait: row('wait'), done: row('done'), run: row('run') } }, (environment) => {
      const handle = environment.mount();
      for (const id of order) openInMain(environment, handle, id);
      const dot = firstByClass(menuOf(handle.tree), 'dshtabs-dot');
      assert.ok(dot, '有 pending 就必须有聚合点');
      assert.equal(dot.props['data-kind'], 'pending');
    });
  }
  withEnv({ statuses, sessions: { run: row('run') } }, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'run');
    assert.equal(firstByClass(menuOf(handle.tree), 'dshtabs-dot').props['data-kind'], 'running', '只有运行中时聚合点是运行中');
  });
  withEnv({ statuses, sessions: { idle: row('idle') } }, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'idle');
    assert.equal(firstByClass(menuOf(handle.tree), 'dshtabs-dot'), undefined, '全是空闲就不画点（不制造「有东西等我」的假象）');
  });
});

test('P2-2：抽屉列出全部标签，当前行标出来，点行切换会话并收起抽屉', () => {
  withEnv({ sessions: { A: row('A'), B: row('B'), C: row('C') } }, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    openInMain(environment, handle, 'B'); // 主区在 B，标签是 [A, B]
    assert.equal(sheetOf(handle.tree), undefined, '抽屉默认不进 DOM');

    openSheet(handle);
    assert.equal(menuOf(handle.tree).props['aria-expanded'], 'true');
    const rows = allByClass(handle.tree, 'dshtabs-row');
    assert.equal(rows.length, 2, '抽屉里一行一个标签');
    assert.equal(rows.filter((item) => item.props['aria-current'] === 'true').length, 1, '当前会话那一行要标出来');
    assert.equal(
      allByClass(rows[0], 'dshtabs-row-main')[0].props.className,
      'dshtabs-row-main',
      '行主体必须是真按钮，不是 div[role=button]（里面有第二个按钮时不能套娃）',
    );

    handle.act(() => allByClass(allByClass(handle.tree, 'dshtabs-row')[0], 'dshtabs-row-main')[0].props.onClick({}));
    assert.deepEqual(environment.calls.openSession, ['A'], '点行切换会话');
    assert.equal(sheetOf(handle.tree), undefined, '切换后抽屉收起');
  });
});

test('P2-2：抽屉行的 × 只关标签、不删会话；关到最后一个时抽屉自动收起', () => {
  withEnv({ sessions: { A: row('A'), B: row('B') } }, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    openInMain(environment, handle, 'B'); // 主区在 B，标签 [A, B]
    openSheet(handle);
    assert.equal(allByClass(handle.tree, 'dshtabs-row').length, 2);

    const stopped = { count: 0, stopPropagation: () => { stopped.count += 1; } };
    handle.act(() => allByClass(handle.tree, 'dshtabs-row-close')[0].props.onClick(stopped));
    assert.equal(stopped.count, 1, '关标签必须拦掉事件，别让点击穿透成「切换会话」');
    assert.deepEqual(titles(handle), ['B'], '标签被移除，会话本身不删');
    assert.equal(environment.calls.openSession.length, 0, '关标签不该触发导航');
    assert.ok(sheetOf(handle.tree), '还剩一个标签，抽屉留着');
    assert.equal(allByClass(handle.tree, 'dshtabs-row').length, 1, '抽屉里的行要跟着集合一起变');
  });
});

test('P2-2：关最后一个标签时抽屉自己收起，不留一个空面板', () => {
  withEnv({ sessions: { A: row('A') } }, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    openSheet(handle);
    assert.equal(allByClass(handle.tree, 'dshtabs-row').length, 1);
    handle.act(() => allByClass(handle.tree, 'dshtabs-row-close')[0].props.onClick({ stopPropagation() {} }));
    assert.deepEqual(titles(handle), [], '标签被移除');
    assert.equal(sheetOf(handle.tree), undefined, '抽屉里已经没东西可点，跟着收起');
  });
});

test('P2-2：Esc 收起抽屉，并把焦点还给入口按钮', () => {
  withEnv({ sessions: { A: row('A') } }, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    openSheet(handle);
    const panel = sheetOf(handle.tree);
    assert.equal(environment.env.focused, panel, '打开时焦点进抽屉（否则 Esc 没人接）');
    assert.equal(panel.props['aria-modal'], 'true');
    assert.equal(panel.props.role, 'dialog');

    let userEscape = false;
    handle.act(() =>
      panel.props.onKeyDown({
        key: 'Escape',
        preventDefault() {
          userEscape = true;
        },
      }),
    );
    assert.equal(userEscape, true, 'Esc 要拦默认行为');
    assert.equal(sheetOf(handle.tree), undefined, 'Esc 收起抽屉');
    assert.equal(
      environment.env.focused && environment.env.focused.props.className,
      'dshtabs-menu',
      '焦点必须还给入口按钮，不能掉回页面顶端',
    );
  });
});

test('P2-2：抽屉第二行写状态文字与 workspace —— 触屏没有悬停，状态不能只藏在 title 里', () => {
  const workspaces = [{ workspaceId: 'w1', title: 'alpha', path: '/repos/alpha', sessionIds: ['A'] }];
  const statuses = new Map([
    ['A', { running: false, pendingInteraction: { key: 'k', kind: 'approval', sessionId: 'A' }, completionUnread: false }],
  ]);
  withEnv({ workspaces, statuses, sessions: { A: row('A') } }, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    openSheet(handle);
    const meta = allByClass(handle.tree, 'dshtabs-row-meta')[0];
    assert.ok(meta, '抽屉行必须有第二行');
    assert.equal(meta.children.join(''), '等待你的回答 · alpha');
  });
});

test('P2-2 / P2-3：0 个标签时抽屉入口不渲染（没有内容可放，也就没有空面板）', () => {
  withEnv({}, (environment) => {
    const handle = environment.mount();
    assert.equal(menuOf(handle.tree), undefined, '0 个标签不该留一个 ≡0 的入口');
    assert.equal(sheetOf(handle.tree), undefined);
  });
});

test('P2-2：窄屏断点只有一个来源，覆盖规则排在桌面规则之后', () => {
  const px = /const NARROW_PX = (\d+);/.exec(SOURCE);
  assert.ok(px, '断点必须是一个具名常量');
  const cssString = /const CSS = \[([\s\S]*?)\]\.join\(''\)/.exec(SOURCE);
  assert.ok(cssString, '应该能在源码里定位到 CSS 常量');
  const css = cssString[1];
  assert.ok(
    css.includes("'@media (max-width:' + NARROW_PX + 'px){'"),
    '媒体查询必须用同一个常量拼，不能另写一个数字（两处写死不同值 = 半个功能）',
  );
  assert.ok(
    /NARROW_QUERY\s*=\s*'\(max-width:'\s*\+\s*NARROW_PX\s*\+\s*'px\)'/.test(SOURCE),
    'JS 侧的 matchMedia 查询也必须由同一个常量拼出来',
  );
  const desktopRule = css.indexOf('.dshtabs-menu{display:none');
  const narrowRule = css.indexOf('@media (max-width:');
  assert.ok(desktopRule >= 0 && narrowRule > desktopRule, '窄屏覆盖必须排在最后：同优先级下靠源码顺序决胜');
  assert.ok(css.includes('.dshtabs-tab:not([aria-selected="true"]){display:none}'), '窄屏必须隐藏非当前标签');
  assert.ok(css.includes('.dshtabs-close{display:none}'), '窄屏横条上不该留 28px 的关闭热区');
});

test('P2-5：抽屉入口在横条左侧（手机单手更好按），且展开/收起是同一个可见按钮', () => {
  withEnv({ sessions: { A: row('A'), B: row('B') } }, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    const root = bar(handle.tree);
    const order = (root.children || []).map((node) => (node && node.props && node.props.className) || '');
    const menuAt = order.indexOf('dshtabs-menu');
    const listAt = order.indexOf('dshtabs-list');
    assert.ok(menuAt >= 0 && listAt >= 0, '横条里得有入口和标签列表');
    assert.ok(menuAt < listAt, '入口必须排在标签列表之前（左侧），否则又回到右下角那颗不好按的按钮');
    assert.equal(menuOf(handle.tree).props['aria-expanded'], 'false');
    openSheet(handle);
    assert.equal(menuOf(handle.tree).props['aria-expanded'], 'true', '展开时按钮要进入按下态（aria-expanded 是可样式化的唯一真相）');
    const sheet = sheetOf(handle.tree);
    assert.ok(sheet, '点一次就该展开');
  });
});

test('P2-5：抽屉自带「收起」按钮——收回不再依赖「点遮罩」这个看不见的动作', () => {
  withEnv({ sessions: { A: row('A'), B: row('B') } }, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    openSheet(handle);
    const close = firstByClass(handle.tree, 'dshtabs-sheet-close');
    assert.ok(close, '面板头部必须有显式关闭按钮');
    assert.equal(close.props['aria-label'], '收起');
    handle.act(() => close.props.onClick({}));
    assert.equal(sheetOf(handle.tree), undefined, '点「收起」面板必须消失');
    assert.equal(menuOf(handle.tree).props['aria-expanded'], 'false');
  });
});

test('P2-5：窄屏抽屉不盖住横条（面板与遮罩都从横条上沿往上长）', () => {
  const css = /const CSS = \[([\s\S]*?)\]\.join\(''\)/.exec(SOURCE)[1];
  assert.ok(
    css.includes("'.dshtabs-scrim{bottom:var(--dsh-tabs-h,48px)}'"),
    '遮罩要给横条让位，否则横条被盖住、收起按钮点不到',
  );
  assert.ok(
    css.includes("'.dshtabs-sheet{bottom:var(--dsh-tabs-h,48px);max-height:calc(64vh - var(--dsh-tabs-h,48px))}'"),
    '面板要落在横条上沿，且最大高度扣掉横条',
  );
  assert.ok(
    css.includes('.dshtabs-menu[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-active)'),
    '展开态必须有一个看得见的外观变化',
  );
});

test('P2-6：viewport meta 只在宿主没声明 interactive-widget 时补', () => {
  const fn = /function withResizesContent\(content\) \{([\s\S]*?)\n    \}/.exec(SOURCE);
  assert.ok(fn, '必须有一个纯函数承载这条规则（离线可测）');
  // 直接从源码里取出函数体求值，避免再造一份实现
  const impl = new Function('content', fn[1]);
  assert.equal(
    impl('width=device-width, initial-scale=1'),
    'width=device-width, initial-scale=1, interactive-widget=resizes-content',
    '宿主没声明时要补上',
  );
  assert.equal(
    impl('width=device-width, initial-scale=1, interactive-widget=resizes-content'),
    'width=device-width, initial-scale=1, interactive-widget=resizes-content',
    '宿主已经声明过就一个字符都不改',
  );
  assert.equal(impl('  '), 'interactive-widget=resizes-content', '空 content 也要给一个合法值');
  assert.ok(
    /ensureViewportMeta\(\);/.test(SOURCE),
    '组件挂载时必须真的调用它（只写函数不接线等于没修）',
  );
});

test('P2-4：窄屏横条挪到底部，顶部整条让给宿主（宿主的侧边栏抽屉开关在左上角）', () => {
  const px = Number(/const NARROW_PX = (\d+);/.exec(SOURCE)[1]);
  assert.equal(px, 767, '断点必须与宿主侧边栏抽屉的分界点对齐（宿主 <768 时侧边栏变离屏抽屉）');
  const css = /const CSS = \[([\s\S]*?)\]\.join\(''\)/.exec(SOURCE)[1];
  // 避让从顶部换到底部：只换一半会得到「内容被顶下去 48px、横条又在底部」这种双重占位。
  assert.ok(
    css.includes("'[data-dsh-tabs]{padding-top:0;padding-bottom:var(--dsh-tabs-h,38px)}'"),
    '窄屏的框架避让必须从 padding-top 换成 padding-bottom',
  );
  assert.ok(
    css.includes('.dshtabs{top:auto;bottom:0;border-top:0.5px solid var(--dsw-alias-border-l2);border-bottom:0}'),
    '窄屏横条必须贴底，并翻转分隔线方向（底边线→顶边线）',
  );
  assert.ok(
    css.includes('env(safe-area-inset-bottom,0px)'),
    '贴底横条要给手势条/刘海留安全区，否则最后一行触区被系统手势吃掉',
  );
});

test('P2-2：当前会话不在集合里时（别的设备把它的标签关了），窄屏仍有一个只读标题兜底', async () => {
  const server = fakeServer();
  const sessions = { A: row('A'), B: row('B') };
  const a = liveEnv({ fetch: server.fetch, localStorage: memoryStorage(), sessions });
  const b = liveEnv({ fetch: server.fetch, localStorage: memoryStorage(), sessions });
  try {
    openInMain(a.environment, a.handle, 'A');
    await settle();
    b.environment.fireWindowEvent('focus');
    await settle();
    b.handle.rerender();
    assert.deepEqual(titles(b.handle), ['A'], 'B 先看到 A 的标签');

    closeTab(b.handle, 0); // 另一台设备把 A 的标签关掉
    await settle();
    a.environment.fireWindowEvent('focus');
    await settle();
    a.handle.rerender();
    assert.deepEqual(titles(a.handle), [], 'A 这一侧的标签确实没了（主区还停在 A 上）');

    // 这正是窄屏会「一条标题都没有」的状态：集合里没有 A，但主区在 A。兜底标题必须补上。
    const stray = firstByClass(bar(a.handle.tree), 'dshtabs-stray');
    assert.ok(stray, '当前会话不在集合里时必须有一个只读标题兜底');
    assert.equal(firstByClass(stray, 'dshtabs-label').children.join(''), 'A');
    assert.equal(firstByClass(stray, 'dshtabs-close'), undefined, '兜底标题不是标签，不该带关闭入口');
    assert.equal(allByClass(stray, 'dshtabs-tab').length, 0);
  } finally {
    b.environment.dispose();
    a.environment.dispose();
  }
});

test('P2-2：窄屏下方向键不把落点搬到看不见的标签上，Delete 仍作用在可见的那条', () => {
  withEnv({ narrow: true, sessions: { A: row('A'), B: row('B') } }, (environment) => {
    const handle = environment.mount();
    openInMain(environment, handle, 'A');
    openInMain(environment, handle, 'B'); // 主区在 B
    const byTitle = () => Object.fromEntries(tabs(handle.tree).map((tab) => [tab.props.title, tab]));
    assert.equal(byTitle().B.props.tabIndex, 0, '可见的当前标签必须是唯一的 Tab 停靠点');
    assert.equal(byTitle().A.props.tabIndex, -1, '看不见的标签不该占着 Tab 停靠点');

    assert.equal(press(handle, 'ArrowRight'), false, '窄屏方向键不该被接管（没有第二个可见标签可去）');
    assert.equal(byTitle().B.props.tabIndex, 0, '落点不能被搬到 display:none 的标签上');

    assert.equal(press(handle, 'Delete'), true, 'Delete 仍然可用');
    assert.deepEqual(titles(handle), ['A'], '关掉的是可见的那条（B），不是看不见的 A');
  });
});
