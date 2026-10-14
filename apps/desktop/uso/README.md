# Teste de uso

Um teste ponta a ponta com o Claude de verdade, para ver o app como um usuário veria. Não roda no CI, porque gasta
tokens e depende de rede.

```sh
export ANTHROPIC_API_KEY=sk-ant-...
pnpm --filter @open-semantic/desktop test:uso
```

O roteiro (`petclinic.uso.ts`) clona o [Spring Pet Clinic](https://github.com/spring-projects/spring-petclinic) (em
cache, em `~/.cache/open-semantic-uso`), abre o workspace, associa o repositório e faz quatro pedidos: como a
aplicação funciona, a especificação de um cadastro de produtos (BPMN e tela), um refinamento da tela e a ida para a
implementação. Perguntas do agente são respondidas pelo avaliador e confirmações são aprovadas.

A cada passo:

- **Checagens fixas:** projeto associado, camada nova com BPMN e wireframe, o refinamento muda o wireframe, camada
  "Implementação: …" com `specs/<assunto>.md` e o botão Copiar pedido, nenhum diagrama sobreposto, nenhum erro no
  console.
- **Julgamento da IA (Opus, esforço baixo):** olha o screenshot e o resumo do canvas e dá nota à explicação, aos
  diagramas e à organização do conjunto (diagramas relacionados próximos e agrupados, sem distâncias desnecessárias,
  sem confusão, leitura clara), e aponta bugs e melhorias.

Sai em `relatorios-uso/<data>/relatorio.md`, com screenshots, as checagens que falharam, bugs e melhorias
priorizados e o custo da execução.

Variáveis opcionais: `USO_MODELO_APP` (modelo do agente do app; padrão Haiku), `USO_MODELO_AVALIADOR`,
`USO_PETCLINIC_REF` (commit fixo do Pet Clinic), `USO_MAX_CUSTO_PEDIDO` (limite por pedido no app, em US$).
