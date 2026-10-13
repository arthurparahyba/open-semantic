# 13. Layout semântico (serviço de posicionamento)

Status: primeira entrega implementada (blocos, relações, três distâncias, reorganização animada com desfazer).

## Decisões do Arthur

- O posicionamento é um **módulo à parte**. Ele não opina sobre o que deve existir no canvas, só sobre **onde** cada coisa fica, uma vez que ela existe.
- Ele recebe **eventos** do que entra, sai ou muda no canvas e responde com posições.
- Ele **pode reorganizar o que já existe** quando o layout fica desbalanceado (informação relacionada espalhada, um lado muito cheio).
- A reorganização é **animada**: o canvas tira um pouco o zoom, move os objetos de forma rápida mas perceptível (coisas se aproximando e se afastando) e depois volta ao foco.
- Ajustes aprovados: (1) `show_diagram` aceita título, introdução e notas na mesma chamada, formando uma seção; `show_blocks` fica para blocos soltos. (2) Objetos movidos à mão ficam fixos; só "reorganizar tudo" mexe neles. (3) Reorganiza só quando o desequilíbrio passa de um limite e o usuário não está mexendo no canvas, com "desfazer" logo depois. (4) A reorganização fica restrita à camada ativa.
- A ideia nasce de um problema de leitura: diagramas lado a lado, sem títulos nem textos, ficam difíceis de entender depois. O espaço vazio deve mostrar o que está mais ou menos associado.

## Como ficou (primeira entrega)

- Módulo `packages/workspace-store/src/layout/`: `placement.ts` e `anchoring.ts` (o posicionamento que já existia), `flow.ts` (relações e as três distâncias: 16, 48 e 160 px), `arranged.ts` (lugar de um objeto novo pela relação), `rebalance.ts` (plano de reorganização) e `blockSize.ts`. É puro e roda também na interface (`@open-semantic/workspace-store/layout`).
- Contratos: `Arrangement` (`relation`: annotates, continues, details; `targetId`; `side` para annotates), `block.schema.json` (heading, text, list, table), `objectKind: "block"` no canvas e `blocks` no snapshot. Diagramas também têm `arrangement`.
- Operações: `block.create` (vários blocos em ordem), `block.update`, `block.remove`, `canvas.rebalance` (`preview` só calcula; `all` inclui o que o usuário pôs à mão) e `canvas.arrange` (aplica posições: é o desfazer).
- `show_diagram` aceita `heading`, `intro`, `notes` (texto, lista, tabela), `continues` e `details`. Sem relação dita, um diagrama novo continua o último do mesmo projeto (embaixo). Os blocos da seção têm ids estáveis (`blk_<diagrama>_intro`, `_n1`…): chamar de novo atualiza.
- `show_blocks`: títulos, textos, listas e tabelas soltos, com `annotates`/`continues`/`details`.
- Regras de lugar: acima, um título novo sobe se couber; senão a seção desce. Um detalhe alinha o topo com o que ele detalha. A continuação vai embaixo de tudo que vem do alvo, inclusive os detalhes. Arrastar um objeto leva os blocos colados nele; tirar um diagrama tira os blocos colados.
- Reorganização: depois que diagramas ou blocos entram ou saem, com o usuário 3 s sem mexer no canvas, a interface pede a prévia; se a soma dos deslocamentos passar de 120 px, afasta a câmera, aplica (os objetos deslizam por ~0,5 s), volta e mostra "Reorganizei o canvas" com Desfazer. Botão "Reorganizar" na barra faz o mesmo para tudo, inclusive o que foi arrumado à mão. Só objetos da camada ativa se movem; com "reduzir movimento", sem animação.
- Persistência: os blocos ficam no arquivo do workspace (com a disposição do canvas), não no `.open-semantic/` do repositório. Levar para o repositório fica para depois.
- Testes: `workspace-store/test/layout.test.ts`, um caso em `core/test/visual.test.ts` e o e2e `layout.spec.ts` (captura `layout-1-explicacao.png`).

---

Proposta original abaixo.

## 1. O que existe hoje

- `packages/workspace-store/src/placement.ts`: `findFreeSpot` põe o objeto novo à direita da âncora (ou abaixo, à esquerda, acima) ou à direita de tudo, com `GAP = 40` fixo. `placeNew` trata regiões e unidades de contexto.
- `packages/workspace-store/src/anchoring.ts`: `placeAnchored` posiciona pela unidade de contexto.
- Essas funções são chamadas de dentro dos handlers (`handlers.ts`), no momento da gravação. Não há reorganização nem animação; um objeto, uma vez colocado, só se move pela mão do usuário.

## 2. Responsabilidades

| Quem | Decide |
|---|---|
| Agente / `show_diagram` / usuário | **O que** existe e **como se relaciona** (detalha, continua, mesmo assunto, assunto diferente) |
| Layout semântico (novo módulo) | **Onde** fica: posição, distância, agrupamento, quando reorganizar |
| Canvas (renderer) | **Como** a mudança aparece: zoom out, animação, volta ao foco |

O layout é uma função pura sobre o documento: entra o estado do canvas + relações + evento, sai um plano de posições. Não grava nada sozinho; o store aplica o plano como uma operação comum (fica no histórico e pode ser desfeita).

## 3. Relações que o layout entende

Declaradas por quem cria o objeto (novos campos opcionais em `placement` / `show_diagram`):

- `continues: <id>` — próximo passo da mesma explicação. Vai **abaixo** do anterior (eixo vertical = narrativa).
- `details: <id>` — aprofunda um ponto. Vai **à direita** do objeto detalhado (eixo horizontal = profundidade).
- `annotates: <id>` — título, texto ou legenda de um objeto. Fica **colado** a ele e se move junto.
- `topic: <chave>` — assunto/repositório. Objetos do mesmo tópico formam um grupo; tópicos diferentes ficam afastados.

Sem relação declarada, vale a regra de hoje (perto da âncora, ou no espaço livre).

## 4. Distâncias

Três níveis, no lugar do `GAP` único:

- **Junto** (≈16px): objeto e seus títulos/textos (`annotates`).
- **Próximo** (≈48px): passos e detalhes da mesma explicação (`continues`, `details`).
- **Separado** (≈160px): tópicos diferentes.

Os valores ficam em uma constante do módulo para ajuste fino.

## 5. Elementos de explicação (não só diagramas)

Pedido do Arthur: a explicação precisa de outros elementos gráficos além dos diagramas, vivendo junto deles quando o layout decidir assim. Tipos de bloco:

- **Título** (com nível: seção, subseção).
- **Descrição** (parágrafo curto, markdown simples: negrito, itálico, código inline, links).
- **Título com descrição** (um bloco só, o caso mais comum).
- **Lista não numerada** e **lista numerada** (com um nível de aninhamento).
- **Tabela** (cabeçalho + linhas, células com markdown simples).
- **Diagrama** (o que já existe).

Cada bloco é um objeto do canvas como qualquer outro, com tamanho calculado pelo conteúdo. Quem escreve é o agente; quem posiciona é o layout. Um bloco pode declarar `annotates: <id do diagrama>` para viver colado ao diagrama (e se mover junto na reorganização), ou `continues` / `details` / `topic` como qualquer objeto.

Como o agente cria:
- `show_diagram` aceita opcionalmente `title`, `intro` e `takeaway` (atalho para o caso comum: vira título com descrição acima e uma frase abaixo, todos `annotates` o diagrama);
- uma ferramenta nova, `show_blocks`, cria um ou mais blocos de texto/lista/tabela, com as mesmas relações (`annotates`, `continues`, `details`, `topic`). Ex.: uma tabela comparando caches ao lado do diagrama de infraestrutura.

O índice usa os blocos de título como entradas.

## 6. Eventos

O módulo expõe:

- `onAdded(obj, relações)` → posição do objeto novo (síncrono, como hoje).
- `onRemoved(id)`, `onResized(id)`, `onRelated(...)` → podem marcar o layout como "a revisar".
- `rebalance(doc)` → plano de reorganização (lista de `{id, de, para}`), ou vazio se está bom.

## 7. Quando reorganizar

`rebalance` roda depois de um evento e só propõe mudança quando vale a pena, por exemplo:

- objetos do mesmo tópico ficaram separados por objetos de outro tópico;
- um detalhe (`details`) ficou longe do que ele detalha;
- a trilha vertical ficou com buracos depois de remoções;
- o grupo cresceu muito para um lado só.

Para não ficar mexendo o tempo todo: no máximo uma reorganização por resposta do agente (ao fim dela), só se o ganho medido (distância total entre relacionados, sobreposição, área ocupada) passar de um limite, e só quando o usuário não está mexendo no canvas (sem arrasto/edição nos últimos segundos). Depois de reorganizar, o canvas mostra um aviso curto com "desfazer". A reorganização considera só os objetos da **camada ativa**.

**Objetos que o usuário moveu à mão** ficam marcados como fixos e não são movidos pela reorganização (o layout organiza em volta deles). Um comando "reorganizar tudo" ignora a marca quando o usuário pedir. (confirmado pelo Arthur).

## 8. Animação no canvas

Quando chega um plano de reorganização:

1. zoom out suave até enquadrar todos os objetos que vão se mover (≈250ms);
2. move os objetos em paralelo, com easing, de forma rápida mas visível (≈400–600ms);
3. volta ao zoom anterior ou enquadra o objeto novo (≈250ms).

Durante a animação a edição fica bloqueada; o estado final já está gravado no store desde o início (a animação é só visual). Com "reduzir movimento" do sistema ativo, a mudança é aplicada sem animação.

## 9. Como se encaixa em camadas e índice

- **Camadas (spec 11):** cada camada tem seu próprio layout; o módulo roda por camada. Uma explicação que desce de nível (visão geral → infraestrutura → cache) pode usar camadas em vez de só empilhar na vertical; o `details` entre camadas vira navegação, não posição.
- **Índice:** títulos (`title`) viram entradas do índice, na ordem da trilha (`continues`). Clicar leva ao objeto, e isso continua valendo depois de uma reorganização, porque o índice aponta para ids, não para posições.

## 10. Entregas sugeridas

1. Extrair `placement.ts` + `anchoring.ts` para o módulo de layout, sem mudar comportamento (testes atuais passando).
2. Relações `continues` / `details` / `annotates` / `topic` e as três distâncias; blocos de título, descrição, listas e tabelas (`show_blocks`) e `title`/`intro`/`takeaway` no `show_diagram`.
3. `rebalance` + animação no canvas + marca de objeto fixo.
4. Testes: uma explicação de 4–5 passos sai em coluna com detalhes à direita; uma remoção no meio fecha o buraco com animação; objeto movido à mão não se mexe.
