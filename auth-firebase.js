// auth-firebase.js
// Guarda a sessao do WhatsApp dentro do Firebase.
// Sem isso, toda vez que o servidor reiniciasse voce teria que ler o QR de novo.

const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

// Firebase nao aceita . # $ / [ ] nos nomes das chaves
const limpar = (t) => String(t).replace(/[.#$/\[\]]/g, '_');

async function useFirebaseAuthState(databaseURL, sessaoId = 'principal') {
  const base = `${databaseURL}/sessoes/${sessaoId}`;

  const ler = async (caminho) => {
    try {
      const r = await fetch(`${base}/${caminho}.json`);
      if (!r.ok) return null;
      const bruto = await r.json();
      if (!bruto) return null;
      return JSON.parse(bruto, BufferJSON.reviver);
    } catch (e) {
      console.error('Erro ao ler sessao:', e.message);
      return null;
    }
  };

  const gravar = async (caminho, dados) => {
    try {
      await fetch(`${base}/${caminho}.json`, {
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
      await fetch(`${base}/${caminho}.json`, { method: 'DELETE' });
    } catch (e) {
      console.error('Erro ao apagar sessao:', e.message);
    }
  };

  const creds = (await ler('creds')) || initAuthCreds();

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
