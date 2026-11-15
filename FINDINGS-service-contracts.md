# Encerramento da investigação offline de serviço

> Histórico de uma passagem anterior. A conclusão de encerramento foi superada pela continuação: tipos master e framing foram recuperados e uma fatia funcional de inferência offline foi implementada. Veja `FINDINGS-offline-inference.md`. Falta de autorização impede ativação, não investigação/implementação offline.

## Veredicto

A etapa offline está encerrada; o provider OAuth solicitado **não está concluído**. O artefato executável entregue é o inspetor ELF/Go e o workbench OAuth puro. A passagem limitada recuperou schemas internos de predição, catálogo e quota, mas não um contrato suficiente para implementar um driver de inferência correto. Não foi criado um provider que apenas simula sucesso, nem presumida compatibilidade com Gemini público.

O limite é de evidência e autorização, não uma afirmação de impossibilidade técnica. Mais análise estática poderia recuperar outras dependências, mas esta passagem não estabelece o ciclo completo de inferência, nem autorização para usá-lo. Não houve execução de `agy`, login, chamadas de serviço, leitura de credenciais, instalação, ativação, mudança global ou commit.

## Identidade e método

O arquivo instalado mudou entre as etapas. As observações anteriores continuam associadas exclusivamente ao SHA-256 `5df525a2d6908989c57b897723caea66e00d7c4d2e24411f91ad306989574642` (280.564.136 bytes).

Esta passagem usa SHA-256 `9db59b6371107b939befa9c507c0a24989fda974e75d81d8529f3689ef7322e5` (281.432.776 bytes), tabelas de 188.458 e 19.365 funções, pcHeader principal no offset 24.603.856, moduledata no offset 212.980.928 e base de texto link-time `0x6f68080`. Não são endereços de execução/ASLR. Um primeiro lookup de callees com base antiga produziu desconhecidos; foi descartado e substituído por resolução com identidade verificada. Nenhuma conclusão depende daquele lookup.

Evidência privada: `/tmp/opencode/antigravity-rea/final-*`. Os nomes e intervalos vêm do inspetor estruturado; instruções vêm de objdump existente; schemas vêm de bytes protobuf ancorados no código de inicialização. Isto não é decompilação REA nem observação de tráfego. Não foram repetidas importações Ghidra. Os JSONs dos descritores são extrações seletivas: não preservam todas as options, enums ou anotações HTTP. Não devem ser tratados como arquivos `.proto` completos.

### Descritores recuperados

- Predição: `google/internal/cloud/code/v1internal/prediction_service.proto`; VA/offset `0x66103c2`, 5.880 bytes; SHA-256 `7083333895648871257354517d3c328d67bb1d624e32ae022b5a256d254a1658`. Ponteiro em `0x7995cdd`, comprimentos em `0x7995cec`/`0x7995cf8`. Evidência: `final-descriptor-init.asm`, `final-extract-descriptor.py`, `final-prediction-descriptor.json`.
- Catálogo: `model_configs.proto`; VA/offset `0x6626865`, 6.302 bytes; SHA-256 `f9912a577025def786532abde588a0174dfd9513c54fe62f9ae25b0f6cb3d1cd`. Ponteiro em `0x7992f6d`, comprimentos em `0x7992f7c`/`0x7992f88`. Evidência: `final-model-config-init.asm`, `final-model-config-descriptor.json`.
- Resumo de quota: `quota_summary.proto`; VA/offset `0x64b4084`, 1.235 bytes; SHA-256 `25fb955c9f1e1dd3e97253e64048527854c0907cd734e5357b0593509ca51790`. Ponteiro em `0x7998aad`, comprimentos em `0x7998abc`/`0x7998ac8`. Evidência: `final-quota-summary-init.asm`, `final-quota-summary-descriptor.json`.

Cada intervalo foi relacionado a um único segmento PT_LOAD com backing em arquivo e extraído após conferir o hash do ELF atual. O manifesto privado `final-evidence-manifest.json` registra hashes dos arquivos desta passagem. Não aplicar offsets deste documento ao artefato anterior ou a atualizações futuras.

## O que foi estabelecido estaticamente

### Predição

`PredictionService` declara `GenerateContent`, `StreamGenerateContent` (server-streaming), `CountTokens`, `RetrieveUserQuota`, `FetchAvailableModels` e `RetrieveUserQuotaSummary`. A declaração de serviço não estabelece por si só o transporte HTTP usado pelo cliente.

O wrapper `GenerateContentRequest` tem `project` string #1, `requestId` string #2, `request` mensagem #3, `model` string #4, `userPromptId` string #5, `userAgent` string #6, `requestType` string #7 e `enabledCreditTypes` enum repetido #8. A mensagem #3 é **`.google.cloud.aiplatform.master.GenerateContentRequest`**, não um body Gemini público verificado.

`GenerateContentResponse` contém `response` master #1, `traceId` #2, `consumedCredits` repetido #3, `remainingCredits` #4 e `metadata` #5. As dependências master, credits e remote_context não foram integralmente recuperadas/interpretadas. Não há mapeamento comprovado de ferramentas, raciocínio, uso ou motivos de término para OpenCode.

`marshalCCPARequest [0x9523da0,0x9523e80)` chama `protojson.MarshalOptions.marshal`. O itab usado pelo wrapper resolve `ProtoReflect` em `0x7993940`. `streamGenerateContentFromCCPA [0x9523e80,0x95247c0)` constrói uma requisição com contexto e chama o envio de stream; a variante não-stream está em `[0x9525b80,0x95260e0)`. Evidências: `final-marshal.asm`, `final-stream.asm`, `final-generate.asm`, `final-callees.json`. Não basta copiar nomes de campos para garantir defaults/omissões, validação e serialização dos tipos dependentes.

### Framing

`ProcessStreamChunks [0x95455a0,0x9545c20)` usa `bufio.Scanner.Scan`, `strings.TrimSpace`, JSON-v2 Unmarshal e despacho a um conversor indireto. `toStreamResponseChunk [0x952f0a0,0x952f2a0)` compara os prefixos `event:` e `data:`. Evidências: `final-chunks.asm`, `final-chunk-envelope.asm`, `final-stream-iterator.asm`.

Isso ancora extração de um envelope textual semelhante a SSE, **não conformidade SSE completa**. Não foram estabelecidos todos os limites entre eventos, multiline data, chunking de transporte, término normal, erro remoto, cancelamento e transformação da resposta master. Não se assumiu um marcador `[DONE]` nem que EOF represente geração bem-sucedida.

### Catálogo

`fetchAvailableModels [0x9532e80,0x9533460)` seleciona caminhos por configuração: chave Gemini/catálogo local, gateway, licenciamento/BAIC, ADC/defaults e uma requisição baseada em projeto. O ramo BAIC está em `[0x950c440,0x950c820)`. Isso impede tratar qualquer catálogo local como entitlement OAuth universal. Evidências: `final-models.asm`, `final-models-baic.asm`, `final-model-request.asm`.

O schema recuperado define request com `project` #1, `requestId` #2, `location` #3 e `entitlement` #9. A resposta possui entradas key/value em `models` #1, `defaultAgentModelId` #2, agrupamentos e listas por finalidade. `ModelDetails` declara displayName, suporte a imagens/thinking, limites de tokens, quotaInfo, disabled, enums de modelo/provider e várias opções/experimentos. A extração não interpreta todas as options de map/oneof nem os enums externos `exa.codeium_common_pb`. Presença desses campos não demonstra seus valores reais ou regras de seleção. Nenhum nome de modelo ou limite foi inventado para o pacote.

### Quota

O schema de `RetrieveUserQuota` declara buckets com `remainingAmount` int64 #1, `resetTime` Timestamp #2, `tokenType` enum #3, `modelId` string #4 e `remainingFraction` float #5.

`RetrieveUserQuotaSummaryRequest` declara `project` #1; a resposta declara `buckets` #1, `groups` #2 e `description` #3. Um bucket de resumo declara bucketId, displayName, window, remainingFraction, remainingAmount, resetTime, description e disabled. Grupos contêm buckets, displayName e description. Evidências: `final-prediction-descriptor.json`, `final-quota-summary-descriptor.json`, wrapper `[0x954c9c0,0x954cd20)` em `final-quota.asm`.

Schema não estabelece totais, unidade de saldo, entitlement, escopo por conta/time, janela efetiva ou semântica de valores ausentes/zero. Não foi feita conversão para percentuais de plano, saldo monetário ou limites semanais/5h.

## Fronteira OpenCode e bloqueadores

A documentação oficial V2 de plugins/server e os registros locais somente-leitura de QwenCloud/Junie 2.2.5 mostram integração de credenciais via `ctx.integration.transform` e registro de provider via `ctx.provider.transform`. Um provider precisa ainda de um driver de modelo e catálogo válidos. Helpers PKCE ou um registro vazio não implementam esse driver. Nenhuma dependência SDK ou export raiz foi adicionado.

Para concluir o provider faltam, no mínimo:

1. Um caminho de integração permitido pelo fornecedor e configuração OAuth de cliente explicitamente autorizada, incluindo redirect, scopes, issuer/conta e regras de entitlement. Strings embarcadas não concedem essa autorização. A restrição consumer/OpenCode registrada nas etapas anteriores continua valendo.
2. Schema completo e contrato de serialização das mensagens master e tipos transitivos, além do mapeamento de conteúdo, ferramentas, raciocínio, uso e término para o driver OpenCode.
3. Contrato de transporte e fixtures sanitizadas autorizadas de request/resposta e stream: sucesso, erro e cancelamento, incluindo frames finais e truncamento. A extração parcial não prova semântica operacional de headers, retries ou replay.
4. Fixtures de descoberta e quota com regras documentadas de seleção, conta/escopo, ausência, zero, reset e unidades. Visibilidade de modelo não pode virar autorização de inferência.

Esses materiais podem ser fornecidos como documentação/schema e fixtures **sem tokens, códigos OAuth, cookies, client secrets ou dados pessoais**. Não é necessário autorizar acesso live para fornecer essas entradas. Mais mocks inventados ou novos utilitários genéricos não resolvem esses bloqueadores.

## Artefato utilizável e validação

Com dependências já presentes, `npm run build && npm run typecheck` compila e verifica os dois subpaths privados. `node --test test/oauth-workbench.test.mjs` verifica a fatia OAuth; `node dist/cli.js --help` mostra o inspetor sem executar o alvo. O exemplo sintético do README constrói apenas uma URL e não abre navegador nem troca tokens.

Os 32 testes existentes foram previamente verificados pelo parent, incluindo mutação da comparação de state. Esta passagem não muda código de produção nem testes: adiciona evidência e encerra a viabilidade. A revisão final e a suíte completa continuam atribuídas ao parent; resultados desta lane devem ser reportados separadamente. Não existe comprovação de login, geração ou quota live.

Verificação desta passagem: build e typecheck passaram; os 12 testes focados de OAuth passaram sem skips; `node dist/cli.js --help` terminou com sucesso. A identidade do ELF foi reconferida e o manifesto privado contém 22 arquivos de evidência. Não houve nova execução da suíte completa nesta lane.

Fontes de fronteira SDK consultadas: `https://opencode.ai/v2/docs/build/plugins` e `https://opencode.ai/v2/docs/build/plugins/server` (redirecionadas pelo site); referências irmãs somente-leitura: `opencode-qwencloud-oauth/src/index.ts` e `opencode-jetbrains-junie-oauth/src/index.ts`. Campos FileDescriptorProto/DescriptorProto/FieldDescriptorProto foram conferidos em `https://raw.githubusercontent.com/protocolbuffers/protobuf/main/src/google/protobuf/descriptor.proto`. Nenhuma dessas fontes substitui um contrato autorizado do serviço.
