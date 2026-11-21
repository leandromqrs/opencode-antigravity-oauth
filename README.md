# opencode-antigravity-oauth

Plugin servidor OpenCode V2 text-only com OAuth PKCE e política fixa de destinos Google, acompanhado de workbenches de evidência/inferência offline. A implementação e os testes sintéticos não comprovam autorização Google ou compatibilidade live.

**Inferência offline implementada:** request → transport injetado → stream fragmentado → texto, thoughts, ferramentas e uso. Schemas master recuperados fundamentam o workbench; os valores das fixtures são sintéticos. O provider nativo mantém o mínimo text-only e não foi ativado. Veja [contrato, evidências e limites](FINDINGS-offline-inference.md).

**Adaptador nativo V2 disponível para revisão offline:** `opencode-antigravity-oauth/offline-opencode` exporta `createOfflineModel`, testado com `@opencode/ai@2.2.5` em geração e streaming reais do SDK, usando frames sintéticos em memória. Execute `npm run demo:opencode` após build. Configuração, transport e políticas delta/cumulativo/uso são obrigatórios; somente texto é suportado. Veja [contrato nativo, exceção de compilação e dependências](FINDINGS-offline-opencode.md). Não há ativação ou inferência live.

> [!IMPORTANT]
> **Não use uma conta Antigravity neste plugin para validar o OAuth.** A [FAQ oficial](https://antigravity.google/docs/faq/#why-cant-i-use-third-party-software-such-as-claude-code-openclaw-or-opencode-with-my-antigravity-login) proíbe usar o login do Antigravity em ferramentas de terceiros, incluindo OpenCode, e alerta para suspensão ou encerramento da conta. `authorizationAcknowledged` não concede permissão. Para validar o fluxo sem uma conta, use `npm test` e `npm run demo:configured`. Para usar Gemini em uma ferramenta de terceiros, o Google recomenda uma chave do Gemini Enterprise ou do Google AI Studio.

### Integração configurável

O export raiz padrão é um `Plugin.define` real: `setup(ctx)` lê configuração pública explícita de `ctx.options`, sem iniciar login automaticamente. No modo completo existente, exige `authorizationAcknowledged:true`, cliente público autorizado, destinos Google fixos, projeto, metadados completos e políticas explícitas de texto/uso. O modo `agy-public-oauth` registra somente OAuth/refresh; `agy-local-oauth` também descobre modelos e registra o provedor após encontrar uma conexão OAuth própria ativa. `createAntigravityPlugin` aplica a mesma política; o chamador não pode ampliar destinos/scopes/callback. O OpenCode gerencia a persistência nativa; falha de gravação impede inferência. `createSyntheticAntigravityPlugin` é separado para fake fetch e hosts reservados. O demo `npm run demo:configured` executa autorização → refresh → geração SDK inteiramente em memória. Veja [configuração, contratos, segurança e limites](CONFIGURED-INTEGRATION.md).

### Configuração do fluxo local (referência técnica)

Após build e recarga pelo responsável pela instalação, use estas opções na entrada V2 do plugin:

```json
{ "mode": "agy-local-oauth", "authorizationAcknowledged": true }
```

Selecione **Google Antigravity** em `/connect`; o ID é `agy-local-oauth` e o método é `configured-pkce`. Copie o código mostrado na página de callback para o prompt do OpenCode, não a URL limpa da barra de endereço. Inicie uma tentativa nova após a recarga; não compartilhe o código em chat/logs.

Esse modo não depende do executável `agy`. A identidade OAuth do aplicativo (`clientId` e `clientSecret`, não tokens de conta) fica no arquivo privado `$XDG_CONFIG_HOME/opencode/antigravity-oauth-client.json`, ou `~/.config/opencode/antigravity-oauth-client.json` quando XDG não está definido. Em sistemas POSIX, o arquivo deve pertencer ao usuário e ter modo `0600` ou `0400`, sem acesso a grupo/outros. O secret vai somente no formulário enviado ao endpoint Google fixo, nunca em URL, opções, metadados ou logs. O plugin não executa nem lê o binário e não importa credenciais de conta do CLI. O modo público não usa esse arquivo nem tenta fallback. [Configuração privada, diagnósticos e limites](CONFIGURED-INTEGRATION.md#explicit-approved-local-client-oauth-and-model-discovery).

Modelos com sufixo de esforço são publicados como um modelo base com variants, como no AGY: `gemini-3.8-flash` expõe os esforços presentes no catálogo (`low`, `medium` e `high` na verificação atual; `minimal` somente quando disponível), com preferência pelo padrão `medium`. Use `/effort`, `/thinking` ou `/variants` no OpenCode V2. O nome base não mantém o qualificador “(Medium)”; selecionar um variant envia exatamente o ID do catálogo daquele esforço. IDs de outros modelos são rejeitados.

Para mostrar a quota no OpenCode Quota, adicione a opção opcional `quotaBridge` (somente neste modo) e registre o endpoint loopback como Custom Provider:

```json
{ "mode": "agy-local-oauth", "authorizationAcknowledged": true,
  "quotaBridge": { "port": 62369, "apiKeyEnv": "ANTIGRAVITY_QUOTA_BRIDGE_KEY", "autoKey": true } }
```

A chave é gerada pelo plugin por processo, exportada nessa variável de ambiente e removida no cleanup; nada de credencial ou projeto é aceito do chamante. Veja [bridge de quota](CONFIGURED-INTEGRATION.md#quota-bridge-for-opencode-quota).

Uma verificação histórica registrou login bem-sucedido. Isso não confirma autorização do Google, acesso a modelos nem funcionamento atual.

Em testes históricos, requisições isoladas com esforço `low` e `medium` responderam, mas uma sessão completa recebeu HTTP 429. A causa não foi confirmada. Consulte [o registro técnico](.opencode/status.md) para detalhes; esses resultados não são uma validação atual.

### Login experimental com client ID público

Após `npm run build`, adicione ao `plugins` do `opencode.jsonc` do projeto (formato **V2**), preservando as demais entradas:

Exemplo inerte incluído no pacote: [`examples/opencode-agy-public.jsonc`](examples/opencode-agy-public.jsonc). Ele não ativa configuração automaticamente; o preset é experimental e carregá-lo não inicia HTTP.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "/caminho/absoluto/opencode-antigravity-oauth",
    "options": { "mode": "agy-public-oauth", "authorizationAcknowledged": true }
  }]
}
```

O preset usa o ID público comprovado do agy e cinco scopes-base observados; não extrai nem envia client secret. **Aceitação secretless pelo Google não foi testada.** Nenhum projeto, catálogo ou preço é inventado; esse modo não habilita geração. Configurações completas antigas continuam obrigatórias para inferência, sem fallback implícito.

Se autorizado a tentar o fluxo, abra `/connect` e selecione **Antigravity public OAuth (experimental, login only)**; alternativamente, execute `opencode auth login agy-public-oauth --method configured-pkce` em terminal interativo. **Copie o código mostrado na página de callback do Antigravity e cole no prompt do OpenCode**, não a URL da barra de endereço. É um código de autorização OAuth, não um access/refresh token; não o cole em logs/chat. Após atualizar/recarregar o plugin, inicie um login novo, sem reutilizar o código da tentativa anterior. Nenhum login ou consentimento foi iniciado nesta correção.

Somente os dois presets explícitos aceitam código isolado: sem a URL completa, não é possível validar o state retornado. O plugin mantém state aleatório na autorização, PKCE exclusivo por tentativa, expiração de cinco minutos, uso único e proteção contra troca de conta; a vinculação código/verifier depende do servidor OAuth. URL completa válida continua opcional nesses modos. O modo configurado completo e o workbench puro permanecem estritos. Veja [instruções, limitação de state e diagnóstico sanitizado](CONFIGURED-INTEGRATION.md#experimental-public-client-login-only).

O typecheck, o build, a suíte de testes e o demo configurado foram revalidados sem login real. A auditoria do lockfile apontou 21 alertas moderados, sem alertas altos ou críticos. Isso não comprova compatibilidade com o serviço Google.

Não são emitidos `enabledCreditTypes`, fallback de créditos ou pedidos de cobrança, compra, plano ou entitlement; não há substituição por API key/ACP. Nas fixtures, `cost: []` significa tarifa ausente/desconhecida, não serviço gratuito ou custo monetário zero. Catálogo, capacidades e limites fornecidos pelo operador são configuração; OAuth não comprova assinatura ou entitlement.

O inventário do demo é fictício: capacidades text-only e limites são configuração da fixture, não descoberta de modelos, entitlement ou limites reais do serviço. O inventário de produção também é fornecido pelo operador e vinculado à conexão OAuth selecionada; não é apresentado como descoberta automática.

## Executar

Requer Node.js 22+ e npm. Em Linux:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
npm run inspect -- --help
```

`npm test` também compila o pacote. Para recompilar sem testes, execute `npm run build`.

As fixtures de configuração privada usam `/tmp/opencode` por padrão e respeitam `TMPDIR` quando definido. Na verificação atual, uma quota de escrita (`EDQUOT`) nesse diretório exigiu um diretório temporário alternativo; nenhum teste foi pulado ou teve suas asserções reduzidas.

Forneça explicitamente um arquivo ELF autorizado para leitura:

```sh
npm run inspect -- --binary /caminho/absoluto/agy --query getOAuthConfig --limit 10
```

Para obter somente JSON, sem o cabeçalho do npm:

```sh
node dist/cli.js --binary /caminho/absoluto/agy --query getOAuthConfig --limit 10
```

O comando apenas lê o arquivo; não executa `agy`, não abre conexão de rede, não procura credenciais e não altera configurações. Arquivos especiais, diretórios e links simbólicos no componente final do caminho são rejeitados. A instalação de dependências é a única etapa acima que pode usar rede.

## O que a saída estabelece

O JSON inclui SHA-256, seções ELF, candidatos aceitos/rejeitados e nomes de funções validados pelo índice Go. Cada resultado conserva o offset do nome, o offset do registro e o intervalo de PC **relativo**. `textStartDeclaration` é apenas o conteúdo do slot histórico do cabeçalho; zero aparece como `null`, e layouts Go recentes deixam esse slot sem uso.

`goCodeMappings` tenta relacionar cada tabela a um moduledata de perfil suportado. Só produz VAs **link-time** e offsets de código quando PT_LOAD, PT_DYNAMIC/DT_RELA, relocations relativas, subtables, min/max e mapa único de texto concordam. Não soma o início de `.text` ao PC por suposição. Ausência de prova produz `unresolved`, inclusive para payloads embarcados não relacionados. Load bias/ASLR e endereços de execução permanecem desconhecidos; `absoluteAddressesRecovered` e `runtimeAddressesRecovered` não passam a true.

Suporte: ELF64 little-endian x86-64 com seções; pclntab little-endian de 64 bits com magic `0xfffffff1` e layout estrutural compatível. Limites: arquivo de 512 MiB, 16 candidatos, 2 milhões de funções por tabela, nomes de até 4096 bytes, 128 MiB de nomes decodificados por candidato e até 100 resultados por tabela. `--query` é uma substring literal de até 256 caracteres; o padrão é vazio, com limite de 20 resultados. Ausência de tabela aceita não prova ausência de código Go.

Atribuição de payloads embarcados permanece desconhecida. A filtragem de formatos conhecidos de credenciais é uma precaução, não garantia de sanitização de qualquer segredo arbitrário: revise relatórios antes de compartilhá-los e mantenha binários e saídas reais fora do repositório.

## API local

O subpath `opencode-antigravity-oauth/protocol-evidence` fornece `inspectBytes(buffer, options)` e `inspectFile(absolutePath, options)`. As opções são `query` e `limit`. A API lança erros de validação; o CLI retorna exit code 1 e erro JSON genérico. O pacote é privado e não ativa integração alguma.

### OAuth puro, sem rede

`opencode-antigravity-oauth/oauth-workbench` fornece `deriveS256Challenge`, `encodeStateEntropy`, `buildAuthorizationUrl` e `validateAuthorizationResponse`. Todos os valores de cliente/endpoints/scopes/state/verifier são explícitos; não há configuração real embutida. Exemplo **sintético**, sem login ou abertura de URL:

```js
import { buildAuthorizationUrl } from 'opencode-antigravity-oauth/oauth-workbench';

const authorizationUrl = buildAuthorizationUrl({
  authorizationEndpoint: 'https://auth.example/authorize',
  clientId: 'synthetic-client',
  redirectUri: 'https://client.example/callback',
  scopes: ['synthetic.read'],
  state: 'synthetic-state-for-tests-123',
  verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
});
```

Não reutilize esses valores determinísticos em autenticação real. O chamador deve gerar entropia segura, armazenar/vincular transações, impor expiração e consumo único. `encodeStateEntropy` apenas codifica exatamente 16 bytes fornecidos; não gera aleatoriedade. Verifier aceita 43–128 caracteres RFC 7636; state aceita 22–128 caracteres unreserved.

O validador recebe `{ responseUrl, redirectUri, expectedState }` e devolve `{ kind: 'code', code }` ou `{ kind: 'denied' }`. Exige callback HTTPS completo/exato e um único state correspondente; rejeita código isolado, fragmentos, duplicatas e parâmetros desconhecidos. Descarta detalhes de erro remoto. URLs base precisam estar na forma canônica serializada, sem query/fragmento/credenciais. HTTP localhost/custom schemes não são suportados nesta política. Não registre URLs de autorização ou códigos em logs.

**Checks são nova política, não validação observada no binário.** O validador puro não impede replay; não há token exchange, refresh ou validação de issuer/conta. Veja [o contrato](SPEC-oauth-workbench.md) e [as observações de state/refresh](FINDINGS-state-and-refresh.md). Verificação focada: `npm run build && node --test test/oauth-workbench.test.mjs`.

## Evidência e limites

### Inferência sintética executável

```sh
npm run build
npm run demo:inference
```

`opencode-antigravity-oauth/offline-inference` exporta `buildInferenceRequest`, `convertInferenceResponse`, `createInferenceDecoder` e `inferOffline`. O demo usa um iterador em memória, não fetch. O transport recebe somente JSON/AbortSignal; nenhum endpoint, header ou cliente OAuth é presumido. Texto/thought/signature, chamadas/resultados de função e contadores explícitos são preservados; chunks não são agregados nem tratados como prova de geração live. Recursos fora do subconjunto falham explicitamente. Verificação focada: `node --test test/offline-inference.test.mjs` após build.

Os testes do inspetor usam ELF inteiramente sintético, cobrindo corrupção, limites, redaction e comportamento do CLI. A inspeção inicial encontrou tabelas de 187.711 e 19.365 funções. O binário instalado foi atualizado durante a investigação; a passagem final encontrou 188.458 e 19.365 funções, com identidade e endereços separados no relatório final. Esses resultados vêm do parser estruturado, **não de decompilação REA**.

Consulte [a especificação](SPEC-protocol-evidence.md), [o mapa de capacidades](CAPABILITY-MAP.md), [as observações iniciais](FINDINGS.md) e [a investigação de endereços/OAuth](FINDINGS-addresses-and-oauth.md). A segunda fatia recupera referências estáticas a endpoints, callback e PKCE, mas não estabelece um contrato de serviço suportado para terceiros. Autorização, refresh, modelos, streaming e quota não devem ser deduzidos apenas de nomes de símbolos.
