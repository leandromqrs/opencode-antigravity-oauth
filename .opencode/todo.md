## M1: Provedor OAuth nativo funcional | status: completed
### T1.1: Identificar causa do bloqueio remoto | status: completed
- [x] S1.1.1: Confirmar origem da divergência entre CLI oficial e catálogo do provedor com evidência verificável.
- [x] S1.1.2: Verificar aceitação remota de catálogo, geração e glob com credencial OAuth própria selecionada, sem inferir autorização contratual.
### T1.2: Implementar e verificar integração | status: completed
- [x] S1.2.1: Implementar correções fundamentadas com testes de regressão sintéticos.
- [x] S1.2.2: Executar build e testes locais e verificar tipos.
- [x] S1.2.3: Validar catálogo, inferência e glob real com seleção de conexão OAuth verificável e resposta final após resultado.
- [x] S1.2.4: Obter novo login antes do diagnóstico remoto; usuário confirmou e API lista conexão OAuth própria.
- [x] S1.2.5: Atualizar perfil do artefato AGY após revisão estática, regressão e validação local do loader.
- [x] S1.2.6: Confirmar login no host; usuário confirmou sucesso e API local lista conexão credential/oauth.
### T1.4: Publicar modelos no host V2 após login | status: completed
- [x] S1.4.1: Reproduzir a falha com editor síncrono fiel ao SDK real.
- [x] S1.4.2: Separar descoberta assíncrona da publicação e invalidar catálogo após mudanças de credencial.
- [x] S1.4.3: Verificar modelos na API real, build, testes e tipos; registrar limites de inferência.
### T1.5: Compatibilidade de inferência com o host real | status: completed
- [x] S1.5.1: Reproduzir a entrada nativa rejeitada por lower() após catálogo real publicado.
- [x] S1.5.2: Corrigir apenas contratos comprovados e verificar geração e glob real com resposta final.
- [x] S1.5.3: Propagar timeout nativo por requisição e verificar deadlines total, headers e chunk sem ignorar cancelamento.
- [x] S1.5.4: Remover diagnóstico temporário, fixar URL shared-v21 e executar validação final local e remota.
- [x] S1.5.5: Mapear texto assinado e thought para eventos nativos sem perder assinaturas ou afrouxar terminais/ferramentas.
- [x] S1.5.6: Implementar snapshots de usage explícitos sem somar contagens, preservar single-report e verificar geração real.
- [x] S1.5.7: Localizar rejeição de entrada na sessão completa e validar glob somente leitura com resultado reinserido e resposta FOUND.
### T1.3: Eliminar dependência do executável AGY | status: completed
- [x] S1.3.1: Guardar configuração do cliente AGY autorizada em arquivo privado fora do projeto.
- [x] S1.3.2: Substituir extração binária por configuração privada com testes de regressão.
- [x] S1.3.3: Verificar ausência de dependência em runtime, build, testes, tipos e documentação.

## M2: UX do provedor (nome, /connect, efforts, quota) | status: completed
### T2.1: Renomear para Google Antigravity e melhorar /connect | status: completed
- [x] S2.1.1: Nome do preset local e mensagem de reautorização; rótulo/instruções do /connect; testes e docs.
### T2.2: Efforts estilo AGY (flash agrupado em variants) | status: completed
- [x] S2.2.1: Agrupar modelos flash por base no catálogo com variants low/medium/high e wire model em settings.
- [x] S2.2.2: Driver resolve wire model a partir do variant selecionado, validado contra o catálogo; segurança permite variants.
- [x] S2.2.3: Regressões RED/GREEN, suíte completa (339/339), tipos, revisão estática aprovada e publicação agrupada confirmada no host real.
- [x] S2.2.4: Geração de sessão completa com esforço selecionado verificada em shared-v53: low/medium/high contextual retornam200 com resposta exata; histórico preservado.
### T2.4: Corrigir effort ausente e falha de envio relatados pelo usuário | status: completed
- [x] S2.4.1: Reproduzir seleção de effort e offline_stage=input no host V2 sem alterar quota.
- [x] S2.4.2: Corrigir causas comprovadas com testes RED/GREEN e nova geração fixa do driver.
- [x] S2.4.3: Geração de sessão completa no host real verificada em shared-v53 (low/medium/high200 exato); causa do429 isolada e corrigida.
- [x] S2.4.4: Isolar diferença contextual com probes controlados, remover instrumentação e verificar driver final sem reescrever instruções.
- [x] S2.4.5: Obter decisão do usuário antes de qualquer adaptação da identidade/instruções do sistema; formulário autorizou investigar adaptação explícita.
- [x] S2.4.6: Testar adaptação limitada, preservando regras/caminhos/comandos/quota; remover probes e verificar estado final.
### T2.5: Corrigir pela comparação direta com agy-auth-local | status: completed
- [x] S2.5.1: Comparar pipeline real da referência, sem copiar credenciais ou alterar quota.
- [x] S2.5.2: Demonstrar diferenças relevantes com regressões RED/GREEN e aplicar correção focada.
- [x] S2.5.3: Verificar geração contextual no host, testes/build/tipos e sincronizar evidências.
- [x] S2.5.4: Referência stock1.5.8 NÃO gera no V2 (modelos não selecionáveis: inventory sem sourceConnection); teste autenticado negativo documentado. Correção própria verificada com caso contextual aceito.
### T2.6: Comparar referência local com upstream 1.5.8 sem instalar | status: completed
- [x] S2.6.1: Confirmar versão publicada, commits divergentes e comparar fontes fixadas no commit da release.
- [x] S2.6.2: Concluir análise da dependência Google 4.0.108 versus 4.0.120 e identificar impacto no subconjunto textual.
- [x] S2.6.3: Registrar conclusão e recomendação sem alterar runtime, quota ou correções locais do fork.
### T2.7: Testar User-Agent 1.5.8 somente na inferência | status: completed
- [x] S2.7.1: Demonstrar RED/GREEN para novo cabeçalho de inferência e preservar quota/catalog/override.
- [x] S2.7.2: Executar build, suíte completa, tipos e verificar novo driver fixo no host.
- [x] S2.7.3: Comparar geração contextual e controle low contemporâneo; registrar resultado sem alterar histórico original.
### T2.8: Testar referência completa 1.5.8 de forma isolada | status: completed
- [x] S2.8.1: Verificar pacote publicado fixado, carregamento V2 e credencial própria sem importar tokens oficiais.
- [x] S2.8.2: Executar referência completa em localização temporária sem substituir fork/configuração global/quota.
- [x] S2.8.3: Comparar geração contextual e controle, limpar ativação temporária e registrar limites/evidências.
- Evidência T2.8: teste concluído COM FALHA DE GERAÇÃO, não correção da missão. Novo OAuth próprio autorizado pelo usuário em HOME/XDG privados fora do projeto; tentativa complete/1conexão, auth0600/projeto descoberto/token fresco verificados. Release59arquivos idêntica ao tarball. Seis modelos ativos, seleção real google-agy/gemini-3.8-flash low confirmada. Stateless404 ModelNotFound; session.generate503 Model unavailable. Também fluxo normal /prompt200→wait204→idle failed “Model unavailable”, sem assistant. Sessões descartadas/servidor privado parado/callback esquecido; produção e histórico originais intactos. Credencial nova fica somente no diretório privado0600 para continuidade; remover quando missão terminar. Evidência reference-e2e-1.5.8/final-authenticated-verification.json e authenticated-*.json. Não demonstra rejeição429 remota nem caso aceito; T2.5.4 e demais objetivos de geração continuam abertos.
### T2.3: Quota em Custom Providers (bridge quota-v1) | status: completed
- [x] S2.3.1: Buscar retrieveUserQuotaSummary e converter buckets em entradas percent quota-v1 sanitizadas.
- [x] S2.3.2: Bridge HTTP loopback com bearer, opção quotaBridge e ciclo de vida no plugin; testes.
- [x] S2.3.3: Registrar provider custom no OpenCode Quota e verificar exibição (linhas semanais reais via quota_provider_test); suíte/tipos/docs.
### T2.9: Corrigir 429 contextual (gatilho remoto no system) | status: completed
- [x] S2.9.1: Isolar por bissecção controlada o gatilho exato do429: substring literal `tools.opencode.session_move` no systemInstruction (outros tools.opencode.*/openchamber.* e `opencode.session_move` sem prefixo `tools.` passam).
- [x] S2.9.2: Correção mínima em offline-opencode.ts (neutralizeSystemText) reescreve só essa referência para descrição equivalente em system/system-update; regras/caminhos/ferramentas/histórico assinado intactos. RED4/5→GREEN5/5.
- [x] S2.9.3: Suíte366/366 sem skips/build/tipos; quota/catalog SHA preservados; driver shared-v53. Fork contextual real200 exato (FORK53_OK), histórico inalterado; efforts low/medium/high200 exato; controle stateless200. Probes de bissecção removidos, produção limpa.
- Evidência T2.9: verification-tmp/system-filter-{red,green,suite,types}.log, fork-v53-verification.json, efforts-v53-verification.json. Causa remota inferida (blocklist direcionada), não confirmada contratualmente; correção cobre o gatilho comprovado, outros substrings filtrados em outros catálogos não observados.
### T2.10: Quota custom Antigravity ausente no painel (bridge compartilhado) | status: completed
- [x] S2.10.1: Diagnosticar causa: getQuota dependia do inventory efêmero (TTL60s) de uma única instância dona do bridge; sem eleição compartilhada, reload/local inativo deixava a quota “Unavailable”. Comparado ao padrão QwenCloud/Junie (bridge dentro do plugin com leases).
- [x] S2.10.2: Portar registry de leases process-global (configured-quota-bridge-state.ts) + acquireQuotaBridge (configured-quota-bridge-plugin.ts): um bridge loopback compartilhado por todas as instâncias; getQuota agrega leases (primeira quota real vence); release fecha só sem leases; autoKey gerido no acquire/release. getQuota autossuficiente: descobre projeto sob demanda quando inventory expira.
- [x] S2.10.3: Testes novos4/4 (compartilhamento/agregação/release/autoKey/config incompatível); ajuste de asserção de warning para diagnóstico preciso invalid-key; suíte370/370 sem skips/build/tipos; configured-quota.ts e configured-catalog.ts SHA intactos.
- [x] S2.10.4: Deploy via reload My/LuminusOS sem warnings de bridge; quota_status custom3=success (Gemini weekly89%/100%), refresh do contexto Teste sem Unavailable; controle de inferência200 exato. (Camada de dados verificada; exibição no painel continuou ausente → causa real em T2.11.)
- Evidência T2.10: verification-tmp/quota-bridge-{build,test,suite,types}.log. Limitação: eleição cross-process (shared:true) ainda não implementada; compartilhamento é in-process (leases), suficiente para o host único.
### T2.11: Quota Antigravity ausente no painel — eleição cross-process (shared:true) | status: in_progress
- [x] S2.11.1: Causa raiz confirmada: serviço antigo (pid21197, manual Nov14, shutdown travado desde19:16Z) ainda segura a porta62369; o novo serviço gerenciado (pid650044, porta49374) não consegue bindar o bridge e o autoKey é process-local → check custom3 missing_credential → linha excluída do painel. OpenChamber/sessão ainda conectados ao servidor antigo. Junie/QwenCloud sobrevivem porque usam shared:true (chave em arquivo de estado + health probe + takeover monitor). Evidência: ss -ltnp (portas no pid21197), status RPC no serviço novo (custom3 missing_credential), /api/provider estável com antigravity-local em My/LuminusOS, entries do snapshot-v6 (entrada LuminusOS16:25:48 só junie+qwencloud).
- [x] S2.11.2: Portado o padrão QwenCloud/Junie: configured-quota-bridge-storage.ts (chave privada0600/0700, first-writer-wins, O_NOFOLLOW, publicação atômica), configured-quota-bridge-shared.ts (health probe HMAC + monitor de takeover), health endpoint aditivo em configured-quota.ts (sharedHealth, X-Agy-Nonce/Proof, 204+prova, rate-limit32/s, sem bearer), acquireQuotaBridge com caminho shared (env gerido por onAvailability, statuses, compatibilidade shared/stateDirectory). Testes8/8 no arquivo de bridge (4novos: health, storage, takeover, acquire cross-process com owner externo); suíte374/374 sem skips; build/tipos OK; configured-catalog.ts SHA intacto; configured-quota.ts alterado aditivamente com nova baseline shared-bridge-preserved.sha256.
- [ ] S2.11.3: Config alinhada: quotaBridge shared:true em opencode.jsonc (backup before-agy-shared-20261115T194409Z.bak). PENDENTE: usuário mata o servidor antigo pid21197 no terminal dele (esta sessão roda nele); depois reconectar, reload e verificar painel/contexto Teste + inferência no serviço gerenciado.
- [x] S2.11.4: CONFIGURED-INTEGRATION.md atualizado (shared implementado, health endpoint, exemplo com shared:true); baseline SHA nova com justificativa; arquivos de missão sincronizados.
