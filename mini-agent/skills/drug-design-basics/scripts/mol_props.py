#!/usr/bin/env python3
"""批量计算小分子基础性质（RDKit）。用法: mol_props.py <SMILES... | 文件> [--csv 输出.csv]
退出码：0 成功；127 缺少 RDKit（环境问题）。"""
import csv
import os
import sys

try:
    from rdkit import Chem
    from rdkit.Chem import QED, Crippen, Descriptors, Lipinski, rdMolDescriptors
    from rdkit.Chem.FilterCatalog import FilterCatalog, FilterCatalogParams
except ImportError:
    print("[环境问题] 缺少 RDKit，请先执行: python -m pip install rdkit")
    sys.exit(127)


def read_inputs(args):
    items = []  # (name, smiles)
    for a in args:
        if os.path.isfile(a):
            with open(a, encoding="utf-8-sig", newline="") as f:
                sample = f.read(2048)
                f.seek(0)
                if a.lower().endswith(".csv") and "smiles" in sample.lower().split("\n")[0]:
                    for i, row in enumerate(csv.DictReader(f), start=1):
                        low = {k.lower(): v for k, v in row.items()}
                        items.append((low.get("name") or f"mol{i}", (low.get("smiles") or "").strip()))
                else:
                    for i, line in enumerate(f, start=1):
                        line = line.strip()
                        if line and not line.startswith("#"):
                            parts = line.split()
                            items.append((parts[1] if len(parts) > 1 else f"mol{len(items) + 1}", parts[0]))
        else:
            items.append((f"mol{len(items) + 1}", a))
    return items


def main():
    argv = sys.argv[1:]
    out_csv = None
    if "--csv" in argv:
        i = argv.index("--csv")
        out_csv = argv[i + 1] if i + 1 < len(argv) else None
        argv = argv[:i] + argv[i + 2:]
    if not argv:
        print(__doc__)
        return 2

    params = FilterCatalogParams()
    params.AddCatalog(FilterCatalogParams.FilterCatalogs.PAINS)
    pains = FilterCatalog(params)

    rows = []
    for name, smi in read_inputs(argv):
        mol = Chem.MolFromSmiles(smi) if smi else None
        if mol is None:
            rows.append({"name": name, "input": smi, "valid": False})
            continue
        mw, logp = Descriptors.MolWt(mol), Crippen.MolLogP(mol)
        hbd, hba = Lipinski.NumHDonors(mol), Lipinski.NumHAcceptors(mol)
        violations = sum([mw > 500, logp > 5, hbd > 5, hba > 10])
        rows.append({
            "name": name, "input": smi, "valid": True,
            "smiles": Chem.MolToSmiles(mol),
            "MW": round(mw, 2), "cLogP": round(logp, 2), "HBD": hbd, "HBA": hba,
            "TPSA": round(rdMolDescriptors.CalcTPSA(mol), 1),
            "RotB": rdMolDescriptors.CalcNumRotatableBonds(mol),
            "QED": round(QED.qed(mol), 3),
            "Lipinski_violations": violations,
            "PAINS_alerts": len(pains.GetMatches(mol)),
        })

    cols = ["name", "valid", "smiles", "MW", "cLogP", "HBD", "HBA", "TPSA", "RotB", "QED", "Lipinski_violations", "PAINS_alerts"]
    print("\t".join(cols))
    for r in rows:
        print("\t".join(str(r.get(c, "")) if r["valid"] or c in ("name", "valid") else ("(无效 SMILES: " + r["input"] + ")" if c == "smiles" else "")
                        for c in cols))
    bad = [r for r in rows if not r["valid"]]
    print(f"\n共 {len(rows)} 个分子，有效 {len(rows) - len(bad)}，无效 {len(bad)}")

    if out_csv:
        with open(out_csv, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
            w.writeheader()
            w.writerows(rows)
        print(f"已写入 {out_csv}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
