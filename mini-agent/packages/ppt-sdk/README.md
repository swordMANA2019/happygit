# @mini-agent/ppt-sdk

用 Node.js 通过 COM 实时操作 **Windows 桌面版 PowerPoint** 的库：读状态、批量编辑、规则检查（lint）、渲染截图、本地素材搜索、实时监视，
以及一套可以直接交给任何 LLM 的 **OpenAI 兼容工具定义 + 处理函数**。

- 零运行时依赖，不读环境变量（配置全部由宿主以参数传入），与 mini-agent 无关；
- 仅 Windows（需要 Windows PowerShell 5.1 和桌面版 PowerPoint）；其它平台 `pptAvailable()` 返回 `false`；
- 直接操作你**正打开**的演示文稿：不改文件、不自动保存；修改前可用 `SaveCopyAs` 备份；PowerPoint 里 Ctrl+Z 可撤销。

## 目录

| 模块 | 内容 |
|---|---|
| `bridge` | `PptBridge`（常驻 PowerShell 进程 + JSON 行协议）、`pptAvailable()`、`PptApi` 接口（测试时可用假对象替换） |
| `ops` | `applyOps`：带备份的批量编辑；`collectFixOps`、`touchedSlides`、`lintTargets` |
| `lint` | `lintSlide`：出界/重叠/字号/对比度/溢出/过密/对齐/边距/空占位符/字体/alt/标题；机械问题带 `fix.ops` |
| `assets` | `searchAssets`、`scanAssets`：本地素材搜索（文件名/文件夹/可选 `index.json` 元数据，支持中文） |
| `describe` | 把幻灯片/形状/主题/选区描述成给模型看的紧凑文本 |
| `watch` | `PptWatcher`（EventEmitter）：用户手动编辑停手后做 lint，只报新问题；`apply()` 执行机械修复 |
| `tools` | `PPT_TOOL_DEFS`（7 个工具的 JSON schema）、`callPptTool(host, name, args)` |

## 快速开始

### 1. 直接用 API

```ts
import { PptBridge, pptAvailable, lintSlide, formatIssues } from "@mini-agent/ppt-sdk";

if (pptAvailable()) {
  const ppt = new PptBridge();
  try {
    await ppt.edit([
      { op: "add_textbox", slide: 1, text: "Hello", left: 60, top: 40, width: 400, height: 50, size: 32 },
    ]);
    console.log(formatIssues(lintSlide(await ppt.dump(1))));
  } finally {
    ppt.dispose();           // 结束 PowerShell 进程
  }
}
```

### 2. 接到任何 LLM（function calling）

```ts
import { PptBridge, PPT_TOOL_DEFS, callPptTool, type PptHost } from "@mini-agent/ppt-sdk";

const host: PptHost = {
  ppt: new PptBridge(),
  root: process.cwd(),
  scratchDir: ".agent/scratch/ppt",
  backupDir: ".agent/backups/ppt",
  // 可选：vision / attachImage / resolvePath / assetDirs / readOnly / saveRoot ...
};

// 1) 把 PPT_TOOL_DEFS 作为 tools 传给模型（OpenAI chat.completions 格式）
// 2) 模型返回 tool_call 时：
const text = await callPptTool(host, call.function.name, JSON.parse(call.function.arguments));
// 返回给模型的字符串；未知工具名返回 undefined；错误一律变成"下一步指引"文本，不抛异常
```

`PptHost` 的宿主钩子：

| 字段 | 作用 |
|---|---|
| `readOnly` | `true` 时拒绝 `ppt_edit` / `ppt_open` / `ppt_save` / `ppt_lint fix`（对应 ask / 只读模式） |
| `resolvePath(p, kind)` | 读取图片、`.pptx` 之前的校验，宿主在这里接入自己的权限/授权；默认相对 `root` 解析且必须存在 |
| `vision(req)` | 给 PNG + 提示词，返回点评文字（`ppt_look` 用）；没有时尝试 `attachImage`，再没有就明确告知"不可用" |
| `assetDirs` / `onAssetDirs` | 素材目录；搜索时把目录告诉宿主，便于授权只读 |
| `saveRoot` | `ppt_save` 另存的限制目录，默认 `root`，`null` 不限制 |

### 3. 实时监视

```ts
import { PptWatcher, formatWatchEvent, formatApplyResult } from "@mini-agent/ppt-sdk";

const w = new PptWatcher({ ppt, backupDir: ".agent/backups/ppt", busy: () => agentIsEditing });
w.on("issues", (e) => console.log(formatWatchEvent(e)));      // e.fresh = 新问题, e.all = 当前页全部问题
w.on("stopped", () => console.log("连续读取失败，已停止"));
w.start();
// ...
console.log(formatApplyResult(await w.apply("")));             // "" = 全部机械修复，"2" = 只修第 2 条
```

## 工具一览

| 工具 | 读/写 | 说明 |
|---|---|---|
| `ppt_read` | 读 | 实时状态 + 用户选中的形状 + 大纲 + 当前页形状 + 主题 |
| `ppt_edit` | 写 | 批量操作（单次最多 40 个）：文本框/形状/线/图片/格式/几何/层级/分组/对齐/分布/页面/备注/背景/跳转；成功后附带自动 lint |
| `ppt_lint` | 读（`fix` 为写） | 规则检查；`fix=true` 自动修复机械问题并复查 |
| `ppt_look` | 读 | 渲染成图交给视觉模型点评 |
| `asset_search` | 读 | 本地素材搜索 |
| `ppt_open` | 写 | 打开 `.pptx` 或新建空白文稿 |
| `ppt_save` | 写 | 保存 / 另存为 `.pptx` |

## 随包发布与打包

- `ppt-bridge.ps1`（COM 桥）与 `dist/` 一起发布，**保持纯 ASCII**，否则 Windows PowerShell 5.1 会按 ANSI 读错。
- 脚本查找：`new PptBridge({ scriptPath })` 显式指定；否则依次找 包根目录（`dist/` 的上一级，npm 安装 / workspace）→ `dist/` 同目录 → 可执行文件同目录 → 可执行文件旁的 `packages/ppt-sdk/`（bun `--compile` 单文件时用后两个）。
- 构建：`npm run build -w @mini-agent/ppt-sdk`（`tsc` → `dist/`）。

## 测试

```bash
npm test -w @mini-agent/ppt-sdk                    # 单元测试：lint / assets / tools / watch，用内存假 PowerPoint，不需要 Office
npm run test:integration -w @mini-agent/ppt-sdk    # 集成测试：真实 PowerPoint（新建临时演示文稿，用后关闭，不保存）
```
