# opencode-google-antigravity-oauth

Projeto experimental e não oficial para estudar OAuth PKCE e testar um adaptador OpenCode V2 com dados sintéticos. O caminho rápido não usa conta, credenciais nem a API do Google.

[Comece offline](#comece-offline) · [OpenCode Quota](#opencode-quota) · [O que os testes cobrem](#o-que-os-testes-cobrem)

> [!IMPORTANT]
> Não use uma conta Antigravity neste plugin. A [FAQ oficial do Google](https://antigravity.google/docs/faq/#why-cant-i-use-third-party-software-such-as-claude-code-openclaw-or-opencode-with-my-antigravity-login) proíbe usar esse login em ferramentas de terceiros, incluindo OpenCode, e alerta para suspensão ou encerramento da conta. A opção `authorizationAcknowledged` não concede permissão. Para usar Gemini em uma ferramenta de terceiros, o Google recomenda uma chave do Gemini Enterprise ou do Google AI Studio.

## Comece offline

Requer **Node.js 22+** e npm. Não precisa instalar o OpenCode nem o `agy` para rodar os exemplos.

```sh
git clone https://github.com/leandromqrs/opencode-google-antigravity-oauth.git
cd opencode-google-antigravity-oauth
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run demo:configured
```

O demo simula, em memória, a troca do código OAuth, a renovação do token e uma geração. A instalação de dependências acessa o registro npm; o demo não chama serviços externos.

## OpenCode Quota

Use [o perfil de exemplo](examples/opencode-quota-demo.jsonc) em uma configuração isolada do OpenCode. Ajuste os dois caminhos absolutos e use um build do OpenCode Quota com suporte a [`mode: "published"`](https://github.com/slkiser/opencode-quota/pull/518). O perfil declara um provedor fictício para tornar a cota visível; o modelo não serve para inferência. Adicione às configurações do Quota, em `providers.custom`:

```json
{"id":"antigravity-demo","providerId":"antigravity-demo","label":"Antigravity (sintético)","mode":"published"}
```

O exemplo usa o RPC `slkiser.opencode-quota/publishQuota` e envia a cota fixa de 73% com o ticket fornecido pelo receptor. Não registra OAuth, não carrega o plugin principal e não abre um servidor HTTP. Não é uma medição da sua conta. A renomeação mantém os IDs existentes do plugin principal e o diretório de estado da ponte legada.

## O que os testes cobrem

- **OAuth:** criação e validação de transações PKCE, expiração, renovação com respostas simuladas e troca de conta.
- **Inferência offline:** requisições e streams sintéticos com texto, raciocínio, ferramentas e metadados de uso.
- **OpenCode V2:** registro do plugin, publicação de catálogo e integração com o SDK em fixtures. Os resultados não confirmam compatibilidade com o serviço Google, acesso a modelos ou direitos de uso.

```sh
npm run typecheck
npm test
npm run demo:inference
npm run demo:opencode
```

`npm test` inclui o build. Os demos adicionais usam o build gerado.

## Código e histórico

`src/oauth-workbench.ts` contém o workbench PKCE; `src/offline-inference.ts` trata as requisições e os streams das fixtures; `src/offline-opencode.ts` faz a adaptação ao SDK. `src/server.ts` é o ponto de entrada experimental, separado dos demos offline. Resultados históricos e especificações anteriores continuam no histórico Git.
