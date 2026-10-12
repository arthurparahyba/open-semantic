# Open Semantic

Ambiente de desenvolvimento de software orientado por IA que une conversa, canvas persistente, diagramas, ferramentas funcionais (mods) e o projeto real em um único espaço de trabalho. Aplicativo desktop em Electron.

## Estado atual

| Marco | Conteúdo | Situação |
|---|---|---|
| M0 · Fundação | Contratos (JSON Schema), tipos gerados, Dispatcher de operações, testes e CI | Pronto |
| M1 · Workspace persistente | Primeira janela: canvas, Explorer e Editor que persistem ao reabrir | Pronto |
| M2 · Conversa e protocolo | Lotes, diagramas, navegação automática e agente roteirizado (parte 1); conversa com o Claude (parte 2) | Em andamento |
| M3 · Open Semantic | Entidades, relações, evidências | — |
| M4 · Execução | Terminal, Tabela, sincronização, conflitos, permissões | — |

O plano completo está em [docs/como-comecar.md](docs/como-comecar.md).

## Rodar no seu computador

Pré-requisitos:
- [Node.js 22 ou mais novo](https://nodejs.org/)
- pnpm: `npm install -g pnpm` (ou `corepack enable`)
- Python 3 com `pip install jsonschema` (só para `pnpm validate:contracts`)

```bash
git clone https://github.com/arthurparahyba/open-semantic.git
cd open-semantic
pnpm install
pnpm dev           # abre o aplicativo (Electron) com recarga automática da interface
```

Na primeira execução o Electron baixa o próprio binário, o que pode levar um minuto. Outras formas de rodar:

```bash
pnpm start         # compila e abre o aplicativo sem servidor de desenvolvimento
pnpm test          # testes de todos os pacotes
pnpm typecheck     # checagem de tipos
pnpm test:e2e      # abre o app real e percorre os fluxos do M1 e do M2 (no Linux sem tela: xvfb-run -a pnpm test:e2e)
pnpm validate:contracts
```

### O que dá para fazer no M1

1. Clique em **Abrir pasta…** e escolha a pasta de um projeto. O Explorer aparece no canvas.
2. Clique num arquivo: ele abre num Editor ao lado. `Ctrl/⌘+S` salva no disco. Se o arquivo mudou fora do app, o Editor mostra o conflito em vez de sobrescrever.
3. Arraste o fundo para mover, use `Ctrl/⌘ + roda` para zoom, arraste o título de um mod para movê-lo e o canto inferior direito para redimensioná-lo.
4. Feche o app e abra de novo: mods, posições, pastas expandidas e câmera continuam onde estavam.

### O que dá para fazer no M2 (parte 1)

O painel **Agente**, à direita, tem um agente roteirizado: ainda sem IA, ele executa planos fixos pelo mesmo protocolo que a IA vai usar.

1. **Criar o backend e mostrar a arquitetura:** cria a pasta `backend/`, uma região “Backend” com um Explorer dentro e um diagrama de arquitetura, e leva a câmera até eles. A aresta Frontend → Backend aparece tracejada porque é uma suposição do agente.
2. **Mostrar o backend:** se você mexeu no canvas há menos de 4 segundos (ou desligou “Navegação automática”), o agente não move a câmera e deixa um botão de sugestão.
3. **Remover o Explorer do backend:** aparece um cartão de confirmação; nada acontece até você aprovar.

Arraste os nós do diagrama para fixá-los; Esc ou qualquer gesto interrompe um movimento automático.

O estado do workspace fica em `workspaces/ws_default.json` e o histórico de ações em `history/ws_default.jsonl`, dentro da pasta de dados do Electron (`~/.config/Open Semantic` no Linux, `~/Library/Application Support/Open Semantic` no macOS, `%APPDATA%\Open Semantic` no Windows).

## Estrutura

```
contracts/                JSON Schemas, exemplos do fluxo de referência e validar.py
docs/                     visão, especificação V0.1, documentação por funcionalidade e plano
packages/protocol/        tipos gerados dos contratos + Dispatcher de operações
packages/workspace-store/ estado do workspace, persistência em arquivo e operações de canvas
packages/project-runtime/ acesso seguro ao projeto real (listar, ler, escrever, conflitos)
packages/mod-runtime/     tipos de mod (Explorer, Editor) e seu ciclo de vida
packages/navigator/       câmera e enquadramento
packages/semantic/        Open Semantic (parte mínima do M2: observações, inferências, consulta)
packages/diagram-engine/  diagramas: modelo, patches atômicos e layout com elkjs
packages/core/            liga tudo: Dispatcher, lotes, políticas, histórico, autosave, agente
apps/desktop/             aplicativo Electron (main, preload e interface React)
scripts/gen-types.mjs     gera packages/protocol/src/generated/contracts.ts
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
