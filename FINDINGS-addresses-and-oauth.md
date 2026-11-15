# Segunda fatia: relocations, endereços e referências OAuth

## Proveniência e limite

Mesmo artefato da primeira fatia, SHA-256 `5df525a2d6908989c57b897723caea66e00d7c4d2e24411f91ad306989574642`. Os resultados abaixo vêm de parsing ELF somente-leitura e GNU objdump já instalado no toolbox existente. Não são Evidence REA, decompilação Ghidra ou observação de execução. Nenhum login, chamada de serviço, leitura de credenciais do usuário, instalação ou alteração global foi realizado.

Saídas e script de reprodução específico desse hash ficam em `/tmp/opencode/antigravity-rea/`: `mapped-oauth-config.json`, `recover-public-oauth-observations.py`, `anchored-public-oauth-observations.json` e arquivos `oauth-*.asm`. A extração de literais usa referências exatas e uma allowlist de valores públicos; não decodifica nem emite os valores de client ID/client secret.

## Base de código comprovada no arquivo

O campo historicamente chamado textStart no pcHeader não contém a base. O runtime Go atual documenta esse slot como não utilizado, substituído por `moduledata.text`. Não há relocation nesse slot do cabeçalho neste artefato.

A seção `.go.module`, offset de arquivo `0xca406c0`, VA link-time `0xd2406c0`, contém o prefixo de moduledata. Os ponteiros nulos no arquivo são resolvidos por `R_X86_64_RELATIVE` com símbolo zero. Essas entradas estão cobertas por DT_RELA no PT_DYNAMIC, não apenas por um nome de seção. Âncoras relevantes:

- Offset de relocation `0x174c5c0`: destino `moduledata+0`, addend `0x17652a0`, relacionando o pcHeader principal.
- Os seis ponteiros de subtables e o comprimento de ftab concordam com o cabeçalho e seu índice. ftab declara 187.712 entradas incluindo sentinela.
- `moduledata+0xb0` declara text `0x6eef080`; minpc, maxpc e a sentinela do índice corroboram essa base. etext é `0xa8a3e90`.
- O mapa de texto tem uma entrada, com offset virtual zero e base relocada igual a text. Seu comprimento inclui um byte além do marcador etext; toda a extensão é file-backed e executável.
- PT_LOAD de índice 1 traduz esses VAs em offsets de arquivo idênticos para este segmento. A seção `.text` começa em `0x6eef000`, **128 bytes antes da base Go**. A soma ingênua com `.text` produziria endereços errados.

O CLI agora conserva esse encadeamento em `goCodeMappings`, sem sobrescrever PCs relativos. Foram recuperados:

```text
authclient.getOAuthConfig  link-time [0x9850140, 0x9850720)
oauthMethod.getOAuthConfig link-time [0xa0656a0, 0xa0657e0)
```

Objdump nessas faixas encontra prólogos Go, retornos e caminhos morestack coerentes com os limites. As chamadas diretas se resolvem em entradas do mesmo índice, incluindo `getScopesByAuthMethod`, `runtime.newobject` e barreiras de escrita. Isso corrobora o mapeamento, não constitui recuperação completa de fluxo. Load bias/ASLR e endereços de runtime continuam desconhecidos. A tabela embarcada de 19.365 funções **não** está relacionada a esse moduledata e permanece sem mapeamento.

## OAuth: observações ancoradas

`oauthMethod.getOAuthConfig`, em `0xa0656a0`, chama `getScopesByAuthMethod` em `0xa065180`, copia campos do objeto de método para uma configuração e copia um objeto Endpoint em `0xcf35260`. O layout público de `golang.org/x/oauth2` ordena seus campos como AuthURL, DeviceAuthURL, TokenURL e AuthStyle. Os três headers de string, com ponteiros respaldados por relocations, apontam para:

```text
AuthURL       https://accounts.google.com/o/oauth2/auth
DeviceAuthURL https://oauth2.googleapis.com/device/code
TokenURL      https://oauth2.googleapis.com/token
```

O word seguinte é 1. A presença de DeviceAuthURL no objeto não prova que o fluxo investigado usa device grant. Nenhum segredo desse objeto ou dos ramos de seleção de cliente é reproduzido aqui.

### Scopes: ramo CLI

O header de slice em `0xcedbaa0` referencia cinco strings estáticas: `https://www.googleapis.com/auth/cloud-platform`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/userinfo.profile`, `https://www.googleapis.com/auth/cclog` e `https://www.googleapis.com/auth/experimentsandconfigs`.

Em `getScopesByAuthMethod`, a comparação explícita com `gcp` separa dois caminhos. O caminho gcp remove `https://www.googleapis.com/auth/aicode` se presente; o outro caminho preserva os itens e acrescenta esse scope e `openid` quando ausentes. Comparações, append e retorno são visíveis entre `0xa065180` e `0xa0656a0`. Isso estabelece a transformação estática do ramo CLI, não uma lista de scopes que um terceiro esteja autorizado a solicitar. Valores globais podem ser alterados antes da chamada; a inicialização e todos os chamadores não foram integralmente reconstruídos.

O getter do language server também referencia um segundo slice em `0xcedbac0`. Sua política de seleção não deve ser confundida com o ramo CLI. Um dos seus cinco elementos permanece deliberadamente não emitido por estar fora da allowlist de literais públicos; não alegamos recuperar todos os scopes de todos os fluxos.

### Início interativo e troca

Em `oauthMethod.StartInteractive`, intervalo `[0xa064660, 0xa064ac0)`, a instrução em `0xa06475e` referencia exatamente 41 bytes em `0x630d67e`: `https://antigravity.google/oauth-callback`. O ponteiro e o comprimento são gravados nos offsets compatíveis com Config.RedirectURL antes da chamada AuthCodeURL. Portanto, não há evidência aqui para inventar callback localhost.

O mesmo método chama `GenerateVerifier` em `0x7943f40`, `generateState` em `0xa065c60`, `S256ChallengeFromVerifier` em `0x7943fc0` e `Config.AuthCodeURL` em `0x7942700`. Referências exatas adicionais contêm `S256`, `prompt` e `consent`. A closure `completeOAuth.func1.1`, intervalo `[0xa06a7c0, 0xa06b2c0)`, constrói uma opção com o literal `code_verifier` e chama `Config.Exchange` em `0x79432a0`.

Essas instruções sustentam um caminho de código compatível com authorization-code + PKCE S256. Não demonstram uma autenticação bem-sucedida nem autorizam reutilizar o cliente embarcado. A geração/validação de state, a cadeia completa de captura do código e o corpo final da requisição ainda precisam de análise independente.

### Refresh

`refreshAndSaveStoredToken`, intervalo `[0xa066700, 0xa0669c0)`, chama `oauthConfigFor`, `codeassistclient.RefreshingTokenSource`, `savingTokenSource.Token` e `StoredToken.RememberIDToken`. A closure de troca também chama RefreshingTokenSource. Isso localiza o próximo percurso de análise; não estabelece expiração, persistência, rotação, retries, associação de conta ou formato de tokens.

## Próximo limite

Investigar `oauthConfigFor` e `codeassistclient.RefreshingTokenSource`, seguindo o token source e o tratamento de state/código, sempre por faixas já ancoradas. O pacote continua sem provider, rede ou autenticação. Não há base para ativar OAuth consumer no OpenCode; a restrição documentada na FAQ continua aplicável.

## Referências

- [Go runtime moduledata, textAddr e pcHeader](https://github.com/golang/go/blob/master/src/runtime/symtab.go). Snapshot privado SHA-256 `1bd54eb357f799408bebb9a70cf2fda5891d7bfe30e31f5d43d9bc8d7f597df2`.
- [Go linker textsectionmap](https://github.com/golang/go/blob/master/src/cmd/link/internal/ld/symtab.go). Snapshot privado SHA-256 `6f12a6632f6a72bcf37d2e5208016f1a308558abe490b127dec041309b2a8177`.
- [Go OAuth2 Endpoint e Config](https://github.com/golang/oauth2/blob/master/oauth2.go), consultado via Context7. O layout público é referência comparativa, não identidade demonstrada de toda a biblioteca vendorizada.
