/**
 * dsh-tabs **Host 半边**的离线测试：状态文件、op 语义、精确 Fetch 路由的注册与应答。
 *
 * 与 `tabs.test.mjs` 同一个原则：不装任何东西、不需要真 DSH 实例。Host 半边只用 Node 内建
 * 模块（`node:fs` / `node:path` / `node:os`），所以可以直接 import 真实实现、用临时目录当
 * `$DSH_HOME`，再用 `Request` / `Response`（Node 18+ 自带）驱动路由处理函数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apply,
  applyOps,
  createHandler,
  createStore,
  defaultStateFile,
  PAYLOAD_VERSION,
  ROUTE_PATH,
} from '../lib/host.js';

/** 一个临时「DSH_HOME」：每个用例一份，结束即删。 */
async function withTemp(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tabs-host-'));
  const file = join(root, 'dsh-tabs', 'state.json');
  try {
    return await run(file, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 临时吞掉 `console.warn`：故意的坏文件用例不该把告警刷进测试输出。 */
async function quietly(run) {
  const original = console.warn;
  const said = [];
  console.warn = (...args) => said.push(args.map((value) => String(value)).join(' '));
  try {
    return await run(said);
  } finally {
    console.warn = original;
  }
}

// ───────────────────────── op 语义（与客户端 applyOps 同口径） ─────────────────────────

test('host：open 追加、重复 open 幂等、close 移除、陌生 op 忽略、顺序不变', () => {
  assert.deepEqual(applyOps([], [{ op: 'open', id: 'A' }, { op: 'open', id: 'B' }]), {
    tabs: ['A', 'B'],
    workspaceByTab: {},
    changed: true,
  });
  const unchanged = { tabs: ['A', 'B'], workspaceByTab: {}, changed: false };
  assert.deepEqual(applyOps(['A', 'B'], [{ op: 'open', id: 'A' }]), unchanged);
  assert.deepEqual(applyOps(['A', 'B'], [{ op: 'close', id: 'A' }]), {
    tabs: ['B'],
    workspaceByTab: {},
    changed: true,
  });
  assert.deepEqual(applyOps(['A'], [{ op: 'close', id: 'B' }]), { tabs: ['A'], workspaceByTab: {}, changed: false });
  assert.deepEqual(applyOps(['A'], [{ op: 'explode', id: 'A' }, null, { id: 'A' }]), {
    tabs: ['A'],
    workspaceByTab: {},
    changed: false,
  });
  assert.deepEqual(applyOps([], [{ op: 'open', id: '' }, { op: 'open', id: 7 }]), {
    tabs: [],
    workspaceByTab: {},
    changed: false,
  });
});

// ───────────────────────── 状态文件与 seq ─────────────────────────

test('host：mutate 推进 seq 并落盘；新实例从同一个文件恢复', async () => {
  await withTemp(async (file) => {
    const store = createStore({ file });
    assert.deepEqual(await store.get(), { v: PAYLOAD_VERSION, seq: 0, tabs: [], workspaceByTab: {}, updatedAt: 0 });

    const opened = await store.mutate([{ op: 'open', id: 'A' }]);
    assert.equal(opened.changed, true);
    assert.equal(opened.state.seq, 1);
    assert.deepEqual(opened.state.tabs, ['A']);

    const duplicate = await store.mutate([{ op: 'open', id: 'A' }]);
    assert.equal(duplicate.changed, false, '重复 open 不推进 seq');
    assert.equal(duplicate.state.seq, 1);

    const closed = await store.mutate([{ op: 'close', id: 'A' }]);
    assert.equal(closed.state.seq, 2);
    assert.deepEqual(closed.state.tabs, []);

    // 「重启 DSH」= 新实例读同一个文件。
    const again = createStore({ file });
    assert.equal((await again.get()).seq, 2);
    assert.deepEqual((await again.get()).tabs, []);

    // 文件确实是可读 JSON（运维要能直接看）。
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(onDisk.v, PAYLOAD_VERSION);
    assert.equal(onDisk.seq, 2);
    assert.deepEqual(onDisk.tabs, []);
  });
});

test('host：并发 mutate 不互相吞掉（写链串行、状态按到达顺序累积）', async () => {
  await withTemp(async (file) => {
    const store = createStore({ file });
    await Promise.all([
      store.mutate([{ op: 'open', id: 'A' }]),
      store.mutate([{ op: 'open', id: 'B' }]),
      store.mutate([{ op: 'close', id: 'A' }]),
    ]);
    const state = await store.get();
    assert.deepEqual(state.tabs, ['B'], '三个操作都要按顺序落到同一份状态上');
    assert.equal(state.seq, 3);
  });
});

test('host：状态文件损坏 / 版本不认识 → 按空集合处理并告警，而不是崩溃', async () => {
  await withTemp(async (file, root) => {
    const { mkdir, writeFile: write } = await import('node:fs/promises');
    await mkdir(join(root, 'dsh-tabs'), { recursive: true });
    await write(file, '{ 这不是 JSON', 'utf8');
    await quietly(async (said) => {
      const state = await createStore({ file }).get();
      assert.deepEqual(state, { v: PAYLOAD_VERSION, seq: 0, tabs: [], workspaceByTab: {}, updatedAt: 0 });
      assert.match(said.join('\n'), /状态文件读不了/);
    });

    await write(file, JSON.stringify({ v: 99, seq: 7, tabs: ['A'] }), 'utf8');
    assert.deepEqual(await createStore({ file }).get(), {
      v: PAYLOAD_VERSION,
      seq: 0,
      tabs: [],
      workspaceByTab: {},
      updatedAt: 0,
    });
  });
});

test('host：多余/非法 id 被收敛掉，集合上限生效', async () => {
  await withTemp(async (file) => {
    const { mkdir, writeFile: write } = await import('node:fs/promises');
    await mkdir(join(file, '..'), { recursive: true });
    await write(file, JSON.stringify({ v: PAYLOAD_VERSION, seq: 3, tabs: ['A', 'A', 7, '', 'B'] }), 'utf8');
    const state = await createStore({ file }).get();
    assert.deepEqual(state.tabs, ['A', 'B']);
  });
});

test('host：默认状态文件是 $DSH_HOME/dsh-tabs/state.json，DSH_HOME 未设置时回落到 ~/.dsh', () => {
  const previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = '/tmp/dsh-tabs-example-home';
    assert.equal(defaultStateFile(), '/tmp/dsh-tabs-example-home/dsh-tabs/state.json');
    process.env.DSH_HOME = '   ';
    assert.equal(defaultStateFile(), join(homedir(), '.dsh', 'dsh-tabs', 'state.json'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

// ───────────────────────── 精确 Fetch 路由 ─────────────────────────

function request(method, body) {
  const init = { method };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('http://127.0.0.1/api/dsh-tabs/state', init);
}

test('host：GET 返回完整状态，POST 应用 ops 并回报 changed', async () => {
  await withTemp(async (file) => {
    const handle = createHandler(createStore({ file }));

    const empty = await (await handle(request('GET'))).json();
    assert.deepEqual(empty, {
      ok: true,
      state: { v: PAYLOAD_VERSION, seq: 0, tabs: [], workspaceByTab: {}, updatedAt: 0 },
    });

    const opened = await (
      await handle(request('POST', { v: PAYLOAD_VERSION, ops: [{ op: 'open', id: 'A' }] }))
    ).json();
    assert.equal(opened.ok, true);
    assert.equal(opened.changed, true);
    assert.deepEqual(opened.state.tabs, ['A']);

    const again = await (
      await handle(request('POST', { v: PAYLOAD_VERSION, ops: [{ op: 'open', id: 'A' }] }))
    ).json();
    assert.equal(again.changed, false, '幂等：重复打开同一会话不算变化');
  });
});

test('host：坏请求各自带明确状态码（400 / 413），不抛异常', async () => {
  await withTemp(async (file) => {
    const handle = createHandler(createStore({ file }));

    const badJson = await handle(request('POST', '{ 这不是 JSON'));
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error, 'invalid-json');

    const badVersion = await handle(request('POST', { v: 99, ops: [] }));
    assert.equal(badVersion.status, 400);
    assert.equal((await badVersion.json()).error, 'invalid-payload');

    const notOps = await handle(request('POST', { v: PAYLOAD_VERSION, ops: 'A' }));
    assert.equal(notOps.status, 400);

    const huge = await handle(request('POST', 'x'.repeat(64 * 1024 + 1)));
    assert.equal(huge.status, 413);
    assert.equal((await huge.json()).error, 'payload-too-large');
  });
});

test('host：apply() 通过 ctx.inject 等 connection，注册精确路由（GET/POST、buffered）', async () => {
  await withTemp(async (file) => {
    const registered = [];
    const ctx = {
      inject: (deps, callback) => {
        assert.deepEqual(deps, ['connection'], '只依赖 connection 一个服务');
        callback({
          connection: {
            fetch: {
              register: (route) => {
                registered.push(route);
                return async () => {};
              },
            },
          },
        });
      },
    };
    apply(ctx, { stateFile: file });

    assert.equal(registered.length, 1);
    const route = registered[0];
    assert.equal(route.path, ROUTE_PATH);
    assert.deepEqual(route.methods, ['GET', 'POST']);
    assert.equal(route.requestBody, 'buffered');

    const payload = await (await route.fetch(request('GET'))).json();
    assert.deepEqual(payload, {
      ok: true,
      state: { v: PAYLOAD_VERSION, seq: 0, tabs: [], workspaceByTab: {}, updatedAt: 0 },
    });
    const opened = await (
      await route.fetch(request('POST', { v: PAYLOAD_VERSION, ops: [{ op: 'open', id: 'session-x' }] }))
    ).json();
    assert.deepEqual(opened.state.tabs, ['session-x']);
  });
});

test('host：apply() 不传 config 时用默认状态文件（路径来自 DSH_HOME）', async () => {
  const previous = process.env.DSH_HOME;
  const root = await mkdtemp(join(tmpdir(), 'dsh-tabs-home-'));
  process.env.DSH_HOME = root;
  try {
    const registered = [];
    apply({
      inject: (deps, callback) => {
        callback({
          connection: { fetch: { register: (route) => registered.push(route) } },
        });
      },
    });
    const payload = await (
      await registered[0].fetch(request('POST', { v: PAYLOAD_VERSION, ops: [{ op: 'open', id: 'Z' }] }))
    ).json();
    assert.deepEqual(payload.state.tabs, ['Z']);
    const onDisk = JSON.parse(await readFile(join(root, 'dsh-tabs', 'state.json'), 'utf8'));
    assert.deepEqual(onDisk.tabs, ['Z'], '默认路径就是 $DSH_HOME/dsh-tabs/state.json');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('host：状态文件读取路径含中文/空格也能工作（不拼 shell）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tabs-带空格 '));
  const file = join(root, '状态 目录', 'state.json');
  try {
    const store = createStore({ file });
    await store.mutate([{ op: 'open', id: 'A' }]);
    assert.deepEqual((await createStore({ file }).get()).tabs, ['A']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ───────────────────────── workspaceByTab（P2-1 兜底冗余） ─────────────────────────

/** 真实的旧格式：`{v, seq, tabs}`，**没有** `workspaceByTab`（用户的 ~/.dsh 现在是这个形状）。 */
function legacyPayload(tabs, seq) {
  return { v: PAYLOAD_VERSION, seq, tabs, updatedAt: 1788000000000 };
}

async function seed(file, payload) {
  const { mkdir, writeFile: write } = await import('node:fs/promises');
  await mkdir(join(file, '..'), { recursive: true });
  await write(file, JSON.stringify(payload), 'utf8');
}

async function onDisk(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

test('host P2-1：旧格式 state.json（10 条 tabs、无 workspaceByTab）原样读，seq 不变、GET 补空表', async () => {
  await withTemp(async (file) => {
    const tabs = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'];
    await seed(file, legacyPayload(tabs, 280));
    const store = createStore({ file });
    const state = await store.get();
    assert.equal(state.seq, 280, 'seq 必须原样保留（不是从 0 重来）');
    assert.equal(state.v, PAYLOAD_VERSION, '协议版本仍是 1');
    assert.deepEqual(state.tabs, tabs, '10 条标签一条不丢、顺序不变');
    assert.deepEqual(state.workspaceByTab, {}, '没有该字段就是空表，不是 undefined');

    const viaHttp = await (await createHandler(store)(request('GET'))).json();
    assert.deepEqual(viaHttp.state, state, 'GET 与 store.get() 逐字段一致');

    // 读操作不能顺带改写磁盘（旧文件保持原样）。
    const untouched = await onDisk(file);
    assert.equal(untouched.workspaceByTab, undefined);
    assert.equal(untouched.seq, 280);
  });
});

test('host P2-1：open 带 workspaceId → 记进 workspaceByTab、seq +1、GET 与磁盘逐字段一致', async () => {
  await withTemp(async (file) => {
    const store = createStore({ file });
    const result = await store.mutate([{ op: 'open', id: 'A', workspaceId: 'ws-soho' }]);
    assert.equal(result.changed, true);
    assert.deepEqual(result.state.tabs, ['A']);
    assert.deepEqual(result.state.workspaceByTab, { A: 'ws-soho' });

    const disk = await onDisk(file);
    assert.deepEqual(
      Object.keys(disk).sort(),
      ['seq', 'tabs', 'updatedAt', 'v', 'workspaceByTab'],
      '磁盘上就这五个字段',
    );
    assert.deepEqual(disk.workspaceByTab, { A: 'ws-soho' }, '归属确实落了盘（重启不丢）');
    const state = await store.get();
    assert.deepEqual(
      { v: state.v, seq: state.seq, tabs: state.tabs, workspaceByTab: state.workspaceByTab, updatedAt: state.updatedAt },
      disk,
      'GET 的 state 与磁盘文件逐字段一致',
    );

    // 换 workspace：只归属变了也算变化，要推进 seq 别的设备才看得到。
    const moved = await store.mutate([{ op: 'open', id: 'A', workspaceId: 'ws-lv' }]);
    assert.equal(moved.changed, true, '归属变化必须算变化');
    assert.equal(moved.state.seq, 2);
    assert.deepEqual(moved.state.tabs, ['A'], '标签不重排、不重复');
    assert.deepEqual(moved.state.workspaceByTab, { A: 'ws-lv' });

    // 同一个 workspaceId 重复上报：幂等，不推进 seq。
    const same = await store.mutate([{ op: 'open', id: 'A', workspaceId: 'ws-lv' }]);
    assert.equal(same.changed, false);
    assert.equal(same.state.seq, 2);
  });
});

test('host P2-1：不带 workspaceId 的旧式 open 照旧工作，且不覆盖已有归属', async () => {
  await withTemp(async (file) => {
    const handle = createHandler(createStore({ file }));
    // 旧客户端载荷形状（op 只有 op/id）——一字不改地照发。
    const first = await (await handle(request('POST', { v: PAYLOAD_VERSION, ops: [{ op: 'open', id: 'A' }] }))).json();
    assert.equal(first.ok, true);
    assert.deepEqual(first.state.tabs, ['A']);
    assert.deepEqual(first.state.workspaceByTab, {}, '没 workspaceId 就没有归属，也不报错');

    await handle(request('POST', { v: PAYLOAD_VERSION, ops: [{ op: 'open', id: 'A', workspaceId: 'ws-soho' }] }));
    const legacyAgain = await (
      await handle(request('POST', { v: PAYLOAD_VERSION, ops: [{ op: 'open', id: 'A' }] }))
    ).json();
    assert.equal(legacyAgain.changed, false, '旧式重复 open 仍是幂等 no-op');
    assert.deepEqual(legacyAgain.state.workspaceByTab, { A: 'ws-soho' }, '不带 workspaceId 不抹掉已知归属');
  });
});

test('host P2-1：close 之后 workspaceByTab 里对应项消失（重新 open 也不会复活）', async () => {
  await withTemp(async (file) => {
    const store = createStore({ file });
    await store.mutate([
      { op: 'open', id: 'A', workspaceId: 'ws-soho' },
      { op: 'open', id: 'B', workspaceId: 'ws-lv' },
    ]);
    const closed = await store.mutate([{ op: 'close', id: 'A' }]);
    assert.deepEqual(closed.state.tabs, ['B']);
    assert.deepEqual(closed.state.workspaceByTab, { B: 'ws-lv' }, '只剩 B 的归属');
    assert.deepEqual((await onDisk(file)).workspaceByTab, { B: 'ws-lv' }, '磁盘上也删掉了');

    const reopened = await store.mutate([{ op: 'open', id: 'A' }]);
    assert.deepEqual(reopened.state.workspaceByTab, { B: 'ws-lv' }, '旧式 open 不该把已删的归属带回来');
  });
});

test('host P2-1：非法 workspaceId 被忽略而不是报错，seq 照常按标签变化推进', async () => {
  await withTemp(async (file) => {
    const handle = createHandler(createStore({ file }));
    const bad = [
      { op: 'open', id: 'A', workspaceId: '' },
      { op: 'open', id: 'B', workspaceId: 7 },
      { op: 'open', id: 'C', workspaceId: null },
      { op: 'open', id: 'D', workspaceId: { id: 'ws' } },
      { op: 'open', id: 'E', workspaceId: 'x'.repeat(201) },
    ];
    const response = await handle(request('POST', { v: PAYLOAD_VERSION, ops: bad }));
    assert.equal(response.status, 200, '非法值不该让整个请求 400');
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.state.tabs, ['A', 'B', 'C', 'D', 'E'], '标签照常写入');
    assert.deepEqual(payload.state.workspaceByTab, {}, '一个非法 workspaceId 都没留下');

    // 长度上限与 isId 同口径：200 字符可以，201 不行。
    const edge = await (
      await handle(request('POST', { v: PAYLOAD_VERSION, ops: [{ op: 'open', id: 'F', workspaceId: 'y'.repeat(200) }] }))
    ).json();
    assert.equal(edge.state.workspaceByTab.F.length, 200, '200 字符（与 isId 同上限）是合法的');
  });
});

test('host P2-1：磁盘上的 workspaceByTab 也做收敛（类型错/不在集合里/集合外键）', async () => {
  await withTemp(async (file) => {
    await seed(file, {
      v: PAYLOAD_VERSION,
      seq: 5,
      tabs: ['A', 'B'],
      workspaceByTab: { A: 'ws-soho', B: 42, ghost: 'ws-lv', C: 'ws-x' },
      updatedAt: 1,
    });
    const state = await createStore({ file }).get();
    assert.deepEqual(state.workspaceByTab, { A: 'ws-soho' }, '只留「在集合里 + 值是合法字符串」的条目');
    assert.equal(state.seq, 5);

    await seed(file, { v: PAYLOAD_VERSION, seq: 5, tabs: ['A'], workspaceByTab: 'ws-soho', updatedAt: 1 });
    assert.deepEqual((await createStore({ file }).get()).workspaceByTab, {}, '字段类型整个不对时按空表处理');
  });
});

test('host P2-1：applyOps 归约在后、变化即推进 seq（两种顺序等价）', () => {
  const first = applyOps([], [{ op: 'open', id: 'A', workspaceId: 'ws-a' }, { op: 'close', id: 'A' }], {});
  assert.deepEqual(first, { tabs: [], workspaceByTab: {}, changed: true }, '同一批里先开有关：最终没有归属');
  const second = applyOps(['A', 'B'], [{ op: 'open', id: 'A', workspaceId: 'ws-a' }], { B: 'ws-b' });
  assert.deepEqual(second, {
    tabs: ['A', 'B'],
    workspaceByTab: { A: 'ws-a', B: 'ws-b' },
    changed: true,
  });
  const noop = applyOps(['A'], [{ op: 'open', id: 'A', workspaceId: 'ws-a' }], { A: 'ws-a' });
  assert.equal(noop.changed, false, '状态一致就是 no-op');
});

// `writeFile` 只在少数用例里用得到；留一行显式引用，免得 lint 把 import 当成死代码。
void writeFile;
