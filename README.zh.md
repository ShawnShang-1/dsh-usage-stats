# dsh-usage-stats

[English](README.md) | [中文](README.zh.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在**设置**里加一页「使用统计」，把本机会话日志里属于你自己的用量摊开给你看——累计与峰值 Token、聊天时长与连续天数、一整年的 Token 活动日历，以及每个模型的输入/输出/缓存命中率和**消费金额**。

![使用统计图标](icon.svg)

```text
设置 → 使用统计
┌──────────────────────────────────────────────────────────────────┐
│ Token 活动                          [每日]  每周   累计    刷新   │
│                                                                  │
│  ┌───────────┬───────────┬───────────┬───────────┬───────────┐   │
│  │ 5852.8万  │ 5472.3万  │ 30.7 小时 │    2 天   │    2 天   │   │
│  │累计 Token │峰值 Token │最长聊天时长│当前连续天数│最长连续天数│   │
│  └───────────┴───────────┴───────────┴───────────┴───────────┘   │
│                                                                  │
│  ▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢       │
│  ⋮ 53 周 × 7 行，一天一个方格，6 档颜色，↓ 越往下用量越多          │
│  10月   11月   12月    1月    2月   …                        9月  │
│                                                                  │
│  模型明细                                       今日  [累计]      │
│  模型            累计 Token 数   输入    输出   缓存读取  命中率  累计消费 │
│  deepseek-flash      1.2亿     90.6万  53.7万    1.2亿   99.2%    65.5  │
│                                                                  │
│  已扫描 5/5 个会话 · 更新于 20:23                                 │
└──────────────────────────────────────────────────────────────────┘
```

界面文案跟随 UI 语言，上面示意的是中文界面。

## 它显示什么

| 区域 | 内容 |
|---|---|
| 顶部五格 | **累计 Token 数**、**峰值 Token 数**（单日最高，下面标出是哪天）、**最长聊天时长**、**当前连续天数**、**最长连续天数** |
| Token 活动 | 53 周 × 7 行的活动日历，一天一个方格；**每日 / 每周 / 累计** 三种口径；底部按月标注；颜色分 **6 档**，用得越多越深 |
| 模型明细 | 每个模型一行：累计 Token 数、输入、输出、缓存读取、缓存命中率，以及 **今日 / 累计消费**（右上角切换） |

活动日历永远画满最近 **371 天（53 周）**，所以刚开始用时也不会退化成一根竖条——空白日照样是浅色方格。

## 数字怎么算的

用量全部来自本机持久化的会话日志。每条 `assistant/message` 事件都带着 provider 自己上报的 `TokenUsage` 和当时的路由，所以是**精确值**而不是估算：

```text
总 Token   = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
输入       = inputTokens          （未命中缓存的 prompt token）
输出       = outputTokens
缓存读取   = cacheReadTokens
缓存命中率 = cacheReadTokens / (cacheReadTokens + inputTokens)
消费       = Σ_时段 ( 输入 × 单价 + 输出 × 单价 + 缓存读取 × 单价 + 缓存写入 × 单价 ) / 单位
```

几个约定：

- **按本地日历日分桶**（不是 UTC），一天一个索引，所以夏令时切换不会打断连续天数。
- **所有工作区的会话都算**，子代理（subagent）会话也算——它们是真的花了钱。
- 每个样本在折叠时还会按**峰谷时段**（`peak` / `offPeak`）分桶，因为按时段打折的 provider，同样的 token 收不同的钱。折叠本身不知道价格：Host 把分类器传进去，再自己把桶换算成钱，浏览器端拿不到任何单价。

## 消费金额：`prices.json`

单价表就是插件根目录的 [`prices.json`](prices.json)，与 `lib/` 同级。**Host 每次扫描都会重新读它**，所以改完文件、在面板上点一下「刷新」就生效——不用重装、不用刷新页面。

```json
{
  "unit": 1000000,
  "currency": "",
  "offPeakWindow": { "start": "00:30", "end": "08:30", "weekends": true, "utcOffsetMinutes": 480 },
  "models": [
    { "model": "deepseek-flash",
      "input": 2, "cacheRead": 0.5, "output": 8, "cacheWrite": 0,
      "offPeak": { "input": 1, "cacheRead": 0.25, "output": 4, "cacheWrite": 0 } }
  ]
}
```

| 字段 | 含义 |
|---|---|
| `unit` | 单价的分母，默认一百万 token。 |
| `currency` | 金额前缀，默认空字符串——所以面板上只显示纯数字。想显示 `¥` 或 `$` 就填进去。 |
| `offPeakWindow` | 折扣时段，按 **provider 自己的时钟**算。`start` 含、`end` 不含；窗口可以跨零点；`weekends` 为真时周六周日整天算谷时；`utcOffsetMinutes` 指定读哪个时区（480 = UTC+8）。填 `null` 就取消峰谷拆分。 |
| `models[]` | 一行一个模型。`model` 匹配事件里的模型 id；加上 `provider` 就按 `provider/model` 精确匹配。`offPeak` 可选——不写表示这个模型全天都按上面的峰时价。 |
| `config.prices` | profile 补丁里 `config.prices` 数组会追加在文件之后，可以只覆盖某一行而不动插件文件。 |

**匹配不到就显示「—」，绝不猜。** 没配单价的模型会明明白白空着，而不是悄悄按 0 算。

> ⚠️ **仓库里自带的单价是占位值。** 我写这个插件时 `web_fetch` 在沙箱里被拦住了（任何域名都解析到非公网 IP），DSH 自身也不暴露任何金额元数据，所以 `deepseek-flash` = 输入 2 / 缓存命中 0.5 / 输出 8、`deepseek-v4-pro` = 4 / 1 / 16、谷时 5 折与 2.5 折，都是按公开价位的估计值。**请按你自己的账单核对后改掉。** 改动只在 `prices.json` 一个文件里。

## 环境要求

- DeepSeek Harness，且组合里启用了 `ui-settings-general`（桌面版与 `dsh web` 都满足）。
- 已在 DSH `0.2.0-rc.2` / macOS 上验证。

## 安装

### 方式 A：直接从 GitHub 装（不用手动 clone）

让 Harness 里的 agent 执行：

```text
plugin_manager install_bundle  target: github:ShawnShang-1/dsh-usage-stats
```

装完就是最新提交。想升级就重新执行一次。

### 方式 B：先 clone 再本地安装（推荐，我验证过的是这条）

```bash
git clone https://github.com/ShawnShang-1/dsh-usage-stats.git ~/code/dsh-usage-stats
```

然后让 Harness 里的 agent 执行：

```text
plugin_manager install_bundle  target: /Users/你/code/dsh-usage-stats
```

或者，`PATH` 上有 `dsh` 命令时：

```bash
dsh plugin --profile "$DSH_PROFILE" add ~/code/dsh-usage-stats
```

两种方式都一样：包同时声明了 `dsh.bundle.patch`（Host 行）和 `dsh.client`（浏览器 bundle），所以一次安装两半都进。安装通过 HMR 立即生效；**如果设置面板里没出现，重新打开一次设置面板或 `Cmd`/`Ctrl` + `R` 刷新页面。**

### 验证

打开 **设置 → 使用统计**（导航里排在「模型」和「内置插件」之间），应该看到上面那张示意图的内容。

不想开 UI 的话，可以直接打那条 Host 路由——没挂载时前缀会落到 `405`，挂载了但在浏览器信任栅栏后面时是 `401`：

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' \
  http://127.0.0.1:19387/dsh-usage-stats/overview
# 401
```

## 配置

改 profile 的 `cordis.patch.yml` 里这一行，或者在安装时传：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `ttlMs` | `30000` | 一次扫描的结果缓存多久；超时后先返回旧结果、后台重扫。`0` 表示每次都重扫。 |
| `maxSessions` | `4000` | 一次扫描最多折叠多少个会话。 |
| `prices` | — | 追加/覆盖单价行，见上文。 |

```yaml
- id: usage-stats
  name: './lib/entry.js'
  config:
    ttlMs: 30000
    maxSessions: 4000
    prices:
      - model: some-other-model
        input: 1
        cacheRead: 0.2
        output: 4
```

## 卸载

```text
plugin_manager remove_bundle dsh-usage-stats
```

插件目录、`prices.json` 和你的改动都留在原地，想再装回来执行一次安装即可。

## 实现方式

| 半边 | 文件 | 职责 |
|---|---|---|
| Host | `lib/entry.js` | Loader 行的稳定入口。每次激活时按文件版本重新 import `lib/host.js`。 |
| Host | `lib/host.js` | 用 `ctx.sessionQuery` 扫全部会话，用 `lib/fold.js` 折叠，通过组合出来的 webserver 上一条 `/dsh-usage-stats` 前缀路由应答。 |
| Host | `lib/fold.js` | 纯折叠：事件进、聚合 JSON 出，并按时段分桶。不碰 Cordis、不读时钟、不做 I/O。 |
| Host | `lib/pricing.js` | 纯计价：单价文档进，匹配 / 峰谷分类 / 金额出。 |
| Browser | `lib/client.js` | 把「使用统计」页注册进 `settings.section` 插槽，拉路由，渲染聚合结果。 |

路由用 `ctx.connection.admit(req)` 做准入，所以它继承的正是 `/api` 那一套浏览器信任栅栏与持久浏览器会话，然后返回纯 JSON：

```text
POST /dsh-usage-stats/overview   最近一次扫描（必要时后台重扫）
POST /dsh-usage-stats/refresh    强制重扫（面板上的「刷新」）
```

### 为什么入口是个垫片

内置 Loader 会缓存 ESM 模块，缓存键是解析后的完整 URL。所以一个 specifier 从不改变的行，永远执行它第一次 import 进来的那份代码——在运行中的进程里改插件代码等于没改。`lib/entry.js` 因此把 `host.js` / `fold.js` / `pricing.js` 的文件元数据摘要成一个版本号，再用它 import `host.js`，`host.js` 把同一个查询串透传给另外两个模块。整份实现属于同一个缓存代。

```text
改 lib/host.js 或 lib/fold.js 或 lib/pricing.js → 下一次插件激活（或开关一次插件）就生效
改 lib/client.js                              → Host 提供新的 bundle 版本，页面跟随模块图
改 prices.json                                → 面板上点「刷新」即可
改 cordis.patch.yml 或 package.json            → 重装一次 bundle，让 profile 重读补丁层
```

## 离线自检

仓库里带了五个不依赖浏览器和运行中 Host 的检查脚本：

```bash
node scripts/check-fold.mjs        # 折叠 ~/.dsh/sessions，打印聚合结果
node scripts/check-prices.mjs      # 单价匹配、峰谷窗口边界、金额手算
node scripts/check-host.mjs        # 挂载真实的 lib/host.js，驱动一次真实请求
node scripts/check-ui.mjs          # 用桩 React 断言页面元素树
```

真实 DOM 渲染检查需要临时装三个开发依赖（**不是插件的依赖**，装完记得删）：

```bash
npm i --no-save --no-package-lock react@18.3.1 react-dom@18.3.1 jsdom@24
node scripts/check-dom.mjs
rm -rf node_modules package-lock.json
```

其中 `check-host.mjs` 是端到端那个：它把 `lib/host.js` 挂到桩 Cordis 上下文上（`sessionQuery` 直接读本机会话日志），捕获插件注册的路由，真的驱动一次 `POST /dsh-usage-stats/overview`，再用原始单价独立重算每一个金额做比对；另外还塞了一个凌晨 3 点的合成会话，证明谷时确实按折扣价计算。

`check-dom.mjs` 用真实 React 把磁盘上的 `lib/client.js` 渲染进 jsdom，断言五格卡片、371 个日期方格、表格表头、切到「今日」后表头和数字都变化，以及三种聚合对同一批方格着色确实不同。

## 已知限制

- **单价默认为占位值**，见上文；请按实际账单核对。
- 消费金额按 **token 用量** 精算，不含任何 provider 侧的额外计费（例如按次计费、图片按张计费等）。
- 活动日历固定为最近 371 天，更早的历史仍然计入总量与模型明细，但不画在格子里。
- 「最长聊天时长」是单个会话的跨度（首条到最后一条事件），一个挂着的长会话会让这个数字很大。
- 统计完全在本机完成，只读会话日志，不发起任何模型调用，也不联网。
