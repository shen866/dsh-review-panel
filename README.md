# dsh-code-review

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：收集当前仓库的代码变更，在右侧栏提供「代码变更」面板，并支持一键发起独立智能体检视。

## 组成（一个 bundle，两个入口）

- **`ReviewPanelService`（`src/service/`，类形态，入口 `.`）**：以 `reviewPanel` 服务名注册。核心方法 `collect(options)` 返回 `ChangeSet`（变更文件列表 + unified diff）。
- **web 后端（`src/web/`，函数形态，入口 `./web`）**：通过可选依赖 `webServer` 注册 JSON API。`session` 是浏览器会话 id，服务端经可选依赖 `workspaceRegistry`（按请求惰性解析）映射为该会话工作区的仓库路径；不传时回退 `process.cwd()`。
  - `GET /review-panel/api/changes?scope=&ref=&base=&session=` — 收集 diff（对不匹配的 method 返回 405）
  - `GET /review-panel/api/models` — 可检视模型目录（注册的 provider + 各 provider 的模型目录 + 宿主默认模型）；模型服务不可用时返回 503
  - `POST /review-panel/api/review/start?session=&provider=&model=` — 发起独立智能体检视（`provider`/`model` 可选但必须成对，缺省用宿主默认模型；同一仓库同时只跑一个，重复调用返回同一个 run；只接受 POST，否则 405）
  - `GET /review-panel/api/review/status?id=` — 轮询检视状态与结论（含实际使用的 `model`、结构化 `findings` 与 `verdict`）
  - `GET /review-panel/api/review/latest?session=` — 该仓库最近一次检视：有进行中的 run 优先返回（前端可恢复轮询），否则返回持久化的最新记录，两者皆无返回 404
  - `POST /review-panel/api/commit/start?session=&push=&provider=&model=` — 自动生成 commit 信息并提交全部变更（`push=1`/`true` 同时推送；`provider`/`model` 规则同检视；同一仓库同时只跑一个）
  - `GET /review-panel/api/commit/status?id=` — 轮询提交结果（`message`、`commit` 短哈希、`pushed`、`pushError`）
- **智能体检视（`src/review/`）**：`ReviewRunner` 复用官方 webhook 插件的模式——创建一个一次性的 root agent 作为 parent，再经 `ctx.subagents.start('spawn', …)` 启动独立子智能体，把评审 prompt + diff 交给它，等待终局结论文本；10 分钟超时，结束即 dispose。评审回答末尾的 `review-findings` JSON 块由 `parseReviewFindings` 解析为结构化意见（只输出逐条 findings，不再要求总体评价正文；`severity` 分三级：critical=严重 / normal=一般 / suggestion=建议，旧记录的 major/minor 归并为 normal）。检视落定后（成功或失败）经 `ReviewStore` 持久化为该仓库的最新一条记录（`<storageDir>/reviews.json`，按仓库 realpath 覆盖写入，临时文件 + rename 保证原子性），内存中也只保留最新一次 run。`CommitRunner` 走同一 spawn 模式生成 Conventional Commits 格式的 commit 信息（3 分钟超时），随后服务端执行 `git add -A` + `git commit`（可选 `git push`；推送失败不影响已完成的提交，以 `pushError` 上报）。
- **客户端模块（`src/client.ts` 编译为 `lib/client.js`，`dsh.client` 声明）**：把「代码变更」面板注册为 DSH 原生右侧栏的 tab 类型——类型进 `ctx.sidebarRightTabs`（带 guide 入口），面板体进 `sidebar.right.pane.tab` 槽位。面板只展示当前未提交的变更，每 4 秒自动轮询同步，按文件折叠；diff 按 hunk 解析并带新旧行号、行级着色。头部「开始检视」按钮触发智能体评审，旁边的下拉框可选择检视使用的模型（选项来自 `/review-panel/api/models`，选择持久化到 localStorage，缺省用宿主默认模型）；检视结果区顶部按严重级统计意见数量（严重 / 一般 / 建议，另计已忽略 / 已修改），并提供 ↑/↓ 按钮在意见间快速跳转（高亮当前条并滚动定位）。结构化意见经 `quote` 逐字锚定到 diff 行（`side` 区分新旧，`line` 消歧重复 quote），以严重级彩色卡片渲染在对应代码行下方，有意见的文件自动展开；无 quote 的文件级意见渲染在文件 diff 块顶部；锚定失败的意见（代码在检视后已变化）汇总进结果区底部列表，绝不丢失。每条意见可手动标记「忽略」；曾经锚定、后因代码改动失去锚点的意见自动标记「已修改」——两种标记按检视 id 持久化到 localStorage。面板挂载时经 `/review/latest` 恢复该仓库最近一次检视（进行中的恢复轮询，已落定的直接展示）。底部操作栏提供「提交」「提交并推送」按钮，自动生成 commit 信息并完成提交（推送可选）。展开/收起、分栏、全屏都由右侧面板原生提供。

bundle 保持 `window.__ModuleLoader__.load` 格式（与官方包产物一致）：源码是 `src/client.ts`，`pnpm build` 经独立的 `tsconfig.client.json`（script 模式，非 NodeNext）编译为 `lib/client.js`；react 由客户端模块系统的 shell 基座提供。`package.json` 的 `exports["./client"]` 指向该产物，但它是一个由宿主在运行时注入页面的 IIFE script（`module: none`，无任何导出），不提供 `.d.ts` 类型声明——消费方按脚本入口引用即可，不要从它 import 符号。

## 目录结构

```
dsh-plugins/  (= dsh-code-review 包根)
├── package.json          # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # 一个 bundle 两个入口：review-panel / review-panel-web
├── tsconfig.json         # NodeNext ESM
├── tsconfig.client.json  # 客户端 bundle 编译配置（script 模式，输出 lib/）
├── lib/
│   └── client.js         # 客户端 bundle：由 src/client.ts 编译生成，勿手改
├── src/
│   ├── index.ts          # 服务入口（re-export，默认导出 ReviewPanelService）
│   ├── web.ts            # web 入口（re-export，函数形态）
│   ├── client.ts         # 客户端 bundle 源码：注册右侧栏「代码变更」tab
│   ├── config.ts         # 服务 Config（Schemastery，公开契约）
│   ├── service/          # 服务实现
│   │   ├── index.ts      #   ReviewPanelService（Service 类形态）
│   │   ├── git.ts        #   纯逻辑：三种 scope 的 diff 收集
│   │   └── types.ts      #   ReviewScope / ChangeSet / FileChange
│   ├── review/           # 智能体检视与提交
│   │   ├── runner.ts     #   ReviewRunner：root agent + spawn 子智能体一次性评审
│   │   ├── findings.ts   #   review-findings 结构块解析（三级 severity 的 findings）
│   │   ├── commit.ts     #   CommitRunner：生成 commit 信息并提交/推送
│   │   └── store.ts      #   ReviewStore：每仓库最新检视记录的文件持久化
│   └── web/              # Web 后端实现
│       ├── plugin.ts     #   apply：注册 JSON API 路由 + 装配 ReviewRunner / CommitRunner
│       └── routes.ts     #   /review-panel/api/changes + /models + /review/* + /commit/*
└── test/                 # git / routes / runner / commit / store / service 六组单测
```

## 检视范围（ReviewScope）

- `working-tree` — 当前代码变更（`git diff HEAD` + 未跟踪文件，未跟踪文件以 `added` 状态纳入；无提交的新仓库自动退化为对空树 diff）
- `since-ref` — 指定 git 记录之后到 HEAD 的变更（`git diff <ref>..HEAD`，需提供 `ref`）
- `branch` — 分支全量检视（`git diff <base>...HEAD`，base 缺省用 review-panel 的 `defaultBaseBranch` 配置）

## 配置

`review-panel` 服务（`src/config.ts`）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `defaultBaseBranch` | `main` | `branch` scope 缺省基准分支 |
| `maxPatchBytes` | `524288` | diff 截断阈值（截断会标记 `truncated`） |
| `storageDir` | `~/.dsh-code-review` | 检视记录持久化目录，每仓库保留最新一次检视结果 |

## 设计要点

- **服务形态**：对外提供能力必须用类形态——`ReviewPanelService extends Service`，`super(ctx, 'reviewPanel')`，并通过声明合并把类型挂到 `Context` 上。
- **UI 架构**：面板 UI 以客户端模块（`dsh.client` 声明 + `lib/client.js`，由 `src/client.ts` 编译）注册为 DSH 原生右侧栏的 tab 类型；后端通过 `webServer` 路由提供 JSON API；`webServer` 仅 web profile 存在，故用 `ctx.inject(['webServer'], cb)` 可选加载。
- **仓库定位**：面板不接收仓库路径输入——槽位是 session 作用域，框架给面板组件注入 `sessionId`，前端以 `?session=` 传给 API，服务端经 `workspaceRegistry` 把 session 解析为其工作区的仓库路径（按请求惰性解析，规避启动时序）；无 session 时回退 `process.cwd()`。
- **自动同步**：面板每 4 秒轮询 API，按 diff 内容快照比对，只在变更真正变化时重渲染；页面隐藏时暂停轮询。
- **独立智能体**：评审不占用当前会话——`ReviewRunner` 创建一个一次性 root agent 作 parent，再 spawn 子智能体执行评审（模型经 spawn 请求的 `agentOptions` 显式指定，覆盖默认的父代继承）；`agents` / `subagents` / `agentDefaultModel` 均按请求惰性解析。
- **检视记录持久化**：cordis 没有 `storageDomain` 服务，故持久化用文件实现——`ReviewStore` 把每仓库最新一次检视记录写入 `<storageDir>/reviews.json`（单文件表，键为仓库 realpath，临时文件 + rename 原子替换）；写盘失败只静默降级，绝不影响检视本身。runner 落定时写入，面板挂载时经 `/review/latest` 恢复。
- **意见锚定**：`ReviewFinding` 用 `path` + `quote`（逐字 diff 行内容，先精确后 trim 宽松匹配）+ `side`（new→add/ctx，old→del）+ 可选 `line`（重复 quote 时按行号距离消歧）定位到结构化 diff 行；前端 `parseFileDiff` 解析 `@@ -a,b +c,d @@` 头维护新旧行号。
- **生命周期**：`webServer.register` 返回的 disposer 不由 fiber 托管，均包进 `ctx.effect()`。

## 开发

```bash
pnpm install
pnpm build
pnpm test
```

## 安装到 dsh profile 验证

```bash
dsh plugin --profile web add -w .
dsh --profile web --dump-config   # 确认 review-panel / review-panel-web 条目已入配置树
```

## 消费方示例

```ts
export const inject = ['reviewPanel']

export async function apply(ctx: Context) {
  const changeSet = await ctx.reviewPanel.collect({ cwd: process.cwd(), scope: 'working-tree' })
}
```

## 后续开发路线

- 面板：renamed 状态展示旧路径。
- 检视：历史检视记录列表（目前只保留每仓库最新一次）；reasoning effort 选择。
