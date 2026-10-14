# 16 — Fluxo de ponta a ponta: discovery, especificação e implementação

## Ideia (pedido do Arthur)
Usar o Open Semantic do começo ao fim de uma mudança num sistema que já existe (exemplo: Pet Clinic). Começa entendendo o sistema, passa para a especificação do que se quer e termina na implementação validada. Tudo vira documentação e contexto, porque foi construído em cima de diagramas ligados ao código.

Princípios: visual first, rápido, pouco texto digitado. Cada mudança de camada é **sugerida** pelo agente e confirmada com um clique.

## As três camadas
| Camada | Pergunta que responde | Conteúdo |
|---|---|---|
| **1. Discovery (base)** | Como o sistema é hoje? | Perguntas gerais, explicações já gravadas, diagramas do sistema atual |
| **2. Especificação (filha da base)** | O que queremos? | BPMN dos fluxos, wireframes, back-end, modelo de dados |
| **3. Implementação (filha da 2)** | Onde queremos chegar e como saber que chegamos? | Definição de cada funcionalidade com seus critérios de aceite |

### Camada 1: Discovery
Comportamento de hoje (explicação breve e explicação ampla, ver 15). Quando a conversa muda de "como funciona" para "quero uma coisa nova", o agente sugere: **"Especificar isso numa camada nova?"** com os botões *Mudança no existente* e *Cenário novo*.

### Camada 2: Especificação, em dois casos
1. **Mudança sobre o existente.** A camada parte dos diagramas da base e mostra a **diferença**:
   - elementos novos em verde, alterados em amarelo, removidos riscados, iguais em cinza;
   - cada elemento alterado guarda o id do elemento de origem na base;
   - um resumo "entra / muda / fica igual" aparece no topo da camada.
2. **Cenário novo.** Funcionalidade sem equivalente no sistema (ex.: cadastro de produtos para pets). Os diagramas são todos novos, mas reutilizam o padrão do projeto lido na base (camadas da arquitetura, convenções de tela, banco).

Em ambos os casos o modo *Planejamento em etapas* conduz: processo (BPMN) → interface (wireframe) → back-end (sequência) → dados (ER). Vários fluxos podem conviver na mesma camada (cadastro, atualização, listagem, compra, histórico).

Quando o usuário diz que quer implementar, o agente sugere: **"Preparar a implementação de [fluxo]?"**, e cria a camada 3 a partir dos diagramas escolhidos.

### Camada 3: Implementação
Não é um plano passo a passo. É a **definição do alvo e de como validá-lo**. Para cada funcionalidade:
- **Definição:** o diagrama de origem (referência, não cópia), um texto curto da intenção e uma lista de passos focada no resultado ("o dono vê o produto na listagem logo após salvar").
- **Restrições do projeto:** vindas da base, por exemplo "seguir controller → service → repository", "usar o mesmo padrão de formulário das telas de Owner".
- **Critérios de aceite**, derivados dos diagramas:
  | Origem | Vira |
  |---|---|
  | Cada caminho do BPMN (feliz e exceções) | Um cenário: dado / quando / então |
  | Cada wireframe | Verificação de tela: abrir, ver campos, executar ação |
  | Cada entidade e relação do ER | Checagem de banco (tabela, colunas, restrições) |
  | Cada sequência de back-end | Verificação de endpoint e camada |

Cada critério guarda o id do nó ou diagrama de origem. Se a camada 2 mudar depois, os critérios ligados a ela ficam marcados como **desatualizados**, com o botão *Regerar*.

## Fechando o ciclo
1. **Implementar.** Um agente de código recebe a camada 3 como contexto: definições, restrições e critérios, com os diagramas como referência. O botão é *Implementar* na própria camada. As alterações de arquivo seguem as confirmações já existentes.
2. **Validar.** Cada critério recebe um status: *pendente*, *passou* ou *falhou*. O status aparece **no diagrama de origem**: o caminho do BPMN fica verde quando todos os seus critérios passam, vermelho se algum falhou. Na primeira entrega a validação é feita pelo agente (lê o código, roda os testes do projeto) e o usuário pode marcar à mão; testes automáticos de interface vêm depois.
3. **Atualizar a base.** Com os critérios aprovados, o agente sugere **"Levar para a base?"**: os diagramas da camada 2 são incorporados à camada 1 como o novo estado do sistema (a diferença vira o normal), e as camadas 2 e 3 ficam como histórico da mudança. Assim a documentação nunca fica atrás do código.

## MVP: uma fatia fina de ponta a ponta
Só o **cadastro de produto** do Pet Clinic, passando por todas as etapas:
1. Discovery: uma ou duas perguntas na base, com as explicações gravadas.
2. Especificação (cenário novo): um BPMN do cadastro e um wireframe da tela.
3. Implementação: definição da funcionalidade e critérios gerados do BPMN e do wireframe.
4. Agente implementa a partir da camada 3.
5. Critérios marcados como passou ou falhou no próprio BPMN e wireframe.
6. Base atualizada com o cadastro de produto.

Fora do MVP: os demais fluxos (atualização, listagem, compra, histórico), back-end e ER na camada 3, testes automáticos de interface, o caso "mudança sobre o existente" com diferença visual completa.

## Pontos em aberto
- Formato dos critérios no disco (arquivo por camada em `.open-semantic/`, junto dos diagramas?).
- Se a validação automática vira um modo de execução plugável (ver 15) ou um mod próprio.
- Quanto da camada 2 copiar para a base: tudo, ou só o que o usuário escolher.

## Primeira entrega
- **Modo Implementação** (`packages/core/src/modes/index.ts`): ativa com "Preparar a implementação", "quero implementar isso", "Implementar", "Validar os critérios", "Levar para a base" (e mensagens curtas logo depois). Conduz quatro etapas: preparar (camada filha da especificação com definição, restrições e tabela de critérios derivados dos diagramas), implementar (removido depois, ver abaixo), validar (status na tabela e no diagrama) e levar para a base (`layer.remove_members`).
- **Planejamento em etapas** conhece os dois casos da camada 2 e, numa mudança sobre o existente, marca a diferença em relação à base.
- **Ferramenta `mark_diagram`**: marca nós sem redesenhar (`novo`, `muda`, `remove`, `pendente`, `passou`, `falhou`), por id ou rótulo. A marca fica em `attributes.mark` e continua quando o diagrama é redesenhado.
- **Canvas**: nós marcados ganham cor (verde novo/passou, amarelo muda, vermelho remove/falhou, cinza pendente; o que sai fica riscado) e uma legenda no rodapé do diagrama.

## Mudança de direção: o app refina, o agente de código implementa
Decisão do Arthur: o Open Semantic não implementa, não cria arquivos, não roda comandos e não abre terminal. Implementar exige um agente de código completo (branch, modelo, dúvidas, acompanhamento), e essa responsabilidade não é do app. A entrega que criava arquivos e rodava comandos (PR #38) foi revertida.

- **A camada 3 é só refinamento:** definição, restrições e critérios de aceite. O modo Implementação não altera arquivos do projeto.
- **A camada vira markdown sozinha:** toda camada chamada "Implementação: <assunto>" é gravada em `specs/<assunto>.md` na raiz do repositório, a cada mudança. A conversão é programática (`packages/workspace-store/src/specs.ts`), sem modelo e sem inventar conteúdo:
  - blocos e diagramas na mesma ordem de leitura que o layout semântico (doc 13) usa no canvas: título e introdução, o objeto, as notas, depois o que detalha e o que continua. As coordenadas não entram, então mover algo à mão não embaralha o documento. Heading vira `##`, texto vira parágrafo, lista vira lista, tabela vira tabela markdown;
  - diagramas em Mermaid quando o tipo permite: bpmn, flow, architecture e layers viram `flowchart` (raias e faixas como `subgraph`), sequence vira `sequenceDiagram`, er vira `erDiagram`; wireframe e tree viram uma lista aninhada com o tipo de cada elemento;
  - as marcas dos nós (novo, muda, sai, pendente, passou, falhou) aparecem como lista embaixo do diagrama;
  - no fim, os diagramas da camada mãe (a especificação), de onde vêm os critérios.
- **O usuário entrega o arquivo ao agente de código que preferir** (Claude Code, Cursor etc.).
- **Validar continua no app:** quando o usuário diz que implementou, o agente lê o código e marca os critérios (passou ou falhou) na tabela e nos diagramas. Levar para a base também continua.
