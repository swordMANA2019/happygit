---
name: office-docs
description: 创建或修改 Word（.docx）、Excel（.xlsx）文件，以及把内容导出为 PDF。用户要"写 Word 文档 / 做 Excel 表格 / 生成报告文件"时使用（PPT 请用 pptx 技能）。
---

# Word / Excel 文件

读取已有的 .docx/.xlsx/.pdf：直接用 `read_document` 工具（不需要 Python）。
**创建/修改**需要 Python 库，在脚本里完成：

| 目标 | 库 | 安装 |
|---|---|---|
| Word | `python-docx` | `{python} -m pip install python-docx` |
| Excel | `openpyxl` | `{python} -m pip install openpyxl` |

## 流程

1. 先 `{python} -c "import docx"` / `import openpyxl` 确认库可用，缺少就安装（较慢时 `background=true` + `job_output`）。
2. 把"内容"和"排版代码"分开：先把正文整理成结构化数据（Markdown/JSON），再写一个小脚本 `make_report.py` 生成文件，脚本留在项目里方便用户重跑。
3. Word：标题用 `doc.add_heading`，正文 `add_paragraph`，表格 `add_table`；中文字体需要同时设置 `eastAsia`（否则会回退成宋体）。
4. Excel：第一行写表头并冻结（`ws.freeze_panes = "A2"`）；数值写成数字而不是字符串；公式用 `ws["C2"] = "=A2*B2"`。
5. **生成后用 `read_document` 读回来核对**：内容是否完整、表格行列是否对、有无乱码。
6. 汇报：文件路径、结构概览、做过的假设。

## 注意

- 不要覆盖用户已有文件；输出换新文件名，或先确认。
- 不要编造数据；缺失的数据在文档里标"待补充"。
