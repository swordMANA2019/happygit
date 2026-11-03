---
name: pptx
description: 制作 PowerPoint 演示文稿（.pptx）：根据资料/需求设计大纲、生成幻灯片、自动检查版式。用户要"做 PPT / 演示文稿 / slides / 汇报材料"时使用。
verify: {python} "{skill_dir}/scripts/check_deck.py" {changed}
verify_ext: .pptx
---

# 制作 PPT

目录 `{skill_dir}` 里有现成脚本，**不要自己从零写 python-pptx 代码**，改写 JSON 规格即可。

## 流程

1. **弄清需求**（缺了关键信息才问，能合理假设就写明假设继续）：受众、目的（汇报/说服/培训）、页数或时长、语言、是否有现成资料/模板。
2. **收集内容**：用 `read_document` / `read_file` 阅读用户给的资料（多份资料可用 `delegate` 并行阅读），把要点记进 `save_notes`。
3. **设计大纲**（先 `update_plan`）：
   - 一页只讲一个结论；标题写成"结论句"（如"Q3 成本下降 12%，主要来自采购"），而不是"成本情况"。
   - 每页最多 6 条要点，每条不超过 20 个字（英文 15 词）；细节放进 `notes`（演讲备注）。
   - 结构：封面 → 背景/问题 → 核心内容（2~5 页）→ 结论/下一步。
4. **写规格文件** `deck_spec.json`（用 write_file），格式见下。
5. **确认环境**：`{python} -c "import pptx"`。若缺少，`{python} -m pip install python-pptx`（可能较慢，用 `background=true` 并 job_output 等待）。
6. **生成**：`{python} "{skill_dir}/scripts/build_deck.py" deck_spec.json 输出文件名.pptx`
7. **检查**：任务结束时系统会自动运行 `check_deck.py`（检查空白页、文字溢出、越界）。失败时按报错修改规格并重新生成。
8. **（可选）看效果**：`{python} "{skill_dir}/scripts/render_deck.py" 输出文件名.pptx` 渲染成图片（需要 LibreOffice）；
   若可以使用 `view_image`，逐页查看版式；不能渲染就如实告诉用户"未做视觉检查"。
9. **汇报**：文件路径、页数、你做的假设、哪些内容需要用户补充（如缺失的数据/图片）。

## deck_spec.json 格式

```json
{
  "theme": {"font": "Calibri", "accent": "1F4E79"},
  "slides": [
    {"layout": "title", "title": "项目季度汇报", "subtitle": "2026 Q3 | 产品部"},
    {"layout": "bullets", "title": "收入增长 18%，主要来自新客户",
     "bullets": ["新客户贡献 62% 增量", ["华东 +35%", "华南 +21%"], "老客户续约率 94%"],
     "notes": "演讲备注：这里解释口径……"},
    {"layout": "two_column", "title": "方案对比", "left": ["方案 A：成本低"], "right": ["方案 B：周期短"]},
    {"layout": "table", "title": "关键指标", "columns": ["指标", "Q2", "Q3"], "rows": [["收入", "10M", "11.8M"]]},
    {"layout": "image", "title": "架构图", "image": "figs/arch.png", "caption": "图 1 系统架构"}
  ]
}
```

- `bullets` 里的子数组表示二级要点。
- 图片路径相对于运行命令的目录；图片不存在时脚本会报错。
- 脚本会按文字量自动缩小字号，但内容太多仍会被检查器判为溢出——应当拆页，而不是堆字。

## 注意

- 不要编造数据。资料里没有的数字、结论不要写进幻灯片；缺什么在汇报里列出来。
- 覆盖已存在的 .pptx 前先确认用户是否要保留旧版本（换个文件名更安全）。
