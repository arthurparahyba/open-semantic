# 11. Camadas de assunto (lentes)

Status: especificação aprovada na conversa, sem questões abertas. Nada implementado.

## Em uma frase

Uma camada é um **recorte nomeado por assunto** que o agente descobre durante a conversa e que reúne, de qualquer parte do workspace, os elementos que importam para aquele assunto, como uma folha transparente sobre a planta.

## O conceito abstrato

O workspace tem dois eixos independentes:

| Eixo | Pergunta que responde | Exemplo em software | Exemplo em culinária |
|---|---|---|---|
| **Unidade** (doc 09) | *Onde* isso mora? | repositório A, repositório B | "Cozinha básica", "Panificação" |
| **Camada** (este doc) | *Sobre o que* estamos falando? | infraestrutura, autenticação, integração A↔B | fermentação, massas frescas |

A unidade é a planta estrutural: diz onde cada coisa está, é estável e um elemento pertence a uma só. A camada é a folha transparente: atravessa unidades, um elemento pode estar em várias, e ela nasce e morre com o interesse do usuário.

Termos:

- **Elemento**: qualquer coisa do workspace: diagrama, nó, nota ou trecho de conversa. Trechos de conversa são membros de pleno direito.
- **Camada**: `{ id, nome, descrição curta, termos, membros[], origem: agente|usuário, criada_em, última_atividade }`.
- **Pertinência**: cada membro tem um peso (0..1) e um motivo ("mencionado na pergunta X", "gerado nesta camada", "adicionado pelo usuário"). Membro com peso baixo aparece esmaecido, não some.
- **Camada ativa**: no máximo uma por vez; é o assunto corrente da conversa.
- **Base**: o workspace vazio é a camada base. Os primeiros assuntos entram nela como overview.
- **Hierarquia**: toda camada, exceto a base, tem uma mãe ("Massas italianas" dentro de "Cozinha básica"), o que dá o efeito de índice/capítulos. Cada camada tem uma só mãe; um elemento pode estar em várias camadas.
  - **A mãe não herda o conteúdo das filhas.** Ativar "Cozinha básica" mostra só o que é de cozinha básica; massas e fermentação só aparecem quando o usuário entra na filha. No canvas da mãe, cada filha aparece no máximo como um marcador recolhido (nome e quantidade), que leva até ela.
  - O mesmo vale para a LLM: com a mãe ativa, as filhas entram só pelo nome.

Por que "camada" e não "label": uma label é só uma etiqueta no elemento. A camada é um objeto próprio, com nome, descrição, histórico e estado visual, guardado à parte (`layers.json` no workspace), e os diagramas não precisam saber dela.

## Aprofundar: a camada filha ancorada

É o principal motivo da hierarquia. Quando o usuário quer se aprofundar num elemento de um diagrama ("quero entender os meandros da autenticação", tendo à frente o diagrama de infraestrutura com caixas de cache, autenticação, logs e transações), o agente **não cria mais um diagrama ao lado**: cria uma camada filha **ancorada naquele elemento**.

- **Âncora**: a filha guarda `ancoras: [{ diagrama, elemento }]` na mãe. Normalmente é uma só; uma camada de integração entre aplicações pode ter mais de uma (um elemento em A e outro em B, ambos na mesma mãe). Na mãe, o elemento ganha um marcador discreto ("aprofundado em *Autenticação*") que leva à filha.
- **Posição**: no espaço, a filha fica sobre a sua âncora, como uma folha transparente posta em cima daquele ponto da planta. Na vista empilhada isso é literal; na vista normal, entrar na filha faz zoom a partir da âncora, e a mãe fica esmaecida ao fundo, mostrando de onde se veio.
- **Conectar sem poluir**: o diagrama da mãe não cresce. O detalhe mora na filha e a ligação é só a âncora. Elementos da filha podem apontar para outros elementos da mãe (por exemplo, autenticação usa o cache), desenhados como linhas que descem até a mãe só quando a filha está aberta.
- **Diagramas novos dentro da filha**: enquanto a filha está ativa, todo diagrama criado nasce nela, não na mãe.
- **Desfazer**: segue a seção de controle. "Não precisa de camada para isso" transforma a filha num diagrama comum na mãe, sem perder nada.

Exemplo em culinária: na camada "Cozinha básica" há um diagrama do preparo do arroz com a etapa "refogar". O usuário pergunta a diferença entre refogar, saltear e dourar. Nasce a filha "Técnicas de refogado", ancorada na etapa "refogar".

## Ciclo de vida: quando o agente age sozinho

Regra central: **toda camada nasce de um elemento da camada de baixo.** Não existe camada solta.

1. **Detectar**: a cada mensagem, o motor de contexto (doc 08) produz o assunto principal e os elementos citados.
2. **Overview primeiro**: um assunto novo, que ainda não tem elemento na camada atual, ganha um overview (diagrama ou texto) **na camada atual**. Não cria camada.
3. **Aprofundar cria a filha**: quando o usuário se aprofunda num assunto que já tem overview (pede detalhes, segue uma linha própria dentro dele), nasce a filha ancorada nesse elemento. Basta um pedido; não há contagem de mensagens.
4. **Nomear**: a LLM dá um nome curto (2 a 4 palavras) e uma descrição de uma linha. O usuário pode renomear.
5. **Popular**: entram os elementos gerados no aprofundamento, os trechos de conversa dele e os que a busca local (doc 08, seção 2) acha parecidos, inclusive em outras unidades.
6. **Ativar e trocar**: quando a mensagem nova cai em outra camada existente, ela vira a ativa. Se for ambíguo, vale a regra do doc 08: supõe a mais provável e mostra que supôs.
7. **Evoluir**: camadas parecidas podem ser fundidas e uma camada grande pode ser dividida. Por iniciativa do agente é só sugestão; pedido pelo usuário ("junta essas duas") já vale como confirmação.
8. **Adormecer**: camada sem atividade por muito tempo fica recolhida na lista. Nada é apagado automaticamente.

Exemplo: em "Cozinha básica", a primeira pergunta sobre massas gera um diagrama-resumo de massas na própria "Cozinha básica". Quando o usuário pergunta como fazer massa fresca com ovos, nasce a filha "Massas italianas", ancorada nesse diagrama.

## Sem camada ativa

Se nenhuma camada está ativa (início do workspace, ou o usuário saiu de todas), a camada ativa é a base: o canvas mostra os elementos da base em cor plena e as filhas só como marcadores; a LLM recebe o foco atual e o contexto enxuto do doc 08, mais a lista de nomes das camadas.

## Controle do usuário

Princípio: toda manipulação visual (criar diagrama, criar camada, mover membros) é automática, mas o usuário opina e corrige a qualquer momento, e corrigir tem que ser trivial.

- Toda ação automática aparece como uma linha discreta na conversa ("Criei a camada *Autenticação* com 4 diagramas"), com botão de desfazer.
- **Correção por texto**: o usuário pode simplesmente escrever, por exemplo, "não precisa de camada para isso", "tira esse diagrama daqui" ou "junta essas duas". O agente interpreta e aplica sem pedir confirmação.
- **Desfazer uma camada só remove o recorte**: diagramas, mensagens e histórico permanecem intactos. Apagar camada nunca apaga conteúdo.
- O agente aprende com a recusa: o assunto recusado não volta a virar camada sozinho, a menos que o usuário peça.
- O usuário também pode criar, renomear, mover elementos, fixar e apagar camadas na mão; o que ele fez manualmente o agente não desfaz.

## Efeito no contexto da LLM

A camada ativa vira o filtro principal do contexto enxuto (doc 08, seção 4):

- Entram primeiro os membros da camada ativa, ordenados por peso, depois o foco atual, depois o resto, até o orçamento.
- Entram também o nome e a descrição da camada, como uma linha de "assunto atual" no prompt.
- Outras camadas entram só como uma lista de nomes, para o agente saber que existem e poder sugerir a troca.
- Ganho esperado: menos tokens e respostas que não misturam assuntos (por exemplo, não falar de cache quando a pergunta é sobre permissões).

## Como aparece

Proposta em três níveis, do mais simples ao mais vistoso:

1. **Painel de camadas** (obrigatório): lista lateral como a de um editor de imagem, com nome, quantidade de elementos, olho para mostrar/esconder e destaque da ativa. Funciona como o índice do livro.
2. **Destaque no canvas** (obrigatório): ao ativar uma camada, seus membros ficam em cor plena e o resto esmaece. Com dois olhos ligados, as camadas sobrepõem cores, como folhas transparentes empilhadas.
3. **Vista empilhada** (depois da primeira versão; decidido: a primeira versão usa só o zoom a partir da âncora, em 2D, que já mostra de onde a filha veio): modo 2.5D/3D em que o canvas inclina e cada camada flutua num plano acima da base, com os membros "subindo" para ela. Bonito para entender a ideia, mas não deve ser o modo de trabalho do dia a dia.

Também há a opção de **vista isolada**: abre só a camada, com os membros reorganizados num layout próprio, como uma planta só da hidráulica. As posições na base não mudam.

## Fora de escopo agora

- Camadas compartilhadas entre workspaces.
- Permissões por camada.
- Apagar ou fundir camadas sem confirmação.

## Critérios de aceitação (primeira versão)

- Um assunto novo gera um overview na camada atual, não uma camada.
- Pedir para aprofundar um elemento que já existe cria uma filha nomeada, ancorada nele, com marcador visível na mãe.
- Uma camada de integração pode ser ancorada em elementos de duas unidades diferentes.
- Ativar a mãe não mostra o conteúdo das filhas, só os marcadores, e a LLM recebe as filhas só pelo nome.
- Diagramas criados com uma filha ativa nascem na filha.
- Trocar de assunto troca a camada ativa e o destaque no canvas.
- O contexto enviado à LLM com camada ativa é menor e contém os membros dela (medido na avaliação do CI do doc 08).
- Tudo que o agente faz sozinho pode ser desfeito com um clique ou com uma frase.
- Desfazer uma camada não apaga nenhum diagrama nem mensagem.

## Decisões

- Gatilho de criação: overview primeiro, filha só no aprofundamento (substitui a regra "3 em 10 mensagens"). Sem configuração na primeira versão; o agente calibra pelo que o usuário desfaz e pelo que diz.
- Hierarquia entra na primeira versão, com a filha ancorada; a mãe não herda o conteúdo das filhas.
- Vista 3D empilhada fica para depois; a primeira versão usa zoom 2D a partir da âncora.

## Plano de implementação

Cada etapa é um PR pequeno, com testes, que deixa a main funcionando.

1. **Modelo e contrato** (`contracts/`, `packages/protocol`, `packages/workspace-store`): schema da camada (`id`, `nome`, `descricao`, `mae`, `ancoras[]`, `membros[]` com peso e motivo, `origem`), persistido em `layers.json`; operações `layer.create`, `layer.rename`, `layer.addMembers`, `layer.removeMembers`, `layer.dissolve`, `layer.merge`, `layer.activate`. Dissolver nunca apaga elementos.
2. **Contexto da LLM** (`packages/semantic-context`): a camada ativa filtra e ordena o contexto enxuto; filhas e irmãs entram só pelo nome. Caso novo na avaliação do CI medindo tokens com e sem camada.
3. **Agente** (`packages/core`): regra overview primeiro / filha no aprofundamento; nomear e popular a camada; diagramas novos nascem na camada ativa; correção por texto ("não precisa de camada para isso", "junta essas duas") mapeada para as operações da etapa 1.
4. **Interface** (`apps/desktop`): painel de camadas em árvore, destaque e esmaecimento no canvas, marcador na âncora, zoom 2D ao entrar numa filha, linha "Criei a camada X" com desfazer.
5. **Depois**: vista empilhada 3D, seletor de postura, vista isolada.
