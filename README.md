# dsh-code-review

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：收集当前仓库的代码变更，在右侧栏提供「代码变更」面板，并支持一键发起独立智能体检视。

## 组成（一个 bundle，两个入口）

- **`ReviewPanelService`（`src/service/`，类形态，入口 `.`）**：以 `reviewPanel` 服务名注册。核心方法 `collect(options)` 返回 `ChangeSet`（变更文件列表 + unified diff）。
- **web 后端（`src/web/`，函数形态，入口 `./web`）**：通过可选依赖 `webServer` 注册 JSON API。`session` 是浏览器会话 id，服务端经可选依赖 `workspaceRegistry`（按请求惰性解析）映射为该会话工作区的仓库路径；不传时回退 `process.cwd()`。
  - `GET /review-panel/api/changes?scope=&ref=&base=&session=` — 收集 diff
  - `GET /review-panel/api/models` — 可检视模型目录（注册的 provider + 各 provider 的模型目录 + 宿主默认模型）
  - `POST /review-panel/api/review/start?session=&provider=&model=` — 发起独立智能体检视（`provider`/`model` 可选但必须成对，缺省用宿主默认模型；同一仓库同时只跑一个，重复调用返回同一个 run）
  - `GET /review-panel/api/review/status?id=` — 轮询检视状态与结论（含实际使用的 `model`）
- **智能体检视（`src/review/`）**：`ReviewRunner` 复用官方 webhook 插件的模式——创建一个一次性的 root agent 作为 parent，再经 `ctx.subagents.start('spawn', …)` 启动独立子智能体，把评审 prompt + diff 交给它，等待终局结论文本；10 分钟超时，结束即 dispose。
- **客户端模块（`lib/client.js`，`dsh.client` 声明）**：把「代码变更」面板注册为 DSH 原生右侧栏的 tab 类型——类型进 `ctx.sidebarRightTabs`（带 guide 入口），面板体进 `sidebar.right.pane.tab` 槽位。面板只展示当前未提交的变更，每 4 秒自动轮询同步，按文件折叠、diff 行级着色；头部「开始检视」按钮触发智能体评审，旁边的下拉框可选择检视使用的模型（选项来自 `/review-panel/api/models`，选择持久化到 localStorage，缺省用宿主默认模型），结论展示在面板顶部的可折叠区域并标注所用模型；展开/收起、分栏、全屏都由右侧面板原生提供。

bundle 是手写的 `window.__ModuleLoader__.load` 格式（与官方包产物一致），无需构建步骤；react 由客户端模块系统的 shell 基座提供。

## 目录结构

```
dsh-plugins/  (= dsh-code-review 包根)
├── package.json          # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # 一个 bundle 两个入口：review-panel / review-panel-web
├── tsconfig.json         # NodeNext ESM
├── lib/
│   └── client.js         # 手写客户端 bundle：注册右侧栏「代码变更」tab
├── src/
│   ├── index.ts          # 服务入口（re-export，默认导出 ReviewPanelService）
│   ├── web.ts            # web 入口（re-export，函数形态）
│   ├── config.ts         # 服务 Config（Schemastery，公开契约）
│   ├── service/          # 服务实现
│   │   ├── index.ts      #   ReviewPanelService（Service 类形态）
│   │   ├── git.ts        #   纯逻辑：三种 scope 的 diff 收集
│   │   └── types.ts      #   ReviewScope / ChangeSet / FileChange
│   ├── review/           # 智能体检视
│   │   └── runner.ts     #   ReviewRunner：root agent + spawn 子智能体一次性评审
│   └── web/              # Web 后端实现
│       ├── plugin.ts     #   apply：注册 JSON API 路由 + 装配 ReviewRunner
│       └── routes.ts     #   /review-panel/api/changes + /models + /review/start + /review/status
└── test/                 # git / routes / runner 三组单测
```

## 检视范围（ReviewScope）

- `working-tree` — 当前代码变更（`git diff HEAD`；无提交的新仓库自动退化为对空树 diff）
- `since-ref` — 指定 git 记录之后到 HEAD 的变更（`git diff <ref>..HEAD`，需提供 `ref`）
- `branch` — 分支全量检视（`git diff <base>...HEAD`，base 缺省用 review-panel 的 `defaultBaseBranch` 配置）

## 配置

`review-panel` 服务（`src/config.ts`）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `defaultBaseBranch` | `main` | `branch` scope 缺省基准分支 |
| `maxPatchBytes` | `524288` | diff 截断阈值（截断会标记 `truncated`） |

## 设计要点

- **服务形态**：对外提供能力必须用类形态——`ReviewPanelService extends Service`，`super(ctx, 'reviewPanel')`，并通过声明合并把类型挂到 `Context` 上。
- **UI 架构**：面板 UI 以客户端模块（`dsh.client` 声明 + `lib/client.js` 手写 bundle）注册为 DSH 原生右侧栏的 tab 类型；后端通过 `webServer` 路由提供 JSON API；`webServer` 仅 web profile 存在，故用 `ctx.inject(['webServer'], cb)` 可选加载。
- **仓库定位**：面板不接收仓库路径输入——槽位是 session 作用域，框架给面板组件注入 `sessionId`，前端以 `?session=` 传给 API，服务端经 `workspaceRegistry` 把 session 解析为其工作区的仓库路径（按请求惰性解析，规避启动时序）；无 session 时回退 `process.cwd()`。
- **自动同步**：面板每 4 秒轮询 API，按 diff 内容快照比对，只在变更真正变化时重渲染；页面隐藏时暂停轮询。
- **独立智能体**：评审不占用当前会话——`ReviewRunner` 创建一个一次性 root agent 作 parent，再 spawn 子智能体执行评审（模型经 spawn 请求的 `agentOptions` 显式指定，覆盖默认的父代继承）；`agents` / `subagents` / `agentDefaultModel` 均按请求惰性解析。
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

export function apply(ctx: Context) {
  const changeSet = await ctx.reviewPanel.collect({ cwd: process.cwd(), scope: 'working-tree' })
}
```

## 后续开发路线

- 面板：未跟踪文件纳入 `working-tree` 范围（目前 `git diff HEAD` 不含未跟踪文件）；renamed 状态展示旧路径。
- 检视：评审结论 Markdown 渲染（目前纯文本）；评审结果持久化（`storageDomain`）；reasoning effort 选择。
