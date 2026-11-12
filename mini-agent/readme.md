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
    ├── stats.ts        # 耗时统计：阶段 / 模型调用 / 工具耗时，任务结束打印
    ├── ui/diffview.ts  # 高亮 diff：数据（hunk + 行内变化）/ 摘要 / 终端打印 / HTML / IDE 打开
    ├── ui/diffviewer.ts # 交互式 diff 查看器（并排、跳转、备用屏幕）+ 可选 vim -d
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

验证与黑盒自测：
- 有项目自带验证器（测试/编译/类型检查）→ 照旧：验证 → 评审 → 重试/回滚，状态 fixed。
- 没有任何验证器通过（常见于新项目、训练脚本、调用外部接口的代码）→ 不直接宣布完成，进入【黑盒自测】：
  模型自己设计 2~4 个场景（正常 + 失败/边界），用假服务/最小数据真正运行，把实际输出和期望对照；发现缺陷先修再重测。
  结论行固定为 `SELFTEST: PASS|FAIL|SKIPPED`，并核对"本轮是否真的执行过命令"——没跑就说 PASS 不予采信（状态 unverified）。
  通过则状态为 selftested（强度低于 fixed，证据写在最终报告的"验证"一节）。AGENT_SELFTEST=0 可关闭。
- 不预置任何测试工具：思路放在 blackbox-testing 技能里（"怎样才能亲眼看到它出问题"→缺什么条件就自己临时搭桩服务/假数据/最小配置），
  具体怎么搭由模型针对当前问题决定；测试文件写在 .agent/scratch/（可写，不计入改动、不进 diff，也不会弹确认）。
- 最终报告固定结构（改动类任务）：原因 → 改动 → 验证 → 注意事项；纯问答直接回答。

LLM 超时与"看起来卡死"：
- 主循环默认用流式响应。超时不再是"整个响应必须在 N 秒内完成"（写几百行脚本本来就要几分钟），而是三道看门狗：
  首包 AGENT_LLM_FIRST_TOKEN_MS（180s）、数据流静默 AGENT_LLM_IDLE_MS（60s）、总时长 AGENT_LLM_TOTAL_MS（900s）。
  只要模型还在输出就不会超时；被截断的半截回复不会被当成答案，而是按"可重试的超时"处理。
- 网关不支持 stream 时自动降级为一次性响应（也可 AGENT_LLM_STREAM=0），此时用 AGENT_LLM_TIMEOUT_MS（120s）。
- 连续两次超时会提示模型把输出拆小（先写骨架再 edit_file 分段补充）。
- 所有慢阶段都有进度输出（间隔 AGENT_HEARTBEAT_MS，默认 10s）：等待模型 / 模型输出了多少字符 / 验证命令 / 评审 / 整理历史。
- 没显式设置超时的调用（如评审）也不再沿用 SDK 默认的 10 分钟。

速度（`stats.ts`）：
- 任务结束后打印耗时统计（超过 20s 才显示；`AGENT_STATS=1` 总是显示）：总用时、各阶段（准备/主循环/验证/评审/自测）、
  模型调用次数与耗时、平均每次发送的字符数、思考字符数、各工具累计耗时。慢在哪一眼可见，调优以它为准。
- 推理模型（GLM / DeepSeek-R1 / Qwen3 等）每一步都会先"思考"一大段，是最常见的慢因。流式进度会显示"🧠 思考中…思考 N 字符"。
  GLM 系列模型现在默认自动关闭思考（`AGENT_THINKING=auto`；主循环、历史摘要、评审、探测都生效；接口返回 400 说不认 thinking 时会自动撤销）。
  需要深度推理时设 `AGENT_THINKING=on`；其它模型（Qwen3/DeepSeek 等）用 `AGENT_EXTRA_BODY` 按网关要求关闭，
  例如 `AGENT_EXTRA_BODY='{"enable_thinking":false}'`；`AGENT_EXTRA_BODY` 里显式写了 `thinking` 则以它为准。
- 省 token：
  - 任务结束的统计里有接口返回的真实用量（输入 / 缓存命中 / 输出 / 其中思考 token）；流式请求会带 `stream_options.include_usage`（网关不认会自动撤销）。
  - 已设置关闭思考、模型却仍在输出思考内容时，会警告一次（说明网关/模型忽略了该参数）；
    并且思考超过 `AGENT_THINK_MAX_CHARS`（6000 字符，0 = 不限）仍无任何输出，就中止这次生成（停止计费）、带一条临时提示重试一次。
  - 每一步都会重发整份历史，所以输入 token ≈ 步数 × 历史长度：`AGENT_CONTEXT_CHARS`（默认 120k 字符）、
    `AGENT_TOOL_OUTPUT_CAP`（单个工具结果上限，默认 10k 字符）、`AGENT_EARLY_FOLD_RATIO`（历史到预算的 25% 起就把
    最近 10 个之前的大块工具输出与写文件参数折叠）共同控制。
- 整理对话历史：较早的对话切成最多 `AGENT_SUMMARY_PARALLEL`（4）段并行摘要，每段 `AGENT_SUMMARY_MAX_TOKENS`（1200）封顶，
  可用 `AGENT_SUMMARY_MODEL` 指定更快的模型；并且每个回合结束后就在后台预先整理（`AGENT_BG_COMPACT=0` 关闭），下一回合开始时直接套用。
- 少绕弯：提示词要求同一轮里并行发出互相独立的工具调用（含 update_plan/save_notes），单个文件一次写完（≤~300 行），
  简单任务不建计划；已读过的文件不重复读。
- 历史里较早的 write_file/edit_file 大参数从预算的 25%（`AGENT_EARLY_FOLD_RATIO`）起就折叠——文件已在磁盘上，不必每步重发。
- 验证器并发运行（总用时 = 最慢的那个）；上下文构建/目录快照/技能发现并发；目录快照上限 1.5s。
- 没有验证器时：模型改完文件后自己运行了有意义的命令（不是 cat/ls）且成功、回复里有"验证"一节，就直接采信，不再开一整轮自测
  （状态仍是 selftested，并在 warnings 里写明依据）；否则才进入自测轮（最多 15 步）。会进入自测时，评审先不做。

路径与项目外文件：
- 路径可相对工作目录，也可绝对。root 是符号链接/挂载点（/mnt/build → /data/build）时，两种写法都认。
- 项目外已存在的绝对路径（如 /mnt/abc/temp/a.c）：read_file / list_files / read_document / view_image 可读，
  首次访问该目录时询问用户，同意后本会话内该目录可读（--yes 免问）；项目外一律不可写（要改请 /cd）。
  ~/.ssh、~/.aws、/etc/shadow 等系统凭据位置始终拒绝（AGENT_ALLOW_SECRETS=1 可关闭）。
- 不存在的绝对路径仍会按"去掉前缀当相对路径"纠错（模型常把 src/a.ts 写成 /src/a.ts）。

改动查看（对应 Cursor 的 diff 面板）：
- 任务结束后自动打印变更摘要（每个文件 +新增 −删除）。
- /diff：内置交互式查看器（纯 Node，Windows/macOS/Linux 终端都能用，不需要 vim/浏览器/IDE）。
  文件列表 ↑↓ 选择、Enter 打开 → 左右并排（旧 | 新）高亮：红/绿整行底色 + 行内词级加深 + 新旧行号 + 上下文折叠；
  n/p 在改动块间跳转，←→ 切换文件，u 切并排/统一视图，Esc 回列表，q 退出。/diff <编号|路径> 直接打开某个文件。
- /diff print [编号|路径]：把高亮 diff 直接打印出来（可复制/重定向；写文件前确认里按 d 也是这个视图）。
- /diff vim：用 vim -d 对比（找 nvim / vim / vimdiff；Windows 会找 Git for Windows 自带的 vim；都没有就自动改用内置查看器）。
- /diff html：生成 .agent/diff.html（每个文件点击标题展开/折叠）并尝试用浏览器打开。
- /diff ide [编号]：用 Cursor / VS Code 的内置 diff 编辑器对比（需要 `cursor` / `code` 命令在 PATH 里）。

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
