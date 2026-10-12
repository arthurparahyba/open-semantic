# Open Semantic

Ambiente de desenvolvimento de software orientado por IA que une conversa, canvas persistente, diagramas, ferramentas funcionais (mods) e o projeto real em um único espaço de trabalho. Aplicativo desktop em Electron.

## Estado atual

| Marco | Conteúdo | Situação |
|---|---|---|
| M0 · Fundação | Contratos (JSON Schema), tipos gerados, Dispatcher de operações, testes e CI | Este marco |
| M1 · Workspace persistente | Primeira janela: canvas, Explorer e Editor que persistem ao reabrir | Próximo |
| M2 · Conversa e protocolo | Lotes, agente de IA, diagramas, navegação automática | — |
| M3 · Open Semantic | Entidades, relações, evidências | — |
| M4 · Execução | Terminal, Tabela, sincronização, conflitos, permissões | — |

O plano completo está em [docs/como-comecar.md](docs/como-comecar.md). Por enquanto (M0) não há janela para abrir; o que roda são os testes. A partir do M1, `pnpm dev` abre o aplicativo.

## Rodar no seu computador

Pré-requisitos:
- [Node.js 22 ou mais novo](https://nodejs.org/)
- pnpm: `npm install -g pnpm` (ou `corepack enable`)
- Python 3 com `pip install jsonschema` (só para `pnpm validate:contracts`)

```bash
git clone https://github.com/arthurparahyba/open-semantic.git
cd open-semantic
pnpm install
pnpm test          # testes de todos os pacotes
pnpm typecheck     # checagem de tipos
pnpm validate:contracts
```

## Estrutura

```
contracts/            JSON Schemas, exemplos do fluxo de referência e validar.py
docs/                 visão, especificação V0.1, documentação por funcionalidade e plano
packages/protocol/    tipos gerados dos contratos + Dispatcher de operações
scripts/gen-types.mjs gera packages/protocol/src/generated/contracts.ts
```

## Contratos e tipos

Os contratos em `contracts/schemas` são a fonte de verdade. Depois de alterar um schema:

```bash
pnpm gen:types            # regenera os tipos TypeScript
pnpm validate:contracts   # valida schemas, exemplos e integridade referencial
pnpm test
```

O CI falha se os tipos gerados estiverem desatualizados.

## Documentação

- [Visão do produto](docs/visao.md)
- [Especificação V0.1](docs/especificacao-v0.1.md)
- [Documentação por funcionalidade](docs/funcionalidades/README.md)
- [Como começar a implementar](docs/como-comecar.md)
