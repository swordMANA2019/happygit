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