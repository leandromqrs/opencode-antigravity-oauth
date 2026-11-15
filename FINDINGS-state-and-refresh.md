# Terceira fatia: state, código colado e refresh

## Proveniência e fronteira

Mesmo artefato SHA-256 `5df525a2d6908989c57b897723caea66e00d7c4d2e24411f91ad306989574642`. Observações estáticas comuns de ELF/objdump com a base Go comprovada `0x6eef080`, não nova Evidence REA, decompilação Ghidra ou execução. Endereços são link-time da imagem principal, nunca do payload secundário. Nenhum cliente embarcado foi reutilizado; nenhum serviço de autenticação ou estado privado do usuário foi acessado.

## State: geração demonstrada, validação não demonstrada

`generateState [0xa065c60,0xa065ce0)` aloca 16 bytes e chama `crypto/rand.Read` em `0xa065c91`. Erro leva a `runtime.gopanic`; sucesso carrega o encoding global `0xcfe4220` e chama `encoding/base64.(*Encoding).EncodeToString`.

`encoding/base64.init [0x71626c0,0x71629e0)` usa o alfabeto URL em `0x637a62f`, conferido exatamente como `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_`. A cópia derivada desse encoding recebe padding `-1` em `0x7162943` e é armazenada em `0xcfe4220`. Isso sustenta state de 16 bytes aleatórios codificados como base64url sem padding, 22 caracteres. Não demonstra validação posterior.

`SubmitAuthorizationCode [0xa064ac0,0xa064be0)` reconhece prefixos HTTP/HTTPS, chama `net/url.Parse`, consulta a query e procura `code`, literal de quatro bytes em `0x60cda5c`. O primeiro valor substitui a entrada se não vazio; nos demais caminhos a entrada original continua para `completeOAuth`. É um manipulador de código/URL colado, não prova de listener localhost. Não foi observada comparação de state, origin ou path nessa função.

`completeOAuth [0xa064be0,0xa064da0)` usa mutex/Once para despacho. A closure `[0xa06a5a0,0xa06a7c0)` encaminha à closure Exchange `[0xa06a7c0,0xa06b2c0)` da fatia anterior. Nenhuma comparação de state foi observada nesse percurso revisado. Once não equivale a validação CSRF ou associação de conta.

### Cobertura dos chamadores

Scan E8 rel32 limitado ao texto Go principal `[0x6eef080,0xa8a3e81)`, seguido de objdump a partir da entrada da função contendo cada candidato: **16 call sites diretos em 12 funções** para os seis alvos desta fatia. Nenhum caller E8 direto de SubmitAuthorizationCode encontrado nessa fronteira. Chamadas indiretas/interface, tail jumps, outras imagens e payloads não foram cobertos. Não alegamos todos os callers nem ausência global de validação de state.

## Refresh: comportamento local, não contrato do serviço

`oauthConfigFor [0xa0692c0,0xa0695c0)` testa argumento em RDI. Ramo não nulo constrói Config com globals separados e o segundo slice de scopes em `0xcedbac0`; ramo nulo chama `getOauthParams`/`getScopesByAuthMethod` e copia o Endpoint em `0xcf35260`. Valores reutilizáveis de cliente não são publicados. O significado de alto nível do argumento não foi estabelecido só pelo teste de registrador.

`RefreshingTokenSource [0x94708a0,0x9470b00)` prepara contexto/cliente HTTP e fontes, gravando **300000000000** em campos de token/source. Relocations dos slots de método `0xc9454b0` e `0xc9454d0`, em offsets `0x142c028` e `0x142c070`, resolvem para `reuseTokenSource.Token` em `0x7943b20` e `tokenRefresher.Token` em `0x7943860`.

`reuseTokenSource.Token [0x7943b20,0x7943cc0)` serializa acesso com mutex, verifica access token e chama o predicado em `0x79446a0`. Caminho válido devolve cache; o outro chama a fonte subjacente. Erro retorna nil/erro; sucesso copia o delta da source para o token em offset `0x60` e substitui o cache. O layout público Go OAuth2 identifica campos correspondentes como `expiryDelta time.Duration`: o imediato é compatível com **cinco minutos de antecipação**. A aritmética do predicado não foi revisada; esta interpretação depende também do layout comparativo, não de equivalência integral demonstrada da biblioteca vendorizada.

`tokenRefresher.Token [0x7943860,0x7943b20)` rejeita string de refresh vazia, constrói mapa e chama helper `0x79447a0`. Após sucesso, compara campo de refresh retornado com o armazenado e substitui a string local quando diferente (`0x7943a4d..0x7943aac`). Isso evidencia atualização **em memória**, não rotação realizada pelo serviço ou persistência correta. Preservação de refresh omitido, helper de transporte e envelope final continuam não reconstruídos.

`savingTokenSource.Token [0xa0657e0,0xa065c60)` chama fonte antes de adquirir seu mutex de salvamento. Compara a string access token com o cache; só chama callback de save quando diferente. Erros do save são logados, mas o cache é atualizado e o token devolvido sem propagar esse erro. Access token igual não invoca save: mudanças isoladas de refresh não têm persistência demonstrada nesse caminho. Erros da fonte retornam nil/erro; classificação de erro de rede afeta logging. Não há garantia demonstrada de persistência durável, retry de save ou atomicidade entre processos.

## Componente entregue: nova política explícita

`./oauth-workbench` deriva PKCE S256, codifica 16 bytes fornecidos, constrói URL de autorização e valida resposta estritamente. Não contém defaults de endpoint, scope, redirect ou client ID reais. Não gera aleatoriedade, inicia servidor, abre browser ou faz troca/refresh/rede.

**Validação estrita é política nova, não comportamento recuperado.** Exige callback HTTPS completo/exato e um único state igual ao esperado. Rejeita código isolado, fragmentos, duplicatas e origin/path incorretos. Chamador ainda deve gerar entropia segura, armazenar e vincular transações, impor expiração/consumo único e validar issuer/conta/autorização. O pacote não é provider OpenCode ou integração consumer autorizada.

## Evidências e referências

Privadas em `/tmp/opencode/antigravity-rea/`: `state-refresh-ranges.json`, `slice3-*.asm`, `slice3-direct-callers-verified.json` e `slice3-evidence-ledger.json` (identidade/hashes). Nenhuma credencial é reproduzida neste relatório.

Referências comparativas: [Go OAuth2](https://github.com/golang/oauth2/blob/master/oauth2.go), [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.txt), [Node crypto](https://nodejs.org/api/crypto.html). Vetor RFC público, configuração de teste sintética. Associação de conta, contrato de rotação/persistência e requisições wire-level continuam desconhecidos.
