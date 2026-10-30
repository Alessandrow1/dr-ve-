# Dr!nk — Arquitetura, fluxos e riscos

> Documento do protótipo (v0.1). Tudo o que está marcado como **demo** ou **pendente** não existe em produção.

## 1. Ambiente analisado e decisão para o protótipo

| Item | Encontrado | Decisão |
|---|---|---|
| Node.js | 22 | Backend e frontend sem dependências externas: roda com `npm start`, sem `npm install` |
| Python | 3.13 | Usado só para testes de interface (Playwright), fora do produto |
| Rede para pacotes | disponível | Não necessária para rodar o protótipo |
| Mapas/pagamentos/push | sem chaves nem contas | Não simulados como se fossem reais: há uma camada de adaptação e dados de demonstração identificados |

O protótipo é web mobile-first (instalável como atalho no celular) porque é o caminho mais rápido para validar o **fluxo** de solicitação e acompanhamento. O app nativo vem depois, reaproveitando as regras do backend.

## 2. Arquitetura do protótipo

```
 Navegador (celular)                    Servidor Node (server/)
┌──────────────────────┐   HTTP/JSON   ┌───────────────────────────────────────┐
│ public/app.js        │──────────────▶│ index.js     rotas, estáticos, SSE,   │
│  app do cliente      │               │              limite de requisições    │
│ public/motorista.js  │◀──────────────│ rides.js     máquina de estados,      │
│  app do motorista    │  SSE (tempo   │              regras de segurança,     │
│ public/acompanhar.js │   real)       │              visões por perfil        │
│  contato de confiança│               │ pricing.js   cotação transparente     │
└──────────────────────┘               │ payments.js  interface de provedor    │
                                       │ drivers.js   cadastro e aprovação     │
                                       │ dispatch.js  motorista SIMULADO (demo)│
                                       │ events.js    barramento SSE           │
                                       │ store.js     JSON em disco (demo)     │
                                       └───────────────────────────────────────┘
```

Princípios aplicados:

- **O servidor é a fonte da verdade.** A interface só mostra o que o backend confirmou: a corrida só aparece como "Procurando motorista" depois da resposta do `confirm`, e cada tela é desenhada a partir do estado devolvido pela API.
- **Cada perfil enxerga só o que precisa** (`view()` em `rides.js`): o cliente vê o código de segurança; o motorista não; o contato de confiança vê status e posição, sem placa, pagamento ou código.
- **Sem segredos no cliente.** Credenciais de pagamento, mapas e push ficam exclusivamente em variáveis de ambiente do backend (hoje não há nenhuma).

## 3. Módulos

| Módulo | Responsabilidade |
|---|---|
| `server/rides.js` | Estados, transições, checklist, código de segurança, cancelamento, avaliação, ocorrências, ganhos |
| `server/pricing.js` | Tarifa (base + distância + tempo + deslocamento + noturno + mínimo), comissão, política de cancelamento |
| `server/payments.js` | Contrato `authorize / capture / voidAuth / refund / payout` e provedor `demo` |
| `server/drivers.js` | Cadastro com validação (CPF, CNH), aprovação/reprovação/suspensão com auditoria |
| `server/dispatch.js` | Motorista simulado que usa as mesmas regras do motorista real |
| `server/geo.js` | Área de atendimento, bairros de Mossoró (coordenadas aproximadas), distâncias |
| `server/events.js` | SSE por canal (corrida do cliente, corrida do motorista, link de acompanhamento, fila de motoristas) |
| `public/` | Telas do cliente, do motorista e de acompanhamento; identidade visual |

## 4. Máquina de estados da corrida

```
aguardando_confirmacao ─confirmar─▶ procurando_motorista ─aceitar─▶ motorista_encontrado
        │                                   ▲                              │ iniciar deslocamento
        │                                   └──── liberar ────┐            ▼
        │                                                     └── motorista_a_caminho
        │                                                                  │ cheguei
        ▼                                                                  ▼
    cancelado ◀── cancelar (até a verificação) ────────────────── motorista_chegou
                                                                           │ iniciar verificação
                                                                           ▼
                                                                verificacao_pre_servico
                                                      (checklist + código do cliente + equipamento)
                                                                           │ iniciar serviço (só com verificação ok)
                                                                           ▼
                                  servico_concluido ◀─ finalizar ─ em_andamento ◀─ servico_iniciado
```

Regras garantidas pelo servidor (e cobertas por testes em `test/flow.test.js`):

1. Nenhuma etapa pode ser pulada; ações fora de ordem retornam `409`.
2. O serviço **só inicia** com checklist completo **e** código de segurança do cliente correto.
3. Três códigos errados encerram a corrida sem custo e abrem uma ocorrência.
4. Se o equipamento do motorista não puder ser levado com segurança, ele registra "inviável": a corrida é cancelada **sem custo para o cliente** e gera ocorrência.
5. Cancelamento: grátis até o aceite; taxa com motorista a caminho ou no local; **não existe cancelamento após o início** (usa-se suporte/emergência).
6. Cliente precisa declarar que é proprietário ou autorizado a usar o veículo; placa é validada.
7. Preço fixado na confirmação (sem variação durante a corrida).

> A confirmação do checklist pelo motorista **não é** prova de habilitação nem de seguro. Essas verificações pertencem ao cadastro e à apólice, que dependem de serviços externos (seção 7).

## 5. Telas e fluxos

**Cliente** (`/`): início com mapa, embarque, destino e estimativa → confirmar pedido (veículo, autorização, pagamento, preço detalhado, política de cancelamento, compartilhamento opcional) → acompanhamento com etapas, motorista, código de segurança e cancelamento → conclusão com avaliação, recibo e suporte. Menu: histórico, pagamentos, perfil, suporte e segurança.

**Motorista** (`/motorista.html`): entrada (demo) ou cadastro → chave online/offline → solicitações com distância até o cliente, valor líquido, distância e duração → atendimento passo a passo com checklist, equipamento, código e navegação → ganhos do dia, 7 e 30 dias e histórico.

**Contato de confiança** (`/acompanhar.html?t=…`): somente leitura, mostra status, posição e tempo estimado.

**Operação** (`/admin.html`): indicadores, motoristas (aprovar, reprovar, suspender), corridas, clientes, pagamentos e comissões, reembolsos, incidentes, tarifas, áreas e auditoria. Toda ação que altera algo grava auditoria.

## 6. O que é real, demo e pendente

| Recurso | Situação |
|---|---|
| Máquina de estados, regras de segurança, preço, cancelamento, avaliação, recibo | **Real** (lógica do servidor, testada) |
| Tempo real (SSE) com fallback por consulta periódica | **Real** |
| Cadastro de motorista com validação e aprovação com auditoria | **Real** (lógica); documentos e verificações **pendentes** |
| Pagamentos (Pix, cartão), repasses, reembolsos | **Demo**: provedor `demo`; valores e códigos fictícios identificados na tela |
| Tarifas e comissão | **Demo**: valores de exemplo em `pricing.js` |
| Motorista simulado | **Demo**: opcional, desmarcável no pedido |
| Mapa, bairros, rotas, ETA | **Demo**: mapa esquemático; bairros com coordenadas aproximadas; distância = linha reta × 1,35 |
| Login de cliente e motorista | **Demo**: identificação por aparelho/seleção |
| Banco de dados | **Demo**: JSON em `data/db.json` |
| Cupons, indicações, parcerias com estabelecimentos, métricas de operação | **Pendente** |
| Painel administrativo web (clientes, corridas, pagamentos, reembolsos, incidentes, tarifas, áreas, indicadores, auditoria) | **Real** (lógica e tela); acesso por chave única de demonstração |
| Painel: login individual, permissões por perfil, MFA, cadastro de novas áreas | **Pendente** |
| Fotos do veículo e documentos | **Pendente** (exigem armazenamento seguro e consentimento) |
| Notificações push | **Pendente** |

## 7. Serviços externos necessários

| Necessidade | Opções a avaliar | Observação |
|---|---|---|
| Mapas, geocodificação, rotas | Google Maps Platform, Mapbox, OSRM/OpenStreetMap | Chaves apenas no backend (proxy) ou com restrição de domínio/app |
| Pagamentos (Pix, cartão, repasse/split) | provedores brasileiros de pagamento | Implementar a interface de `payments.js`; conformidade PCI via tokenização do provedor |
| Verificação de identidade e antecedentes | provedores de KYC e de consulta de antecedentes | Base legal e minimização de dados (LGPD) |
| Validação de CNH | consulta junto ao órgão de trânsito, quando aplicável | Exige parecer sobre o meio permitido |
| Seguro | seguradora com cobertura compatível com o serviço | Ver risco regulatório 1 |
| Push | FCM e APNs | Via backend |
| Banco, cache e filas | PostgreSQL (+PostGIS), Redis | Substituem `store.js` e `events.js` |
| Observabilidade | logs estruturados, métricas e alertas | Rastrear corrida por `id` |

## 8. Caminho para produção

1. Trocar `store.js` por PostgreSQL com migrações. Tabelas sugeridas: `users`, `drivers`, `driver_documents` (cofre criptografado), `vehicles`, `rides`, `ride_events` (a linha do tempo atual), `verifications`, `payments`, `payouts`, `incidents`, `ratings`, `tariffs`, `service_areas`, `audit_log`.
2. Autenticação real (OTP por SMS/e-mail ou provedor de identidade), tokens de curta duração, papéis (cliente, motorista, operador, administrador) e MFA para a operação.
3. SSE/WebSocket atrás de Redis pub/sub para múltiplas instâncias.
4. Despacho real: ofertas por proximidade e disponibilidade, com tempo limite e reoferta.
5. App nativo multiplataforma (React Native ou Flutter) consumindo a mesma API.
6. Painel administrativo web com RBAC, filas de análise e indicadores.
7. Lançamento fechado em Mossoró com área geográfica limitada, depois expansão por cidade quando houver motoristas e suporte suficientes.

## 9. Riscos

### Técnicos
- **Posição e ETA estimados:** sem rotas reais, a precisão é baixa. Mitigação: provedor de rotas e GPS do motorista (o app já aceita posição real quando liberada).
- **Conexões lentas:** o app usa consulta periódica como fallback do SSE e telas leves; falta cache offline e reconexão de GPS em segundo plano (exige app nativo).
- **Autenticação e autorização simplificadas** neste protótipo; não expor publicamente antes de substituí-las.
- **Concorrência no despacho:** hoje o primeiro aceite vence no processo único; em produção exige transações e travas no banco.
- **Dados sensíveis (CPF, CNH, localização):** exigem criptografia, retenção mínima e trilha de acesso.

### Operacionais
- **Disponibilidade de motoristas** concentrada em sexta, sábado e eventos; picos e longos tempos de espera elevam cancelamentos.
- **Equipamento que não cabe no porta-malas:** previsto no fluxo (guardar em local seguro, equipe de apoio ou cancelar sem custo), mas gera custo e tempo operacionais.
- **Cliente alcoolizado:** risco de agressividade, enjoo no veículo, recusa em pagar ou alegações de avarias. Mitigação: registro de estado do veículo com consentimento, protocolo de ocorrências, canal de suporte, avaliação e denúncia.
- **Segurança do motorista:** pedaladas noturnas, retorno após o destino e fadiga. Definir limites de jornada e rotas de retorno.
- **Fraude:** carro que não é do cliente (mitigado pela declaração, conferência de documento e placa), falso motorista (código de segurança e identificação), abuso de cupons.

### Regulatórios (avaliar com profissionais antes do lançamento — este documento não é parecer jurídico)
1. **Seguro e responsabilidade civil:** a apólice do carro do cliente pode não cobrir condutor contratado; é preciso cobertura compatível para acidente, avaria e terceiros.
2. **Trânsito:** habilitação adequada, regras sobre condução de veículo de terceiros por prestador, circulação de bicicleta elétrica e scooter elétrica (limites de potência e velocidade, equipamentos obrigatórios) e eventual enquadramento do serviço no âmbito municipal.
3. **Trabalhista e tributário:** relação com motoristas parceiros (autonomia versus vínculo), tributação e emissão de documentos fiscais.
4. **LGPD:** base legal, consentimento específico para fotos, localização e documentos, encarregado, prazos de retenção e resposta a incidentes.
5. **Consumidor:** transparência de preço, cancelamento e reembolso (já refletida na interface); termos de uso.
6. **Publicidade:** a comunicação não pode glamorizar o consumo de álcool; a marca deve posicionar o serviço como escolha responsável.
7. **Exigências locais:** alvarás e regras do município de Mossoró e do estado do Rio Grande do Norte.
