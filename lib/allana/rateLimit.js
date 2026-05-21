// Rate limit in-memory best-effort. Conforme escolha do usuário (mais simples,
// sem banco / sem dependência). Janela deslizante de 60s, limite 10 req/IP.
//
// LIMITAÇÃO CONHECIDA: em ambiente serverless o estado vive por instância. Em
// cold starts ou múltiplas instâncias o controle não é global. A proteção de
// custo principal vem da Camada 1 (cache) + max_tokens 150 + prompt curto.

const JANELA_MS = 60 * 1000
const LIMITE = 10

const acessos = new Map() // ip -> number[] (timestamps)

/**
 * Registra um acesso e diz se o IP excedeu o limite.
 * @param {string} ip
 * @returns {{ allowed: boolean, remaining: number }}
 */
export function checkRate(ip) {
  const agora = Date.now()
  const chave = ip || 'desconhecido'
  const lista = (acessos.get(chave) || []).filter(t => agora - t < JANELA_MS)

  if (lista.length >= LIMITE) {
    acessos.set(chave, lista)
    return { allowed: false, remaining: 0 }
  }

  lista.push(agora)
  acessos.set(chave, lista)

  // limpeza oportunista para não crescer indefinidamente
  if (acessos.size > 5000) {
    for (const [k, ts] of acessos) {
      const vivos = ts.filter(t => agora - t < JANELA_MS)
      if (vivos.length === 0) acessos.delete(k)
      else acessos.set(k, vivos)
    }
  }

  return { allowed: true, remaining: LIMITE - lista.length }
}
