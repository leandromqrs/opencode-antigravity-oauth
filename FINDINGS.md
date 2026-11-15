# Observações estáticas sanitizadas

## Identidade

Artefato investigado somente por leitura: ELF x86-64, 280.564.136 bytes, SHA-256 `5df525a2d6908989c57b897723caea66e00d7c4d2e24411f91ad306989574642`. Nenhum login, execução do artefato, acesso a credenciais ou chamada de serviço foi realizado nesta fatia.

## REA e análise nativa

REA 6.8.0 produziu notas ELF (`ev_dd0f2ac56bf46881a4d9607cf2ebfd104c4bd4cf803bd171c387055688ad12a9`) e inventário de artefato (`ev_afa61db4896643bcea060392a06789d71a03e462406ed2f39d95240b6bf6a7b0`). O inspetor Go integrado recusou o arquivo por exceder seu limite fixo de 268.435.456 bytes; o arquivo não foi truncado.

Uma tentativa Ghidra 12.1.4, com heap 4 GiB e prazo de 30 minutos, terminou em `provider_timeout`. Logs registraram Go 1.28 não testado, ausência de bootstrap RTTI e falhas dos analisadores Go. Nenhuma função decompilada ou relação de chamadas foi recuperada. O bundle nativo exportado contém zero registros; processos da tentativa foram encerrados e a limpeza foi confirmada. Não houve nova importação pesada.

## Recuperação estruturada independente

O parser local validou todos os registros de duas tabelas:

- `.lrodata`, offset `0x17652a0`: 187.711 funções; 91 nomes correspondem à substring `cli/backend/auth/auth.`.
- `.noptrdata`, offset `0xe54e3e9`: 19.365 funções; nenhuma corresponde à mesma consulta. A propriedade desse payload permanece desconhecida.

No primeiro índice, `google3/third_party/jetski/cli/backend/auth/auth.(*oauthMethod).getOAuthConfig` declara intervalo relativo `[0x3176620, 0x3176760)`, registro no offset `0x4958de8` e nome no offset decimal 46.436.437. `auth.getOauthParams` declara intervalo relativo `[0x3175f40, 0x3176100)` e registro no offset decimal 76.909.880.

Na primeira fatia, o slot histórico `textStart` era zero e nenhuma base havia sido recuperada. A [segunda fatia](FINDINGS-addresses-and-oauth.md) agora relaciona a tabela principal a moduledata por relocations e recupera VAs link-time e offsets de código; endereços de execução permanecem desconhecidos. Somar automaticamente PCs à seção `.text` continua incorreto. Os resultados são observações de bytes estruturados, não Evidence REA.

## Reproduzir e continuar

Após `npm test`, execute o CLI com caminho absoluto e consulta literal conforme o README. Preserve saídas reais em diretório privado, fora do projeto. Os testes não precisam do artefato real.

O próximo bloqueio para um provider é estabelecer contratos e autorização de integração: grant, cliente, scopes, callback, refresh, envelope de requisição, streaming, modelos e quota. Não há implementação de rede nem autenticação fictícia nesta entrega.

Referências de layout: [Go debug/gosym](https://github.com/golang/go/blob/master/src/debug/gosym/pclntab.go). Limites de integração: [FAQ](https://antigravity.google/docs/faq) e [termos](https://antigravity.google/terms). O layout público é referência; a compatibilidade observada é estrutural, não certificação de suporte a Go 1.28.
