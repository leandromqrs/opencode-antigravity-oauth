# Inferência sintética sobre contrato recuperado

## Resultado e fronteira

`./offline-inference` implementa uma fatia funcional request → transport injetado → bytes fragmentados → chunks normalizados. Não contém fetch, endpoint, headers, credenciais, SDK OpenCode ou registro de plugin. O transport recebe um body JSON e AbortSignal; a implementação demonstrativa é um iterador de fixtures em memória. Os valores de modelo, projeto, conteúdo, ferramentas e contadores são sintéticos; não são catálogo, entitlement ou respostas observadas de serviço.

Esta continuação supera o encerramento prematuro em `FINDINGS-service-contracts.md`: a falta de autorização restringe **ativação**, não recuperação estática e implementação offline. A fatia agora implementada usa tipos master recuperados do binário, não compatibilidade Gemini presumida. Não conclui o provider OAuth/OpenCode nem comprova que um servidor aceitaria este subconjunto sem campos adicionais.

## Evidência de schema

Hash do ELF reconferido antes de usar offsets: `9db59b6371107b939befa9c507c0a24989fda974e75d81d8529f3689ef7322e5`. Os novos arquivos privados têm prefixo `adapter-` em `/tmp/opencode/antigravity-rea/`; não usar endereços do binário anterior.

1. `master/prediction_service.proto`: VA/offset `0x696e95c`, 46.372 bytes, SHA-256 `8f83d7bcc7513723cc4d488f8fd0c2cd78e62339fc5bdec30d85eb53731cb1f0`; init `[0x797dbe0,0x797e380)`, ponteiro `0x797e13d`, tamanhos `0x797e14c/0x797e158`.
2. `master/content.proto`: VA/offset `0x68f342d`, 36.675 bytes, SHA-256 `649b7ce3164eb77a8ad9e396e17988424d3ad15860452c51cfec90211f638a20`; init `[0x794e160,0x794f3a0)`, ponteiro `0x794f09d`, tamanhos `0x794f0ac/0x794f0b8`.
3. `master/tool.proto`: VA/offset `0x6852bbb`, 24.946 bytes, SHA-256 `e2309711f0775fde247afe7800740e3193c6a7a525cf4ad4a2bc5507f9493cff`; init `[0x753fe80,0x7540a00)`, ponteiro `0x754079d`, tamanhos `0x75407ac/0x75407b8`.

`adapter-extract.py` verifica o hash e backing PT_LOAD único. Os JSONs preservam campos/tipos/números/jsonName, repetição, oneofIndex, proto3Optional, MessageOptions.map_entry e enums/números, recursivamente. Não são descritores completos: outras options/anotações não são exportadas. A serialização local usa jsonName e o mapeamento oficial de Struct/Value/bytes/enums em https://protobuf.dev/programming-guides/json/. Não se apresenta como parser ProtoJSON geral (null, nomes snake_case e formas alternativas de números/bytes estão fora do subconjunto).

Campos selecionados usados no código:

- O wrapper interno previamente recuperado contém `project` #1, `requestId` #2, `request` master #3 e `model` #4. O request master contém `contents` #2, `generationConfig` #4, `tools` #6 e `systemInstruction` #8. Model/endpoint internos não são inventados nem derivados do modelo externo.
- `Content`: role #1 e parts repetido #2. `Part.data` é um oneof: text #1, functionCall #5 e functionResponse #6 são as variantes suportadas; thought #10 e thoughtSignature bytes #11 são campos independentes. Imagens, áudio, código e outros dados são rejeitados, não descartados.
- FunctionCall: name #1, args Struct #2 e id #3. FunctionResponse: name #1, response Struct #2 e id #3. O id é preservado quando presente, nunca gerado. PartialArgs/willContinue, parts multimídia e scheduling não são suportados. Tool.functionDeclarations #1 e FunctionDeclaration.parametersJsonSchema Value #5 fundamentam declarações com schema JSON objeto; nenhum executor de ferramentas foi adicionado.
- GenerationConfig: temperature float #1, topP float #2, maxOutputTokens int32 #5, stopSequences repetido #6 e thinkingConfig #25. ThinkingConfig contém includeThoughts #1, thinkingBudget int32 #3 e thinkingLevel enum #4, com presença proto3 optional independente. Zeros/false explícitos são preservados; não se inventa budget nem limite de modelo. O enum recuperado inclui LOW, MEDIUM, HIGH, MINIMAL, EXTRA_HIGH, MAX e XHIGH, além de UNSPECIFIED.
- Response master: candidates #2, promptFeedback #3 e usageMetadata #4. Candidate: index #1, content #2 e finishReason enum #3. A conversão conserva todos os 20 nomes de FinishReason recuperados (0–19); SAFETY, MAX_TOKENS, CONTINUATION etc. não viram STOP. UsageMetadata fornece promptTokenCount #1, candidatesTokenCount #2, totalTokenCount #3, cachedContentTokenCount #5, toolUsePromptTokenCount #13 e thoughtsTokenCount #14, todos int32. Ausência continua ausência, zero continua zero; totais não são somados ou inferidos.

Maps relevantes foram conferidos: GenerateContentRequest.LabelsEntry e GenerationConfig.LogitBiasEntry são map_entry, mas labels/logitBias não fazem parte da API suportada. Struct/Value são representados por JSON segundo o contrato WKT, sem wrappers artificiais `fields`/`stringValue`. Args, resultados e schemas são clonados, limitados e não permitem chaves de prototype pollution.

## Evidência de framing e política nova

`deserializeStreamResponse [0x9564b00,0x9565040)` testa HTTP status 200–299 e configura um Scanner. As relocations de funcval `0xcab12b8` → `bufio.ScanLines 0x70b5a40` e `0xcab1368` → `codeassistclient.scan 0x95453c0` mostram a substituição pelo split customizado em `0x9564f28`. O buffer inicial é 0x400 e o máximo configurado no binário é 0x10000000; esse máximo **não** foi copiado para a política local.

`scan [0x95453c0,0x95455a0)` procura LF/LF e depois CRLF/CRLF; no EOF entrega o restante não vazio, removendo CR final. `toStreamResponseChunk [0x952f0a0,0x952f2a0)` divide linhas e extrai/trim event e data. Dados repetidos substituem o valor anterior no código observado; não há junção SSE multiline estabelecida. `ProcessStreamChunks` verifica JSON de erro sem envelope, chama conversor indireto, passa resultado/erro ao consumidor e encerra se o callback retorna false. Em EOF sem erro de Scanner retorna sem sintetizar um finish. O leitor tem fechamento deferido; o sender instala contexto cancelável e timer. Evidências: `adapter-scan.asm`, `adapter-deserialize.asm`, `adapter-send.asm` e os `final-chunks/chunk-envelope/stream-iterator.asm` anteriores, todos da identidade atual.

O decoder local é deliberadamente **mais estreito**, não emulação completa do cliente:

1. Aceita frames data-only com uma linha `data:` e delimitador LF/LF ou CRLF/CRLF; aceita um último frame sem delimitador no EOF. Extração é incremental por bytes, inclusive UTF-8 e delimitadores divididos. Não suporta event/id/retry/comments, data repetido ou `[DONE]`. Seleciona o primeiro delimitador encontrado, não reproduz a prioridade global LF do split original em buffers mistos.
2. JSON inválido, UTF-8 inválido, variantes/oneofs desconhecidos e erros remotos são rejeitados. As mensagens de erro têm apenas códigos fixos; não incluem body, prompt, erro remoto ou abort reason. Falha fecha o decoder. JSON.parse tem semântica last-wins para chaves iguais; variantes distintas do oneof são rejeitadas.
3. Exige ao menos um Candidate.finishReason conhecido e diferente de UNSPECIFIED antes de considerar a leitura encerrada. Isso é **nova política local conservadora**, não um terminador observado no transporte. Preserva a razão para o chamador distinguir bloqueio/limite/continuação de STOP. Não implementa retomada de CONTINUATION. Após finish aceita somente trailers sem candidatos, por exemplo usage. EOF vazio/sem finish falha como truncated; chunks anteriores podem já ter sido consumidos.
4. Preserva fronteiras dos chunks. Não presume se texto/args/usage são deltas ou cumulativos, não agrega texto nem totais e não monta argumentos parciais. Suporta um candidato de índice zero; candidato ausente não é convertido em conteúdo inventado. O índice omitido normaliza para o default proto3 zero, não para um modelo selecionado.
5. Limites locais: 1 MiB por body/frame, 16 MiB de stream total, 1.024 frames não vazios, 256 contents/parts, 64 declarações, 32 stop sequences, 10.000 nós JSON e profundidade 16. Uma leitura do transport pode agrupar vários frames válidos e exceder 1 MiB; o limite não depende do agrupamento de bytes pela rede. O orçamento JSON é conservador e pode rejeitar objetos menores que 1 MiB. Headers, escopo de conta e entitlement não são inferidos. Campos conhecidos de metadados externos são ignorados, não expostos como saldo/quota; outros recursos desconhecidos falham explicitamente.

O transport é explicitamente caller-owned; não há implementação padrão. O generator remove listener de abort, aborta seu sinal interno e solicita iterator.return em erro/cancelamento/break. Cancelamento interrompe uma leitura pendente; o cleanup do transport é best-effort e não pode substituir o erro sanitizado nem prender o consumidor. Isso é política local de ciclo de vida, não observação de callbacks JavaScript no cliente Go.

## Executar e verificar

Com as dependências já instaladas:

```sh
npm run build
npm run typecheck
node --test test/offline-inference.test.mjs
npm run demo:inference
```

O demo usa somente `examples/offline-inference.mjs` e imprime dois chunks sintéticos: conteúdo e finish/usage. O teste integração envia bytes um a um pelo transport de memória; outro verifica todas as posições de corte de um frame CRLF/UTF-8 e o roundtrip de chamada/resultado de ferramenta. Mocks não provam operação do serviço, login ou entitlement.

RED inicial confirmou módulo ausente; GREEN passou após implementar a fatia. Um teste adversarial de 16 MiB de frames vazios expôs busca quadrática do protótipo de splitter; a versão final percorre bytes uma vez com buffer limitado, mantendo esse teste de regressão. Nenhum teste existente foi alterado ou removido. O parent continua responsável pela suíte completa final e revisão de integração.

Na continuação do provider HTTP, o limite incorreto de 1 MiB por chamada a `push` foi removido após regressão RED: dois frames de 600 KiB devem produzir o mesmo resultado separados ou concatenados. Permanecem os limites de 1 MiB por frame, buffer com até quatro bytes adicionais para delimitadores e 16 MiB total. O teste anterior de chunk grande foi substituído por verificações de frame excedido no EOF, overflow real do buffer (`MAX_BYTES + 5`) e limite total. A suíte focada atual tem 16 testes, todos aprovados com o preload de bloqueio de rede; a contagem de 15 abaixo registra a etapa original.

Validação final desta lane: build/typecheck, os 15 testes focados (zero skips) e o demo passaram. Inverter a condição de EOF/finish fez o teste de framing falhar; a mutação foi restaurada antes do build final. O teste de cancelamento com chunk final suspenso também passou por RED→GREEN. O hash do ELF foi reconferido no encerramento e `adapter-evidence-manifest.json` registra os 10 arquivos privados desta fatia. Os 32 testes anteriores permanecem intactos; a nova suíte completa não foi executada nesta lane.

O driver SDK OpenCode foi implementado posteriormente como factory text-only explícita `./offline-opencode`; veja `FINDINGS-offline-opencode.md`, incluindo a exceção de compilação do SDK. Restam configuração de cliente autorizada, transporte real permitido, descoberta/entitlement e quota; também adaptação/retomada de recursos fora do subconjunto. Esses limites não impedem usar e testar as fatias offline.
