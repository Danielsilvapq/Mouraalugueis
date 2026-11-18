// Moura Aluguéis — Pix com baixa automática pelo Asaas (https://docs.asaas.com).
//
// Fica DESLIGADO até duas coisas acontecerem:
//   1. o servidor receber ASAAS_API_KEY e ASAAS_WEBHOOK_TOKEN (secrets do GitHub, veja Manuais/Pix automático (Asaas).md);
//   2. o administrador ligar em Configurações → Pix com baixa automática.
//
// Como funciona:
//   - Para cada parcela em aberto que vence nos próximos N dias (ou já venceu), cria no Asaas uma cobrança Pix
//     só dela. O "Pix copia e cola" e o link de pagamento ficam gravados na parcela e vão nas mensagens.
//   - Quando o motorista paga, o Asaas chama /api/asaas/webhook e a parcela fica paga sozinha.
//     Se o aviso do Asaas se perder, o sistema também confere as cobranças de tempos em tempos.
//   - Parcela recebida à mão (dinheiro, chave Pix antiga), aluguel encerrado ou parcela apagada:
//     a cobrança no Asaas é cancelada, para o motorista não pagar duas vezes.

const crypto = require('node:crypto');

const API_KEY = process.env.ASAAS_API_KEY || '';
const WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN || '';
const AMBIENTE = process.env.ASAAS_AMBIENTE === 'sandbox' ? 'sandbox' : 'producao';
const API_BASE = process.env.ASAAS_API_BASE // trocado só em testes
  || (AMBIENTE === 'sandbox' ? 'https://api-sandbox.asaas.com/v3' : 'https://api.asaas.com/v3');
const configurado = () => !!(API_KEY && WEBHOOK_TOKEN);

const PIX_PADRAO = { id: 'pix', ativo: false, dias: 5, encargos: true };
const PAGO = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];
const FORMA = 'Pix (Asaas)';

module.exports = function iniciarAsaas({ db, rota, transacao, fmtData }) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS asaas_cobrancas (
    payment_id TEXT PRIMARY KEY,
    parcela_id TEXT NOT NULL,
    valor REAL,
    venc TEXT,
    status TEXT NOT NULL,
    criado_em TEXT DEFAULT (datetime('now','localtime')),
    verificado_em TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_asaas_parcela ON asaas_cobrancas(parcela_id);
  CREATE TABLE IF NOT EXISTS asaas_eventos (
    id INTEGER PRIMARY KEY,
    tipo TEXT NOT NULL,
    parcela_id TEXT,
    cliente TEXT,
    valor REAL,
    detalhe TEXT,
    criado_em TEXT DEFAULT (datetime('now','localtime'))
  );
  `);

  // ---------- utilidades ----------
  const hoje = () => fmtData(new Date());
  const addDias = (s, n) => { const [y, m, d] = s.split('-').map(Number); return fmtData(new Date(y, m - 1, d + n)); };
  const difDias = (a, b) => { const p = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }; return Math.round((p(b) - p(a)) / 864e5); };
  const num = (v) => Number(v) || 0;
  const r2 = (v) => Math.round(v * 100) / 100;
  const digitos = (s) => String(s || '').replace(/\D/g, '');

  function colecao(c) {
    const m = new Map();
    for (const l of db.prepare('SELECT id, dados FROM registros WHERE colecao = ? AND apagado = 0').all(c)) m.set(l.id, JSON.parse(l.dados));
    return m;
  }
  function config() {
    const cfg = colecao('config');
    return { geral: cfg.get('geral') || {}, pix: { ...PIX_PADRAO, ...(cfg.get('pix') || {}) } };
  }
  // altera um registro guardado e avisa as telas abertas (versão nova)
  function alterar(c, id, fn) {
    return transacao(() => {
      const l = db.prepare('SELECT dados FROM registros WHERE colecao = ? AND id = ? AND apagado = 0').get(c, id);
      if (!l) return null;
      const d = JSON.parse(l.dados);
      if (fn(d) === false) return d;
      const v = db.prepare('SELECT COALESCE(MAX(versao), 0) v FROM registros').get().v + 1;
      db.prepare("UPDATE registros SET dados = ?, versao = ?, usuario_id = NULL, atualizado_em = datetime('now','localtime') WHERE colecao = ? AND id = ?")
        .run(JSON.stringify(d), v, c, id);
      return d;
    });
  }
  const evento = db.prepare('INSERT INTO asaas_eventos (tipo, parcela_id, cliente, valor, detalhe) VALUES (?, ?, ?, ?, ?)');
  const nomeCliente = (pid) => {
    const p = colecao('parcelas').get(pid), k = p && colecao('contratos').get(p.contratoId), c = k && colecao('clientes').get(k.clienteId);
    return c ? c.nome : '';
  };

  async function api(metodo, caminho, corpo) {
    const r = await fetch(API_BASE + caminho, {
      method: metodo,
      headers: { access_token: API_KEY, 'Content-Type': 'application/json', 'User-Agent': 'mouraalugueis' },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.errors && j.errors.map((e) => e.description).join('; ')) || `HTTP ${r.status}`);
    return j;
  }

  // ---------- baixa ----------
  // marca a parcela como paga pelo Asaas (vale para o aviso do webhook e para a conferência)
  function darBaixa(pid, pay) {
    let duplicado = false;
    const d = alterar('parcelas', pid, (p) => {
      if (p.pago) { duplicado = p.forma !== FORMA; return false; }
      Object.assign(p, {
        pago: true, dataPg: String(pay.clientPaymentDate || pay.paymentDate || hoje()).slice(0, 10),
        valorPago: num(pay.value), forma: FORMA, baixaAuto: true, obsPg: 'Baixa automática pelo Asaas',
      });
      p.asaas = { ...(p.asaas || {}), status: pay.status };
    });
    db.prepare('UPDATE asaas_cobrancas SET status = ? WHERE payment_id = ?').run(pay.status, pay.id);
    if (!d) { evento.run('alerta', pid, '', num(pay.value), `Pagamento recebido (${pay.id}), mas a parcela não existe mais. Confira no Asaas.`); return; }
    if (duplicado) { evento.run('alerta', pid, nomeCliente(pid), num(pay.value), 'Pago no Asaas, mas a parcela já tinha sido recebida à mão. Pode ter sido pago duas vezes.'); return; }
    evento.run('baixa', pid, nomeCliente(pid), num(pay.value), `Pix recebido em ${String(pay.clientPaymentDate || pay.paymentDate || hoje()).slice(0, 10)}`);
  }

  // ---------- rotina: criar, atualizar, cancelar e conferir cobranças ----------
  const falhas = new Map(); // parcela -> momento da última falha (tenta de novo depois de 1 h)
  let rodando = false;
  async function sincronizar(forcar) {
    if (rodando || !configurado()) return { erro: !configurado() ? 'Asaas ainda não configurado no servidor' : 'Já está rodando' };
    const { geral, pix } = config();
    if (!pix.ativo) return { erro: 'Pix automático desligado' };
    rodando = true;
    const res = { criadas: 0, atualizadas: 0, canceladas: 0, baixas: 0, erros: 0 };
    try {
      const t = hoje(), lim = addDias(t, Math.max(0, num(pix.dias)));
      const parcelas = colecao('parcelas'), contratos = colecao('contratos'), clientes = colecao('clientes'), motos = colecao('motos');
      const abertas = db.prepare("SELECT * FROM asaas_cobrancas WHERE status IN ('PENDING','OVERDUE')").all();

      // 1) cancela cobranças que não devem mais ser pagas
      for (const cb of abertas) {
        const p = parcelas.get(cb.parcela_id), k = p && contratos.get(p.contratoId);
        const motivo = !p ? 'parcela apagada' : p.pago && p.forma !== FORMA ? 'parcela recebida à mão'
          : k && k.status !== 'Ativo' && p.venc > (k.fim || t) ? 'aluguel encerrado' : '';
        if (!motivo) continue;
        try {
          // antes de cancelar, confere se já não foi paga
          const pay = await api('GET', `/payments/${cb.payment_id}`);
          if (PAGO.includes(pay.status)) { darBaixa(cb.parcela_id, pay); res.baixas++; continue; }
          await api('DELETE', `/payments/${cb.payment_id}`);
          db.prepare("UPDATE asaas_cobrancas SET status = 'DELETED' WHERE payment_id = ?").run(cb.payment_id);
          if (p) alterar('parcelas', p.id, (x) => { delete x.asaas; });
          evento.run('cancelada', cb.parcela_id, p ? nomeCliente(p.id) : '', cb.valor, `Cobrança cancelada no Asaas: ${motivo}`);
          res.canceladas++;
        } catch (e) { evento.run('erro', cb.parcela_id, '', cb.valor, 'Cancelar: ' + e.message); res.erros++; }
      }

      // 2) cria ou atualiza a cobrança de cada parcela em aberto
      for (const p of parcelas.values()) {
        if (p.pago || p.venc > lim) continue;
        const k = contratos.get(p.contratoId); if (!k || k.status !== 'Ativo') continue;
        const c = clientes.get(k.clienteId); if (!c) continue;
        if (falhas.has(p.id) && Date.now() - falhas.get(p.id) < 3600e3) continue;
        const m = motos.get(k.motoId) || {};
        const atraso = Math.max(0, difDias(p.venc, t));
        // vencida antes de existir cobrança: o Asaas não aceita vencimento no passado, então vence hoje com os encargos já somados
        const enc = atraso && pix.encargos ? r2(p.valor * num(geral.multa) / 100 + p.valor * num(geral.juros) / 100 * atraso) : 0;
        const valor = r2(p.valor + enc), venc = p.venc < t ? t : p.venc;
        try {
          if (!p.asaas || !p.asaas.id) {
            const cpf = digitos(c.cpf);
            if (cpf.length !== 11 && cpf.length !== 14) throw new Error(`${c.nome}: falta o CPF no cadastro (o Asaas exige)`);
            let cid = c.asaasId;
            if (!cid) {
              const achou = await api('GET', `/customers?cpfCnpj=${cpf}`);
              cid = achou.data && achou.data[0] ? achou.data[0].id
                : (await api('POST', '/customers', { name: c.nome, cpfCnpj: cpf, mobilePhone: digitos(c.fone), email: c.email || undefined, externalReference: c.id, notificationDisabled: true })).id;
              alterar('clientes', c.id, (x) => { x.asaasId = cid; });
              c.asaasId = cid;
            }
            const corpo = {
              customer: cid, billingType: 'PIX', value: valor, dueDate: venc, externalReference: p.id,
              description: `Parcela ${k.qtd ? `${p.n}/${k.qtd}` : 'nº ' + p.n} do aluguel da moto ${[m.marca, m.modelo].filter(Boolean).join(' ')} ${m.placa || ''}`.trim(),
            };
            if (pix.encargos && !atraso) {
              if (num(geral.multa)) corpo.fine = { value: num(geral.multa) };
              if (num(geral.juros)) corpo.interest = { value: r2(num(geral.juros) * 30) }; // Asaas usa juros ao mês
            }
            const pay = await api('POST', '/payments', corpo);
            const qr = await api('GET', `/payments/${pay.id}/pixQrCode`);
            db.prepare('INSERT OR REPLACE INTO asaas_cobrancas (payment_id, parcela_id, valor, venc, status) VALUES (?, ?, ?, ?, ?)').run(pay.id, p.id, valor, venc, pay.status);
            alterar('parcelas', p.id, (x) => { x.asaas = { id: pay.id, url: pay.invoiceUrl, pix: qr.payload, valor, venc, status: pay.status, qrEm: t }; });
            evento.run('criada', p.id, c.nome, valor, `Cobrança Pix criada (vence ${venc.split('-').reverse().join('/')})`);
            res.criadas++;
          } else if (p.asaas.valor !== valor && p.venc >= t && PAGO.indexOf(p.asaas.status) < 0) {
            // valor da parcela mudou (ex.: aluguel editado): atualiza a cobrança
            await api('PUT', `/payments/${p.asaas.id}`, { value: valor, dueDate: venc });
            const qr = await api('GET', `/payments/${p.asaas.id}/pixQrCode`);
            db.prepare('UPDATE asaas_cobrancas SET valor = ?, venc = ? WHERE payment_id = ?').run(valor, venc, p.asaas.id);
            alterar('parcelas', p.id, (x) => { x.asaas = { ...x.asaas, valor, venc, pix: qr.payload, qrEm: t }; });
            res.atualizadas++;
          } else if (p.venc <= t && p.asaas.qrEm !== t) {
            // vencendo ou vencida: renova o copia e cola uma vez por dia (o Asaas recalcula juros e multa)
            const qr = await api('GET', `/payments/${p.asaas.id}/pixQrCode`);
            alterar('parcelas', p.id, (x) => { x.asaas = { ...x.asaas, pix: qr.payload, qrEm: t }; });
          }
          falhas.delete(p.id);
        } catch (e) {
          falhas.set(p.id, Date.now());
          evento.run('erro', p.id, c.nome, valor, e.message.slice(0, 300));
          res.erros++;
        }
      }

      // 3) confere as cobranças em aberto (caso algum aviso do Asaas tenha se perdido); no botão, confere todas na hora
      const conferir = db.prepare(`SELECT * FROM asaas_cobrancas WHERE status IN ('PENDING','OVERDUE')
        AND (? OR verificado_em IS NULL OR verificado_em < datetime('now','localtime','-30 minutes')) AND venc <= ? LIMIT 50`).all(forcar ? 1 : 0, addDias(t, 1));
      for (const cb of conferir) {
        try {
          const pay = await api('GET', `/payments/${cb.payment_id}`);
          db.prepare("UPDATE asaas_cobrancas SET status = ?, verificado_em = datetime('now','localtime') WHERE payment_id = ?").run(pay.status, cb.payment_id);
          if (PAGO.includes(pay.status)) { darBaixa(cb.parcela_id, pay); res.baixas++; }
        } catch (e) { res.erros++; }
      }
      return res;
    } finally { rodando = false; }
  }

  setInterval(() => { sincronizar().catch((e) => console.error('Asaas:', e.message)); }, 5 * 60e3).unref();
  setTimeout(() => { sincronizar().catch((e) => console.error('Asaas:', e.message)); }, 15e3).unref();

  // ---------- rotas ----------
  // Aviso do Asaas. Sempre responde 200 depois de conferir a senha: se o Asaas recebe erros seguidos, ele pausa os avisos.
  rota('POST', '/api/asaas/webhook', ({ req, body }) => {
    const recebido = Buffer.from(String(req.headers['asaas-access-token'] || ''));
    const esperado = Buffer.from(WEBHOOK_TOKEN);
    if (!WEBHOOK_TOKEN || recebido.length !== esperado.length || !crypto.timingSafeEqual(recebido, esperado)) {
      const e = new Error('Não autorizado'); e.status = 401; throw e;
    }
    try {
      const pay = body && body.payment;
      if (!pay || !pay.id) return { ok: true };
      const cb = db.prepare('SELECT * FROM asaas_cobrancas WHERE payment_id = ?').get(String(pay.id));
      if (!cb) return { ok: true }; // cobrança que não foi criada por este sistema
      if (['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(body.event)) darBaixa(cb.parcela_id, pay);
      else if (body.event === 'PAYMENT_REFUNDED') {
        db.prepare("UPDATE asaas_cobrancas SET status = 'REFUNDED' WHERE payment_id = ?").run(cb.payment_id);
        evento.run('alerta', cb.parcela_id, nomeCliente(cb.parcela_id), num(pay.value), 'Pagamento estornado no Asaas. A parcela continua como paga: confira e desfaça o pagamento se for o caso.');
      } else if (body.event === 'PAYMENT_DELETED') {
        db.prepare("UPDATE asaas_cobrancas SET status = 'DELETED' WHERE payment_id = ?").run(cb.payment_id);
      }
    } catch (e) { console.error('Asaas webhook:', e.message); }
    return { ok: true };
  }, { publica: true });

  rota('GET', '/api/asaas/status', () => ({
    configurado: configurado(), ambiente: AMBIENTE,
    abertas: db.prepare("SELECT COUNT(*) n FROM asaas_cobrancas WHERE status IN ('PENDING','OVERDUE')").get().n,
    eventos: db.prepare('SELECT tipo, cliente, valor, detalhe, criado_em FROM asaas_eventos ORDER BY id DESC LIMIT 50').all(),
  }), { admin: true });
  rota('POST', '/api/asaas/sincronizar', () => sincronizar(true), { admin: true });
};
