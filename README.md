# Antigravity OAuth Workbench for OpenCode

Projeto experimental e não oficial para estudar OAuth PKCE e testar um adaptador OpenCode V2 com dados sintéticos. O caminho rápido não usa conta, credenciais nem a API do Google.

[Comece offline](#comece-offline) · [O que os testes cobrem](#o-que-os-testes-cobrem) · [Documentação técnica](#documentação-técnica)

> [!IMPORTANT]
> Não use uma conta Antigravity neste plugin. A [FAQ oficial do Google](https://antigravity.google/docs/faq/#why-cant-i-use-third-party-software-such-as-claude-code-openclaw-or-opencode-with-my-antigravity-login) proíbe usar esse login em ferramentas de terceiros, incluindo OpenCode, e alerta para suspensão ou encerramento da conta. A opção `authorizationAcknowledged` não concede permissão. Para usar Gemini em uma ferramenta de terceiros, o Google recomenda uma chave do Gemini Enterprise ou do Google AI Studio.

## Comece offline

Requer **Node.js 22+** e npm. Não precisa instalar o OpenCode nem o `agy` para rodar os exemplos.

```sh
git clone https://github.com/leandromqrs/opencode-antigravity-oauth.git
cd opencode-antigravity-oauth
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run demo:configured
```

O demo simula, em memória, a troca do código OAuth, a renovação do token e uma geração. A instalação de dependências acessa o registro npm; o demo não chama serviços externos.

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

## Documentação técnica

- [Mapa de módulos e capacidades](CAPABILITY-MAP.md)
- [Workbench OAuth](SPEC-oauth-workbench.md)
- [Adaptador OpenCode e seus limites](FINDINGS-offline-opencode.md)
- [Contrato de inferência offline](FINDINGS-offline-inference.md)
- [Referência da integração configurável](CONFIGURED-INTEGRATION.md)
