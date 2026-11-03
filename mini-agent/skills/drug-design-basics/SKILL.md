---
name: drug-design-basics
description: 小分子药物设计的基础分析：检查 SMILES 是否有效、计算理化性质（MW/logP/HBD/HBA/TPSA/QED）、Lipinski 规则与 PAINS 警示结构、对候选分子做初筛排序。用户涉及分子、SMILES、候选化合物、类药性时使用。
---

# 小分子药物设计 · 基础分析

本技能只覆盖**化学信息学基础**（基于 RDKit）。对接（docking）、生成模型、ADMET 预测、结合自由能等需要专门的工具——
如果系统提示里有"外部工具（MCP）"，优先用那些工具；没有就如实告诉用户"需要接入对应工具"，**不要编造打分结果**。

## 工具脚本

`{python} "{skill_dir}/scripts/mol_props.py" <输入> [--csv 输出.csv]`

- `<输入>`：一个或多个 SMILES，或一个文本/CSV 文件（每行一个 SMILES；CSV 需要名为 `smiles` 的列，可选 `name` 列）。
- 输出每个分子的：是否有效、规范 SMILES、MW、cLogP、HBD、HBA、TPSA、可旋转键、QED、Lipinski 违规数、PAINS 警示数。
- 缺少 RDKit 时脚本会提示 `pip install rdkit`（安装可能较慢，用 `background=true` + `job_output` 等待）。

## 工作流程

1. 明确目标：靶点/适应症、必须满足的性质范围（如口服：MW<500、logP<5、TPSA<140）、候选来源。
2. 把候选写进文件（如 `candidates.csv`），用脚本批量计算，**不要心算性质**。
3. 先过滤再排序：无效 SMILES → 违反硬性约束 → 有 PAINS 警示（标注，不一定剔除）→ 按用户关心的指标排序。
4. 报告里区分三类信息：脚本算出来的数值（可信）、经验规则的判断（Lipinski 只是经验）、你的推测（明确标注"推测"）。
5. 结论只依据真实输出；不要给出没有跑过的结合亲和力、毒性、活性数据。

## 注意

- 性质预测是**初筛**，不能替代实验。说明这一点，不要夸大。
- 涉及真实药物研发决策、临床用途的结论，提示需要专业人员复核。
