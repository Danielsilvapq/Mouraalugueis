// Moura Aluguéis — envio automático de cobranças pelo WhatsApp (API oficial da Meta, "Cloud API").
//
// Fica DESLIGADO até duas coisas acontecerem:
//   1. o servidor receber WHATSAPP_TOKEN e WHATSAPP_PHONE_ID (secrets do GitHub, veja Manuais/WhatsApp automático.md);
//   2. o administrador ligar em Configurações → WhatsApp automático.
// Sem isso, nada é enviado. A prévia ("quem receberia hoje") funciona mesmo sem token.
//
// Uma vez por dia, no horário escolhido, manda os avisos das parcelas:
//   - a vencer: uma vez, quando faltarem até N dias (N = "Avisar quantos dias antes" nas Configurações);
//   - vence hoje: uma vez, no dia do vencimento;
//   - vencida: repete a cada X dias, até Y dias de atraso.
// Cada aviso fica gravado na parcela (aparece na tela) e na tabela wa_envios (histórico).

const TOKEN = process.env.WHATSAPP_TOKEN || '';
const PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const API_VERSAO = process.env.WHATSAPP_API_VERSION || 'v23.0';
const API_BASE = process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com'; // trocado só em testes
const configurado = () => !!(TOKEN && PHONE_ID);

const AUTO_PADRAO = {
  id: 'auto', ativo: false, hora: '09:00', avencer: true, hoje: true, vencidas: true,
  intervalo: 2, maxAtraso: 30, teste: true, foneTeste: '', idioma: 'pt_BR',
  modelos: { avencer: 'parcela_a_vencer', hoje: 'parcela_vence_hoje', vencida: 'parcela_vencida' },
};

module.exports = function iniciarWhatsapp({ db, rota, transacao, fmtData }) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS wa_envios (
    id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    parcela_id TEXT,
    cliente TEXT,
    fone TEXT,
    tipo TEXT,
    status TEXT NOT NULL,
    erro TEXT,
    wamid TEXT,
    criado_em TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS wa_estado (chave TEXT PRIMARY KEY, valor TEXT);
  `);

  // ---------- leitura dos dados ----------
  const p2 = (n) => String(n).padStart(2, '0');
  const hoje = () => fmtData(new Date());
  const dt = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
  const difDias = (a, b) => Math.round((dt(b) - dt(a)) / 864e5);
  const fdate = (s) => { const [y, m, d] = String(s).split('-'); return `${d}/${m}/${y}`; };
  const brl = (n) => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const num = (v) => Number(v) || 0;
  const foneWa = (s) => { let d = String(s || '').replace(/\D/g, '').replace(/^0+/, ''); if (d.length === 10 || d.length === 11) d = '55' + d; return d.length >= 12 ? d : ''; };

  function colecao(c) {
    const m = new Map();
    for (const l of db.prepare('SELECT id, dados FROM registros WHERE colecao = ? AND apagado = 0').all(c)) m.set(l.id, JSON.parse(l.dados));
    return m;
  }
  function config() {
    const cfg = colecao('config');
    const auto = { ...AUTO_PADRAO, ...(cfg.get('auto') || {}) };
    auto.modelos = { ...AUTO_PADRAO.modelos, ...(auto.modelos || {}) };
    return { geral: cfg.get('geral') || {}, auto };
  }
  const getEstado = (k) => (db.prepare('SELECT valor FROM wa_estado WHERE chave = ?').get(k) || {}).valor || '';
  const setEstado = (k, v) => db.prepare('INSERT INTO wa_estado (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor').run(k, v);

  // Quem recebe hoje e qual mensagem. Mesmas regras da tela (situação da parcela, multa e juros).
  function fila() {
    const { geral, auto } = config();
    const t = hoje(), diasAviso = num(geral.diasAviso ?? 2);
    const contratos = colecao('contratos'), clientes = colecao('clientes'), motos = colecao('motos');
    const out = [];
    for (const p of colecao('parcelas').values()) {
      if (p.pago) continue;
      const k = contratos.get(p.contratoId); if (!k) continue;
      const c = clientes.get(k.clienteId); if (!c || c.ativo === false || c.semAuto) continue;
      const m = motos.get(k.motoId) || {};
      const d = difDias(t, p.venc), avisos = p.avisos || [];
      if (avisos.some((a) => a.data === t)) continue; // alguém já avisou hoje (manual ou automático)
      const autos = (tp) => avisos.filter((a) => a.auto && a.tipo === tp);
      let tipo = null;
      if (d > 0 && d <= diasAviso && auto.avencer && !autos('avencer').length && k.status === 'Ativo') tipo = 'avencer';
      else if (d === 0 && auto.hoje && !autos('hoje').length && k.status === 'Ativo') tipo = 'hoje';
      else if (d < 0 && auto.vencidas && -d <= num(auto.maxAtraso)) {
        const ult = autos('vencida').map((a) => a.data).sort().pop();
        if (!ult || difDias(ult, t) >= Math.max(1, num(auto.intervalo))) tipo = 'vencida';
      }
      if (!tipo) continue;
      const atraso = Math.max(0, -d);
      const enc = atraso ? Math.round((p.valor * num(geral.multa) / 100 + p.valor * num(geral.juros) / 100 * atraso) * 100) / 100 : 0;
      const parc = k.qtd ? `${p.n}/${k.qtd}` : `nº ${p.n}`;
      const motoTx = `${[m.marca, m.modelo].filter(Boolean).join(' ')} (${m.placa || ''})`;
      const nome = String(c.nome || '').split(' ')[0];
      // Variáveis na ordem dos modelos aprovados na Meta (veja o manual): {{1}}, {{2}}...
      const params = tipo === 'avencer' ? [nome, parc, motoTx, brl(p.valor + enc), fdate(p.venc)]
        : tipo === 'hoje' ? [nome, parc, motoTx, brl(p.valor + enc)]
        : [nome, parc, motoTx, brl(p.valor + enc), fdate(p.venc), `${atraso} dia${atraso === 1 ? '' : 's'}`];
      out.push({ parcelaId: p.id, cliente: c.nome, fone: foneWa(c.fone), tipo, venc: p.venc, valor: p.valor + enc, params });
    }
    return out.sort((a, b) => a.venc.localeCompare(b.venc));
  }

  // ---------- envio ----------
  async function enviarModelo(fone, modelo, idioma, params) {
    const r = await fetch(`${API_BASE}/${API_VERSAO}/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: fone, type: 'template',
        template: { name: modelo, language: { code: idioma }, components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: String(text) })) }] },
      }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && (j.error.error_user_msg || j.error.message)) || `HTTP ${r.status}`);
    return (j.messages && j.messages[0] && j.messages[0].id) || '';
  }

  const registrar = db.prepare('INSERT INTO wa_envios (data, parcela_id, cliente, fone, tipo, status, erro, wamid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  // marca o aviso na parcela (a tela mostra "avisado hoje" e não repete)
  function marcarParcela(pid, tipo) {
    transacao(() => {
      const l = db.prepare("SELECT dados FROM registros WHERE colecao = 'parcelas' AND id = ? AND apagado = 0").get(pid);
      if (!l) return;
      const d = JSON.parse(l.dados);
      d.avisos = [...(d.avisos || []), { data: hoje(), tipo, auto: true }];
      const v = db.prepare('SELECT COALESCE(MAX(versao), 0) v FROM registros').get().v + 1;
      db.prepare("UPDATE registros SET dados = ?, versao = ?, usuario_id = NULL, atualizado_em = datetime('now','localtime') WHERE colecao = 'parcelas' AND id = ?")
        .run(JSON.stringify(d), v, pid);
    });
  }

  let rodando = false;
  async function rodar(motivo) {
    if (rodando) return { erro: 'Já está enviando' };
    const { auto } = config();
    if (!configurado()) return { erro: 'WhatsApp ainda não configurado no servidor' };
    rodando = true;
    const res = { enviados: 0, erros: 0, teste: !!auto.teste };
    try {
      let itens = fila();
      const foneTeste = foneWa(auto.foneTeste);
      if (auto.teste) {
        if (!foneTeste) return { erro: 'Modo teste ligado, mas falta o celular de teste' };
        itens = itens.slice(0, 3); // no teste vão no máximo 3 mensagens, todas para o seu número
      }
      for (const it of itens) {
        const destino = auto.teste ? foneTeste : it.fone;
        if (!destino) { registrar.run(hoje(), it.parcelaId, it.cliente, '', it.tipo, 'erro', 'Celular inválido no cadastro', ''); res.erros++; continue; }
        try {
          const wamid = await enviarModelo(destino, auto.modelos[it.tipo], auto.idioma, it.params);
          registrar.run(hoje(), it.parcelaId, it.cliente, destino, it.tipo, auto.teste ? 'teste' : 'enviado', '', wamid);
          if (!auto.teste) marcarParcela(it.parcelaId, it.tipo);
          res.enviados++;
        } catch (e) {
          registrar.run(hoje(), it.parcelaId, it.cliente, destino, it.tipo, 'erro', String(e.message).slice(0, 300), '');
          res.erros++;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      setEstado('ultima', `${new Date().toISOString()}|${motivo}|${res.enviados}|${res.erros}`);
      console.log(`WhatsApp (${motivo}): ${res.enviados} enviada(s), ${res.erros} erro(s)${auto.teste ? ' — modo teste' : ''}`);
      return res;
    } finally { rodando = false; }
  }

  // confere a cada minuto se chegou a hora do envio do dia
  setInterval(() => {
    try {
      const { auto } = config();
      if (!auto.ativo || !configurado()) return;
      const agora = new Date(), hhmm = `${p2(agora.getHours())}:${p2(agora.getMinutes())}`;
      if (hhmm < String(auto.hora || '09:00') || getEstado('dia') === hoje()) return;
      setEstado('dia', hoje());
      rodar('automático').catch((e) => console.error('WhatsApp:', e.message));
    } catch (e) { console.error('WhatsApp:', e.message); }
  }, 60e3).unref();

  // ---------- rotas (só administrador) ----------
  rota('GET', '/api/whatsapp/status', () => {
    const [quando, motivo, enviados, erros] = (getEstado('ultima') || '').split('|');
    return {
      configurado: configurado(),
      ultima: quando ? { quando, motivo, enviados: Number(enviados), erros: Number(erros) } : null,
      envios: db.prepare('SELECT data, cliente, fone, tipo, status, erro, criado_em FROM wa_envios ORDER BY id DESC LIMIT 50').all(),
    };
  }, { admin: true });
  rota('GET', '/api/whatsapp/previa', () => fila().map(({ params, ...x }) => x), { admin: true });
  rota('POST', '/api/whatsapp/enviar-agora', () => rodar('manual'), { admin: true });
};
module.exports.AUTO_PADRAO = AUTO_PADRAO;
