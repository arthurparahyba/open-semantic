# 9. Ancoragem e projeção do canvas

> Parte da documentação por funcionalidade do Open Semantic. Índice em [README.md](README.md). Usa as entidades do [05 Open Semantic](05-open-semantic.md), alimenta o [08 Motor de contexto semântico](08-gestao-de-contexto.md) e decide o lugar das coisas no [01 Workspace e Canvas](01-workspace-e-canvas.md). Aprovado por Arthur em 12/10.

## Em uma frase

Tudo o que o agente cria na conversa nasce **ancorado** a uma unidade de contexto do Open Semantic (um repositório, um módulo, um assunto), e o canvas é uma **projeção** dessas âncoras: itens da mesma unidade ficam juntos, unidades relacionadas ficam vizinhas, e contornos e títulos são só o desenho desse agrupamento.

## O que não é

Não é uma funcionalidade de "desenhar contorno em volta dos diagramas de um repositório". Contorno, título, cor e tracejado são escolhas de desenho do agrupamento e podem mudar sem mudar a regra. A regra é a ancoragem.

## 1. Unidade de contexto

É a coisa sobre a qual se conversa. Vive no Open Semantic, não no canvas: é uma entidade semântica comum (`sem_…`) que tem coisas ancoradas a ela.

| Tipo | Exemplo | Como surge |
|---|---|---|
| Repositório | `spring-petclinic` (`kind: "repository"`) | O app cria uma ao trazer a pasta ou clonar o repositório, se o repositório ainda não tiver a sua em `.open-semantic/` |
| Módulo, serviço, API, componente | Back-end de pedidos, `api-pagamentos` | O agente registra ao ler o código ou ao discutir a ideia |
| Assunto | "Checkout lento", "Migração para eventos" (`kind: "concept"`) | O agente registra quando a conversa abre um tema que não é uma peça do código |

As unidades formam uma árvore pela relação `contains`: o repositório contém seus módulos, um módulo pode conter assuntos. Uma unidade sem pai é de primeiro nível. Outras relações (`calls`, `depends_on`, `communicates_with`…) dizem quais unidades são vizinhas.

## 2. Ancoragem

- Todo diagrama tem `anchorIds`: a lista das unidades sobre as quais ele fala (pelo menos uma).
- Mods (Explorer, Editor) usam o `semanticEntityIds` que já existe como âncora.
- O agente escolhe a âncora pelo assunto da conversa, que o motor do [08](08-gestao-de-contexto.md) já identifica (`Relevance.topics[0]`). Se a dúvida mudar onde a coisa vai parar, ele pergunta; senão supõe e diz qual escolheu.
- Sem âncora explícita, vale a unidade do repositório (`projectId`) do diagrama; sem repositório, a do projeto ativo.
- A âncora vai junto com o diagrama para `<repositório>/.open-semantic/` e as unidades vão em `knowledge.json`, então quem clona recebe também a organização.

## 3. Projeção no canvas

O lugar de cada coisa sai das âncoras, não de comandos de layout:

1. **Item novo** ancorado a U vai para junto dos itens já ancorados a U (ou a unidades dentro de U).
2. Se U ainda não tem nada no canvas, vai para junto do grupo da unidade que contém U (o repositório, por exemplo); se não houver, para perto de unidades relacionadas a U; se não houver, à direita de tudo.
3. **Grupo** de uma unidade é o retângulo que envolve seus itens e os grupos das unidades de dentro. Não é gravado: é recalculado do que está no canvas, então acompanha quando o usuário arrasta algo.
4. **Desenho do grupo:** repositório com contorno tracejado e nome; módulo ou assunto com área clara e título. Isso é só a renderização atual.
5. O que o usuário arrasta fica onde ele pôs (`placedBy: "user"`), e o grupo se ajusta em volta.

As regiões (`region.*`) continuam existindo para áreas livres que o usuário ou o agente quiserem nomear à mão, mas não são mais o jeito de organizar o canvas.

## 4. "O que temos sobre X?"

`navigation.frame` com `semanticEntityIds: [X]` enquadra **tudo o que está ancorado em X e nas unidades de dentro de X**, além dos nós que já representam X, e destaca o grupo. É isso que o motor do 08 chama em `AttentionPort.focus(X)`.

## Encaixe com o motor de contexto (08)

- Unidade de contexto é um `TargetRef` `sem_…`; o motor não precisa de um conceito novo.
- O índice do motor ganha a ligação item → unidade (âncoras) no grafo de vizinhança: achar a unidade leva aos diagramas dela, e achar um diagrama leva à unidade.
- `buildContext` expande o assunto principal pelas âncoras: os diagramas da unidade entram no contexto da IA no nível de detalhe que couber.

## Contratos

- `semantic.schema.json`: `EntityKind` ganha `repository`.
- `diagram.schema.json`: `DiagramModel.anchorIds` (lista de `SemanticEntityId`); `diagram.create` aceita `anchorIds`.
- Operação nova `diagram.anchor {diagramId, anchorIds}` para mudar a âncora depois (o diagrama não muda de lugar sozinho; o usuário ou o agente pede).

## Critérios de aceitação

1. Ao trazer um repositório, existe uma unidade `repository` para ele, e só uma, mesmo abrindo o mesmo repositório em outro workspace.
2. Um diagrama criado pelo agente sem âncora fica ancorado à unidade do repositório; com âncora, à unidade pedida.
3. Dois diagramas ancorados à mesma unidade ficam lado a lado; um diagrama de outro repositório fica fora do grupo do primeiro.
4. O grupo de cada unidade aparece desenhado sem nenhuma operação de layout.
5. Depois de uma conversa, enquadrar a unidade X mostra todos os diagramas ancorados em X e nas unidades de dentro dela, e nada de outras unidades.
6. Âncoras e unidades voltam iguais ao reabrir e chegam a outro workspace que abre o mesmo repositório.
