# Colocar a Moura Aluguéis online

O sistema pode rodar no mesmo servidor da Oracle que já usa o Beach Sports 092 (ou em outro).
Ele fica separado dos outros: porta, serviço (`mouraalugueis`), banco de dados e endereço próprios.
Publicar a Moura **não tira os outros sistemas do ar**.

## 1. Cadastrar o servidor neste repositório (uma vez só)
No GitHub, abra o repositório **Mouraalugueis** → **Settings** → **Secrets and variables** → **Actions**:

1. Aba **Secrets** → **New repository secret**
   - Nome: `ORACLE_SSH_KEY`
   - Valor: o conteúdo inteiro da chave privada do servidor (a mesma usada no Beach Sports).
2. Aba **Variables** → **New repository variable**
   - Nome: `SERVIDOR_IP` — Valor: o IP do servidor.
   - (Opcional) `SERVIDOR_USUARIO` — só se o usuário não for `ubuntu`.

## 2. Publicar
1. Aba **Actions** → **Publicar no servidor** → **Run workflow**.
2. Deixe o domínio **vazio** para usar o endereço grátis `https://mouraalugueis.IP-DO-SERVIDOR.sslip.io`,
   ou digite um domínio próprio (antes, crie no painel do domínio um registro **A** apontando para o IP).
3. Na **primeira** publicação, abra o passo **Instalar no servidor**: ali aparecem o usuário `admin` e a senha inicial.
   Entre no sistema e troque a senha em **Minha senha**.

Para atualizar depois, é só rodar **Publicar no servidor** de novo. Os dados nunca são apagados.

## Backups
O servidor faz um backup por dia (guarda 30 dias). Toda segunda-feira o GitHub traz uma cópia:
**Actions → Backup do servidor →** execução mais recente **→ Artifacts → mouraalugueis-backups**.

## Pelo Mac (opcional)
Também dá para publicar com `Publicar na nuvem.command` e baixar backups com `Baixar backup da nuvem.command`.

## Se der problema
```
ssh -i SUA-CHAVE ubuntu@IP-DO-SERVIDOR
sudo journalctl -u mouraalugueis -n 50     # ver erros
sudo systemctl restart mouraalugueis       # reiniciar
```
