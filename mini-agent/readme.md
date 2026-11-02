文件目录结构：
mini-agent/
├── package.json
├── tsconfig.json
├── .env.example
└── src/
    ├── index.ts        # CLI 入口 / REPL
    ├── config.ts       # 配置与常量
    ├── safety.ts       # 路径沙箱
    ├── llm.ts          # 模型客户端 + 工具 schema
    ├── agent.ts        # Agent 主循环
    ├── context.ts      # 项目树 / git 上下文
    └── tools/
        ├── fs.ts       # 读写改文件
        ├── search.ts   # 代码搜索
        └── shell.ts    # 执行命令

架构：
┌─ CLI (index.ts) ──────────────────────────────────────────────┐
│  自然语言 / /fix / /edit  →  classify() 路由                   │
│   ask ──→ runTask（单次，无兜底）                              │
│   edit/fix ──→ runFixTask（闭环）                              │
└───────────────────────┬───────────────────────────────────────┘
                        │
┌───────────────────────▼───────────────────────────────────────┐
│  ① 学习层 probe.ts                                             │
│     marker 文件 → 语言 → 冒烟测试（exit≠0 但命令存在=好验证器） │
│     → LLM 生成可判定 rubric → .agent/manifest.json（TTL+mtime） │
└───────────────────────┬───────────────────────────────────────┘
                        │ 注入 buildContext()
┌───────────────────────▼───────────────────────────────────────┐
│  ② 闭环 fix.ts                                                 │
│   git checkpoint                                               │
│     loop ≤ maxRetries:                                         │
│       runTask(task + 历史错误摘要, context)  ← 无状态补偿       │
│       ③ shell 验证器串联  FAIL→原文喂回→retry / 全PASS→↓        │
│       ④ critic 评 diff（只给否决权）fatal→继续修                │
│   fixed / 超次 → git rollback                                  │
└───────────────────────┬───────────────────────────────────────┘
                        │
┌───────────────────────▼───────────────────────────────────────┐
│  ⑤ 执行层 agent.ts（ReAct，无状态，结构未改）                   │
│   read/write/edit/list/search/run_command(cwd?,timeoutMs?)     │
│   只读模式由 AGENT_READONLY 环境变量控制（diagnose 用）          │
└───────────────────────┬───────────────────────────────────────┘
                        │
        文件系统 · shell 子进程 · ripgrep · git

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
