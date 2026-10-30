# Dr!nk — "Bebeu? A gente dirige."

Protótipo funcional de uma plataforma de **motoristas designados**: um profissional chega ao cliente em bicicleta ou scooter elétrica dobrável, assume o volante do **carro do próprio cliente** e leva os dois ao destino. Mercado inicial: Mossoró (RN).

> **Este é um protótipo.** Preços, pagamentos, verificações de motorista e mapa são **simulados** e identificados como demonstração na tela. Não use para operar de verdade. Veja [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) para o que é real, demo e pendente, além dos riscos.

## Como executar

Requisitos: **Node.js 20 ou superior** (testado no 22). Não há dependências para instalar.

```bash
cd drink
npm start
```

Abra no navegador (de preferência no modo celular das ferramentas de desenvolvedor, ou no celular pela rede local):

| Tela | Endereço |
|---|---|
| Cliente | http://localhost:3000/ |
| Motorista | http://localhost:3000/motorista.html |
| Operação (painel admin) | http://localhost:3000/admin.html (entre com a chave admin mostrada no terminal) |
| Contato de confiança | link gerado pelo cliente ao compartilhar a viagem |

Ao iniciar, o terminal mostra a **chave admin desta execução**. Para fixá-la: `ADMIN_KEY=minha-chave npm start`.

Outras opções: `PORT=8080 npm start` (porta), `DRINK_PERSIST=0` (não salvar dados em `data/db.json`), `DEMO_SPEED=0.25` (acelera o motorista simulado), `npm run dev` (reinicia ao editar), `npm test` (testes).

## Como experimentar

**Rápido, só com a tela do cliente:** escolha um destino, toque em *Solicitar motorista*, preencha o carro, marque a autorização e confirme. O **motorista simulado** aceita, chega, passa pela verificação e conclui. Você vê cada etapa, o código de segurança, o recibo e a avaliação.

**Fluxo real com duas telas:** na tela do pedido, **desmarque** o modo demonstração. Em outra aba, abra `/motorista.html`, entre como *Rafael Menezes (demo)*, ative **Online** e aceite o pedido. Siga as etapas: ao chegar, o motorista completa o checklist e digita o **código de 4 dígitos** que aparece no app do cliente. Sem isso o serviço não inicia.

**Painel da operação** (`/admin.html`): indicadores (conversão, cancelamentos, tempo de espera, clientes recorrentes, pedidos por hora, financeiro simulado), aprovação, reprovação e suspensão de motoristas, corridas com filtro por estado, clientes, pagamentos e comissões, reembolso total ou parcial com motivo, incidentes com resolução justificada, edição de tarifas (vale só para novos pedidos), áreas de atendimento e auditoria de todas as ações. Para ver dados, faça algumas corridas na tela do cliente e cadastre um motorista em `/motorista.html`.

## Estrutura

```
server/   API, regras de negócio, preço, pagamentos (interface + demo), SSE
public/   app do cliente, app do motorista, acompanhamento, estilos e logo
test/     testes automatizados do fluxo (npm test)
docs/     arquitetura, fluxos, serviços externos e riscos
data/     banco de demonstração (criado ao rodar; ignorado pelo git)
```

## O que está pronto neste MVP

- Solicitação e acompanhamento completos com os 10 estados pedidos, atualizados em tempo real e sempre vindos do servidor.
- Estimativa com **cálculo transparente**, política de cancelamento clara e taxa aplicada pelo servidor.
- Segurança: declaração de autorização do veículo, código de segurança, checklist, alternativa quando o equipamento não cabe, trava de 3 tentativas, ocorrências, link de acompanhamento com consentimento e telefones de emergência.
- App do motorista: online/offline, solicitações com valor líquido e distâncias, atendimento passo a passo, ganhos e histórico, cadastro com validação de CPF e CNH.
- Camada de pagamentos pronta para um provedor real (interface em `server/payments.js`).
- Painel web da operação com indicadores, motoristas, corridas, clientes, pagamentos, reembolsos, incidentes, tarifas, áreas e auditoria.

## O que ainda falta

Login individual, permissões por perfil e MFA no painel da operação, autenticação real dos clientes e motoristas, pagamentos reais, mapas e rotas reais, verificação de CNH e antecedentes, seguro, fotos do veículo, notificações push, cupons e indicações, app nativo e parecer jurídico. A lista completa fica na tela (*Ver o que falta*) e em `docs/ARQUITETURA.md`.

## Identidade visual

Paleta: preto `#101010`, verde-limão `#B8FF5C`, grafite `#242424` e branco. O ícone (`public/logo.svg`) junta um volante e uma chave; a haste da chave forma o "!" do nome. Nada de copos ou bebidas na marca.
