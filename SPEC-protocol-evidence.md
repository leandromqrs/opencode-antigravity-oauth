# protocol-evidence: primeira fatia offline

## Objetivo

### Fatia de inferência offline (continuação)

Continuação nativa: `./offline-opencode` deve retornar LanguageModel V2 real com configuração explícita e transport injetado, exercitado por generate/stream do SDK público. Semântica de texto obrigatória delta/cumulativo; uso single-report sem totais inventados; subconjunto text-only com rejeição de tools/reasoning/opções desconhecidas no boundary canônico. SDK/config não são prova de integração consumer autorizada. Testes focados/build/typecheck/demo pertencem à lane; suíte completa final ao parent. Ver `FINDINGS-offline-opencode.md` para proveniência, limitações e exceção isolada do compilador causada pelas declarações do SDK.

Recuperar os descritores master ancorados no artefato atual, incluindo oneofs, enums, presença e maps. Implementar `./offline-inference` sem SDK/rede: serialização do wrapper e de contents/config/tools em subconjunto explícito, conversão de texto/thought/functionCall/functionResponse/usage e decoder incremental do framing observado. Um transport injetado recebe somente o body e AbortSignal; não há endpoint, headers ou autenticação presumidos. Valores das fixtures são sintéticos, campos são sustentados pelos descritores. Recursos não suportados falham explicitamente.

Verificação desta lane: testes novos primeiro em RED; depois build/typecheck e testes focados cobrindo request→bytes fragmentados→chunks normalizados, oneof inválido, erro remoto sanitizado, UTF-8 dividido, LF/CRLF, EOF sem finish, limites, cancelamento e fechamento do iterador. O parent mantém suíte completa final. Término explícito é nova política conservadora, não um marcador observado de transporte. A falta de autorização bloqueia ativação, não esta implementação offline.

### Critério da passagem anterior (superado pela continuação)

Concluir esta etapa com um artefato executável sem rede e um veredicto de viabilidade, não com um provider aparentemente pronto. Fazer uma passagem estática limitada por catálogo de modelos, generate/stream e quota, aproveitando os mapas existentes e sem novas importações. Um adapter de serviço só será implementado se método, envelope, respostas e framing estiverem ancorados em evidência; fixtures sintéticas devem identificar o que demonstram e nunca substituir o contrato ausente. Interfaces OpenCode serão conferidas em documentação oficial e referências irmãs somente-leitura.

Aceitação: preservar os 32 testes existentes; documentar evidências, lacunas críticas e fronteira SDK; fornecer um comando offline reprodutível para a capacidade realmente implementada. Se não houver contrato suficiente após essa passagem, encerrar com bloqueadores concretos e o mínimo material externo autorizado necessário. Não criar stubs de provider, catálogo/quota inventados ou login fictício. O parent mantém revisão e suíte completa final; esta lane verifica apenas a mudança focada e build/typecheck. Rede de serviço, execução de agy, credenciais do usuário/cliente embarcado, configuração global, instalações e commits continuam proibidos.

Entregar um pacote TypeScript ESM executável que inspeciona um ELF explicitamente fornecido, sem executá-lo. Recuperar registros Go pclntab estruturados, seus nomes, offsets originais e PCs relativos mesmo quando a recuperação Go do Ghidra falha. Isso implementa o primeiro módulo do capability map, não um provider OAuth funcional.

## Contrato

- `npm run inspect -- --binary /caminho/absoluto --query getOAuthConfig` produz JSON versionado com SHA-256, seções ELF, tabelas Go validadas e funções selecionadas. Limite de 512 MiB por arquivo, 2 milhões de funções/tabela, 100 resultados por tabela e 4096 bytes por nome. Não segue arquivos especiais, não descobre caminhos automaticamente e não imprime bytes ou strings arbitrários.
- Somente ELF64 little-endian x86-64 é admitido. Cabeçalhos, limites, tabelas e nomes são validados. Ausência de pclntab é representada como desconhecida, não como ausência de Go.
- Go pclntab magic `0xfffffff1` e layout de 64 bits são aceitos apenas quando cabeçalho e registros são autoconsistentes. O formato declara nomes e intervalos relativos; não recupera semântica ou fluxo. Ponteiro textStart zero permanece desconhecido: nunca somar automaticamente `.text` ao PC relativo.
- O scanner procura candidatos apenas em seções PROGBITS não executáveis; uma tabela em payload embarcado não é automaticamente atribuída ao cliente principal. A saída inclui seção e offset para auditoria.
- `npm run inspect -- --help` e todos os testes funcionam sem binário instalado, rede, login ou estado privado. Uma fixture ELF inteiramente sintética cobre recuperação e corrupção. Erros do CLI usam JSON e exit code diferente de zero, sem ecoar conteúdo do arquivo.

## Fora do escopo

Nenhum fetch, socket, shell subprocess, login, refresh, registro OpenCode, leitura de tokens, rotação de contas, quota inventada ou invocação do `agy`. Não copiar binário, segredos embarcados ou logs brutos para o projeto. Sem alteração dos projetos irmãos ou commits.

## Verificação e evidência

O responsável pela implementação executa RED→GREEN com Node test runner, typecheck estrito, build e uma inspeção real somente-leitura, salvando resultados privados em `/tmp/opencode/antigravity-rea/`. O parent revisa o diff e executa a verificação final. Testes sintéticos estabelecem comportamento do parser, não fidelidade de contrato de serviço. A inspeção real deve reencontrar funções conhecidas por nome com offsets auditáveis, sem dados de credenciais.

REA 6.8.0/Ghidra 12.1.4 tentou uma importação de 30 minutos com heap 4G; retornou provider_timeout e erros de GoRttiMapper para Go 1.28. Nenhuma função decompilada ficou disponível. Essa alternativa é um parser offline normal, não Evidence REA nem uma segunda importação Ghidra.

Fontes de layout a conferir antes de codificar: código público de `debug/gosym/pclntab.go` e `runtime/symtab.go` do projeto Go. O arquivo instalado é evidência de identidade; nomes/pclntab não demonstram OAuth suportado por terceiros.

## Segunda fatia: endereços link-time ancorados em moduledata

Adicionar `goCodeMappings` ao relatório, sem alterar PCs relativos ou declarar endereços de execução. Suporte conservador: ET_DYN x86-64, PT_LOAD não ambíguos, `.go.module` único com prefixo moduledata de 64 bits validado por relocations RELA `R_X86_64_RELATIVE`, ponteiros aos seis subtables, comprimento do índice, minpc/maxpc, text/etext e mapa de uma única seção de texto. Não usar o início de `.text` como base. Duplicatas ou estruturas incompatíveis não podem produzir mapeamento positivo.

Somente tabelas relacionadas por relocation ao pcHeader desse moduledata recebem mapeamento. Tabelas embarcadas não relacionadas continuam sem mapeamento. A saída deve conservar offsets de moduledata, relocations e segmento, além de VAs link-time e offsets de arquivo de cada resultado selecionado. ASLR/load bias e endereços de runtime permanecem desconhecidos. Esta fatia não implementa um linker geral nem disassembler.

Verificação: fixture sintética ET_DYN com base de texto diferente do início da seção, caso positivo e rejeições por relocation ausente/duplicada/tipo incorreto, min/max inconsistente, segmento não executável e tabela sem relação. Conferência real independente usando objdump somente sobre as duas funções getOAuthConfig, com resultados privados e observações sanitizadas de referências a scopes/endpoints. Sem nova importação Ghidra, execução do artefato ou publicação de client secrets.
