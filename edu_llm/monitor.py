import torch
import torch.nn.functional as F
from transformers import TrainerCallback
import swanlab


# ===================== 监控工具函数 =====================
def calc_act_stats(hidden):
    return hidden.mean().item(), hidden.std().item()

def calc_attn_entropy(attn_weight):
    attn_weight = attn_weight + 1e-10
    entropy = -torch.sum(attn_weight * torch.log2(attn_weight), dim=-1)
    return entropy.mean().item()

def calc_cos_sim(h1, h2):
    h1 = h1.reshape(-1, h1.size(-1))
    h2 = h2.reshape(-1, h2.size(-1))
    return F.cosine_similarity(h1, h2, dim=-1).mean().item()

# ===================== 层监控回调（核心） =====================
class LayerMonitorCallback(TrainerCallback):
    # ✅ 固定名字：on_step_end
    def on_step_end(self, args, state, control, outputs=None, **kwargs):
        # 拿训练已经算好的结果
        if outputs is None:
            return
        print("log on step")
        hidden_states = outputs.hidden_states
        attentions = outputs.attentions

        log_data = {}

        for i in range(len(attentions)):
            h = hidden_states[i+1].float()
            attn = attentions[i].float()

            # 激活分布
            log_data[f"layer_{i}/act_mean"] = h.mean().item()
            log_data[f"layer_{i}/act_std"] = h.std().item()

            # 注意力熵
            attn = attn + 1e-10
            entropy = (-attn * torch.log2(attn)).sum(dim=-1).mean().item()
            log_data[f"layer_{i}/attn_entropy"] = entropy

            # 层间余弦相似度
            if i > 0:
                prev_h = hidden_states[i].float()
                cos = torch.nn.functional.cosine_similarity(
                    prev_h.reshape(-1, prev_h.size(-1)),
                    h.reshape(-1, h.size(-1)),
                    dim=-1
                ).mean().item()
                log_data[f"cos_sim/layer_{i-1}_vs_{i}"] = cos

        # 上传 SwanLab
        if log_data:
            swanlab.log(log_data)
