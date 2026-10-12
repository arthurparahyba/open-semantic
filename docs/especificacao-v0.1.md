# Especificação do Produto — V0.1

Modelo de dados, contratos internos e critérios de aceitação

> Texto original enviado por Arthur no chat do projeto em 2026-10-12. Apenas a formatação Markdown foi adicionada.

A partir das três decisões confirmadas, a V0.1 passa a ter uma direção arquitetural mais definida:

- **Mods persistentes:** uma vez criados, permanecem no workspace até que o usuário ou o agente autorizado os remova.
- **Navegação automática:** o agente pode conduzir a câmera e direcionar a atenção do usuário conforme a conversa evolui.
- **Open Semantic integrado:** o workspace visual e o projeto real são representados em um modelo semântico comum.

A consequência mais importante é que o canvas não pode ser tratado apenas como uma superfície gráfica. Ele é uma representação persistente de um ambiente de trabalho que também contém arquivos, processos e outros recursos reais.

A especificação abaixo estabelece contratos conceituais suficientemente concretos para orientar a implementação, sem assumir prematuramente uma linguagem, um banco de dados ou uma biblioteca de canvas.

## 1. Arquitetura lógica

| Camada | Responsabilidade |
|---|---|
| Interface conversacional | Mensagens, contexto, intenções e explicações. |
| Agent Orchestrator | Planeja ações, consulta contexto e coordena ferramentas. |
| Diagram Engine | Modelos visuais. |
| Semantic Navigator | Câmera e foco. |
| Mod Runtime | Componentes funcionais. |
| Open Semantic | Modelo integrado de entidades, relações, evidências e estado. |
| Workspace Store | Objetos, posições, regiões e preferências. |
| Project Runtime | Arquivos, diretórios e processos autorizados. |

O diagrama representa responsabilidades lógicas, não necessariamente serviços separados. No MVP, várias dessas responsabilidades podem viver no mesmo processo ou aplicação, desde que suas interfaces sejam mantidas claras.

**Regra arquitetural:** o agente não modifica diretamente o estado interno da interface nem acessa arbitrariamente o sistema de arquivos. Ele solicita operações por contratos explícitos; os componentes responsáveis validam e executam essas operações.

## 2. Modelo de dados do workspace

O modelo precisa distinguir quatro conceitos que não devem ser confundidos:

1. **Entidade semântica:** algo que existe ou é conhecido no projeto, como um módulo ou uma API.
2. **Objeto visual:** algo que aparece no canvas, como um mod ou um nó de diagrama.
3. **Recurso real:** algo concreto, como um arquivo, diretório ou processo.
4. **Estado de navegação:** a posição da câmera, o zoom e os elementos destacados.

Um mesmo recurso pode ter várias representações visuais. Por exemplo, um arquivo pode aparecer no Explorer, em um nó de diagrama e no Editor de texto. Essas representações devem referenciar a mesma identidade semântica, sem duplicar o arquivo.

### 2.1 Entidades fundamentais

| Entidade | Responsabilidade | Persistência |
|---|---|---|
| Workspace | Identifica o ambiente e suas configurações. | Persistente |
| Project | Identifica o projeto real e suas raízes autorizadas. | Persistente |
| SemanticEntity | Representa um conceito ou recurso conhecido. | Persistente, com estado atualizado |
| SemanticRelation | Representa uma relação tipada entre entidades. | Persistente, com procedência |
| ModInstance | Representa uma instância de componente funcional. | Persistente |
| DiagramModel | Representa um diagrama estruturado. | Persistente |
| CanvasObject | Representa a posição e as dimensões de um objeto visual. | Persistente |
| NavigationState | Representa câmera, zoom, foco e enquadramento atual. | Estado recuperável |
| ActionRecord | Registra uma operação solicitada e seu resultado. | Histórico persistente |
| ArtifactReference | Identifica um recurso real e sua origem. | Persistente, com validação de atualidade |

A especificação deve permitir que o conteúdo de um objeto visual seja atualizado sem recriar sua identidade. O identificador de uma instância de Explorer, por exemplo, continua o mesmo quando o usuário navega de uma pasta para outra.

### 2.2 Identidade e referências

Cada entidade deve ter um identificador estável, independente de seu nome, posição ou caminho atual.

Exemplos de convenções possíveis:

- `ws_...`: workspace.
- `prj_...`: projeto.
- `mod_...`: instância de mod.
- `dgm_...`: diagrama.
- `sem_...`: entidade semântica.
- `act_...`: operação.
- `art_...`: referência a artefato.

Esses prefixos são convenções sugeridas; UUIDs ou identificadores equivalentes também são válidos.

As referências devem ser explícitas. Um mod pode apontar para uma entidade semântica e uma entidade semântica pode apontar para um recurso real, sem exigir que todas essas identidades sejam iguais.

### 2.3 Exemplo de estado persistido

O exemplo a seguir ilustra como um Explorer pode estar vinculado a um diretório real dentro de um workspace.

```json
{
  "workspace": {
    "id": "ws_example",
    "version": 1,
    "projectIds": ["prj_example"]
  },
  "projects": [
    {
      "id": "prj_example",
      "name": "MinhaAplicacao",
      "rootRef": "art_project_root"
    }
  ],
  "mods": [
    {
      "id": "mod_backend_explorer",
      "type": "explorer",
      "version": 1,
      "projectId": "prj_example",
      "config": {
        "rootRef": "art_backend_dir"
      },
      "lifecycle": "active"
    }
  ],
  "canvas": {
    "objects": [
      {
        "id": "mod_backend_explorer",
        "position": { "x": 900, "y": 300 },
        "size": { "width": 360, "height": 520 }
      }
    ]
  }
}
```

Este JSON é um exemplo ilustrativo de estrutura, não um esquema definitivo. Em particular, `rootRef` deve resolver para uma referência autorizada e validada pelo runtime do projeto. Não deve ser interpretado como permissão para acessar qualquer caminho.

### 2.4 Modelo de estado do mod

A configuração persistida precisa ser separada do estado operacional.

| Categoria | Exemplo | Comportamento |
|---|---|---|
| Identidade | ID e tipo | Estável |
| Configuração | Diretório, filtros ou formato | Persistente |
| Estado operacional | Carregando, pronto ou erro | Atualizável |
| Estado de interface | Seleção, aba e painel expandido | Persistente quando útil |
| Estado transitório | Cursor, hover ou animação | Geralmente não persistente |
| Referência externa | Arquivo ou diretório associado | Deve ser revalidada |

Essa separação evita, por exemplo, salvar uma animação de carregamento como se fosse parte da configuração do projeto.

## 3. Contratos entre componentes

Os componentes precisam compartilhar uma linguagem operacional. O agente solicita uma operação; o runtime verifica se ela é válida; o componente responsável executa; e o resultado volta para o agente.

### 3.1 Contrato comum de operação

Uma operação deve conter:

| Campo | Função |
|---|---|
| operationId | Identificar unicamente a solicitação. |
| operation | Nome da operação registrada. |
| targetId | Identificar o objeto-alvo, quando aplicável. |
| arguments | Parâmetros tipados e validados. |
| preconditions | Condições que precisam continuar verdadeiras. |
| authorization | Contexto de permissões e confirmações. |
| result | Resultado efetivo, erro ou necessidade de confirmação. |

Também precisamos definir operações idempotentes, isto é, operações que possam ser repetidas sem duplicar efeitos indevidos. Isso é particularmente importante quando uma resposta demora ou uma conexão é interrompida.

### 3.2 Contrato do Mod Runtime

O Mod Runtime administra o catálogo e o ciclo de vida dos mods.

Operações conceituais:

- `mod.list_types`: consultar os tipos registrados.
- `mod.create`: criar uma instância.
- `mod.configure`: alterar configuração.
- `mod.focus`: solicitar foco visual.
- `mod.close`: encerrar a visualização operacional sem excluir necessariamente a instância.
- `mod.delete`: remover a instância, mediante as regras de confirmação e integridade.

A diferença entre `close` e `delete` é essencial para a persistência: fechar um mod não deve apagá-lo do canvas nem perder sua configuração.

Cada tipo de mod deve declarar suas próprias capacidades. O Terminal, por exemplo, pode executar comandos autorizados; o Explorer pode navegar por diretórios; a Tabela pode ordenar dados. Não se deve pressupor que todos os mods suportem as mesmas operações.

### 3.3 Contrato do Diagram Engine

O motor de diagramas deve aceitar modelos estruturados, e não apenas imagens ou descrições textuais.

Seu contrato precisa contemplar:

- Criar um diagrama a partir de um modelo tipado.
- Adicionar, atualizar e remover nós e relações.
- Associar nós a entidades semânticas.
- Validar referências e restrições do modelo.
- Calcular ou atualizar o layout visual.
- Retornar as alterações efetivamente aplicadas.

O layout deve ser separado do modelo semântico. Mover um nó não pode alterar uma relação de dependência no projeto real.

### 3.4 Contrato do Open Semantic

O Open Semantic precisa oferecer operações de consulta e atualização com procedência explícita.

Exemplos conceituais:

- `semantic.resolve`: resolver uma referência para uma entidade.
- `semantic.query`: buscar entidades por critérios e contexto.
- `semantic.related`: consultar relações de uma entidade.
- `semantic.upsert_observation`: registrar uma observação validada.
- `semantic.invalidate`: marcar uma informação como desatualizada.
- `semantic.trace`: explicar de quais evidências uma relação foi derivada.

Uma relação semântica deve poder registrar seu tipo, origem, grau de confiança quando houver inferência e estado de validação. Uma inferência do agente não pode ser apresentada como fato confirmado sem evidência adequada.

### 3.5 Contrato do Semantic Navigator

O navegador recebe uma intenção de navegação e um conjunto de referências visuais. Ele resolve o enquadramento e aplica a mudança de câmera.

O contrato deve permitir:

- Focar um objeto existente.
- Enquadrar vários objetos relacionados.
- Aproximar ou afastar a câmera.
- Destacar elementos sem alterar seus dados.
- Preservar um ponto de retorno à visão anterior.
- Cancelar ou interromper uma navegação automática.

O navegador não deve criar entidades de projeto nem alterar arquivos. Ele opera sobre a apresentação visual do estado existente.

## 4. Integração entre workspace e projeto real

Esta é a principal complexidade técnica da V0.1. O ambiente visual precisa refletir o projeto real sem confundir a representação com o recurso representado.

Considere um arquivo `backend/src/server.js`:

- O Explorer apresenta o arquivo dentro da hierarquia de pastas.
- O Editor de texto abre seu conteúdo real.
- Um nó de arquitetura pode representar o serviço implementado pelo arquivo.
- O Open Semantic mantém as relações conhecidas entre o arquivo, o serviço e o projeto.
- O Semantic Navigator pode enquadrar esses elementos quando forem relevantes para a conversa.

Esses elementos não devem manter cópias independentes e contraditórias da identidade do arquivo.

### 4.1 Sincronização e consistência

A V0.1 deve estabelecer as seguintes regras:

1. **Fonte de verdade explícita:** arquivos e processos são governados pelo runtime do projeto; posições e dimensões são governadas pelo workspace; modelos semânticos registram entidades e relações com procedência.
2. **Atualização observável:** mudanças externas detectadas precisam invalidar ou atualizar informações derivadas.
3. **Referências verificáveis:** um caminho inexistente ou inacessível não pode ser tratado como um recurso disponível.
4. **Conflitos explícitos:** se um arquivo mudar externamente enquanto está aberto para edição, o ambiente deve detectar o conflito em vez de sobrescrever silenciosamente.
5. **Atualização eventual controlada:** algumas relações semânticas podem levar tempo para serem recalculadas, mas devem ser identificadas como pendentes ou desatualizadas.
6. **Operações rastreáveis:** modificações em arquivos, execução de comandos e alterações estruturais devem gerar registros de resultado.

Não é necessário que todo o sistema seja transacional. É necessário que o usuário consiga distinguir estado confirmado, estado pendente e estado que falhou.

## 5. Navegação automática: regras de comportamento

Como a autonomia foi definida como automática, ela deve ser tratada como um requisito funcional, não como um detalhe estético.

O agente pode decidir que uma região merece atenção e solicitar o enquadramento correspondente sem exigir um clique do usuário. Entretanto, autonomia de navegação não equivale a autonomia irrestrita para executar qualquer ação.

### 5.1 Política de navegação

| Situação | Comportamento esperado |
|---|---|
| Novo assunto sem objetos existentes | Criar os elementos visuais necessários e enquadrá-los. |
| Continuação do assunto atual | Preservar a região e o foco, salvo motivo relevante para mudar. |
| Referência a outra área do projeto | Navegar até a região relacionada. |
| Pergunta envolvendo vários componentes | Enquadrar os componentes em conjunto, quando possível. |
| Exploração profunda de um componente | Aproximar a câmera sem destruir a visão geral. |
| Usuário move a câmera manualmente | Respeitar a interação e evitar disputar o controle continuamente. |
| Usuário interrompe a navegação | Cancelar o movimento automático em curso. |
| Contexto semântico insuficiente | Não inventar um destino; pedir esclarecimento ou mostrar a melhor visão geral disponível. |

### 5.2 Separar decisão de navegação e movimento da câmera

O agente não precisa calcular coordenadas exatas para cada movimento. Ele pode solicitar algo como “enquadre o fluxo entre frontend e backend”. O Semantic Navigator resolve os objetos relevantes, calcula o enquadramento e anima a câmera.

Isso mantém a IA concentrada na intenção, enquanto a geometria e os limites da interface ficam sob responsabilidade determinística do runtime.

Também recomendo manter um estado de navegação com:

- Região atualmente em foco.
- Última visão geral conhecida.
- Histórico curto de regiões visitadas.
- Movimento em andamento ou cancelado.
- Origem da navegação: agente ou usuário.

## 6. Segurança e confiabilidade

Mesmo na primeira versão, alguns limites devem ser obrigatórios.

- **Acesso a arquivos:** somente dentro de raízes autorizadas, salvo permissões explícitas adicionais.
- **Terminal:** comandos sujeitos às políticas de execução e confirmação definidas pelo produto.
- **Modificações:** distinguir leitura, edição, exclusão e execução como capacidades diferentes.
- **Ações do agente:** validar argumentos, referências e permissões no runtime, não apenas no modelo de IA.
- **Erros:** retornar resultados reais, sem simular sucesso.
- **Histórico:** registrar operações relevantes e suas consequências.
- **Reversão:** oferecer reversão quando tecnicamente segura; operações irreversíveis devem ser identificadas antes da execução.

O princípio é simples: o agente pode planejar de forma flexível, mas a execução precisa ocorrer por interfaces limitadas, validadas e auditáveis.

## 7. Critérios de aceitação da V0.1

Os critérios abaixo definem resultados observáveis que podem ser testados. Eles não dependem de uma tecnologia específica.

### A. Workspace e persistência

1. O usuário cria um workspace e adiciona mods ao canvas.
2. Após fechar e reabrir o ambiente, os mods mantêm seus identificadores, configurações e posições.
3. Fechar um mod não o exclui do workspace.
4. Excluir um mod não apaga automaticamente os arquivos reais aos quais ele estava associado.
5. O canvas suporta zoom, movimentação e enquadramento de regiões com objetos fora da área visível.

### B. Mods funcionais

1. O Explorer navega por uma raiz de projeto autorizada e apresenta a estrutura real de arquivos.
2. O Terminal executa operações permitidas e apresenta saída, erros e estado de conclusão.
3. A Tabela apresenta dados estruturados e diferencia visualização de edição.
4. O Editor de texto permite editar conteúdo e indica alterações não salvas.
5. Cada mod declara suas capacidades e informa erros operacionais de maneira verificável.

### C. Open Semantic

1. O sistema relaciona entidades do workspace com referências ao projeto real.
2. Um mesmo arquivo pode ser referenciado por um Explorer, um Editor e um ou mais diagrams.
3. O sistema distingue relações verificadas, inferidas e desatualizadas.
4. Quando um recurso é removido ou alterado externamente, suas referências podem ser revalidadas.

### D. Diagrams e navegação

1. O agente cria um diagram editável a partir de uma solicitação conversacional.
2. Os nós podem apontar para entidades reais e abrir mods relacionados.
3. O agente consegue enquadrar automaticamente os objetos relevantes para uma pergunta.
4. O usuário consegue interromper a navegação e controlar manualmente a câmera.
5. A navegação não altera o conteúdo dos arquivos nem modifica as relações do modelo por si só.

### E. Protocolo e confiabilidade

1. Uma operação inválida é rejeitada com uma explicação estruturada.
2. Uma operação concluída retorna seu resultado efetivo ao agente.
3. Repetir uma solicitação não duplica objetos quando a operação for definida como idempotente.
4. Alterações relevantes podem ser rastreadas até a operação que as originou.
5. Operações que exigem autorização não são executadas antes de a autorização necessária ser concedida.

## 8. Plano de implementação recomendado

Eu dividiria a implementação em quatro incrementos. Cada incremento entrega algo utilizável e prepara a próxima camada.

1. **Workspace persistente (primeiro incremento).** Canvas infinito, câmera, armazenamento do workspace, registro de mods e posicionamento persistente. Implementar inicialmente o Explorer e o Editor com recursos de teste controlados.
2. **Conversa e protocolo de operações.** O agente recebe o estado do workspace, solicita operações tipadas e recebe os resultados. Implementar criação de mods, criação de diagrams e navegação automática.
3. **Open Semantic integrado.** Introduzir entidades, relações, referências a arquivos e procedência. Permitir que diagrams e mods compartilhem o mesmo contexto semântico.
4. **Execução e refinamento.** Integrar Terminal, Tabela, sincronização com o projeto real, tratamento de conflitos, permissões, histórico e testes de aceitação ponta a ponta.

## 9. Decisões ainda abertas

A V0.1 já define o modelo conceitual e os principais contratos, mas três questões precisam ser decididas antes de congelarmos o desenho técnico:

- **Persistência do projeto:** o projeto real será sempre um diretório local, poderá estar em um ambiente remoto ou ambos?
- **Estrutura semântica:** o Open Semantic será um grafo persistido como modelo principal ou uma camada lógica que pode utilizar diferentes mecanismos de armazenamento?
- **Modelo de interação:** o agente poderá realizar várias operações visuais em um único lote, com validação e confirmação dos resultados, ou cada operação deverá ser concluída antes de a próxima começar?

Minha recomendação é permitir execução em lotes com dependências explícitas, para que uma solicitação como “crie o backend, abra o Explorer e mostre a arquitetura” seja tratada como um plano coerente, e não como três comandos desconectados.

O próximo entregável deveria ser a Especificação Técnica V0.2: contratos formais em JSON Schema, máquina de estados do workspace, interfaces entre os módulos e um fluxo completo de referência. Com isso, teremos uma base concreta para escolher a stack e começar a construir o primeiro protótipo sem perder a visão original do produto.
