// Workspace sintético para a avaliação: 30 repositórios, cerca de 50 mil itens no índice.
// Dois sistemas são escritos à mão (loja e banco digital) para os casos de teste; os outros 28
// são gerados de forma determinística e servem de ruído realista.
import type { IndexDoc, IndexUpdate, UnitLink } from "../src/types.js";

interface UnitSpec {
  id: string;
  name: string;
  kind: string;
  role?: string;
  aliases?: string[];
  description?: string;
  parent: string;
}

interface DiagramSpec {
  id: string;
  title: string;
  kind: string;
  anchors: string[];
  nodes: { id: string; label: string; kind: string; unit?: string }[];
  edges: { id: string; from: string; to: string; label?: string }[];
}

export class FixtureBuilder {
  readonly docs: IndexDoc[] = [];
  readonly links: UnitLink[] = [];

  repo(id: string, name: string, description?: string) {
    this.docs.push({ id, kind: "unit", name, unitIds: [id], unitKind: "repository", extra: "repository repositorio", ...(description ? { description } : {}), projectId: id.replace("sem_", "prj_") });
  }

  unit(u: UnitSpec) {
    this.docs.push({
      id: u.id,
      kind: "unit",
      name: u.name,
      unitIds: [u.id],
      unitKind: u.kind,
      extra: [u.kind, u.role].filter(Boolean).join(" "),
      ...(u.aliases ? { aliases: u.aliases } : {}),
      ...(u.description ? { description: u.description } : {}),
    });
    this.links.push({ from: u.parent, to: u.id, type: "contains" });
  }

  relate(from: string, to: string, type = "calls") {
    this.links.push({ from, to, type });
  }

  diagram(d: DiagramSpec) {
    this.docs.push({ id: d.id, kind: "diagram", name: d.title, unitIds: d.anchors, diagramKind: d.kind, extra: d.kind });
    for (const n of d.nodes) {
      this.docs.push({ id: n.id, kind: "node", name: n.label, unitIds: n.unit ? [n.unit] : d.anchors, diagramId: d.id, diagramKind: d.kind, extra: n.kind });
    }
    for (const e of d.edges) {
      this.docs.push({ id: e.id, kind: "edge", name: e.label ?? "", unitIds: d.anchors, diagramId: d.id, diagramKind: d.kind, sourceId: e.from, targetId: e.to });
    }
  }

  update(): IndexUpdate {
    return { upsert: this.docs, links: this.links };
  }
}

/** Gerador pseudoaleatório determinístico (mulberry32). */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DOMAINS = [
  "faturamento", "estoque", "logistica", "relatorios", "notificacoes", "catalogo", "busca", "recomendacao",
  "fidelidade", "cupons", "frete", "rh", "folha", "contabilidade", "crm", "suporte", "agenda", "reservas",
  "telemetria", "auditoria", "identidade", "arquivos", "midia", "analytics", "marketing", "parceiros", "contratos", "tributos",
];

const VOCAB = [
  "handler", "controller", "cache", "gateway", "parser", "validator", "scheduler", "exporter", "importer", "mapper",
  "adapter", "client", "registry", "config", "metrics", "logger", "router", "session", "template", "renderer",
  "consumer", "producer", "index", "report", "job", "batch", "sync", "retry", "webhook", "storage", "policy", "rules",
];

function title(word: string) {
  return word[0]!.toUpperCase() + word.slice(1);
}

/** Loja: front web, back-end de pedidos, checkout, pagamentos e antifraude. */
function loja(b: FixtureBuilder) {
  b.repo("sem_loja", "loja", "Loja virtual: vitrine web, pedidos e pagamentos.");
  const p = "sem_loja";
  b.unit({ id: "sem_loja_app_web", name: "app-web", kind: "application", role: "frontend", description: "Vitrine e carrinho em React.", parent: p });
  b.unit({ id: "sem_loja_api_pedidos", name: "api-pedidos", kind: "service", role: "backend", description: "API REST de pedidos.", parent: p });
  b.unit({ id: "sem_loja_checkout", name: "Checkout", kind: "module", description: "Fechamento do pedido no front e no back.", parent: p });
  b.unit({ id: "sem_loja_cadastro", name: "Cadastro de clientes", kind: "module", parent: p });
  b.unit({ id: "sem_loja_pagamentos", name: "Serviço de pagamentos", kind: "service", aliases: ["payments"], parent: p });
  b.unit({ id: "sem_loja_antifraude", name: "Antifraude", kind: "service", aliases: ["antifraud"], description: "Valida transações suspeitas.", parent: p });
  b.unit({ id: "sem_loja_db", name: "Banco de pedidos", kind: "data_store", parent: p });
  b.relate("sem_loja_app_web", "sem_loja_api_pedidos");
  b.relate("sem_loja_api_pedidos", "sem_loja_db", "writes");
  b.relate("sem_loja_pagamentos", "sem_loja_antifraude");
  b.relate("sem_loja_checkout", "sem_loja_pagamentos", "depends_on");
  b.diagram({
    id: "dgm_loja_arquitetura",
    title: "Arquitetura da loja",
    kind: "architecture",
    anchors: ["sem_loja"],
    nodes: [
      { id: "nd_loja_web", label: "app-web", kind: "application", unit: "sem_loja_app_web" },
      { id: "nd_loja_api", label: "api-pedidos", kind: "service", unit: "sem_loja_api_pedidos" },
      { id: "nd_loja_pag", label: "Pagamentos", kind: "service", unit: "sem_loja_pagamentos" },
      { id: "nd_loja_af", label: "Antifraude", kind: "service", unit: "sem_loja_antifraude" },
      { id: "nd_loja_db", label: "Banco de pedidos", kind: "data_store", unit: "sem_loja_db" },
    ],
    edges: [
      { id: "edg_loja_web_api", from: "nd_loja_web", to: "nd_loja_api", label: "HTTP" },
      { id: "edg_loja_api_db", from: "nd_loja_api", to: "nd_loja_db" },
      { id: "edg_loja_api_pag", from: "nd_loja_api", to: "nd_loja_pag" },
      { id: "edg_loja_pag_af", from: "nd_loja_pag", to: "nd_loja_af" },
    ],
  });
  b.diagram({
    id: "dgm_loja_seq_pedido",
    title: "Criação do pedido",
    kind: "sequence",
    anchors: ["sem_loja_api_pedidos"],
    nodes: [
      { id: "nd_seq_web", label: "app-web", kind: "participant", unit: "sem_loja_app_web" },
      { id: "nd_seq_api", label: "api-pedidos", kind: "participant", unit: "sem_loja_api_pedidos" },
      { id: "nd_seq_db", label: "Banco de pedidos", kind: "participant", unit: "sem_loja_db" },
    ],
    edges: [
      { id: "edg_seq_post", from: "nd_seq_web", to: "nd_seq_api", label: "POST /pedidos" },
      { id: "edg_seq_insert", from: "nd_seq_api", to: "nd_seq_db", label: "insert pedido" },
      { id: "edg_seq_201", from: "nd_seq_api", to: "nd_seq_web", label: "201 Created" },
    ],
  });
  b.diagram({
    id: "dgm_loja_seq_pagamento",
    title: "Pagamento com antifraude",
    kind: "sequence",
    anchors: ["sem_loja_pagamentos"],
    nodes: [
      { id: "nd_sp_pag", label: "Pagamentos", kind: "participant", unit: "sem_loja_pagamentos" },
      { id: "nd_sp_af", label: "Antifraude", kind: "participant", unit: "sem_loja_antifraude" },
    ],
    edges: [
      { id: "edg_sp_valida", from: "nd_sp_pag", to: "nd_sp_af", label: "valida transação (síncrono)" },
      { id: "edg_sp_ok", from: "nd_sp_af", to: "nd_sp_pag", label: "aprovado" },
    ],
  });
  b.diagram({
    id: "dgm_loja_fluxo_checkout",
    title: "Fluxo do checkout",
    kind: "flow",
    anchors: ["sem_loja_checkout"],
    nodes: [
      { id: "nd_fc_carrinho", label: "Revisar carrinho", kind: "task" },
      { id: "nd_fc_endereco", label: "Escolher endereço", kind: "task" },
      { id: "nd_fc_pagar", label: "Pagar", kind: "task", unit: "sem_loja_pagamentos" },
      { id: "nd_fc_fim", label: "Pedido confirmado", kind: "event" },
    ],
    edges: [
      { id: "edg_fc_1", from: "nd_fc_carrinho", to: "nd_fc_endereco" },
      { id: "edg_fc_2", from: "nd_fc_endereco", to: "nd_fc_pagar" },
      { id: "edg_fc_3", from: "nd_fc_pagar", to: "nd_fc_fim" },
    ],
  });
}

/** Banco digital: dois fronts e dois back-ends; o portal fala com os dois, o app mobile só com contas. */
function banco(b: FixtureBuilder) {
  b.repo("sem_banco", "banco-digital", "Banco digital: portal, app mobile, contas e cartões.");
  const p = "sem_banco";
  b.unit({ id: "sem_banco_portal", name: "Portal do cliente", kind: "application", role: "frontend", aliases: ["portal"], parent: p });
  b.unit({ id: "sem_banco_app_mobile", name: "App mobile", kind: "application", role: "frontend", parent: p });
  b.unit({ id: "sem_banco_api_contas", name: "api-contas", kind: "service", role: "backend", description: "Saldo, extrato e transferências.", parent: p });
  b.unit({ id: "sem_banco_api_cartoes", name: "api-cartoes", kind: "service", role: "backend", description: "Emissão e validação de cartões.", parent: p });
  b.relate("sem_banco_portal", "sem_banco_api_contas");
  b.relate("sem_banco_portal", "sem_banco_api_cartoes");
  b.relate("sem_banco_app_mobile", "sem_banco_api_contas");
  b.diagram({
    id: "dgm_banco_arquitetura",
    title: "Arquitetura do banco digital",
    kind: "architecture",
    anchors: ["sem_banco"],
    nodes: [
      { id: "nd_bc_portal", label: "Portal", kind: "application", unit: "sem_banco_portal" },
      { id: "nd_bc_mobile", label: "App mobile", kind: "application", unit: "sem_banco_app_mobile" },
      { id: "nd_bc_contas", label: "api-contas", kind: "service", unit: "sem_banco_api_contas" },
      { id: "nd_bc_cartoes", label: "api-cartoes", kind: "service", unit: "sem_banco_api_cartoes" },
    ],
    edges: [
      { id: "edg_bc_portal_contas", from: "nd_bc_portal", to: "nd_bc_contas", label: "REST" },
      { id: "edg_bc_portal_cartoes", from: "nd_bc_portal", to: "nd_bc_cartoes", label: "REST" },
      { id: "edg_bc_mobile_contas", from: "nd_bc_mobile", to: "nd_bc_contas", label: "REST" },
    ],
  });
  b.diagram({
    id: "dgm_banco_seq_cartao",
    title: "Validação de cartão",
    kind: "sequence",
    anchors: ["sem_banco_api_cartoes"],
    nodes: [
      { id: "nd_sc_portal", label: "Portal", kind: "participant", unit: "sem_banco_portal" },
      { id: "nd_sc_cartoes", label: "api-cartoes", kind: "participant", unit: "sem_banco_api_cartoes" },
    ],
    edges: [{ id: "edg_sc_valida", from: "nd_sc_portal", to: "nd_sc_cartoes", label: "valida cartão" }],
  });
}

/** Um repositório gerado: API, worker, banco, fila, módulos e diagramas com rótulos do vocabulário. */
function filler(b: FixtureBuilder, domain: string, index: number, scale: number) {
  const random = rng(1000 + index);
  const pick = () => VOCAB[Math.floor(random() * VOCAB.length)]!;
  const id = `sem_${domain}`;
  b.repo(id, domain);
  const api = `${id}_api`;
  const worker = `${id}_worker`;
  const db = `${id}_db`;
  const fila = `${id}_fila`;
  b.unit({ id: api, name: `${title(domain)} API`, kind: "api", parent: id });
  b.unit({ id: worker, name: `Worker de ${domain}`, kind: "service", parent: id });
  b.unit({ id: db, name: `Banco de ${domain}`, kind: "data_store", parent: id });
  b.unit({ id: fila, name: `Fila de ${domain}`, kind: "component", parent: id });
  b.relate(api, db, "writes");
  b.relate(api, fila, "writes");
  b.relate(worker, fila, "reads");
  b.relate(worker, db, "writes");
  b.diagram({
    id: `dgm_${domain}_arquitetura`,
    title: `Arquitetura de ${domain}`,
    kind: "architecture",
    anchors: [id],
    nodes: [
      { id: `nd_${domain}_api`, label: `${title(domain)} API`, kind: "api", unit: api },
      { id: `nd_${domain}_worker`, label: "Worker", kind: "service", unit: worker },
      { id: `nd_${domain}_db`, label: "Banco", kind: "data_store", unit: db },
      { id: `nd_${domain}_fila`, label: "Fila", kind: "component", unit: fila },
    ],
    edges: [
      { id: `edg_${domain}_api_db`, from: `nd_${domain}_api`, to: `nd_${domain}_db` },
      { id: `edg_${domain}_api_fila`, from: `nd_${domain}_api`, to: `nd_${domain}_fila`, label: "publica" },
      { id: `edg_${domain}_worker_fila`, from: `nd_${domain}_worker`, to: `nd_${domain}_fila`, label: "consome" },
      { id: `edg_${domain}_worker_db`, from: `nd_${domain}_worker`, to: `nd_${domain}_db` },
    ],
  });
  const modules: string[] = [];
  for (let m = 0; m < 16; m++) {
    const mid = `${id}_mod${m}`;
    modules.push(mid);
    b.unit({ id: mid, name: `${domain} ${pick()} ${pick()}`, kind: "module", parent: id });
  }
  for (let d = 0; d < scale; d++) {
    const did = `dgm_${domain}_${d}`;
    const anchor = modules[d % modules.length]!;
    const nodes = Array.from({ length: 25 }, (_, n) => ({
      id: `nd_${domain}_${d}_${n}`,
      label: `${title(pick())} ${pick()}`,
      kind: "component",
      ...(random() < 0.3 ? { unit: modules[Math.floor(random() * modules.length)]! } : {}),
    }));
    const edges = Array.from({ length: 30 }, (_, e) => ({
      id: `edg_${domain}_${d}_${e}`,
      from: nodes[Math.floor(random() * nodes.length)]!.id,
      to: nodes[Math.floor(random() * nodes.length)]!.id,
      label: random() < 0.5 ? pick() : undefined,
    })).map(({ label, ...e }) => (label ? { ...e, label } : e));
    b.diagram({ id: did, title: `${title(domain)} ${pick()} ${pick()}`, kind: random() < 0.5 ? "flow" : "dependency", anchors: [anchor], nodes, edges });
  }
}

/** Workspace com 30 repositórios. `scale` diagramas gerados por repositório (30 dá ~50 mil itens). */
export function syntheticWorkspace(scale = 30): IndexUpdate {
  const b = new FixtureBuilder();
  loja(b);
  banco(b);
  DOMAINS.forEach((d, i) => filler(b, d, i, scale));
  return b.update();
}
