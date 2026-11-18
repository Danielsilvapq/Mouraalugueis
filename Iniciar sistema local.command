#!/bin/bash
# Clique duas vezes neste arquivo para abrir o sistema neste computador (separado do online).
cd "$(dirname "$0")/servidor" || exit 1
(sleep 1.5 && open "http://localhost:3300") &
node --no-warnings server.js
