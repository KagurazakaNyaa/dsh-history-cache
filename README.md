# dsh-history-cache

一个 DSH Web 前端插件：**切换会话时不再重新从后端拉取会话历史**。

## 它解决什么

DSH Web 的主视图在切换会话时会释放上一个会话的引用。引用数归零后，客户端会销毁该会话实例、关闭它的事件流并丢掉已经加载的历史窗口；再切回去时只能重新向后端请求一次历史页（`session.follow` 的 opening snapshot）。会话越多、来回切换越频繁，重复拉取就越多。

本插件在浏览器里为**最近打开过的会话**额外持有一个 `historyCache` 引用，并限制在 6 个（LRU）：

- 切走时上一个会话不会因引用归零而被销毁，历史窗口留在内存里；
- 切回来时直接复用已经打开的窗口，**不再发起历史拉取**；
- 超出上限时按最久未使用淘汰，淘汰后恢复原生行为；
- 正在运行 Agent 的会话不驻留（后台 token 流本身就在产生流量，驻留反而更费网络）。

纯前端实现，不改后端、不写会话日志。

## 安装

包名：`@kagurazakanyaa/dsh-history-cache`

这是一个 DSH bundle：在 DSH 的插件管理器里安装该 bundle 即可（安装后由 profile 的 bundle 列表启用）。安装会插入一条 Host 插件行；行为全部在 `client.js`，随页面加载生效。

## 可调项

插件通过 `localStorage` 暴露两个无需重启的设置：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `dsh-history-cache:max` | `6` | 最多保留多少个会话窗口；`0` 等于关闭缓存 |
| `dsh-history-cache:disabled` | `false` | 设为 `true` 可临时完全禁用 |

修改后刷新页面生效。

## 发布

版本标签驱动，推 tag 即发布（GitHub Actions → npm Trusted Publishing / OIDC，**无需 NPM_TOKEN**）：

```sh
npm version patch        # 或 minor / major：改 package.json 并打 tag
git push --follow-tags
```

`publish.yml` 会校验 tag 与 `package.json` 版本一致、跑测试，再执行 `npm publish --access public`；`test.yml` 在 main 和 PR 上跑 Node 20/22 × 三平台。npm 侧只需配置一次 trusted publisher：

| 字段 | 值 |
| --- | --- |
| Organization or user | `KagurazakaNyaa` |
| Repository | `dsh-history-cache` |
| Workflow filename | `publish.yml` |
| Allowed actions | 勾选 `npm publish`（不要只开 stage publish） |

OIDC 只对已存在的包生效，所以第一次发布需要手动完成。

## 限制

- 缓存只在当前页面生命周期内有效；刷新页面后首次打开会话仍会拉取（这是客户端内存缓存，不是持久化缓存）。
- 被淘汰的会话、正在运行的会话以及宿主重启/重连后的会话仍按原生行为重新拉取。
- 只影响 Web 前端的会话切换；其他客户端不受影响。

## 结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | bundle 清单（`dsh.bundle` + `dsh.client`） |
| `cordis.patch.yml` | 插入 Host 插件行 |
| `index.js` | Host 半边（空实现，仅让浏览器扫描发现 `dsh.client`） |
| `client.js` | 浏览器半边：LRU 驻留与释放会话引用 |
| `locale/*.json` | 插件管理器里显示的名称与描述 |
| `icon.svg` | 插件图标 |

## License

AGPL-3.0-or-later，见 [LICENSE](LICENSE)。
