// Moura Aluguéis — servidor sem dependências externas (Node 22.13+ com node:sqlite)
// Guarda os dados de todos os usuários num banco SQLite e serve o sistema (index.html).
// Os dados ficam como "registros" (um por moto, cliente, parcela...) para que duas pessoas
// usando ao mesmo tempo não apaguem o trabalho uma da outra.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3300;
const HOST = process.env.HOST || undefined;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const RAIZ = process.env.RAIZ || path.join(__dirname, '..');           // pasta com index.html e assets/
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'dados', 'mouraalugueis.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), 'backups');
const BACKUP_DIAS = Number(process.env.BACKUP_DIAS) || 30;
const SESSAO_DIAS = 30;

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL DEFAULT 'equipe',
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sessoes (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_em TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS registros (
  colecao TEXT NOT NULL,
  id TEXT NOT NULL,
  dados TEXT NOT NULL,
  versao INTEGER NOT NULL,
  apagado INTEGER NOT NULL DEFAULT 0,
  usuario_id INTEGER,
  atualizado_em TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (colecao, id)
);
CREATE INDEX IF NOT EXISTS idx_registros_versao ON registros(versao);
`);

// ---------- utilidades ----------
class Erro extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const p2 = (n) => String(n).padStart(2, '0');
const fmtData = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(senha, salt, 64).toString('hex');
}
function confereSenha(senha, guardado) {
  const [salt, hash] = String(guardado).split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(String(senha), salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function transacao(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function validaSenha(s) {
  if (typeof s !== 'string' || s.length < 6) throw new Erro(400, 'A senha precisa ter pelo menos 6 caracteres');
  return s;
}

// primeiro acesso: cria o administrador com a senha gerada pelo instalador
if (!db.prepare('SELECT COUNT(*) n FROM usuarios').get().n) {
  const senha = process.env.ADMIN_SENHA_INICIAL || 'moura123';
  db.prepare('INSERT INTO usuarios (nome, login, senha_hash, perfil) VALUES (?, ?, ?, ?)')
    .run('Administrador', 'admin', hashSenha(senha), 'admin');
  console.log('Usuário admin criado.' + (process.env.ADMIN_SENHA_INICIAL ? '' : ' Senha inicial: moura123 (troque no primeiro acesso)'));
}

// ---------- dados do sistema ----------
// códigos internos só com letras, números, _ e - (vão parar dentro de botões da tela)
const ID_OK = /^[A-Za-z0-9_-]{1,80}$/;
const COLECOES = ['motos', 'clientes', 'contratos', 'parcelas', 'manut', 'lanc', 'config'];
const ehAdmin = (u) => u.perfil === 'admin';

// A equipe cuida de motos, clientes, aluguéis, cobranças e manutenção.
// Só o administrador vê e mexe no financeiro (lançamentos avulsos) e nas configurações.
function podeLer(u, c) {
  if (ehAdmin(u)) return true;
  return c !== 'lanc';
}
function podeGravar(u, c) {
  if (ehAdmin(u)) return true;
  return c !== 'lanc' && c !== 'config';
}

const versaoAtual = () => db.prepare('SELECT COALESCE(MAX(versao), 0) v FROM registros').get().v;

function estado(u, desde) {
  const linhas = db.prepare('SELECT colecao, id, dados, versao, apagado FROM registros WHERE versao > ? ORDER BY versao').all(desde);
  const itens = [];
  for (const l of linhas) {
    if (l.apagado) { itens.push({ c: l.colecao, id: l.id, apagado: 1 }); continue; }
    const d = JSON.parse(l.dados);
    if (!podeLer(u, l.colecao)) { if (desde) itens.push({ c: l.colecao, id: l.id, apagado: 1 }); continue; }
    itens.push({ c: l.colecao, id: l.id, dados: d });
  }
  return { versao: versaoAtual(), itens };
}

function sincronizar(u, ops) {
  if (!Array.isArray(ops)) throw new Erro(400, 'Formato inválido');
  if (ops.length > 2000) throw new Erro(413, 'Alterações demais de uma vez');
  return transacao(() => {
    let v = versaoAtual();
    const ler = db.prepare('SELECT dados, apagado FROM registros WHERE colecao = ? AND id = ?');
    const gravar = db.prepare(`INSERT INTO registros (colecao, id, dados, versao, apagado, usuario_id, atualizado_em)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))
      ON CONFLICT(colecao, id) DO UPDATE SET dados = excluded.dados, versao = excluded.versao, apagado = excluded.apagado,
        usuario_id = excluded.usuario_id, atualizado_em = excluded.atualizado_em`);
    let recusados = 0;
    for (const op of ops) {
      const c = op && op.c, id = op && op.id;
      if (!COLECOES.includes(c) || typeof id !== 'string' || !ID_OK.test(id)) throw new Erro(400, 'Registro inválido');
      const linha = ler.get(c, id);
      const atual = linha && !linha.apagado;
      if (op.apagar) {
        if (!atual) continue;
        if (!podeGravar(u, c)) { recusados++; continue; }
        gravar.run(c, id, linha.dados, ++v, 1, u.id);
        continue;
      }
      const d = op.dados;
      if (!d || typeof d !== 'object' || Array.isArray(d) || d.id !== id) throw new Erro(400, 'Registro inválido');
      if (!podeGravar(u, c)) { recusados++; continue; }
      const json = JSON.stringify(d);
      if (json.length > 200000) throw new Erro(413, 'Registro muito grande');
      gravar.run(c, id, json, ++v, 0, u.id);
    }
    return { versao: v, recusados };
  });
}

// ---------- rotas ----------
const rotas = [];
function rota(metodo, caminho, handler, { admin = false, publica = false } = {}) {
  const nomes = [];
  const re = new RegExp('^' + caminho.replace(/:(\w+)/g, (_, n) => { nomes.push(n); return '(\\d+)'; }) + '$');
  rotas.push({ metodo, re, nomes, handler, admin, publica });
}
const exigeAdmin = (u) => { if (!ehAdmin(u)) throw new Erro(403, 'Somente administrador'); };
const ipDe = (req) => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
const ehHttps = (req) => TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https';
const cookie = (req, valor, maxAge) =>
  `sid=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${ehHttps(req) ? '; Secure' : ''}`;

const MAX_FALHAS = 5, BLOQUEIO_MS = 15 * 60 * 1000;
const falhasLogin = new Map();
function conferirBloqueio(ip) {
  const f = falhasLogin.get(ip);
  if (f && f.n >= MAX_FALHAS && Date.now() - f.t < BLOQUEIO_MS) throw new Erro(429, 'Muitas tentativas. Aguarde 15 minutos e tente de novo.');
}
function registrarFalha(ip) {
  const f = falhasLogin.get(ip);
  const n = f && Date.now() - f.t < BLOQUEIO_MS ? f.n + 1 : 1;
  falhasLogin.set(ip, { n, t: Date.now() });
}
const publico = (u) => ({ id: u.id, nome: u.nome, login: u.login, perfil: u.perfil });

rota('POST', '/api/login', ({ req, body, res }) => {
  const ip = ipDe(req);
  conferirBloqueio(ip);
  const u = db.prepare('SELECT * FROM usuarios WHERE login = ? AND ativo = 1').get(String(body.login || '').trim());
  if (!u || !confereSenha(body.senha || '', u.senha_hash)) { registrarFalha(ip); throw new Erro(401, 'Usuário ou senha incorretos'); }
  falhasLogin.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessoes (token, usuario_id) VALUES (?, ?)').run(token, u.id);
  res.setHeader('Set-Cookie', cookie(req, token, SESSAO_DIAS * 86400));
  return publico(u);
}, { publica: true });
rota('POST', '/api/logout', ({ req, token, res }) => {
  if (token) db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', cookie(req, '', 0));
}, { publica: true });
rota('GET', '/api/me', ({ user }) => user);
rota('POST', '/api/me/senha', ({ body, user }) => {
  const u = db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(user.id);
  if (!confereSenha(body.atual || '', u.senha_hash)) throw new Erro(400, 'A senha atual está incorreta');
  db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(validaSenha(body.nova)), user.id);
});

rota('GET', '/api/usuarios', () =>
  db.prepare('SELECT id, nome, login, perfil, ativo, criado_em FROM usuarios ORDER BY ativo DESC, nome').all(), { admin: true });
rota('POST', '/api/usuarios', ({ body }) => {
  const nome = String(body.nome || '').trim(), login = String(body.login || '').trim().toLowerCase();
  if (!nome || !/^[a-z0-9._-]{3,30}$/.test(login)) throw new Erro(400, 'Informe o nome e um usuário com 3 a 30 letras ou números, sem espaço');
  const perfil = body.perfil === 'admin' ? 'admin' : 'equipe';
  if (db.prepare('SELECT 1 FROM usuarios WHERE login = ?').get(login)) throw new Erro(400, 'Esse usuário já existe');
  const r = db.prepare('INSERT INTO usuarios (nome, login, senha_hash, perfil) VALUES (?, ?, ?, ?)').run(nome, login, hashSenha(validaSenha(body.senha)), perfil);
  return { id: Number(r.lastInsertRowid) };
}, { admin: true });
rota('PUT', '/api/usuarios/:id', ({ body, params, user }) => {
  const alvo = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(params.id);
  if (!alvo) throw new Erro(404, 'Usuário não encontrado');
  const nome = String(body.nome ?? alvo.nome).trim() || alvo.nome;
  const perfil = body.perfil === 'admin' ? 'admin' : body.perfil === 'equipe' ? 'equipe' : alvo.perfil;
  const ativo = body.ativo === undefined ? alvo.ativo : body.ativo ? 1 : 0;
  if (alvo.id === user.id && (perfil !== 'admin' || !ativo)) throw new Erro(400, 'Você não pode tirar o seu próprio acesso de administrador');
  db.prepare('UPDATE usuarios SET nome = ?, perfil = ?, ativo = ? WHERE id = ?').run(nome, perfil, ativo, alvo.id);
  if (body.senha) db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(validaSenha(body.senha)), alvo.id);
  if (!ativo || body.senha) db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(alvo.id);
}, { admin: true });

rota('GET', '/api/estado', ({ user, query }) => estado(user, Math.max(0, Number(query.get('desde')) || 0)));
rota('POST', '/api/sync', ({ user, body }) => sincronizar(user, body.ops));

// envio automático de cobranças pelo WhatsApp (desligado até ser configurado)
require('./whatsapp')({ db, rota, transacao, fmtData });

// ---------- servidor HTTP ----------
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json' };
// ícone e nome do atalho quando alguém usa "Adicionar à tela inicial" no celular
const ICONES_APP = `<link rel="manifest" href="/assets/manifest.webmanifest">
<link rel="apple-touch-icon" href="/assets/icone-180.png">
<meta name="theme-color" content="#17191C">
<meta name="apple-mobile-web-app-title" content="Moura Aluguéis">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
`;

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 5e6) { reject(new Erro(413, 'Requisição muito grande')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new Erro(400, 'JSON inválido')); } });
    req.on('error', reject);
  });
}
function lerToken(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
const CABECALHOS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' };
function enviarJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
// index.html é o mesmo da demonstração; aqui ele recebe a marca que liga o modo online
function paginaPrincipal() {
  const html = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');
  return html.replace('</head>', ICONES_APP + '</head>').replace('<script>', '<script>window.MA_ONLINE=1;</script>\n<script>');
}

const servidor = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(CABECALHOS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    try {
      const r = rotas.find((x) => x.metodo === req.method && x.re.test(url.pathname));
      if (!r) throw new Erro(404, 'Rota não encontrada');
      const m = r.re.exec(url.pathname);
      const params = Object.fromEntries(r.nomes.map((n, i) => [n, Number(m[i + 1])]));
      const token = lerToken(req);
      let user = null;
      if (token) {
        user = db.prepare(`SELECT u.id, u.nome, u.login, u.perfil FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
          WHERE s.token = ? AND u.ativo = 1 AND s.criado_em > datetime('now','localtime','-${SESSAO_DIAS} days')`).get(token) || null;
      }
      if (!r.publica && !user) throw new Erro(401, 'Faça login novamente');
      if (r.admin) exigeAdmin(user);
      const body = ['POST', 'PUT'].includes(req.method) ? await lerCorpo(req) : {};
      const out = await r.handler({ req, res, body, params, query: url.searchParams, user, token });
      enviarJson(res, 200, out ?? { ok: true });
    } catch (e) {
      if (!e.status) console.error(e);
      enviarJson(res, e.status || 500, { erro: e.status ? e.message : 'Erro interno: ' + e.message });
    }
    return;
  }
  try {
    if (url.pathname.startsWith('/assets/')) {
      const arquivo = path.normalize(path.join(RAIZ, decodeURIComponent(url.pathname)));
      if (!arquivo.startsWith(path.join(RAIZ, 'assets')) || !fs.existsSync(arquivo) || fs.statSync(arquivo).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TIPOS[path.extname(arquivo)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(arquivo).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': TIPOS['.html'], 'Cache-Control': 'no-cache' });
    res.end(paginaPrincipal());
  } catch (e) {
    console.error(e);
    res.writeHead(500); res.end('Erro interno');
  }
});

// ---------- backup automático ----------
// Uma cópia por dia em dados/backups (guarda os últimos BACKUP_DIAS dias).
function fazerBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const destino = path.join(BACKUP_DIR, `mouraalugueis-${fmtData(new Date())}.db`);
    if (!fs.existsSync(destino)) {
      db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
      console.log('Backup salvo:', destino);
    }
    const antigos = fs.readdirSync(BACKUP_DIR).filter((f) => /^mouraalugueis-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(BACKUP_DIAS);
    for (const f of antigos) fs.unlinkSync(path.join(BACKUP_DIR, f));
    db.prepare(`DELETE FROM sessoes WHERE criado_em <= datetime('now','localtime','-${SESSAO_DIAS} days')`).run();
  } catch (e) {
    console.error('Falha no backup:', e.message);
  }
}
fazerBackup();
setInterval(fazerBackup, 3600e3).unref();

servidor.listen(PORT, HOST, () => {
  console.log(`\n  Moura Aluguéis rodando em: http://localhost:${PORT}\n`);
});
