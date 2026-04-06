import json
import re
import random
from pathlib import Path
from tqdm import tqdm

# ====================== 配置（你只需要改这里）======================
INPUT_WIKI_FILE = "/mnt/build/llm_data/wikipedia-zh-cn-20240820.json"  # 你的维基百科数据路径（每行一条）
OUTPUT_SFT_FILE = "/mnt/build/llm_data/sft_zhwiki.json"  # 输出SFT数据路径
MAX_SAMPLES = 150000  # SFT数据量（科教最佳：5万~20万）
MIN_RESPONSE_LEN = 100  # 回答最小长度
MAX_RESPONSE_LEN = 600  # 回答最大长度（避免过长）

# 科教领域过滤关键词（只保留这些领域，过滤八卦/娱乐/人物）
ALLOW_KEYWORDS = [
    "数学", "物理", "化学", "生物", "地理", "天文", "计算机", "科学",
    "定理", "公式", "原理", "结构", "反应", "算法", "系统", "理论",
    "工程", "技术", "医学", "生态", "细胞", "元素", "分子", "力学"
]

# 指令模板（3种风格，科教最适合）
INSTRUCTION_TEMPLATES = [
    "请解释什么是{title}？",
    "请简述{title}的基本原理。",
    "{title}的主要内容是什么？"
]


# ====================== 清洗函数 ======================
def clean_wiki_text(text: str) -> str:
    """清洗维基百科文本：去除引用、括号、短横线、多余空格"""
    text = re.sub(r'\[\d+\]', '', text)  # 去掉引用标记 [1][2]
    text = re.sub(r'\([^)]*\)', '', text)  # 去掉括号内容
    text = re.sub(r'-{2,}', '', text)  # 去掉长横线
    text = re.sub(r'\s+', ' ', text).strip()  # 合并空格
    return text


def is_edu_related(title: str) -> bool:
    """判断是否是科教相关条目（过滤娱乐人物）"""
    if any(kw in title for kw in ALLOW_KEYWORDS):
        return True
    # 过滤明显非科教标题
    if re.search(r'演员|歌手|运动员|主播|网红|乐队|组合|游戏|动漫|小说', title):
        return False
    return True


# ====================== 主转换逻辑 ======================
def wiki_to_sft():
    input_path = Path(INPUT_WIKI_FILE)
    output_path = Path(OUTPUT_SFT_FILE)

    sft_data = []
    seen_titles = set()  # 去重

    print(f"开始处理维基百科数据 → 生成SFT指令集...")

    with open(input_path, 'r', encoding='utf-8') as f_in:
        lines = f_in.readlines()
        random.shuffle(lines)  # 打乱，避免连续同类条目

        for line in tqdm(lines, desc="转换中"):
            if len(sft_data) >= MAX_SAMPLES:
                break

            try:
                wiki = json.loads(line.strip())
                title = wiki.get("title", "").strip()
                content = wiki.get("text", "").strip()

                # 过滤条件
                if not title or not content:
                    continue
                if title in seen_titles:
                    continue
                if not is_edu_related(title):
                    continue

                # 清洗文本
                content = clean_wiki_text(content)
                if len(content) < MIN_RESPONSE_LEN:
                    continue

                # 截断到合适长度
                content = content[:MAX_RESPONSE_LEN]

                # 随机选一个指令模板
                instruction = random.choice(INSTRUCTION_TEMPLATES).format(title=title)

                sft_data.append({
                    "instruction": instruction,
                    "response": content
                })
                seen_titles.add(title)

            except Exception as e:
                continue

    # 保存为 JSONL（训练标准格式）
    with open(output_path, 'w', encoding='utf-8') as f_out:
        for item in sft_data:
            f_out.write(json.dumps(item, ensure_ascii=False) + "\n")

    print(f"\n✅ 完成！生成 SFT 数据 {len(sft_data)} 条")
    print(f"📄 输出文件：{output_path}")


if __name__ == "__main__":
    wiki_to_sft()
