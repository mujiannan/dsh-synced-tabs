# 开发与发布

> 改代码、跑测试、发版与 DSH 升级后的检查单。架构与宿主契约见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 1. 结构

```
client.js          客户端半边（单文件、无构建、无运行时依赖）
index.js           bundle 入口：加载 Host 半边
lib/host.js        宿主半边：状态文件 + /api/dsh-tabs/state
lib/client.d.ts    宿主契约类型（依赖哪些 API、哪一版提供）
cordis.patch.yml   bundle 补丁：插入一行插件挂载，无 config
test/              node:test 离线测试
docs/              架构与开发文档
COMPATIBILITY.md   逐 DSH 版本的实测表（发版与升级的依据）
```

## 2. 约束

- **零运行时依赖**：`dependencies` 保持为空。peer 只有 DSH 官方包与 `react`，且全部 optional——
  这些包由宿主的安装树或浏览器侧平台提供，不由本包安装。
- **零构建**：发布的就是仓库里的字节，`files` 白名单决定 npm 载荷。
- **一个包一个客户端 bundle**：不能拆多个客户端文件，理由见 [ARCHITECTURE.md](ARCHITECTURE.md) §5。
- **只挂官方接缝**、不匹配 CSS Module 类名，见 [ARCHITECTURE.md](ARCHITECTURE.md) §2。

## 3. 测试

```bash
npm test
```

`test/harness.mjs` 用 `node:vm` 执行**真实的 `client.js` 字节**，截下它注册的工厂，配一个最小的 React
替身与假 DOM，覆盖渲染、切换、关闭、键盘、降级、迁移、跨设备同步，以及注册 id 与包名一致。

一条边界：离线测试证明结构与状态，证明不了 CSS 与定位；后者由 `COMPATIBILITY.md` 里真实实例 +
无头浏览器的读数负责。两者不能互相替代。

## 4. 发版

- **peer 下限 = 有 P0 实测证据的最低 DSH 版本**，不写「什么都兼容」。要放宽下限，先在目标版本上实测。
- 发布走 npm 可信发布（tag 驱动 CI），`prepublishOnly` 跑全量测试；npm 载荷由 `files` 白名单决定。
- 发版前：`npm test` 全绿，且 `COMPATIBILITY.md` 对目标 DSH 版本有一行实测记录。

## 5. 每次 DSH 升级后

1. 在目标版本上跑 P0 清单：横条几何与 `--dsh-tabs-h`、抽屉与遮罩矩形、`elementFromPoint` 命中、
   `aria-expanded` 状态、键盘路径。
2. 把读数写进 `COMPATIBILITY.md` 的新行；没测过的版本写「未验证」，不要用「应该没问题」代替。
3. 若宿主的客户端 API 有破坏性变化，先改代码，再重复第 1 步。

## 6. 参考资料

- DSH 本体：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- 用到的宿主包：`dsh-client-ui-layout`（`shell.overlay` 槽位与框架节点）、
  `dsh-client-ui-session`（`useSessions` / `useSessionStatus`）、
  `dsh-client-ui-workspace`（`uiWorkspace` / `useWorkspaces`）
- 精确 Fetch 路由与鉴权：`dsh-client-connection` 的 Host 半边
