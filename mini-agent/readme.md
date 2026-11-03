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
    ├── memory.ts       # 会话记忆：连续 messages、悬空 tool_call 修复、LLM 摘要压缩、落盘/恢复
    ├── taskstate.ts    # 任务状态：计划 + 工作笔记（update_plan / save_notes），每步注入系统提示，不受历史压缩影响
    ├── skills.ts       # 技能加载：SKILL.md（name/description/verify/verify_ext），渐进披露，use_skill 才读正文
    ├── mcp.ts          # MCP 客户端（stdio JSON-RPC），工具超过 20 个时改用 mcp_search_tools + mcp_call
    ├── runtime.ts      # 运行环境探测（Python 等），供技能占位符 {python} 使用
    ├── snapshot.ts     # 目录快照：发现脚本产出的文件（pptx/xlsx/图片等），不在检查点里也能被验证和汇报
    ├── diagnose.ts     # 只读诊断（/diag）
    ├── context.ts      # 运行环境 / 验证器 / 项目规则（AGENTS.md 等）
    ├── ui/confirm.ts   # 变更确认 UI（统一走 Session 的 prompter，只有一个 readline）
    └── tools/
        ├── ctx.ts      # ToolCtx：每次工具调用携带 root / workspace / 审批函数
        ├── fs.ts       # read / write / edit / delete / list（每次写入：resolve → policy → journal → 写）
        ├── search.ts   # 代码搜索（跳过凭据文件）
        ├── jobs.ts     # 长任务：前台等待 → 超时不杀而转后台 job；job_output / stop_job / list_jobs
        ├── docs.ts     # read_document（docx/pptx/xlsx/pdf）与图片加载
        └── shell.ts    # 进程执行：永不抛异常、杀进程树、超时、GBK 解码、危险命令拦截

架构：
┌─ CLI (index.ts) ─────────────────────────────────────────────────┐
│  没有意图路由器：用户选模式，模型自己理解请求                     │
│   默认 ──→ runFixTask(deferBaseline)  模型自判回答/分析/修改；    │
│            改了文件才进验证闭环，没改就只是一次问答               │
│   /ask ──→ runAgent(mode:"ask")   只读工具集，写工具根本不可见    │
│   /fix /edit /diag                用户显式指定的流程              │
│   所有回合共用 Session.messages（连续对话，见 memory.ts）         │
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

长任务（pip install torch 之类）：
- run_command 前台只等 timeout_ms（默认较短）；还没结束就【转入后台 job】，不杀进程，返回 job id，并明确告诉模型"这不是失败"。
- 模型用 job_output(job_id, wait_ms=60000) 等待并看新增输出，直到"已完成"；stop_job 终止；/jobs 查看。
- 轮询调用不计入重复/卡死检测；前台等待期间有心跳日志；退出时自动清理后台进程。
- 命令明确很慢时可直接传 background=true。

技能 / MCP / 文档：
- 技能目录（后者覆盖前者）：内置 skills/、~/.mini-agent/skills、<项目>/.agent/skills、<项目>/.cursor/skills。/skills 查看。
  系统提示只列 name+description，模型判断相关时调用 use_skill 读正文；技能可声明 verify 命令，在产出文件后自动校验。
- MCP 配置（{"mcpServers": {...}}）：~/.mini-agent/mcp.json（可信）、<项目>/.agent/mcp.json、<项目>/.cursor/mcp.json
  （项目级需用户确认，--yes 跳过）。/mcp [reload] 查看。
- 子任务：delegate 起只读子 Agent（深度受限、最多并行 3 个），适合并行读多份资料。
- 可选视觉检查：AGENT_VISION=1 时 view_image 可看渲染后的图片。其它环境变量：AGENT_MCP_TIMEOUT_MS、AGENT_MCP_START_TIMEOUT_MS。

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
