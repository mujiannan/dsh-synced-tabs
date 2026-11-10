/**
 * dsh-synced-tabs Host 半边：只做一件事 —— 在 DSH 宿主上提供**跨设备共享的标签集合**。
 *
 * 实现与协议说明见 `lib/host.js`（状态文件、`/api/dsh-tabs/state` 精确路由、冲突规则）。
 * 客户端半边（`client.js`）是纯浏览器代码；两边共用同一份协议版本号。
 *
 * 为什么会从「纯客户端插件」长出一个宿主半边：标签集合原先存在 `localStorage` 里，
 * 天然按设备隔离，导致电脑上关掉的会话在手机上仍然显示为「开着」。要跨设备就需要一个
 * 宿主侧的共享介质；DSH 没有给插件用的通用 KV 服务，官方允许的落点是
 * `ctx.connection.fetch.register()`（精确 Fetch 路由）＋ 本插件自己的状态文件。
 *
 * 宿主契约（两边用到的全部接缝）见 `lib/client.d.ts`。
 */

export { apply } from './lib/host.js';
