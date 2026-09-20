// server.js
// Ponte entre WhatsApp e o Painel DS.
//
// Estrutura no Firebase:
//   conversas/{numero}/
//     id, jid, sender, status, operador_atendimento
//     ultima_mensagem, ultima_atualizacao, criada_em
//     mensagens/{msgId}/   <- cada mensagem é um nó próprio (sem race)
//       tipo: 'cliente' | 'operador'
//       texto, timestamp, sender, msgId
//       midia: { tipo, mime, nome, base64 }   <- se for foto/áudio/etc
//   fila_envio/{pushId}/    <- fila de saída
//     numero, jid, texto, tipo, mime, nome, base64 (opcional)
//   servidor/status/       <- heartbeat
//   sessoes/principal/     <- credenciais do Baileys

const express = require('express');
const QRCode = require('qrcode');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');
const { useFirebaseAuthState } = require('./auth-firebase');

const DB = process.env.FIREBASE_DB_URL
  || 'https://ds-painel-whatsapp-default-rtdb.firebaseio.com';

const PORTA = process.env.PORT || 3000;
const INTERVALO_ENVIO = 2000;
const INTERVALO_HEARTBEAT = 30000;
const LIMITE_TEXTO = 4000;
const LIMITE_MIDIA_BYTES = 700 * 1024;   // 700 KB. Base64 vira ~1.3x → <1MB
const MAX_TENTATIVAS = 5;
const STALE_ENVIO_MS = 30000;

const URL_PUBLICA = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL || null;
const INTERVALO_PING = 10 * 60 * 1000;

let sock = null;
let qrAtual = null;
let conectado = false;
let numeroConectado = null;

// ---------- LOGIN NO FIREBASE ----------
const API_KEY = process.env.FIREBASE_API_KEY || '';
const EMAIL_SERVIDOR = process.env.FIREBASE_EMAIL || '';
const SENHA_SERVIDOR = process.env.FIREBASE_SENHA || '';

let token = null;
let tokenExpiraEm = 0;
let proximaTentativa = 0;

async function pegarToken() {
  if (!API_KEY || !EMAIL_SERVIDOR || !SENHA_SERVIDOR) return null;
  if (token && Date.now() < tokenExpiraEm) return token;
  if (Date.now() < proximaTentativa) return null;

  try {
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: EMAIL_SERVIDOR,
          password: SENHA_SERVIDOR,
          returnSecureToken: true
        })
      }
    );

    const dados = await r.json();

    if (!r.ok) {
      const erro = dados?.error?.message || 'erro desconhecido';
      console.error(`❌ LOGIN NO FIREBASE FALHOU: ${erro}`);
      if (erro.includes('INVALID_LOGIN') || erro.includes('INVALID_PASSWORD')) {
        console.error('   -> Confira FIREBASE_EMAIL e FIREBASE_SENHA no Render.');
      }
      if (erro.includes('EMAIL_NOT_FOUND')) {
        console.error('   -> Essa conta não existe no Authentication.');
      }
      if (erro.includes('API key not valid')) {
        console.error('   -> Confira FIREBASE_API_KEY no Render.');
      }
      proximaTentativa = Date.now() + 60000;
      return null;
    }

    token = dados.idToken;
    tokenExpiraEm = Date.now() + (Number(dados.expiresIn || 3600) - 300) * 1000;
    proximaTentativa = 0;
    console.log('🔑 Servidor autenticado no Firebase');
    return token;
  } catch (e) {
    console.error('Erro de rede ao logar no Firebase:', e.message);
    proximaTentativa = Date.now() + 30000;
    return null;
  }
}

// ---------- FIREBASE (REST) ----------
async function comAuth(caminho) {
  const t = await pegarToken();
  return `${DB}/${caminho}.json${t ? `?auth=${t}` : ''}`;
}

async function fbLer(caminho) {
  const r = await fetch(await comAuth(caminho));
  if (!r.ok) throw new Error(`Firebase GET ${r.status}`);
  return r.json();
}

async function fbGravar(caminho, dados) {
  const r = await fetch(await comAuth(caminho), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dados)
  });
  if (!r.ok) throw new Error(`Firebase PUT ${r.status}`);
}

async function fbAtualizar(caminho, dados) {
  const r = await fetch(await comAuth(caminho), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dados)
  });
  if (!r.ok) throw new Error(`Firebase PATCH ${r.status}`);
}

async function fbApagar(caminho) {
  const r = await fetch(await comAuth(caminho), { method: 'DELETE' });
  if (!r.ok && r.status !== 404) throw new Error(`Firebase DELETE ${r.status}`);
}

const limparChave = (t) => String(t).replace(/[.#$/\[\]]/g, '_');

function listaMensagens(conversa) {
  const m = (conversa && conversa.mensagens) || {};
  const arr = Array.isArray(m) ? m.filter(Boolean) : Object.values(m).filter(Boolean);
  return arr.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
}

// ---------- MIDIA ----------
// Baixa a mídia do WhatsApp e devolve { base64, mime, nome, tamanho }.
// Devolve null se passar do limite — nesse caso a mensagem chega só
// com aviso textual ("[foto grande — 1.2MB]").
async function baixarMidia(m) {
  try {
    const buffer = await downloadMediaMessage(m, 'buffer', {});
    const tamanho = buffer?.length || 0;
    if (!tamanho) return null;

    const img = m.message?.imageMessage;
    const aud = m.message?.audioMessage;
    const vid = m.message?.videoMessage;
    const doc = m.message?.documentMessage;

    let tipo = null;
    let mime = 'application/octet-stream';
    let nome = 'arquivo';

    if (img) {
      tipo = 'imagem';
      mime = img.mimetype || 'image/jpeg';
      nome = 'foto.jpg';
    } else if (aud) {
      tipo = 'audio';
      mime = aud.mimetype || 'audio/ogg';
      nome = 'audio.ogg';
    } else if (vid) {
      tipo = 'video';
      mime = vid.mimetype || 'video/mp4';
      nome = 'video.mp4';
    } else if (doc) {
      tipo = 'documento';
      mime = doc.mimetype || 'application/octet-stream';
      nome = doc.fileName || 'documento';
    } else {
      return null;
    }

    if (tamanho > LIMITE_MIDIA_BYTES) {
      return {
        excedeu: true,
        tipo,
        mime,
        nome,
        tamanho
      };
    }

    return {
      base64: buffer.toString('base64'),
      mime,
      nome,
      tipo,
      tamanho
    };
  } catch (e) {
    console.error('Falha ao baixar mídia:', e.message);
    return null;
  }
}

function resumoMidia(midia) {
  if (!midia) return '';
  if (midia.tipo === 'imagem')  return midia.excedeu ? '[foto grande]' : '[foto]';
  if (midia.tipo === 'audio')   return midia.excedeu ? '[áudio grande]' : '[áudio]';
  if (midia.tipo === 'video')   return '[vídeo]';
  if (midia.tipo === 'documento') return `[${midia.nome || 'arquivo'}]`;
  return '[mídia]';
}

// ---------- RECEBER ----------
async function salvarMensagemRecebida({ numero, jid, nome, texto, midia, msgId }) {
  const caminho = `conversas/${numero}`;
  const atual = await fbLer(caminho).catch(() => null);

  const anteriores = listaMensagens(atual);

  if (msgId && anteriores.slice(-80).some(m => m && m.msgId === msgId)) {
    console.log(`(repetida, ignorada) ${nome || numero}`);
    return;
  }

  const agora = new Date().toISOString();
  const idMsg = limparChave(
    msgId || `srv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );

  const payload = {
    tipo: 'cliente',
    texto: (texto || '').slice(0, LIMITE_TEXTO),
    timestamp: agora,
    sender: nome || numero,
    msgId: msgId || null
  };

  if (midia) {
    payload.midia = {
      tipo: midia.tipo,
      mime: midia.mime,
      nome: midia.nome,
      tamanho: midia.tamanho,
      base64: midia.base64 || null,
      excedeu: !!midia.excedeu
    };
  }

  await fbGravar(`conversas/${numero}/mensagens/${idMsg}`, payload);

  const status = atual?.status === 'em-atendimento' ? 'em-atendimento' : 'aguardando';
  const resumo = (texto || '').slice(0, 120)
    || resumoMidia(midia)
    || '[mídia]';

  await fbAtualizar(caminho, {
    id: numero,
    jid,
    sender: atual?.sender || nome || numero,
    status,
    ultima_mensagem: resumo,
    ultima_atualizacao: agora,
    criada_em: atual?.criada_em || agora
  });

  const logTexto = texto ? texto.slice(0, 60) : resumoMidia(midia);
  console.log(`⬅️  ${nome || numero}: ${logTexto}`);
}

// ---------- ENVIAR ----------
async function enviarPendentes() {
  if (!conectado || !sock) return;

  let fila;
  try {
    fila = await fbLer('fila_envio');
  } catch {
    return;
  }
  if (!fila || typeof fila !== 'object') return;

  for (const [pushId, item] of Object.entries(fila)) {
    if (!item || typeof item !== 'object') continue;
    if (!item.numero) continue;
    if (!item.texto && !item.base64) continue;

    if (item.enviando && item.enviando_em) {
      const desde = Date.now() - new Date(item.enviando_em).getTime();
      if (desde < STALE_ENVIO_MS) continue;
    }

    const jid = item.jid || `${item.numero}@s.whatsapp.net`;

    try {
      await fbAtualizar(`fila_envio/${pushId}`, {
        enviando: true,
        enviando_em: new Date().toISOString()
      });

      if (item.base64 && item.tipo) {
        // Mensagem com mídia
        const buffer = Buffer.from(item.base64, 'base64');
        const caption = (item.texto || '').slice(0, LIMITE_TEXTO);

        if (item.tipo === 'imagem') {
          await sock.sendMessage(jid, {
            image: buffer,
            mimetype: item.mime || 'image/jpeg',
            caption: caption || undefined
          });
        } else if (item.tipo === 'audio') {
          await sock.sendMessage(jid, {
            audio: buffer,
            mimetype: item.mime || 'audio/ogg',
            ptt: item.ptt !== false
          });
        } else if (item.tipo === 'video') {
          await sock.sendMessage(jid, {
            video: buffer,
            mimetype: item.mime || 'video/mp4',
            caption: caption || undefined
          });
        } else if (item.tipo === 'documento') {
          await sock.sendMessage(jid, {
            document: buffer,
            mimetype: item.mime || 'application/octet-stream',
            fileName: item.nome || 'arquivo',
            caption: caption || undefined
          });
        }
      } else {
        // Só texto
        const texto = String(item.texto || '').slice(0, LIMITE_TEXTO);
        if (!texto.trim()) {
          await fbApagar(`fila_envio/${pushId}`);
          continue;
        }
        await sock.sendMessage(jid, { text: texto });
      }

      await fbAtualizar(`conversas/${item.numero}/mensagens/${pushId}`, {
        status: 'enviada',
        enviada_em: new Date().toISOString()
      }).catch(() => {});

      await fbApagar(`fila_envio/${pushId}`);
      console.log(`➡️  ${item.numero}: ${item.base64 ? '[mídia]' : String(item.texto || '').slice(0, 60)}`);
    } catch (e) {
      const tentativas = (Number(item.tentativas) || 0) + 1;
      console.error(`Falha (${pushId}) tentativa ${tentativas}: ${e.message}`);

      if (tentativas >= MAX_TENTATIVAS) {
        console.error(`Desistindo após ${MAX_TENTATIVAS} tentativas: ${pushId}`);
        await fbApagar(`fila_envio/${pushId}`).catch(() => {});
        await fbAtualizar(`conversas/${item.numero}/mensagens/${pushId}`, {
          status: 'falhou',
          erro: String(e.message || e).slice(0, 200)
        }).catch(() => {});
      } else {
        await fbAtualizar(`fila_envio/${pushId}`, {
          enviando: false,
          tentativas,
          ultimo_erro: String(e.message || e).slice(0, 200)
        }).catch(() => {});
      }
    }
  }
}

// ---------- HEARTBEAT ----------
async function heartbeat() {
  try {
    await fbAtualizar('servidor/status', {
      online: conectado,
      numero: numeroConectado || null,
      aguardando_qr: !!qrAtual,
      ultima_vez: new Date().toISOString()
    });
  } catch {}
}

// ---------- WHATSAPP ----------
let conectando = false;
let conflitosSeguidos = 0;

async function conectar() {
  if (conectando) return;
  conectando = true;

  let state, saveCreds;
  try {
    ({ state, saveCreds } = await useFirebaseAuthState(DB, 'principal', pegarToken));
  } catch (e) {
    console.error('⚠️  Não foi possível carregar a sessão:', e.message);
    console.error('    Tentando de novo em 15 segundos...');
    conectando = false;
    setTimeout(conectar, 15000);
    return;
  }

  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Painel DS', 'Chrome', '1.0.0'],
    syncFullHistory: false
  });

  conectando = false;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      qrAtual = await QRCode.toDataURL(qr);
      conectado = false;
      console.log('📱 QR Code pronto. Abra a página do servidor para ler.');
    }

    if (connection === 'open') {
      conectado = true;
      qrAtual = null;
      numeroConectado = sock.user?.id?.split(':')[0] || null;
      conflitosSeguidos = 0;
      console.log(`✅ Conectado como ${numeroConectado}`);
      heartbeat().catch(() => {});
    }

    if (connection === 'close') {
      conectado = false;
      conectando = false;

      const motivo = lastDisconnect?.error?.output?.statusCode;
      const deslogado = motivo === DisconnectReason.loggedOut;
      const substituida = motivo === DisconnectReason.connectionReplaced || motivo === 440;

      if (deslogado) {
        console.log('❌ Sessão encerrada no celular. Leia o QR de novo.');
        qrAtual = null;
        heartbeat().catch(() => {});
        return;
      }

      let espera = 3000;
      if (substituida) {
        conflitosSeguidos++;
        espera = Math.min(15000 * conflitosSeguidos, 60000);
      } else {
        conflitosSeguidos = 0;
      }
      console.log(
        substituida
          ? `⚠️  Sessão assumida por outra instância. Volta em ${espera / 1000}s...`
          : `❌ Desconectado (${motivo}). Reconecta em ${espera / 1000}s...`
      );

      heartbeat().catch(() => {});
      setTimeout(conectar, espera);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`📨 Evento "${type}" com ${messages.length} mensagem(ns)`);

    if (type !== 'notify' && type !== 'append') {
      console.log(`   (ignorado: tipo "${type}")`);
      return;
    }

    for (const m of messages) {
      const jid = m.key.remoteJid || '';

      if (m.key.fromMe) continue;

      if (jid.endsWith('@g.us') || jid.endsWith('@newsletter')
          || jid.endsWith('@broadcast') || jid === 'status@broadcast') {
        continue;
      }

      let numero = null;

      if (jid.endsWith('@s.whatsapp.net')) {
        numero = jid.split('@')[0];
      } else if (jid.endsWith('@lid')) {
        const pn = m.key.senderPn || m.key.participantPn || '';
        numero = String(pn).split('@')[0] || jid.split('@')[0];
      }

      if (!numero) {
        console.log(`   (ignorado: sem ID) ${jid}`);
        continue;
      }

      const texto =
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption ||
        m.message?.videoMessage?.caption ||
        '';

      // Detecta mídia
      const temMidia = !!(m.message?.imageMessage
        || m.message?.audioMessage
        || m.message?.videoMessage
        || m.message?.documentMessage);

      if (!texto.trim() && !temMidia) {
        const tipos = Object.keys(m.message || {}).join(', ') || 'vazio';
        console.log(`   (sem texto nem mídia) ${numero} | tipo: ${tipos}`);
        continue;
      }

      let midia = null;
      if (temMidia) {
        midia = await baixarMidia(m);
        if (midia) {
          console.log(`   mídia ${midia.tipo} ${midia.tamanho || '?'} bytes${midia.excedeu ? ' (excedeu, sem base64)' : ''}`);
        }
      }

      const nome = (m.pushName || '').trim() || numero;

      try {
        await salvarMensagemRecebida({ numero, jid, nome, texto, midia, msgId: m.key.id });
      } catch (e) {
        console.error('Erro ao salvar mensagem:', e.message);
      }
    }
  });
}

// ---------- MANTER ACORDADO ----------
async function autoPing() {
  if (!URL_PUBLICA) return;
  try {
    await fetch(`${URL_PUBLICA}/status`);
    console.log('🔄 ping');
  } catch (e) {
    console.error('Ping falhou:', e.message);
  }
}

// ---------- REDE DE SEGURANÇA ----------
process.on('unhandledRejection', (motivo) => {
  console.error('⚠️  Promise rejeitada:', motivo?.message || motivo);
});

process.on('uncaughtException', (e) => {
  console.error('⚠️  Exceção não tratada:', e?.stack || e?.message || e);
  setTimeout(() => process.exit(1), 500);
});

// ---------- EXPRESS ----------
const app = express();

app.get('/', (req, res) => {
  const corpo = conectado
    ? `<div class="ok">✅ Conectado</div>
       <p>Número: <b>${numeroConectado || '-'}</b></p>
       <p>Pode fechar esta página e usar o painel normalmente.</p>`
    : qrAtual
      ? `<p>Abra o <b>WhatsApp</b> no celular &rarr; <b>Aparelhos conectados</b> &rarr; <b>Conectar aparelho</b></p>
         <img src="${qrAtual}" alt="QR Code">
         <p class="dica">A página atualiza sozinha.</p>`
      : `<div class="espera">⏳ Iniciando...</div>
         <p class="dica">Aguarde alguns segundos.</p>`;

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Conexão WhatsApp</title>
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
<body><div class="card"><h1>Painel DS &mdash; Conexão WhatsApp</h1>${corpo}</div></body>
</html>`);
});

app.get('/status', (req, res) => {
  res.json({ conectado, numero: numeroConectado, aguardandoQr: !!qrAtual });
});

app.listen(PORTA, async () => {
  console.log(`Servidor na porta ${PORTA}`);
  console.log(`Limite de mídia: ${Math.round(LIMITE_MIDIA_BYTES/1024)} KB`);

  if (API_KEY && EMAIL_SERVIDOR && SENHA_SERVIDOR) {
    const t = await pegarToken();
    if (!t) console.error('⚠️  Servidor SEM login. Só funciona com regras abertas.');
  } else {
    console.log('ℹ️  Sem credenciais do Firebase. Funciona com regras abertas.');
  }

  conectar().catch(e => console.error('Erro ao conectar:', e));
  setInterval(enviarPendentes, INTERVALO_ENVIO);
  setInterval(heartbeat, INTERVALO_HEARTBEAT);
  heartbeat().catch(() => {});

  if (URL_PUBLICA) {
    console.log(`Auto-ping ligado: ${URL_PUBLICA}`);
    setInterval(autoPing, INTERVALO_PING);
  } else {
    console.log('Auto-ping desligado.');
  }
});