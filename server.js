// server.js
// Conecta no WhatsApp via QR Code (como o WhatsApp Web).
// - Mensagem que chega -> grava no Firebase -> aparece no painel
// - Resposta escrita no painel -> envia no WhatsApp na hora, a qualquer momento

const express = require('express');
const QRCode = require('qrcode');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { useFirebaseAuthState } = require('./auth-firebase');

const DB = process.env.FIREBASE_DB_URL
  || 'https://ds-painel-whatsapp-default-rtdb.firebaseio.com';

const PORTA = process.env.PORT || 3000;
const INTERVALO_ENVIO = 2000; // de quanto em quanto tempo olha se voce escreveu algo

let sock = null;
let qrAtual = null;
let conectado = false;
let numeroConectado = null;

// ---------- FIREBASE (REST) ----------

async function fbLer(caminho) {
  const r = await fetch(`${DB}/${caminho}.json`);
  if (!r.ok) throw new Error(`Firebase leitura falhou: ${r.status}`);
  return r.json();
}

async function fbGravar(caminho, dados) {
  const r = await fetch(`${DB}/${caminho}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dados)
  });
  if (!r.ok) throw new Error(`Firebase gravacao falhou: ${r.status}`);
}

// ---------- RECEBER ----------

async function salvarMensagemRecebida({ numero, jid, nome, texto }) {
  const caminho = `conversas/${numero}`;
  const atual = await fbLer(caminho).catch(() => null);

  const anteriores = Array.isArray(atual?.mensagens)
    ? atual.mensagens
    : Object.values(atual?.mensagens || {});

  const agora = new Date().toISOString();

  await fbGravar(caminho, {
    ...(atual || {}),
    id: numero,
    jid,                       // necessario para conseguir responder
    sender: nome || numero,
    status: atual?.status === 'em-atendimento' ? 'em-atendimento' : 'aguardando',
    mensagens: [...anteriores, { tipo: 'cliente', texto, timestamp: agora, sender: nome || numero }],
    pendentes: Array.isArray(atual?.pendentes) ? atual.pendentes : [],
    ultima_mensagem: texto,
    ultima_atualizacao: agora,
    criada_em: atual?.criada_em || agora
  });

  console.log(`⬅️  ${nome || numero}: ${texto}`);
}

// ---------- ENVIAR ----------

// Fica de olho no painel. Assim que voce escreve, manda no WhatsApp.
async function verificarPendentes() {
  if (!conectado || !sock) return;

  let conversas;
  try {
    conversas = await fbLer('conversas');
  } catch {
    return;
  }
  if (!conversas) return;

  for (const [numero, conversa] of Object.entries(conversas)) {
    if (!conversa || typeof conversa !== 'object') continue;

    const fila = Array.isArray(conversa.pendentes)
      ? conversa.pendentes.filter(t => typeof t === 'string' && t.trim())
      : [];
    if (!fila.length) continue;

    const jid = conversa.jid || `${numero}@s.whatsapp.net`;

    // esvazia a fila ANTES de enviar, para nao mandar duas vezes
    // se o servidor reiniciar no meio
    try {
      await fbGravar(`conversas/${numero}/pendentes`, []);
    } catch {
      continue;
    }

    for (const texto of fila) {
      try {
        await sock.sendMessage(jid, { text: texto });
        console.log(`➡️  ${conversa.sender || numero}: ${texto}`);
      } catch (e) {
        console.error(`Falha ao enviar para ${numero}:`, e.message);
      }
    }
  }
}

// ---------- WHATSAPP ----------

async function conectar() {
  const { state, saveCreds } = await useFirebaseAuthState(DB);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Painel DS', 'Chrome', '1.0.0'],
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      qrAtual = await QRCode.toDataURL(qr);
      conectado = false;
      console.log('📱 QR Code pronto. Abra a pagina do servidor para ler.');
    }

    if (connection === 'open') {
      conectado = true;
      qrAtual = null;
      numeroConectado = sock.user?.id?.split(':')[0] || null;
      console.log(`✅ Conectado como ${numeroConectado}`);
    }

    if (connection === 'close') {
      conectado = false;
      const motivo = lastDisconnect?.error?.output?.statusCode;
      const deslogado = motivo === DisconnectReason.loggedOut;

      console.log(`❌ Desconectado (${motivo}).`, deslogado ? 'Sessao encerrada no celular.' : 'Reconectando...');

      if (!deslogado) setTimeout(conectar, 3000);
      else qrAtual = null;
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const m of messages) {
      if (m.key.fromMe) continue;

      const jid = m.key.remoteJid || '';
      if (jid.endsWith('@g.us')) continue;      // ignora grupos
      if (jid === 'status@broadcast') continue; // ignora status

      const texto =
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption ||
        m.message?.videoMessage?.caption ||
        '';

      if (!texto.trim()) continue;

      const numero = jid.split('@')[0];
      const nome = m.pushName || numero;

      try {
        await salvarMensagemRecebida({ numero, jid, nome, texto });
      } catch (e) {
        console.error('Erro ao salvar mensagem:', e.message);
      }
    }
  });
}

// ---------- PAGINA DO SERVIDOR ----------

const app = express();

app.get('/', (req, res) => {
  const corpo = conectado
    ? `<div class="ok">✅ Conectado</div>
       <p>Numero: <b>${numeroConectado || '-'}</b></p>
       <p>Pode fechar esta pagina e usar o painel normalmente.</p>`
    : qrAtual
      ? `<p>Abra o <b>WhatsApp</b> no celular &rarr; <b>Aparelhos conectados</b> &rarr; <b>Conectar aparelho</b></p>
         <img src="${qrAtual}" alt="QR Code">
         <p class="dica">A pagina atualiza sozinha.</p>`
      : `<div class="espera">⏳ Iniciando...</div>
         <p class="dica">Aguarde alguns segundos.</p>`;

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Conexao WhatsApp</title>
  ${conectado ? '' : '<meta http-equiv="refresh" content="5">'}
  <style>
    body{font-family:system-ui,sans-serif;background:#f0f2f5;margin:0;
         min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:20px}
    .card{background:#fff;padding:28px;border-radius:14px;text-align:center;
          box-shadow:0 4px 16px rgba(0,0,0,.1);max-width:420px;width:100%}
    h1{font-size:19px;margin:0 0 18px;color:#333}
    img{width:100%;max-width:280px;height:auto;margin:14px 0}
    .ok{font-size:21px;color:#0a7;font-weight:600;margin-bottom:10px}
    .espera{font-size:19px;color:#888}
    p{color:#555;font-size:14px;line-height:1.5}
    .dica{color:#999;font-size:12px}
  </style>
</head>
<body><div class="card"><h1>Painel DS &mdash; Conexao WhatsApp</h1>${corpo}</div></body>
</html>`);
});

app.get('/status', (req, res) => {
  res.json({ conectado, numero: numeroConectado, aguardandoQr: !!qrAtual });
});

app.listen(PORTA, () => {
  console.log(`Servidor na porta ${PORTA}`);
  conectar().catch(e => console.error('Erro ao conectar:', e));
  setInterval(verificarPendentes, INTERVALO_ENVIO);
});
