#!/bin/bash
# Baixa para este computador os backups diários que o servidor faz sozinho.
cd "$(dirname "$0")" || exit 1
[ -f .servidor ] && source .servidor
IP="${IP:-}"
USUARIO="${USUARIO:-ubuntu}"
SSH=(ssh -o StrictHostKeyChecking=accept-new)
[ -n "${CHAVE:-}" ] && SSH+=(-i "$CHAVE")
printf -v SSH_CMD '%q ' "${SSH[@]}"
SUDO=""; [ "$USUARIO" != "root" ] && SUDO="sudo"
DESTINO="Backups da nuvem"
mkdir -p "$DESTINO"
rsync -az -e "$SSH_CMD" ${SUDO:+--rsync-path="sudo rsync"} "$USUARIO@$IP:/opt/mouraalugueis/servidor/dados/backups/" "$DESTINO/" \
  && echo "Backups salvos em: $(pwd)/$DESTINO" && open "$DESTINO"
read -r -p "Pressione Enter para fechar."
