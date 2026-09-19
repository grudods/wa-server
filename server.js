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

// O Render (plano gratis) desliga o servico depois de ~15 min sem acesso.
// Entao o proprio servidor se chama de tempos em tempos para continuar acordado.
const URL_PUBLICA = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL || null;
const INTERVALO_PING = 10 * 60 * 1000; // 10 minutos

let sock = null;
let qrAtual = null;
let conectado = false;
let numeroConectado = null;

// ---------- LOGIN NO FIREBASE ----------
// Depois que as regras do banco passam a exigir login, o servidor
// tambem precisa se identificar. Ele usa uma conta so dele.

const API_KEY = process.env.FIREBASE_API_KEY || '';
const EMAIL_SERVIDOR = process.env.FIREBASE_EMAIL || '';
const SENHA_SERVIDOR = process.env.FIREBASE_SENHA || '';

let token = null;
let tokenExpiraEm = 0;

let proximaTentativa = 0;

async function pegarToken() {
  // Sem credenciais configuradas, trabalha sem login
  // (funciona so enquanto as regras estiverem abertas).
  if (!API_KEY || !EMAIL_SERVIDOR || !SENHA_SERVIDOR) return null;

  if (token && Date.now() < tokenExpiraEm) return token;

  // Se o login acabou de falhar, espera um pouco antes de tentar de novo.
  // Evita ficar martelando o Google e tomar bloqueio temporario.
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
        console.error('   -> Essa conta nao existe no Authentication do Firebase.');
      }
      if (erro.includes('API key not valid')) {
        console.error('   -> Confira FIREBASE_API_KEY no Render.');
      }
      proximaTentativa = Date.now() + 60000; // so tenta de novo em 1 minuto
      return null;
    }

    token = dados.idToken;
    // o token vale 1 hora; renovamos 5 minutos antes
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
  if (!r.ok) throw new Error(`Firebase leitura falhou: ${r.status}`);
  return r.json();
}

async function fbGravar(caminho, dados) {
  const r = await fetch(await comAuth(caminho), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dados)
  });
  if (!r.ok) throw new Error(`Firebase gravacao falhou: ${r.status}`);
}

// ---------- RECEBER ----------

async function salvarMensagemRecebida({ numero, jid, nome, texto, msgId }) {
  const caminho = `conversas/${numero}`;
  const atual = await fbLer(caminho).catch(() => null);

  const anteriores = Array.isArray(atual?.mensagens)
    ? atual.mensagens
    : Object.values(atual?.mensagens || {});

  // Se essa mensagem ja foi salva antes, nao salva de novo.
  // Acontece quando o WhatsApp reentrega mensagens apos o servidor voltar.
  if (msgId && anteriores.slice(-60).some(m => m && m.msgId === msgId)) {
    console.log(`(repetida, ignorada) ${nome || numero}: ${texto}`);
    return;
  }

  const agora = new Date().toISOString();

  await fbGravar(caminho, {
    ...(atual || {}),
    id: numero,
    jid,                       // necessario para conseguir responder
    sender: nome || numero,
    status: atual?.status === 'em-atendimento' ? 'em-atendimento' : 'aguardando',
    mensagens: [...anteriores, { tipo: 'cliente', texto, timestamp: agora, sender: nome || numero, msgId }],
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

let conectando = false;

async function conectar() {
  if (conectando) return;      // ja tem uma conexao sendo feita
  conectando = true;

  let state, saveCreds;
  try {
    ({ state, saveCreds } = await useFirebaseAuthState(DB, 'principal', pegarToken));
  } catch (e) {
    // Nao conseguiu ler a sessao. NAO cria sessao nova por conta disso:
    // seria perder a conexao do WhatsApp por causa de uma falha passageira.
    console.error('⚠️  Nao foi possivel carregar a sessao:', e.message);
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
      conectando = false;

      const motivo = lastDisconnect?.error?.output?.statusCode;
      const deslogado = motivo === DisconnectReason.loggedOut;

      // 440 = 'replaced': a mesma sessao conectou em outro lugar.
      // Acontece no redeploy (a instancia velha ainda esta viva) ou se
      // alguem leu o QR de novo. Esperamos mais para nao brigar por ela.
      const substituida = motivo === DisconnectReason.connectionReplaced
                       || motivo === 440;

      if (deslogado) {
        console.log('❌ Sessao encerrada no celular. Vai precisar ler o QR de novo.');
        qrAtual = null;
        return;
      }

      const espera = substituida ? 15000 : 3000;
      console.log(
        substituida
          ? `⚠️  Sessao assumida por outra instancia. Tentando voltar em ${espera/1000}s...`
          : `❌ Desconectado (${motivo}). Reconectando em ${espera/1000}s...`
      );

      setTimeout(conectar, espera);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify'  = mensagem chegando agora
    // 'append'  = mensagem que ficou guardada enquanto o servidor estava fora
    if (type !== 'notify' && type !== 'append') return;

    for (const m of messages) {
      if (m.key.fromMe) continue;

      const jid = m.key.remoteJid || '';

      // So aceita conversa individual de pessoa.
      // Tudo o mais fica de fora: grupos (@g.us), canais e comunidades
      // (@newsletter), status (status@broadcast) e listas de transmissao.
      // Esses chegam como numeros longos comecando com 120363.
      if (!jid.endsWith('@s.whatsapp.net')) continue;

      const numero = jid.split('@')[0];

      // Numero de verdade tem no maximo 15 digitos (padrao internacional).
      // Id de grupo/canal tem 18 ou mais.
      if (!/^\d{6,15}$/.test(numero)) continue;

      const texto =
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption ||
        m.message?.videoMessage?.caption ||
        '';

      if (!texto.trim()) continue;

      const nome = m.pushName || numero;

      try {
        await salvarMensagemRecebida({ numero, jid, nome, texto, msgId: m.key.id });
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
    console.log('🔄 ping (mantendo o servidor acordado)');
  } catch (e) {
    console.error('Ping falhou:', e.message);
  }
}

// ---------- PAGINA DO SERVIDOR ----------

// ---------- REDE DE SEGURANCA ----------
// Sem isso, uma falha solta (queda do WhatsApp, rede) derruba o servidor
// inteiro e o Render marca o deploy como falho.

process.on('unhandledRejection', (motivo) => {
  console.error('⚠️  Falha nao tratada:', motivo?.message || motivo);
});

process.on('uncaughtException', (e) => {
  console.error('⚠️  Erro nao tratado:', e?.message || e);
  // segue rodando: a reconexao do WhatsApp cuida de se restabelecer
});

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

app.listen(PORTA, async () => {
  console.log(`Servidor na porta ${PORTA}`);

  // Testa o login logo de cara, para o erro (se houver) sair no comeco do log
  if (API_KEY && EMAIL_SERVIDOR && SENHA_SERVIDOR) {
    const t = await pegarToken();
    if (!t) console.error('⚠️  Servidor SEM login no Firebase. So funciona com as regras abertas.');
  } else {
    console.log('ℹ️  Sem credenciais do Firebase (FIREBASE_API_KEY / EMAIL / SENHA).');
    console.log('   Funciona enquanto as regras do banco estiverem abertas.');
  }

  conectar().catch(e => console.error('Erro ao conectar:', e));
  setInterval(verificarPendentes, INTERVALO_ENVIO);

  if (URL_PUBLICA) {
    console.log(`Auto-ping ligado: ${URL_PUBLICA}`);
    setInterval(autoPing, INTERVALO_PING);
  } else {
    console.log('Auto-ping desligado (defina KEEP_ALIVE_URL se precisar)');
  }
});
