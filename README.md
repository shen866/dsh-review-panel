# dsh-code-review

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：收集当前仓库的代码变更，在右侧栏提供「代码变更」面板，并向智能体注册 `code_review` 检视工具。

## 组成（一个 bundle，三个入口）

- **`ReviewPanelService`（`src/service/`，类形态，入口 `.`）**：以 `reviewPanel` 服务名注册。核心方法 `collect(options)` 返回 `ChangeSet`（变更文件列表 + unified diff）。
- **web 后端（`src/web/`，函数形态，入口 `./web`）**：通过可选依赖 `webServer` 注册 JSON API：`GET /review-panel/api/changes?scope=&ref=&base=&session=`。`session` 是浏览器会话 id，服务端经可选依赖 `workspaceRegistry`（按请求惰性解析）映射为该会话工作区的仓库路径；不传时回退 `process.cwd()`。
- **`code_review` 工具（`src/tool/`，函数形态，入口 `./tool`）**：`inject: ['tools', 'reviewPanel']`，把变更内容交给智能体做检视。
- **客户端模块（`lib/client.js`，`dsh.client` 声明）**：把「代码变更」面板注册为 DSH 原生右侧栏的 tab 类型——类型进 `ctx.sidebarRightTabs`（带 guide 入口），面板体进 `sidebar.right.pane.tab` 槽位。面板只展示当前未提交的变更，每 4 秒自动轮询同步，按文件折叠、diff 行级着色；展开/收起、分栏、全屏都由右侧面板原生提供。

bundle 是手写的 `window.__ModuleLoader__.load` 格式（与官方包产物一致），无需构建步骤；react 由客户端模块系统的 shell 基座提供。

## 目录结构

```
dsh-plugins/  (= dsh-code-review 包根)
├── package.json          # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # 一个 bundle 三个入口：review-panel / review-panel-web / code-reviewer
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
│   ├── web/              # Web 后端实现
│   │   ├── plugin.ts     #   apply：注册 JSON API 路由
│   │   └── routes.ts     #   /review-panel/api/changes
│   └── tool/             # code_review 智能体工具
│       ├── index.ts      #   工具插件入口：apply / inject / name
│       ├── config.ts     #   工具 Config（defaultScope）
│       ├── code-review.ts #  defineTool('code_review')
│       └── scope.ts      #   纯逻辑：scope 参数校验
└── test/                 # git / routes / scope 三组单测
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

`code-reviewer` 工具（`src/tool/config.ts`）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `defaultScope` | `working-tree` | 工具调用未传 `scope` 时使用的检视范围 |

## 设计要点

- **依赖方向**：`code-reviewer` 工具通过 `inject: ['tools', 'reviewPanel']` 依赖同 bundle 内的服务；`reviewPanel` 服务消失时工具会被自动卸载并在服务恢复后重载。
- **服务形态**：对外提供能力必须用类形态——`ReviewPanelService extends Service`，`super(ctx, 'reviewPanel')`，并通过声明合并把类型挂到 `Context` 上。
- **UI 架构**：面板 UI 以客户端模块（`dsh.client` 声明 + `lib/client.js` 手写 bundle）注册为 DSH 原生右侧栏的 tab 类型；后端通过 `webServer` 路由提供 JSON API；`webServer` 仅 web profile 存在，故用 `ctx.inject(['webServer'], cb)` 可选加载。
- **仓库定位**：面板不接收仓库路径输入——槽位是 session 作用域，框架给面板组件注入 `sessionId`，前端以 `?session=` 传给 API，服务端经 `workspaceRegistry` 把 session 解析为其工作区的仓库路径（按请求惰性解析，规避启动时序）；无 session 时回退 `process.cwd()`。
- **自动同步**：面板每 4 秒轮询 API，按 diff 内容快照比对，只在变更真正变化时重渲染；页面隐藏时暂停轮询。
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
dsh --profile web --dump-config   # 确认 review-panel / review-panel-web / code-reviewer 条目已入配置树
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
- 检视：接入 LLM 服务做自动评审结论；评审结果持久化（`storageDomain`）；slash 命令 `/review`。
