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
  格式要求：<名字>/SKILL.md（只支持一层目录；文件名不区分大小写），开头用 --- 包起 frontmatter，必须有 description（可以是 > / | 多行写法，会合成一行）；目录可以是符号链接/junction。
  /skills 会列出已加载的技能、被跳过的目录及原因（缺 description、套了一层目录、没有 SKILL.md…）和搜索位置——技能没生效先看它。技能按【当前会话目录】查找，不是可执行文件所在目录；Cursor 后端不使用这套技能。
- MCP 配置（{"mcpServers": {...}}）：~/.mini-agent/mcp.json（可信）、<项目>/.agent/mcp.json、<项目>/.cursor/mcp.json
  （项目级需用户确认，--yes 跳过）。/mcp [reload] 查看。
- 子任务：delegate 起只读子 Agent（深度受限、最多并行 3 个），适合并行读多份资料。
- 可选视觉检查：AGENT_VISION=1 时 view_image 可看渲染后的图片。其它环境变量：AGENT_MCP_TIMEOUT_MS、AGENT_MCP_START_TIMEOUT_MS。

PowerPoint 原生控制（仅 Windows + 桌面版 PowerPoint；不用 python-pptx）：
- 结构：能力本身是独立可复用的库 `packages/ppt-sdk`（npm workspace：@mini-agent/ppt-sdk；API、工具定义、集成方式见它的 README），
  与 mini-agent 无关、零运行时依赖；mini-agent 只保留 `src/tools/ppt.ts` 这一层适配（授权、视觉模型、目录约定、AGENT_* 环境变量）。
  `npm run dev` / `npm run build` 会先自动构建 SDK；`npm run test:sdk` 跑 SDK 单元测试（不需要 Office）。
- 原理：常驻一个 PowerShell 进程（packages/ppt-sdk/ppt-bridge.ps1）通过 COM 直接操作你**正打开**的演示文稿，读写都是实时的；
  不改文件、不自动保存；每个会话第一次修改前用 SaveCopyAs 备份到 .agent/backups/ppt/，PowerPoint 里 Ctrl+Z 可撤销。
- 触发：对话里提到 PPT/幻灯片/PowerPoint/slide 才会启用 7 个工具并追加说明（约 1.5k token；没碰 PPT 的会话零开销）。
  工具：ppt_read（实时状态+用户选中的形状+主题）、ppt_edit（批量操作：文本框/形状/线/图片/格式/对齐/分组/页面…）、
  ppt_lint（规则检查，可 fix=true 自动修）、ppt_look（渲染成图交给视觉模型点评）、asset_search（本地素材）、ppt_open、ppt_save。
  ask 模式只有只读的 4 个；子 Agent 没有。
- 命令：/ppt 状态 | /ppt review 只评审不修改 | /watch ppt [off] 你手动编辑停手 3 秒后按规则检查当前页，只提示新问题（不花 token）
  | /apply [编号] 直接执行规则给出的机械修复（不经过模型）。
- 素材：AGENT_ASSETS_DIR=目录1;目录2（默认 <项目>/assets 与 <项目>/.agent/assets）。可在目录里放 index.json
  （[{"file":"flowers/rose.png","tags":["flower","花"],"description":"…","license":"CC0"}]）；不放则按文件名/文件夹名搜。找不到时模型会用基本形状组合绘制，不会联网下载或编造路径。
- 视觉点评：AGENT_VISION_MODEL=<支持图片的模型名>（走同一个 OPENAI_BASE_URL；点评由它完成，主模型不必支持图片）；
  或 AGENT_VISION=1 让主模型自己看图。都没配时 ppt_look 会明确告知不可用，模型只能依赖规则检查。
- 开关：AGENT_PPT=0 关闭，AGENT_PPT=1 强制开启（默认检测注册表里是否有 PowerPoint.Application）。
  监视间隔：AGENT_WATCH_POLL_MS（默认 1500）、AGENT_WATCH_DEBOUNCE_MS（默认 3000）。
- 用 bun 打成单文件时，把 packages/ppt-sdk/ppt-bridge.ps1 放在可执行文件同目录即可（脚本保持 ASCII，Windows PowerShell 5.1 才能正确读取）。

Cursor 后端（可选：AGENT_BACKEND=cursor）：
- 作用：把任务交给 Cursor Agent（@cursor/sdk 的本地运行时）执行，可以用 composer-2.5 等 Cursor 自家模型；mini-agent 只做外壳。
  它**不是** OpenAI 兼容端点：api.cursor.com 的 REST 接口（如 /teams/members）不能当 OPENAI_BASE_URL 用，所以单独做成后端。
- 配置（不使用 OPENAI_BASE_URL / OPENAI_API_KEY）：
    set AGENT_BACKEND=cursor
    set CURSOR_API_KEY=cursor_...          # cursor.com/dashboard/integrations 的用户 API Key，或团队 service-account key（Admin API Key 不支持）
    set AGENT_CURSOR_MODEL=composer-2.5    # 默认 composer-2.5；也可用 AGENT_MODEL；"Composer 2.5" 会自动规范成 composer-2.5；运行中 /model <id> 切换
  需要 Node >= 22.13；@cursor/sdk 是可选依赖（npm install 默认会装；缺失时报错并提示安装）。
- 分工：Cursor Agent 自己读/写/搜索/跑命令/验证；mini-agent 负责
  · 终端交互、Ctrl+C 中断（会取消 Cursor 的运行）、/resume（沿用上次的 Cursor 对话）、/reset、/cd；
  · 改动追踪：任务前备份、任务后比对，所以 /undo、/diff 和"改动文件"列表照常可用（>512KB 的大文件、被忽略的目录如 node_modules/dist 例外：只会提示，不能还原）；
  · /ask、/diag：只读——创建 Cursor agent 时只给读类工具（白名单；若 SDK 拒绝某个名字，用 AGENT_CURSOR_ASK_TOOLS=read,grep,glob,ls,mcp 覆盖），并在事后检查文件是否被动过；
  · PowerPoint：/ppt、/watch ppt 照常；对话里提到 PPT 时，ppt_* 工具以 SDK 的 customTools 形式提供给 Cursor Agent（ppt_look 的渲染图直接作为图片结果返回，或走 AGENT_VISION_MODEL）。
- 不适用（后端换了，这些由 Cursor 自己负责）：mini-agent 的路径防护 / 风险确认 / 自动验证与自测 / 评审 / 技能(.agent/skills) / MCP 配置 / 后台任务 / /plan / /probe。
  Cursor Agent 默认加载项目里的规则与技能：AGENT_CURSOR_SETTINGS=project（默认）| user,project | all | none。
  **安全**：Cursor Agent 在本机直接改文件、执行命令。想隔离一层可设 AGENT_CURSOR_SANDBOX=1（启用 SDK 的沙箱选项）；要看 SDK 自己的 INFO 日志设 AGENT_CURSOR_SDK_LOGS=1。
- 测试：npm run test:agent（假 SDK，不联网、不需要 key；同时跑 Web 界面服务的测试）。

桌面界面（Web 窗口，不用另外起服务）：
- 运行：**默认就是桌面界面**——开发时 `npm run ui`（或 `npm run dev`），打包后直接双击/运行 mini-agent。程序在 127.0.0.1 的随机端口起一个本地服务，并用 Edge/Chrome 的 --app 模式打开独立窗口（没有 Chrome/Edge 时退回默认浏览器的普通标签页；AGENT_UI_BROWSER 可指定浏览器路径，--no-open 只打印地址，AGENT_UI_PORT 固定端口）。关闭窗口后约 3 秒程序自动退出（AGENT_UI_EXIT_GRACE_MS 可调；刷新页面会很快重连，不受影响；电脑睡眠唤醒也不会被当成关窗口）。
- 终端用法：`npm run cli` / `mini-agent --cli` 进入终端交互；`mini-agent "做点什么"` 是一次性命令行调用（不开窗口）；也可设 AGENT_UI=0 让无参数运行走终端。Windows 的 mini-agent.exe 是无控制台窗口的界面程序（终端里没有输出），命令行请用同目录的 mini-agent-cli.exe。界面版启动失败时错误写入 ~/.mini-agent/logs/startup-error.log。
- 多对话（和 Cursor 一样）：左侧按仓库（目录）分组列出对话；顶部的“新对话”图标在当前仓库里新建，仓库名旁的 + 在那个仓库里新建，“添加仓库”输入目录即可加入。每个对话是独立的 Session（自己的目录、模型、记忆、撤销点、授权），可以同时运行、各自中断，输出不会串到别的对话。标题取自第一句任务；对话行下面显示它用的模型。仓库列表保存在 ~/.mini-agent/repos.json（AGENT_UI_DATA 可改）；对话本身不跨重启保存，需要时在对应仓库里 /resume。
- 界面 vs 后端日志：聊天区只显示用户可见结果（助手回答、改动摘要、确认卡片…）和可折叠的 ReAct 过程（思考 / 动作 / 观察）；`console.*` 的运行日志（`[llm]`、`[probe]`、验证进度等）不进界面，写入 `~/.mini-agent/logs/backend-<对话id>.log`；ReAct 另有一份 `react-<对话id>.log`。
- ReAct 过程的显示方式（仿 Cursor）：一个回合只有一个默认折叠的“过程”块，收起时是一行实时状态（“思考中… / read_file src/a.ts”）加用时，结束后变成“已处理 · 思考 N · 工具 M”。展开后是时间线：思考是一段在原地流式增长的文字（后端把模型的逐字增量按约 80ms 合并成批、同一思考共用一个 id，界面直接往同一个节点追加，不会一个词一条记录）；每个工具调用一行（图标 + 名称 + 关键参数，运行中转圈，完成 ✓ / ✗），点开看完整参数与返回。刷新页面时，回放缓冲里同一思考的增量已合并为一条。
- 侧边栏宽度：标题栏与侧栏之间的竖条可拖动调整（宽度记在浏览器 localStorage）。
- 模型按对话选：底部 **下拉框**（不可手输）列出环境里配置过的全部模型（`AGENT_MODEL`、`AGENT_CURSOR_MODEL`、`AGENT_MODELS` 逗号分隔；能不能连上用时再报错）；选模型只影响当前对话。新对话继承当前模型。
- 命令都在输入框里：输入 / 弹出命令提示（带用法和说明），↑↓ 选择，Tab 补全，Enter 确认；`/model `、`/diff `、`/mcp `、`/ppt `、`/watch ` 后面还会提示可选参数。没有额外的命令按钮栏。
- 窗口标题固定 **Mini Agent**（不含仓库名）；任务运行中 **发送** 按钮会变成 **停止**（中断当前对话）。
- 应用图标：默认是内置的 icon.svg。想换成自己的图，把一张 icon.png（也支持 .svg .ico .jpg .webp，≤2MB）放到以下任一位置，刷新窗口即可：环境变量 AGENT_UI_ICON 指向的文件 > 可执行文件所在目录 > ~/.mini-agent/。窗口标题栏/任务栏图标取自这张图。要连 .exe 文件本身的图标也换掉：放一个 assets/icon.ico，再 npm run build:exe（Windows 目标自动带上 --windows-icon）。
- 其它功能：流式输出、确认变更的按钮、内嵌 diff 查看器（/diff）、输出里出现的项目内图片/音频/视频路径会内嵌预览（支持 Range，可拖动进度）、中断；刷新页面会回放所有对话。
- 与终端共用同一套命令实现（src/commands.ts），/ask /fix /edit /diag /undo /resume /ppt /watch … 行为一致。
- 安全：只监听回环地址；每次启动随机令牌 → HttpOnly + SameSite=Strict cookie；校验 Host（防 DNS rebinding）和 POST 的 Origin；/file 只提供项目目录内的媒体/图片/PDF（防目录穿越与符号链接逃逸，不提供源码和 .env）。
- 打包：node scripts/build-exe.mjs [bun-windows-x64 bun-linux-x64 bun-darwin-arm64 bun-darwin-x64]（npm run build:exe）。输出 release/<target>/mini-agent（界面版；Windows 上另有 mini-agent-cli.exe 控制台版）；bun 可交叉编译；Windows 目标附带 ppt-bridge.ps1（放在可执行文件同目录）。Windows 版已实机验证；macOS/Linux 目标只确认能编译，未在对应系统上运行验证。
- 以后换原生外壳（Tauri / webview）：页面和服务协议不变，外壳只需要打开同一个地址。
- 开发：界面源文件在 src/ui/web/（index.html / app.js / style.css，无框架无构建步骤）；scripts/embed-web.mjs 把它们嵌进 src/ui/web/assets.generated.ts（predev / prebuild / ui / test 自动运行，不入库）。
- 测试：test/web-server.test.ts（鉴权 / Host / Origin、事件流与回放、忙碌 409、确认往返、diff、/file 范围与越权、/exit；多对话的并发与输出归属、按对话的模型 / 中断 / 审批、关闭对话与移除仓库、仓库列表持久化、图标覆盖顺序）。

打包工具：
# 装 bun（一次）
curl -fsSL https://bun.sh/install | bash

cd /mnt/source/llm-build/pythonProject/happygit/mini-agent
bun install                      # 复用 package-lock 没问题（会链接 workspace 里的 SDK）
npm run build:sdk                # bun 通过 SDK 的 dist 解析它，所以要先构建 SDK（npm run build 会自动做）

bun build ./src/index.ts \
  --compile \
  --outfile mini-agent \
  --target=bun

chmod +x mini-agent
./mini-agent
