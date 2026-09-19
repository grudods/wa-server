// auth-firebase.js
// Guarda a sessao do WhatsApp dentro do Firebase.
// Sem isso, toda vez que o servidor reiniciasse voce teria que ler o QR de novo.

const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

// Firebase nao aceita . # $ / [ ] nos nomes das chaves
const limpar = (t) => String(t).replace(/[.#$/\[\]]/g, '_');

async function useFirebaseAuthState(databaseURL, sessaoId = 'principal', pegarToken = async () => null) {
  const base = `${databaseURL}/sessoes/${sessaoId}`;

  const url = async (caminho) => {
    const t = await pegarToken();
    return `${base}/${caminho}.json${t ? `?auth=${t}` : ''}`;
  };

  // Le um item da sessao.
  // Diferenca importante:
  //   - devolve null quando o item simplesmente nao existe
  //   - joga erro quando a leitura FALHOU (rede, permissao)
  // Sem isso, uma falha passageira apagaria a sessao e pediria QR de novo.
  const ler = async (caminho, tentativas = 3) => {
    let ultimoErro = null;

    for (let i = 0; i < tentativas; i++) {
      try {
        const r = await fetch(await url(caminho));

        if (r.status === 401 || r.status === 403) {
          throw new Error('sem permissao no Firebase (confira o login do servidor)');
        }
        if (!r.ok) {
          throw new Error(`HTTP ${r.status}`);
        }

        const bruto = await r.json();
        if (!bruto) return null;               // nao existe = sessao nova
        return JSON.parse(bruto, BufferJSON.reviver);
      } catch (e) {
        ultimoErro = e;
        if (i < tentativas - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }

    throw new Error(`Falha ao ler sessao (${caminho}): ${ultimoErro.message}`);
  };

  const gravar = async (caminho, dados) => {
    try {
      await fetch(await url(caminho), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // guardamos como texto para nao perder os Buffers do Baileys
        body: JSON.stringify(JSON.stringify(dados, BufferJSON.replacer))
      });
    } catch (e) {
      console.error('Erro ao gravar sessao:', e.message);
    }
  };

  const apagar = async (caminho) => {
    try {
      await fetch(await url(caminho), { method: 'DELETE' });
    } catch (e) {
      console.error('Erro ao apagar sessao:', e.message);
    }
  };

  let creds;
  const salvas = await ler('creds');   // se falhar, estoura de proposito

  if (salvas) {
    creds = salvas;
    console.log('💾 Sessao recuperada do Firebase (nao precisa ler QR)');
  } else {
    creds = initAuthCreds();
    console.log('🆕 Nenhuma sessao salva. Vai gerar QR Code.');
  }

  return {
    state: {
      creds,
      keys: {
        get: async (tipo, ids) => {
          const saida = {};
          await Promise.all(ids.map(async (id) => {
            let valor = await ler(`keys/${tipo}-${limpar(id)}`);
            if (tipo === 'app-state-sync-key' && valor) {
              valor = proto.Message.AppStateSyncKeyData.fromObject(valor);
            }
            if (valor) saida[id] = valor;
          }));
          return saida;
        },
        set: async (dados) => {
          const tarefas = [];
          for (const tipo in dados) {
            for (const id in dados[tipo]) {
              const valor = dados[tipo][id];
              const caminho = `keys/${tipo}-${limpar(id)}`;
              tarefas.push(valor ? gravar(caminho, valor) : apagar(caminho));
            }
          }
          await Promise.all(tarefas);
        }
      }
    },
    saveCreds: () => gravar('creds', creds),
    limparSessao: () => apagar('')
  };
}

module.exports = { useFirebaseAuthState };
