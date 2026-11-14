# dsh-synced-tabs

> DeepSeek Harness（DSH）Web GUI 的会话标签栏：把「打开过的会话」变成一条显式的活跃集合，并且**在同一宿主的多个设备之间共享**。

[English](README.en.md) · MIT · 需要 DSH `>= 0.2.0-rc.2`（peer 下限；逐版本实测见 [COMPATIBILITY.md](COMPATIBILITY.md)）

[![CI](https://github.com/mujiannan/dsh-synced-tabs/actions/workflows/ci.yml/badge.svg)](https://github.com/mujiannan/dsh-synced-tabs/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-synced-tabs)](https://www.npmjs.com/package/dsh-synced-tabs)
[![license](https://img.shields.io/npm/l/dsh-synced-tabs)](LICENSE)

## 它解决什么

- **会话太多**：DSH 的会话从左侧栏打开，切走之后就没有「现在开着哪几个」的显式视图。这里给你一条标签栏。
- **多设备**：在电脑上关掉的标签，手机上不该还在；手机上新开的会话，电脑上应当几秒内出现。标签是**共享集合**，不是本地视图。
- **手机**：触屏没有悬停，标签栏挤在顶部一条里既看不清点不准。窄屏降到「当前会话 + 抽屉」，横条贴底。
- **状态**：哪条会话在跑、哪条在等你回答、哪条完成未读——标签上有点，抽屉入口上还有聚合状态。

## 与「再写一个标签栏」不同的地方

- **跨设备共享**是核心设计，不是附加项：宿主侧提供一个精确的 `GET/POST /api/dsh-tabs/state` 路由，
  状态落 `$DSH_HOME/dsh-tabs/state.json`；客户端乐观更新 + 补发队列 + 3 秒轮询，断网退回本地模式并在恢复后自动补发。
- **手机是一等公民**：窄屏横条贴底、左下手势区开抽屉、抽屉不盖横条、开软键盘把布局视口压下去（`interactive-widget=resizes-content`）——每条都有真机读数支撑，见 [COMPATIBILITY.md](COMPATIBILITY.md)。
- **零侵入**：只挂官方 `shell.overlay` 槽位，只用自己的 data 属性、一个 CSS 变量和一条精确路由；不改宿主任意文件，卸载清理干净。单文件客户端、无构建、无运行时依赖（peer 只有 DSH 官方包与 `react`）。
- **可验证**：75 条离线测试直接执行真实 `client.js` 字节（不需要浏览器、不需要 DSH 实例）；每个 DSH 版本的实测读数记录在兼容性表里。

## 安装

```bash
dsh plugin --profile web add dsh-synced-tabs
```

装完重启（或让宿主重载插件）即可在 Web GUI 顶部看到标签栏。卸载：

```bash
dsh plugin --profile web remove dsh-synced-tabs
```

## 用法

| 操作 | 桌面 | 手机 |
|---|---|---|
| 切换会话 | 点标签 / 方向键（`←` `→` 在标签间移动，`Alt+Shift+←/→` 调序） | 点标签；或点横条左下的 `≡ N` 打开抽屉 |
| 关闭标签 | 标签上的 `×`；或中键点标签；或聚焦后 `Delete`/`Backspace` | 抽屉行右侧的 `×` |
| 看状态 | 标签上的状态点（运行中 / 等待回答 / 完成未读），悬停有文字说明 | 抽屉每行第二行直接写状态 + workspace 名 |
| 辨认归属 | 标签左内侧的 workspace 色条 + 徽章，同组标签连缝 | 抽屉行左侧色条 + 第二行的 workspace 名 |

关标签**不会**删除、归档或停止会话——它只是从共享集合里移除。

## 跨设备同步：边界与降级

- 范围是**同一个 DSH 宿主实例**下的多个浏览器/设备（同一 `$DSH_HOME`）。不是跨实例同步。
- 客户端与宿主之间是「精确路由 + 轮询」而不是 WebSocket/事件流：标签变更是低频事件，3 秒轮询足够，
  且能在宿主重启、网络闪断后自愈。
- 宿主端点不可用（旧宿主 / 未加载 Host 半边）时，客户端退回**本设备本地模式**，恢复后按队列补发。
- 冲突规则、`seq` 语义、状态文件格式见 [docs/DESIGN.md](docs/DESIGN.md) §4.8。

## 兼容性

DSH 的客户端 API 仍在快速演进，每个版本都要重新验收。逐版本的实测结论（横条高度、抽屉矩形、真机读数、
测试通过数）见 [COMPATIBILITY.md](COMPATIBILITY.md)；没测过的版本写「未验证」，不做推测。

## 开发

```bash
npm test        # 75 条离线测试：在 node:vm 里执行真实 client.js，配一个最小 React 替身与假 DOM
```

仓库结构：

```
client.js             客户端半边（单文件，无构建）
index.js              宿主半边的入口
lib/host.js           宿主半边：状态文件 + /api/dsh-tabs/state 精确路由
lib/client.d.ts       宿主契约类型（依赖哪些 API、哪个版本提供）
cordis.patch.yml      只插入一行插件挂载
docs/DESIGN.md        设计记录：为什么这么写、踩过的坑、预算与维护约束
COMPATIBILITY.md      逐 DSH 版本的实测表
test/                 离线测试（harness 执行真实源码）
```

**内部标识为什么还带 `dsh-tabs` 前缀**：这条插件早于改名就已部署，`data-dsh-tabs` / `--dsh-tabs-h` /
`/api/dsh-tabs/state` 与 `$DSH_HOME/dsh-tabs/state.json` 是已有实例的数据与挂载契约，改名会丢共享集合。
对外只有包名、插件 id、客户端注册 id 与文档使用 `dsh-synced-tabs`——**客户端注册 id
（`__ModuleLoader__.load({id})`）必须等于包名**，它是 boot graph 的行键（见 `docs/DESIGN.md` §7.10）。

## 范围（明确不做）

- 不新建会话（用宿主自带的入口）。
- 不 hook 会话生命周期；关标签不动会话。
- 不做拖拽排序 / pin / 归档 / 分屏——当前版本的取舍是「一条能跨设备对齐的标签栏」。
- 不做跨宿主实例（两台机器各跑一个 DSH）的同步。

## 许可

MIT，见 [LICENSE](LICENSE)。
