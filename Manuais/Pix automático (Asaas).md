# Pix com baixa automática pelo Asaas (configurar depois)

O sistema já tem a integração com o Asaas **pronta e desligada**. Enquanto ela não for configurada,
tudo continua manual: o motorista paga na chave Pix da empresa e alguém clica em **Receber**.

## Como funciona depois de ligado
1. Alguns dias antes do vencimento (você escolhe quantos), o sistema cria no Asaas uma **cobrança Pix só daquela parcela**.
2. O **Pix copia e cola** e o link de pagamento entram sozinhos nas mensagens do botão **Avisar**
   e do WhatsApp automático. Em **Cobranças** aparece o botão **Copiar Pix**.
3. O motorista paga pelo app do banco dele.
4. Na hora, o Asaas avisa o sistema e a parcela fica **paga sozinha** (forma "Pix (Asaas)"), já entrando no financeiro.
   Se esse aviso se perder, o sistema confere as cobranças sozinho de tempos em tempos.
5. Se a parcela for recebida à mão (dinheiro, chave antiga), se o aluguel for encerrado ou se a parcela for apagada,
   a cobrança no Asaas é **cancelada**, para o motorista não pagar duas vezes.

O dinheiro fica no saldo do Asaas e pode ser transferido para a conta da empresa
(manualmente ou com transferência automática, configurada no próprio Asaas).

> **Atenção:** o Asaas exige o **CPF** do motorista. Sem CPF no cadastro, a parcela daquele motorista
> não ganha Pix automático (aparece como erro em "Últimos acontecimentos") e segue manual.

---

## 1. Abrir a conta
1. Crie a conta em **asaas.com** com o CNPJ da Moura Aluguéis e envie os documentos para aprovação.
2. Em **Pix → Minhas chaves**, cadastre uma chave Pix na conta do Asaas (sem ela não dá para gerar cobranças Pix).
3. Confira as tarifas atuais do Asaas para Pix recebido.
4. Recomendado: em **Configurações da conta → Notificações**, desligue os avisos do próprio Asaas para os clientes
   (o sistema já cria os clientes com notificações desligadas; quem avisa é o WhatsApp da Moura).

> Quer testar antes, sem dinheiro de verdade? Crie também uma conta em **sandbox.asaas.com**
> e siga os passos abaixo com ela, cadastrando a variável `ASAAS_AMBIENTE` = `sandbox` (passo 3).
> Depois de testar, troque a chave e o webhook pelos da conta real e mude a variável para `producao`.

## 2. Pegar a chave de API
**Integrações → Chaves de API → Gerar chave**. Copie a chave (começa com `$aact_`).
**Não mande a chave por WhatsApp nem pelo chat.** Ela vai direto no GitHub.

## 3. Guardar no GitHub
Repositório **Mouraalugueis → Settings → Secrets and variables → Actions**:

Aba **Secrets → New repository secret**:
- `ASAAS_API_KEY` = a chave do passo 2
- `ASAAS_WEBHOOK_TOKEN` = uma senha que **você inventa** (só letras e números, de 32 a 255 caracteres).
  Ela também vai no webhook do Asaas (passo 5). É assim que o sistema sabe que o aviso veio mesmo do Asaas.

Aba **Variables** (só para o teste):
- `ASAAS_AMBIENTE` = `sandbox` enquanto testa. Sem essa variável, vale a conta real.

Depois rode **Actions → Publicar no servidor**. O passo "Pix automático pelo Asaas" deve dizer
*"Chave do Asaas enviada ao servidor."*

## 4. Conferir os cadastros
Todo motorista com aluguel ativo precisa ter **CPF** cadastrado (Clientes → Editar).

## 5. Webhook (o aviso de pagamento)
No Asaas: **Integrações → Webhooks → Adicionar**:
- **URL:** `https://ENDERECO-DO-SISTEMA/api/asaas/webhook`. O endereço certo aparece em
  Configurações → Pix com baixa automática.
- **Token de autenticação:** a mesma senha do `ASAAS_WEBHOOK_TOKEN`.
- **Versão da API:** v3. **Tipo de envio:** sequencial.
- **Eventos:** marque *Cobrança recebida* (`PAYMENT_RECEIVED`), *Cobrança confirmada* (`PAYMENT_CONFIRMED`),
  *Cobrança estornada* (`PAYMENT_REFUNDED`) e *Cobrança removida* (`PAYMENT_DELETED`).
- Deixe o webhook **ativo** e a fila **não interrompida**.

## 6. Ligar
No sistema, como administrador: **Configurações → Pix com baixa automática (Asaas)**.
1. O selo deve mostrar **"Pronto, mas desligado"**. Se mostrar "Aguardando chave do Asaas", o passo 3 não foi feito.
2. Escolha com quantos dias de antecedência gerar a cobrança (padrão: 5), ligue e salve.
3. Clique em **Gerar e conferir agora**. As cobranças aparecem em "Últimos acontecimentos" e no painel do Asaas.
4. Faça um Pix pequeno de teste (ou pague uma cobrança no sandbox) e veja a parcela ficar paga sozinha
   em **Cobranças → Pagas no mês**.

A partir daí o sistema roda sozinho: gera as cobranças a cada 5 minutos e dá a baixa assim que o Pix cai.

## Bom saber
- **Multa e juros:** se ligados em Configurações, o Asaas soma ao Pix quando paga com atraso
  (o juro por dia do sistema vira juro ao mês no Asaas: 0,033% ao dia ≈ 1% ao mês).
- **Desfazer pagamento** de uma parcela paga pelo Asaas fica bloqueado no sistema: o estorno se faz no painel do Asaas.
- **Pago duas vezes** (pelo Pix do Asaas e também à mão): aparece um alerta em "Últimos acontecimentos" para conferir.
- O botão manual **Receber** continua valendo para dinheiro e outros meios.
