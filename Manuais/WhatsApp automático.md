# WhatsApp automático (configurar depois)

O sistema já tem o envio automático de cobranças **pronto e desligado**. Enquanto ele não for
configurado, nada é enviado sozinho: a cobrança continua manual, pelo botão **Avisar**.

Quando ligado, uma vez por dia, no horário escolhido, o sistema manda:
- **A vencer:** uma vez, quando faltarem até N dias (N = "Avisar quantos dias antes" em Configurações).
- **Vence hoje:** uma vez, no dia do vencimento.
- **Vencida:** repete a cada X dias, até Y dias de atraso (você escolhe X e Y).

Quem já foi avisado no dia (manual ou automático) não recebe de novo. Um motorista pode ficar de fora:
**Clientes → Editar → Cobrança automática no WhatsApp → Não recebe**.

Usa a **API oficial do WhatsApp (Meta)**: não há risco de bloquear o número, e paga-se por mensagem
(alguns centavos cada; confira a tabela atual da Meta). Não precisa de empresa intermediária.

---

## 1. Número
Separe um **chip só para isso**. Esse número **não pode** estar em uso no aplicativo do WhatsApp
(nem no WhatsApp Business do celular).

## 2. Conta na Meta
1. Crie a conta empresarial em **business.facebook.com** com o CNPJ da Moura Aluguéis.
2. Em **Configurações da empresa → Central de segurança**, faça a **verificação da empresa**.
3. Em **developers.facebook.com → Meus apps → Criar app**, escolha o tipo **Empresa**, ligue à conta empresarial e adicione o produto **WhatsApp**.
4. Em **WhatsApp → Configuração da API**, adicione o número do chip e confirme com o código por SMS.
5. Anote o **ID do número de telefone** (só números).
6. Para o token que não expira: **Configurações da empresa → Usuários do sistema → Adicionar** (perfil Administrador),
   dê acesso ao app e ao número do WhatsApp, e clique em **Gerar token** com as permissões
   `whatsapp_business_messaging` e `whatsapp_business_management`. Copie o token.
   **Não mande o token por WhatsApp nem pelo chat.** Ele vai direto no GitHub (passo 4).

## 3. Modelos de mensagem (a Meta aprova antes)
Em **WhatsApp Manager → Modelos de mensagem → Criar modelo**, crie os três abaixo.
Categoria **Utilidade**, idioma **Português (BR)**. Os nomes precisam ser exatamente estes
(ou troque os nomes também em Configurações → WhatsApp automático).
As variáveis `{{1}}`, `{{2}}`... precisam ficar **nesta ordem**. A última é o pagamento: com o Pix automático (Asaas)
ligado, vai o **Pix copia e cola** da parcela; sem ele, vai a chave Pix das Configurações.

**`parcela_a_vencer`**
```
Olá, {{1}}! Aqui é da Moura Aluguéis. Lembramos que a parcela {{2}} do aluguel da moto {{3}}, no valor de {{4}}, vence em {{5}}. Pague pelo Pix: {{6}}. Obrigado!
```
Exemplos para a Meta: `Carlos` · `5/52` · `Honda CG 160 Fan (QZA-1F23)` · `R$ 300,00` · `20/11/2026` · `00020126580014br.gov.bcb.pix...`

**`parcela_vence_hoje`**
```
Olá, {{1}}! Aqui é da Moura Aluguéis. A parcela {{2}} do aluguel da moto {{3}}, no valor de {{4}}, vence hoje. Pague pelo Pix: {{5}}. Obrigado!
```
Exemplos: `Carlos` · `5/52` · `Honda CG 160 Fan (QZA-1F23)` · `R$ 300,00` · `00020126580014br.gov.bcb.pix...`

**`parcela_vencida`**
```
Olá, {{1}}! Aqui é da Moura Aluguéis. A parcela {{2}} do aluguel da moto {{3}}, no valor de {{4}}, venceu em {{5}} e está em atraso há {{6}}. Por favor, regularize o pagamento pelo Pix: {{7}}. Se já pagou, desconsidere esta mensagem.
```
Exemplos: `Carlos` · `5/52` · `Honda CG 160 Fan (QZA-1F23)` · `R$ 300,00` · `15/11/2026` · `3 dias` · `00020126580014br.gov.bcb.pix...`

O valor `{{4}}` já sai com multa e juros, se estiverem configurados.

## 4. Guardar o token no GitHub
Repositório **Mouraalugueis → Settings → Secrets and variables → Actions → New repository secret**:
- `WHATSAPP_TOKEN` = o token do passo 2.6
- `WHATSAPP_PHONE_ID` = o ID do número do passo 2.5

Depois rode **Actions → Publicar no servidor**. O passo "WhatsApp automático" deve dizer
*"Token do WhatsApp enviado ao servidor."*

## 5. Ligar (primeiro em teste)
No sistema, entre como administrador: **Configurações → WhatsApp automático**.
1. O selo deve mostrar **"Pronto, mas desligado"**. Se mostrar "Aguardando token da Meta", o passo 4 não foi feito.
2. Clique em **Quem receberia hoje** para conferir a lista.
3. Deixe **Modo teste: Ligado**, coloque o **seu celular** em "Celular de teste", ligue o **Envio automático** e salve.
4. Clique em **Enviar agora**. Até 3 mensagens chegam no seu celular. Confira o texto.
5. Tudo certo? Mude **Modo teste** para **Desligado** e salve. A partir daí, todo dia no horário escolhido,
   as mensagens vão para os motoristas. O histórico fica em **Últimos envios**.

## Dica (LGPD)
Inclua no contrato de aluguel uma linha dizendo que o motorista aceita receber avisos de cobrança
pelo WhatsApp no número informado.

## Erros comuns (aparecem em "Últimos envios")
- **Template name does not exist / not approved:** o nome do modelo está diferente ou ainda não foi aprovado.
- **Number of parameters does not match:** o modelo foi criado com outra quantidade de `{{ }}`.
- **Invalid OAuth access token:** o token expirou ou foi copiado errado. Gere outro e atualize o secret.
- **Recipient phone number not valid:** o celular do motorista está errado no cadastro.
