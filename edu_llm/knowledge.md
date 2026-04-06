# BOS / EOS in Chinese Pretraining

## What BOS and EOS Mean

- `bos_token_id`: beginning-of-sequence token ID, marks sequence start.
- `eos_token_id`: end-of-sequence token ID, marks sequence end.

In decoder-only models, these tokens are usually applied in the data and generation pipeline, not via special logic in `model.forward()`.

## Why `model.forward()` Does Not Special-Handle BOS/EOS

`DecoderOnlyModel` takes token IDs and computes logits. It does not branch on token type like:

- `if token == bos_token_id: ...`
- `if token == eos_token_id: ...`

So BOS/EOS are used by sequence construction and stopping rules, then consumed as normal tokens by the model.

## Chinese Pretraining Scenarios

### 1) 多文档预训练（最常见）

你有两条语料：

- 文档 A：`牛顿提出了万有引力定律。`
- 文档 B：`细胞由细胞膜和细胞核组成。`

如果直接拼接（无边界）：

`...万有引力定律。细胞由...`

模型会把前后当成连续上下文，学到一些跨文档“假关系”。

加 `EOS` 后：

`牛顿提出了万有引力定律。<eos>细胞由细胞膜和细胞核组成。<eos>`

模型知道“这里结束了，后面是新样本”。

`BOS` 可选：

- `<bos>牛顿提出了万有引力定律。<eos>`
- `<bos>细胞由细胞膜和细胞核组成。<eos>`

### 2) 指令/对话微调（Chat）

中文样本：

- 用户：`请解释光合作用。`
- 助手：`光合作用是绿色植物利用光能合成有机物的过程。`

格式化成：

`<bos><user>请解释光合作用。</user><assistant>光合作用是...过程。<eos>`

这里 `EOS` 很关键：

- 训练时告诉模型“助手回答到这里结束”
- 推理时生成到 `EOS` 就可以停止

### 3) 生成时停止条件

比如输入：

`地球为什么有四季？`

模型开始续写。如果不看 `EOS`，可能一直生成到 `max_new_tokens`。  
如果设置“遇到 `EOS` 停止”，输出更自然，也避免无意义拖长。

### 4) 样本打包（packing）

为提高吞吐量，常把多条短中文句子拼到一个序列里：

`勾股定理描述直角三角形边长关系。<eos>元素周期表按原子序数排列。<eos>`

这样既利用上下文窗口，又不让样本互相污染。

### 5) 什么时候可以不显式用 BOS

中文继续写作任务里，如果 `prompt` 总是非空：

`请续写：量子力学是研究微观粒子行为的理论，`

很多模型不用显式 `BOS` 也能正常工作。  
但 `EOS` 通常仍建议保留（边界 + 停止都需要）。

## 一句话总结

- `EOS`：强烈建议使用（边界、停止、packing 都依赖它）
- `BOS`：在很多中文任务中是“可选增强项”，尤其在统一格式训练时更有价值