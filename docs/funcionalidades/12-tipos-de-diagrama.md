# 12. Tipos de diagrama e escolha da forma de apresentar

Status: primeira entrega implementada (camadas, sequência e estrutura, formato híbrido, escolha automática).

## Decisões (aprovadas pelo Arthur em 13/10/2026)

- Primeira entrega: **camadas (`layers`), sequência (`sequence`) e estrutura (`tree`)**; os outros tipos da tabela ficam para depois.
- Formato: **híbrido desde já**. O modelo escreve o desenho em `source` (texto curto, estilo Mermaid) e as evidências em `evidence` (JSON por id de nó). Não passa por JSON por tipo antes. O modelo salvo continua JSON.
- O seletor "ver como…" fica para depois.
- Um caso de teste por tipo: "explique as camadas" tem que levar ao diagrama de camadas, e assim por diante.

## Como ficou (primeira entrega)

- `show_diagram` recebe `kind`, `why` (uma frase dizendo por que esse tipo), `source` e `evidence`. Gramática:
  - nó `id[Rótulo]` ou `id[Rótulo]:tipo`; ligação `a --> b : rótulo`;
  - layers: `layer Nome` abre uma faixa, os nós seguintes ficam nela;
  - sequence: `participant id[Rótulo]` na ordem das colunas; `a ->> b : chamada`, `b -->> a : retorno`;
  - tree: um nó por linha, o recuo diz quem contém quem (vira relação `contains`).
  - evidence: `{"owner": {"path": "src/owner", "seen": "...", "kind": "module"}, "a->b": {"seen": true}}`.
- Erros de texto voltam ao modelo com a linha (ex.: sequência sem mensagens, nó fora de faixa).
- Layouts novos em `diagram-engine`: `lanes` (faixas), `sequence` (colunas e linha de vida) e `tree` (ELK mrtree). Faixa e ordem ficam em `attributes` do nó (`layer`) e da aresta (`order`, `reply`).
- Desenho no canvas: faixas com o nome da camada à esquerda; participantes com linha de vida e mensagens numeradas, retorno tracejado; árvore com ligações em cotovelo e sem setas.
- Escolha: guia no prompt e na descrição de `kind` (pela forma da resposta), mais uma dica do app junto do pedido (`[app] Forma sugerida para o diagrama: layers (...)`) quando a pergunta fala de camadas, de implementação passo a passo ou de como o código está dividido.
- Testes: um caso por tipo na escolha (`visual.test.ts`), um desenho por tipo pelo formato híbrido e um e2e com camadas e sequência.

---

Proposta original abaixo.

## 1. O que existe hoje

- `show_diagram` (`packages/core/src/conversation/tools/showDiagram/`) já aceita `kind` = `architecture | flow | sequence | dependency`, mas o `kind` é só um rótulo.
- Todo diagrama vira o mesmo modelo (nós + arestas) e é posicionado pelo ELK em camadas (`packages/diagram-engine/src/layout.ts`) e desenhado como caixas e setas (`apps/desktop/src/renderer/DiagramView.tsx`). Só o `data_store` muda (canto mais arredondado).
- Por isso "sequência" sai igual a "arquitetura": não há participantes com linha de vida, nem ordem de mensagens, nem faixas de camadas.
- O prompt só diz ao modelo o que cada `kind` significa; não há critério de escolha.

## 2. Tipos propostos

Cada tipo é uma *gramática visual* própria (modelo, layout e desenho), não só um rótulo.

| Tipo | Responde a | Forma | Exemplo de pedido |
|---|---|---|---|
| **camadas** (`layers`) | "Como está organizado em níveis?" | Faixas horizontais empilhadas, componentes dentro de cada faixa, poucas setas (só as que furam camadas) | "explique as camadas da aplicação" |
| **componentes** (`components`, o atual) | "Do que é feito e quem fala com quem?" | Caixas e setas, layout ELK | "visão geral do sistema" |
| **sequência** (`sequence`) | "Como esta funcionalidade acontece passo a passo?" | Participantes no topo, linhas de vida, mensagens numeradas em ordem, retorno tracejado | "como está implementado salvar arquivo?" |
| **fluxo** (`flow`) | "Que decisões e etapas o processo tem?" | Fluxograma: início/fim, passos, losangos de decisão | "o que acontece quando o lote falha?" |
| **estados** (`states`) | "Por quais estados isto passa?" | Estados arredondados e transições com evento | "ciclo de vida de uma conversa" |
| **estrutura** (`tree`) | "Como as coisas se contêm?" | Árvore / pastas aninhadas (contêineres) | "como o monorepo está dividido?" |
| **dados** (`entities`) | "Quais dados existem e como se relacionam?" | Entidades com campos e cardinalidade (ER / classes) | "explique o modelo do workspace" |
| **mapa de conceitos** (`mindmap`) | "Quais são as ideias de um tema?" | Centro com ramos radiais, sem setas | "o que é o Open Semantic?" |
| **linha do tempo** (`timeline`) | "Como isso evoluiu / em que ordem?" | Eixo com marcos | "o que mudou nos últimos PRs?" |
| **comparação** (`matrix`) | "Qual a diferença entre A e B?" | Tabela/matriz de critérios | "JSON ou DSL para diagramas?" |

Prioridade sugerida: **camadas, sequência e estrutura** primeiro (cobrem os dois exemplos do Arthur e o caso de monorepo); depois estados, fluxo e dados; mapa, linha do tempo e comparação por último.

## 3. Inteligência de escolha

Três níveis, do mais barato ao mais robusto:

1. **Guia de decisão no prompt e na descrição da ferramenta.** Classificar a pergunta pela *forma* da resposta, não pelo assunto:
   - pergunta de organização/níveis → camadas;
   - "como funciona X", "o que acontece quando" com atores conversando → sequência; com decisões → fluxo;
   - ciclo de vida, status → estados;
   - "como está dividido", pastas, módulos dentro de módulos → estrutura;
   - dados, tipos, tabelas → dados;
   - "quem depende de quem", visão geral → componentes;
   - explicar ideia/conceito → mapa; histórico → linha do tempo; trade-offs → comparação.
   Inclui exemplos curtos de pedido → tipo.
2. **Campo `why` obrigatório** em `show_diagram`: uma frase dizendo por que esse tipo. Força o modelo a raciocinar e aparece na legenda como "visto como camadas porque…". Barato e auditável.
3. **Validação pela forma dos dados** no app (`plan.ts`): sinais de que o tipo ficou errado viram aviso para o modelo trocar, por exemplo: componentes com >2 setas por nó em média e nós com camada declarada → sugerir camadas; sequência sem ordem nas mensagens → erro; fluxo sem decisão → sugerir sequência; árvore com ciclos → erro.

Complementos:
- **Vários diagramas para uma pergunta** quando ajuda (ex.: camadas para a visão + sequência para um caso), anunciado na legenda.
- **Trocar de visão pelo usuário**: no diagrama, um seletor "ver como…" pede ao agente outro tipo sobre as mesmas unidades de contexto (as unidades já são independentes do desenho, então só muda a gramática).
- Avaliação: um conjunto fixo de ~20 perguntas com o tipo esperado, rodado nos testes do core contra o prompt, para medir acertos ao mexer no guia.

## 4. Formato da definição: JSON ou texto simples?

Ponto em aberto. Opções:

- **A. Continuar JSON**, com esquema por tipo (união discriminada por `kind`). Vantagem: validação forte, tool calling nativo, patch incremental por id (já usado para "completar" diagramas), ligação com unidades de contexto (`unit`, `path`, `seen`). Desvantagem: verboso, ruim de ler e editar à mão.
- **B. DSL existente (Mermaid)**. Modelos escrevem Mermaid muito bem e há sintaxe pronta para sequência, fluxo, estados, ER, classes, mindmap, timeline, árvore não. Desvantagem: não carrega `path`/`seen`/`unit` por nó, patch incremental fica difícil, e teríamos de parsear e reimplementar o desenho para manter o canvas próprio.
- **C. Híbrido (recomendado)**: o modelo envia o **corpo do diagrama em texto curto estilo Mermaid** (`source`), e as **evidências por nó em JSON** ao lado (`evidence: { id: { path, seen, unit } }`). O app parseia o texto para o modelo interno (que continua JSON e é o que se salva e se versiona). O usuário pode ver/editar o texto em uma aba "fonte" do diagrama.
  - Ganha legibilidade e menos tokens nos tipos ricos (sequência, estados, ER), sem perder a ligação com o código.
  - Custos: um parser por tipo (dá para usar o parser do Mermaid só para validar, ou escrever parsers pequenos dos subconjuntos que suportamos), e mensagens de erro de sintaxe que voltem ao modelo.

Recomendação: **C**, mas em etapas: começar os novos tipos em JSON por tipo (rápido, aproveita `plan.ts`), e introduzir a fonte em texto na etapa seguinte, já com os tipos estáveis. Se o Arthur preferir decidir já, C desde o início para sequência e estados, onde o JSON é mais penoso.

## 5. Mudanças técnicas (resumo)

- `protocol`: `DiagramModel.kind` com os novos tipos e campos por tipo (ex.: `layer` no nó; `order`, `reply` na mensagem; `decision` no nó de fluxo; `parent` para estrutura).
- `diagram-engine`: um layout por tipo (camadas: faixas fixas + ELK dentro; sequência: layout próprio, colunas e linhas; árvore: ELK `mrtree`; mapa: radial).
- `DiagramView`: um desenhador por tipo (faixas, linhas de vida, losangos, estados, tabelas).
- `show_diagram`: esquema por tipo, `why`, validação de forma, guia de escolha na descrição e no `prompt.ts`.
- Testes: unitários de layout por tipo, avaliação de escolha, e2e com um diagrama de camadas e um de sequência.

## 6. Perguntas para o Arthur

1. Ordem: começar por camadas + sequência + estrutura?
2. Formato: JSON agora e texto depois (recomendado), ou já o híbrido com texto?
3. O seletor "ver como…" entra na primeira entrega ou depois?
