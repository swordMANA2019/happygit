文件目录结构：
mini-agent/
├── package.json
├── tsconfig.json
├── .env.example
└── src/
    ├── index.ts        # CLI 入口 / REPL（只负责输入输出，状态都在 Session 里）
    ├── session.ts      # 会话：目录 + 模型 + 历史 + 撤销点 + 授权（无模块级全局，可并存多个）
    ├── config.ts       # 配置与常量（没有工作目录：目录属于 Session，启动时取 cwd，运行中 /cd 切换）
    ├── llm.ts          # 模型客户端 + 工具 schema + 分模式的系统提示词
    ├── agent.ts        # ReAct 主循环：thought → action → observation
    ├── fix.ts          # 验证闭环：基线 → 修改 → 验证 → 评审 → 重试/回滚
    ├── workspace.ts    # 检查点：文件级 journal（不依赖 git）、diff、回滚；git 仅作只读信息
    ├── guard.ts        # 路径防护：越界 / symlink 逃逸 / 受保护目录 / 凭据文件 / 候选纠错
    ├── policy.ts       # 写操作风险评分与放行策略（allow / ask / deny）
    ├── errors.ts       # 失败分类：env（环境）/ timeout / code（代码）；LLM 错误分类
    ├── probe.ts        # 探测语言与可用验证器（结果缓存在 .agent/manifest.json）
    ├── critic.ts       # LLM 评审（只有否决权）
    ├── router.ts       # 意图路由 ask / edit / fix / clarify
    ├── diagnose.ts     # 只读诊断
    ├── context.ts      # 运行环境 / 验证器 / 项目规则（AGENTS.md 等）
    ├── ui/confirm.ts   # 变更确认 UI（统一走 Session 的 prompter，只有一个 readline）
    └── tools/
        ├── ctx.ts      # ToolCtx：每次工具调用携带 root / workspace / 审批函数
        ├── fs.ts       # read / write / edit / delete / list（每次写入：resolve → policy → journal → 写）
        ├── search.ts   # 代码搜索（跳过凭据文件）
        └── shell.ts    # 进程执行：永不抛异常、杀进程树、超时、GBK 解码、危险命令拦截

架构：
┌─ CLI (index.ts) ─────────────────────────────────────────────────┐
│  自然语言 / /fix / /edit / /ask / /diag  → Session.route()        │
│   ask  ──→ runAgent(mode:"ask")   只读工具集，写工具根本不可见    │
│   edit/fix ──→ runFixTask         闭环                            │
│   /undo ──→ 按 journal 精确还原上一次任务改过的文件               │
└───────────────────────┬──────────────────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────────────────┐
│  ① 学习层 probe.ts                                                │
│     marker → 语言 → 冒烟测试（用退出码+多语言输出判定，           │
│     "命令存在但失败"=好验证器，"命令不存在/超时"=不可用）          │
└───────────────────────┬──────────────────────────────────────────┘
┌───────────────────────▼──────────────────────────────────────────┐
│  ② 闭环 fix.ts                                                    │
│   0. 探测环境（git 可有可无）；基线验证：剔除跑不起来的验证器，    │
│      真实报错原文作为第一轮证据                                    │
│   loop ≤ maxRetries（同一会话持续，不重建上下文）:                 │
│     runAgent → 验证 → 只有 kind=code 的失败才重试；                │
│     env/timeout 只标记"不可用"；连续两轮改动+报错相同则提前终止    │
│   critic 评 diff（只有否决权）                                     │
│   结果：fixed / unverified / no_change / failed(回滚) / aborted    │
└───────────────────────┬──────────────────────────────────────────┘
┌───────────────────────▼──────────────────────────────────────────┐
│  ③ 执行层 agent.ts（ReAct）                                       │
│   LLM 重试+退避+上下文压缩 / 参数校验 / 重复检测 / 可中断          │
│   写操作：guard 解析路径 → policy 评估 → 必要时用户确认 → journal  │
└──────────────────────────────────────────────────────────────────┘

稳健性约定：
- git 不是前提：没装 git、不是仓库、没配身份，都不影响修复与回滚。
- 检查点只记录 Agent 自己改过的文件；run_command 产生的副作用无法回滚（有 git 时会给出提示）。
- 环境问题 ≠ 代码问题：命令不存在、依赖缺失、没网、超时 都不会触发"让模型改代码"。
- 凭据文件（.env、*.pem、id_rsa 等）默认不可读/不可写/不进搜索结果（AGENT_ALLOW_SECRETS=1 可关闭）。
- 高风险写操作（删除、新建配置类文件、风险评分过低）需确认；非交互环境下会被拒绝而不是默认放行；
  --yes 或 AGENT_AUTO_APPROVE=1 可整体放行。

打包工具：
# 装 bun（一次）
curl -fsSL https://bun.sh/install | bash

cd /mnt/source/llm-build/pythonProject/happygit/mini-agent
bun install                      # 复用 package-lock 没问题

bun build ./src/index.ts \
  --compile \
  --outfile mini-agent \
  --target=bun

chmod +x mini-agent
./mini-agent
