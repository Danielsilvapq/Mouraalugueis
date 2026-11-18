#!/bin/bash
# Envia o Moura Aluguéis para o servidor na nuvem e instala/atualiza.
# Use na primeira vez e sempre que o sistema for atualizado — os dados do servidor não são apagados.
cd "$(dirname "$0")" || exit 1
CONFIG=".servidor"
[ -f "$CONFIG" ] && source "$CONFIG"
IP="${IP:-}"
USUARIO="${USUARIO:-ubuntu}"

echo "=== Publicar o Moura Aluguéis na nuvem ==="
echo "(Só aperte Enter para usar o que está entre colchetes.)"
read -r -p "IP do servidor [$IP]: " NOVO_IP
IP="${NOVO_IP:-$IP}"
[ -z "$IP" ] && { echo "Informe o IP do servidor."; read -r -p "Enter para fechar."; exit 1; }

read -r -p "Usuário [$USUARIO]: " NOVO_USU
USUARIO="${NOVO_USU:-$USUARIO}"

echo "Chave SSH do servidor. Dica: arraste o arquivo .key para esta janela."
read -r -p "Chave [${CHAVE:-}]: " NOVA_CHAVE
NOVA_CHAVE="${NOVA_CHAVE%"${NOVA_CHAVE##*[![:space:]]}"}"   # tira espaço do fim (ao arrastar)
NOVA_CHAVE="${NOVA_CHAVE//\\ / }"                           # "\ " -> " "
CHAVE="${NOVA_CHAVE:-${CHAVE:-}}"
CHAVE="${CHAVE/#\~/$HOME}"
if [ -n "$CHAVE" ]; then
  [ -f "$CHAVE" ] || { echo "Não encontrei a chave: $CHAVE"; read -r -p "Enter para fechar."; exit 1; }
  FIXA="$HOME/.ssh/servidor-sistemas.key"   # caminho sem espaços (o rsync exige)
  if [ "$CHAVE" != "$FIXA" ]; then
    mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
    cp "$CHAVE" "$FIXA" || exit 1
    CHAVE="$FIXA"
  fi
  chmod 600 "$CHAVE"
fi

PADRAO_DOM="${DOMINIO:-mouraalugueis.$IP.sslip.io}"
echo "Endereço do sistema. Com domínio próprio, digite-o (ex.: sistema.mouraalugueis.com.br)."
read -r -p "Domínio [$PADRAO_DOM]: " NOVO_DOM
DOMINIO="${NOVO_DOM:-$PADRAO_DOM}"
printf 'IP=%q\nUSUARIO=%q\nCHAVE=%q\nDOMINIO=%q\n' "$IP" "$USUARIO" "$CHAVE" "$DOMINIO" > "$CONFIG"

SOCK="/tmp/mouraalugueis-ssh-$$"
SSH=(ssh -o ControlMaster=auto -o ControlPath="$SOCK" -o ControlPersist=120 -o StrictHostKeyChecking=accept-new)
[ -n "$CHAVE" ] && SSH+=(-i "$CHAVE")
SUDO=""; [ "$USUARIO" != "root" ] && SUDO="sudo"
DESTINO="$USUARIO@$IP"

"${SSH[@]}" "$DESTINO" "$SUDO mkdir -p /opt/mouraalugueis && command -v rsync >/dev/null || ($SUDO apt-get update -qq && $SUDO apt-get install -y -qq rsync)" \
  || { echo "Não consegui conectar em $DESTINO"; read -r -p "Enter para fechar."; exit 1; }

echo "==> Enviando arquivos"
printf -v SSH_CMD '%q ' "${SSH[@]}"
rsync -az --delete -e "$SSH_CMD" ${SUDO:+--rsync-path="sudo rsync"} \
  --exclude 'servidor/dados' --exclude node_modules --exclude .DS_Store --exclude .git --exclude .servidor \
  --exclude '*.command' --exclude 'Manuais' --exclude 'Backups da nuvem' \
  ./ "$DESTINO:/opt/mouraalugueis/" || { read -r -p "Enter para fechar."; exit 1; }

echo "==> Instalando no servidor (a primeira vez leva alguns minutos)"
"${SSH[@]}" "$DESTINO" "$SUDO bash /opt/mouraalugueis/servidor/deploy/instalar.sh '$DOMINIO'" || { read -r -p "Enter para fechar."; exit 1; }
"${SSH[@]}" -O exit "$DESTINO" 2>/dev/null

open "https://$DOMINIO"
read -r -p "Pressione Enter para fechar."
