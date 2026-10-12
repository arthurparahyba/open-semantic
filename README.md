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

1. Clique em **Abrir pasta…** e escolha a pasta de um projeto (ou peça ao agente, veja abaixo). O Explorer aparece no canvas.
2. Clique num arquivo: ele abre num Editor ao lado. `Ctrl/⌘+S` salva no disco. Se o arquivo mudou fora do app, o Editor mostra o conflito em vez de sobrescrever.
3. Arraste o fundo para mover, use `Ctrl/⌘ + roda` para zoom, arraste o título de um mod para movê-lo e o canto inferior direito para redimensioná-lo.
4. Feche o app e abra de novo: mods, posições, pastas expandidas e câmera continuam onde estavam.

### O que dá para fazer no M2 (parte 1)

O painel **Agente**, à direita, tem um agente roteirizado: ainda sem IA, ele executa planos fixos pelo mesmo protocolo que a IA vai usar.

1. **Criar o backend e mostrar a arquitetura:** cria a pasta `backend/`, uma região “Backend” com um Explorer dentro e um diagrama de arquitetura, e leva a câmera até eles. A aresta Frontend → Backend aparece tracejada porque é uma suposição do agente.
2. **Mostrar o backend:** se você mexeu no canvas há menos de 4 segundos (ou desligou “Navegação automática”), o agente não move a câmera e deixa um botão de sugestão.
3. **Remover o Explorer do backend:** aparece um cartão de confirmação; nada acontece até você aprovar.

Arraste os nós do diagrama para fixá-los; Esc ou qualquer gesto interrompe um movimento automático.

### O que dá para fazer no M2 (parte 2): conversa com o Claude

O painel **Agente** agora é um chat. Na engrenagem (⚙), coloque uma chave da API da Anthropic (crie em [console.anthropic.com](https://console.anthropic.com); o uso é cobrado na conta da API, separado da assinatura do Claude). A chave é cifrada com o cofre do sistema e fica só no processo principal; a variável `ANTHROPIC_API_KEY` também funciona.

- **Modelo:** Claude Haiku 5.5 por padrão (US$ 0,10 / 0,50 por milhão de tokens). Sonnet 5.5 e Opus 5.5 ficam como opção.
- **Custo visível:** o cabeçalho mostra o custo da conversa e do último pedido.
- **Tetos por pedido:** custo (padrão US$ 0,10, ajustável), 12 chamadas ao modelo, 6 lotes, 60 passos e 600 mil tokens. Ao bater num teto, o agente para e avisa.
- **Contexto:** quando o prompt de uma chamada passa de 80 mil tokens, os pedidos anteriores são compactados (fica o que foi pedido, respondido e feito). “Nova conversa” zera tudo.
- **Projetos:** o workspace guarda todas as pastas que você já abriu, como etiquetas no topo da janela. A destacada é a pasta aberta por último; é nela que o agente trabalha. Clique numa etiqueta para trocar e no × para tirar o projeto do workspace (os arquivos no disco não mudam).
- O agente lê o projeto (listar pasta, ler arquivo) e muda as coisas só por lotes, com o mesmo cartão de confirmação dos roteiros. Os roteiros de teste continuam no rodapé do painel.

### Workspace como pasta

- **Primeira abertura:** o app pergunta onde fica o workspace. O padrão é `~/Open Semantic`; dá para escolher outra pasta, e clicar no nome do workspace no topo troca de pasta depois.
- **Repositórios pela conversa:** cole no chat o caminho de uma pasta (`/Users/voce/projetos/app` ou `~/projetos/app`) ou o link de um repositório (`https://github.com/dono/repo`). O agente pede confirmação e então traz a pasta, ou clona o repositório para `repos/` dentro do workspace. O botão **Abrir pasta…** continua lá para quem prefere o mouse. O Explorer só abre quando você pede.
- **O contexto mora no repositório:** diagramas e conhecimento (entidades, relações, evidências) sobre um repositório ficam em `<repositório>/.open-semantic/` (`diagrams/<id>.json` e `knowledge.json`), com arquivos citados pelo caminho relativo. Quem clonar o repositório e abri-lo no Open Semantic recebe esse contexto. Pastas abertas só para leitura guardam isso no workspace.
- **No workspace** ficam as referências aos repositórios, a disposição do canvas e o histórico: `<workspace>/.open-semantic/workspace.json` e `history.jsonl`.

A chave da API e as configurações do agente continuam na pasta de dados do Electron (`~/.config/Open Semantic` no Linux, `~/Library/Application Support/Open Semantic` no macOS, `%APPDATA%\Open Semantic` no Windows), junto com a lembrança de qual pasta é o workspace.

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
packages/llm/             provedores de LLM: interface neutra, adaptador do Claude, preços
packages/core/            liga tudo: Dispatcher, lotes, políticas, histórico, autosave, agente e laço da conversa
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
