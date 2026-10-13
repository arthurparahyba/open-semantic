# 10 · Resposta visual (visual first)

O Open Semantic responde desenhando. Quando a pessoa quer entender estrutura ou fluxo ("me explique o projeto", "como funciona o checkout?", "quem depende de quem?"), a resposta é um diagrama no canvas, e o texto é a legenda dele. Pergunta pontual ("qual a versão do Java?") continua sendo uma linha de texto, apontando no canvas o que já existe.

## Como o agente responde

1. **Visão geral primeiro.** A primeira resposta sobre um repositório é um diagrama de arquitetura com 5 a 9 caixas. O detalhe vem quando a pessoa pergunta sobre uma parte, num diagrama próprio ancorado nela.
2. **Reaproveitar antes de redesenhar.** Se o `<workspace>` mostra um diagrama sobre o assunto, o agente usa o mesmo id e completa.
3. **Esboço cedo, refinamento depois.** Depois de uma primeira olhada (raiz e arquivo de build) o agente desenha; lendo mais, completa o mesmo diagrama.
4. **Visto versus suposto.** Caixa com caminho que existe no projeto é conhecimento verificado (linha sólida); sem caminho, suposição (tracejada).
5. **Sem texto antes do desenho.** O texto que o modelo escreve junto de chamadas de ferramenta não aparece no chat. A resposta só aparece no fim, ligada aos diagramas que o pedido desenhou.

## A ferramenta `show_diagram`

O modelo descreve só o desenho: `diagramId`, `title`, `kind` (`architecture`, `flow`, `sequence`, `dependency`), `caption`, nós (`id`, `label`, `kind`, `unit?`, `path?`, `seen?`) e ligações (`from`, `to`, `label?`, `type?`, `seen?`). O app (`packages/core/src/visual.ts`) transforma isso num lote comum, que passa pelo mesmo executor e pelo mesmo cartão:

- unidades de contexto: reaproveita a do nó, a do diagrama ou uma com o mesmo nome no projeto; cria as que faltam, verificadas (`semantic.upsert_observation`, com a evidência do caminho) ou inferidas (`semantic.upsert_inference`);
- relações: verificadas quando a ligação foi vista no código da origem, inferidas no resto;
- diagrama: `diagram.create` ancorado em `about` (ou no repositório) ou `diagram.apply_patch` que acrescenta e atualiza, sem apagar (só o que vier em `remove`);
- `navigation.frame` no diagrama.

Ao modelo volta o resultado do lote, a unidade e o status de cada nó, e avisos (por exemplo, um caminho que não existe).

## Legenda

`caption` é um campo opcional do diagrama (`diagram.schema.json`), aceito em `diagram.create` e `diagram.apply_patch`, e salvo com ele em `.open-semantic/`. Aparece no rodapé do diagrama (o objeto cresce para caber até 4 linhas) e a resposta do chat mostra um botão com o título do diagrama, que leva até ele.

## Cobrança

Se o pedido é de explicação e o turno termina só com texto (nenhum lote rodou), o laço devolve ao modelo, uma vez, a mensagem `[app]` pedindo o diagrama. Se ele insistir em texto, o texto aparece.

## Em aberto

- **Formato de definição de diagramas.** Hoje o agente descreve diagramas em JSON. Arthur quer discutir se vale um formato textual mais simples e legível (no estilo Mermaid, D2 ou PlantUML). Não decidido.
- **Vocabulário visual.** Grupos, sequência com linhas de vida, formas por tipo e detalhar ao clicar ficam para a próxima etapa.
