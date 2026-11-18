# Moura Aluguéis — Sistema de gestão

Sistema da locadora de motos: cadastro de motos e clientes (motoristas), aluguéis com parcelas
geradas automaticamente, cobrança pelo WhatsApp, manutenção e financeiro.

- **Demonstração:** abra `index.html` direto no navegador. Os dados são fictícios e ficam salvos só no navegador.
- **Online (uso real):** o mesmo `index.html` servido pelo `servidor/` entra no modo online, com login e dados guardados no servidor. Veja `Manuais/Como colocar online.md`.

## O que o sistema faz
- **Painel:** motos alugadas, total em atraso, o que entra nos próximos 7 dias, recebido no mês, lista "Cobrar agora", manutenções próximas e CNHs vencendo.
- **Cobranças:** todas as parcelas; botão **WhatsApp** com mensagem pronta (uma para parcela *a vencer*, outra para *vencida*), botão **Receber**, recibo e registro de quem já foi avisado no dia.
- **Aluguéis:** liga cliente + moto; parcela semanal, quinzenal, mensal ou diária, com ou sem quantidade fixa; caução e KM de retirada/devolução. As parcelas são criadas sozinhas (até 35 dias à frente).
- **Motos:** placa, modelo, KM, situação (Alugada, Disponível, Manutenção, Inativa, Vendida) e histórico de aluguéis e manutenções.
- **Clientes:** dados pessoais, celular/WhatsApp, CNH com validade (avisa 30 dias antes) e contato de referência.
- **Manutenção:** serviços, custo, oficina e a próxima por KM ou data (avisa 300 km ou 7 dias antes).
- **Financeiro** (só administrador): parcelas recebidas e manutenções entram sozinhas; IPVA, seguro, rastreador etc. entram como lançamento. Mostra o resultado do mês e por moto.
- **Configurações** (só administrador): nome da empresa, chave Pix, dias de aviso, multa e juros por atraso e os textos das mensagens.
- **Pix com baixa automática** (preparado, desligado): cada parcela ganha um Pix copia e cola no Asaas e fica paga sozinha quando o motorista paga. Veja `Manuais/Pix automático (Asaas).md`.
- **WhatsApp automático** (preparado, desligado): envio diário das cobranças pela API oficial da Meta, com modo teste, prévia e histórico. Para ligar, veja `Manuais/WhatsApp automático.md`.
- **Acessos** (online): administrador vê tudo; equipe não vê financeiro, configurações nem acessos.

## Como está organizado
- `index.html` — a tela do sistema (demonstração e online).
- `servidor/asaas.js` — Pix com baixa automática pelo Asaas (só funciona depois de configurado).
- `servidor/whatsapp.js` — envio automático de cobranças pelo WhatsApp (só funciona depois de configurado).
- `servidor/server.js` — servidor em Node.js (22.13+), sem dependências, banco SQLite em `servidor/dados/`, senha criptografada, bloqueio após 5 tentativas erradas e backup diário (30 dias).
- `servidor/deploy/instalar.sh` — instala/atualiza num Ubuntu (serviço `mouraalugueis`, Caddy com HTTPS automático, porta própria; convive com outros sistemas no mesmo servidor).
- `.github/workflows/` — publicar no servidor e trazer os backups, pela aba **Actions**.
- `assets/` — ícones do app.

Para rodar no próprio computador: `cd servidor && npm start` e abra http://localhost:3300 (usuário `admin`, senha `moura123`).
