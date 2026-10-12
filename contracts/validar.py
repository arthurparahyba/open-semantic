#!/usr/bin/env python3
"""Valida os exemplos contra os schemas da V0.2 e checa regras que JSON Schema não expressa.

Uso: python3 contracts/validar.py   (requer: pip install jsonschema)

Checagens além do schema:
  - snapshot do workspace: toda referência por id aponta para um objeto existente;
    todo mod/diagrama tem exatamente um CanvasObject; ids são únicos.
  - lote: dependências existem, formam um DAG, e todo $bind aponta para um passo
    do qual o passo atual depende (direta ou transitivamente).
"""
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

BASE = Path(__file__).resolve().parent
SCHEMAS = BASE / "schemas"
EXAMPLES = BASE / "exemplos"
URI = "https://schemas.open-semantic.invalid/v0.2/"

registry = Registry()
for p in sorted(SCHEMAS.glob("*.schema.json")):
    doc = json.loads(p.read_text())
    Draft202012Validator.check_schema(doc)
    registry = registry.with_resource(doc["$id"], Resource.from_contents(doc))


def validator(ref):
    return Draft202012Validator({"$ref": URI + ref}, registry=registry, format_checker=FormatChecker())


errors = []


def check(name, instance, ref):
    for e in validator(ref).iter_errors(instance):
        errors.append(f"{name}: {'/'.join(map(str, e.absolute_path)) or '<raiz>'}: {e.message[:300]}")


# ---------- integridade do snapshot ----------
def check_snapshot(name, ws):
    ids = {}

    def reg(obj_id, kind):
        if obj_id in ids:
            errors.append(f"{name}: id duplicado {obj_id}")
        ids[obj_id] = kind

    reg(ws["workspace"]["id"], "workspace")
    for p in ws["projects"]:
        reg(p["id"], "project")
        for r in p["roots"]:
            reg(r["id"], "root")
    for a in ws["artifacts"]:
        reg(a["id"], "artifact")
    for e in ws["semantic"]["entities"]:
        reg(e["id"], "entity")
    for r in ws["semantic"]["relations"]:
        reg(r["id"], "relation")
    for ev in ws["semantic"]["evidence"]:
        reg(ev["id"], "evidence")
    for m in ws["mods"]:
        reg(m["id"], "mod")
    for d in ws["diagrams"]:
        reg(d["id"], "diagram")
        for n in d["nodes"]:
            reg(n["id"], "node")
        for ed in d["edges"]:
            reg(ed["id"], "edge")
    for rg in ws["canvas"]["regions"]:
        reg(rg["id"], "region")

    def need(ref, kind, where):
        if ids.get(ref) != kind:
            errors.append(f"{name}: {where} referencia {ref}, que não é um {kind} existente")

    for pid in ws["workspace"]["projectIds"]:
        need(pid, "project", "workspace.projectIds")
    for p in ws["projects"]:
        need(p["rootRef"], "artifact", f"project {p['id']}.rootRef")
    root_ids = {r["id"] for p in ws["projects"] for r in p["roots"]}
    for a in ws["artifacts"]:
        need(a["projectId"], "project", f"artifact {a['id']}")
        if "rootId" in a["locator"] and a["locator"]["rootId"] not in root_ids:
            errors.append(f"{name}: artifact {a['id']} usa raiz não autorizada {a['locator']['rootId']}")
    evidence_ids = {ev["id"] for ev in ws["semantic"]["evidence"]}
    for e in ws["semantic"]["entities"] + ws["semantic"]["relations"]:
        for evd in e["provenance"].get("evidenceIds", []):
            if evd not in evidence_ids:
                errors.append(f"{name}: {e['id']} cita evidência inexistente {evd}")
    for e in ws["semantic"]["entities"]:
        for art in e.get("artifactIds", []):
            need(art, "artifact", f"entity {e['id']}")
    for r in ws["semantic"]["relations"]:
        need(r["sourceId"], "entity", f"relation {r['id']}.sourceId")
        need(r["targetId"], "entity", f"relation {r['id']}.targetId")
    for ev in ws["semantic"]["evidence"]:
        if "artifactId" in ev:
            need(ev["artifactId"], "artifact", f"evidence {ev['id']}")
    for m in ws["mods"]:
        for key in ("rootRef", "fileRef", "cwdRef"):
            if key in m["config"]:
                need(m["config"][key], "artifact", f"mod {m['id']}.config.{key}")
        for s in m.get("semanticEntityIds", []):
            need(s, "entity", f"mod {m['id']}")
    for d in ws["diagrams"]:
        node_ids = {n["id"] for n in d["nodes"]}
        for n in d["nodes"]:
            if "semanticEntityId" in n:
                need(n["semanticEntityId"], "entity", f"node {n['id']}")
        for ed in d["edges"]:
            for k in ("sourceNodeId", "targetNodeId"):
                if ed[k] not in node_ids:
                    errors.append(f"{name}: edge {ed['id']}.{k} fora do diagrama {d['id']}")
            if "semanticRelationId" in ed:
                need(ed["semanticRelationId"], "relation", f"edge {ed['id']}")
        for nid in d["layout"]["nodes"]:
            if nid not in node_ids:
                errors.append(f"{name}: layout de {d['id']} cita nó inexistente {nid}")
    placed = [o["id"] for o in ws["canvas"]["objects"]]
    for o in ws["canvas"]["objects"]:
        need(o["id"], o["objectKind"], "canvas.objects")
        if "regionId" in o:
            need(o["regionId"], "region", f"canvas object {o['id']}")
    for oid in [m["id"] for m in ws["mods"]] + [d["id"] for d in ws["diagrams"]]:
        if placed.count(oid) != 1:
            errors.append(f"{name}: {oid} deve ter exatamente um CanvasObject (tem {placed.count(oid)})")
    for t in ws["navigation"]["focus"].get("targetIds", []) + ws["navigation"]["focus"].get("highlightIds", []):
        if t not in ids:
            errors.append(f"{name}: navigation.focus cita {t}, inexistente")


# ---------- integridade do lote ----------
def find_binds(value):
    if isinstance(value, dict):
        if set(value) == {"$bind"}:
            yield value["$bind"]["step"]
        else:
            for v in value.values():
                yield from find_binds(v)
    elif isinstance(value, list):
        for v in value:
            yield from find_binds(v)


def check_batch(name, plan):
    steps = {s["stepId"]: s for s in plan["steps"]}
    if len(steps) != len(plan["steps"]):
        errors.append(f"{name}: stepId duplicado")
    op_ids = [s["request"]["operationId"] for s in plan["steps"]]
    if len(set(op_ids)) != len(op_ids):
        errors.append(f"{name}: operationId duplicado")
    for s in plan["steps"]:
        for d in s.get("dependsOn", []):
            if d not in steps:
                errors.append(f"{name}: {s['stepId']} depende de passo inexistente {d}")

    # ancestrais transitivos + detecção de ciclo
    memo, visiting = {}, set()

    def ancestors(sid):
        if sid in memo:
            return memo[sid]
        if sid in visiting:
            errors.append(f"{name}: ciclo de dependências envolvendo {sid}")
            return set()
        visiting.add(sid)
        acc = set()
        for d in steps[sid].get("dependsOn", []):
            if d in steps:
                acc |= {d} | ancestors(d)
        visiting.discard(sid)
        memo[sid] = acc
        return acc

    for sid, s in steps.items():
        anc = ancestors(sid)
        for b in find_binds(s["request"]):
            if b not in anc:
                errors.append(f"{name}: {sid} usa $bind de '{b}' sem depender dele")


def load(name):
    return json.loads((EXAMPLES / name).read_text())


ws = load("workspace-apos-lote.json")
check("workspace-apos-lote.json", ws, "workspace.schema.json")
check_snapshot("workspace-apos-lote.json", ws)

plan = load("lote-referencia.json")
check("lote-referencia.json", plan, "operation.schema.json#/$defs/BatchPlan")
check_batch("lote-referencia.json", plan)

check("lote-resultado.json", load("lote-resultado.json"), "operation.schema.json#/$defs/BatchResult")

rej = load("operacao-rejeitada.json")
check("operacao-rejeitada.json#request", rej["request"], "operation.schema.json#/$defs/OperationRequest")
check("operacao-rejeitada.json#result", rej["result"], "operation.schema.json#/$defs/OperationResult")

# Testes negativos: a regra de procedência precisa recusar inferência marcada como verificada.
bad = json.loads(json.dumps(ws["semantic"]["entities"][1]))
bad["status"] = "verified"
if not list(validator("semantic.schema.json#/$defs/SemanticEntity").iter_errors(bad)):
    errors.append("teste negativo: inferência marcada como 'verified' foi aceita")
bad_path = {"rootId": "root_main", "path": "../etc"}
if not list(validator("project.schema.json#/$defs/ArtifactReference/properties/locator").iter_errors(bad_path)):
    errors.append("teste negativo: caminho com '..' foi aceito")

if errors:
    print("FALHOU")
    for e in errors:
        print(" -", e)
    sys.exit(1)
print(f"OK: {len(list(SCHEMAS.glob('*.schema.json')))} schemas válidos, 4 exemplos válidos, integridade e testes negativos ok.")
