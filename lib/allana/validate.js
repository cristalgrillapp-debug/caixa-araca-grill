// Validação do JSON retornado pela IA. Conforme item 6 do brief.

const INTENTS_VALIDOS = new Set([
  'menu_request', 'birthday', 'hours', 'rules', 'handoff', 'general', 'off_topic',
])

// Extrai o objeto JSON de uma string que pode vir com cercas markdown ou texto.
function extrairJson(texto) {
  if (typeof texto !== 'string') return null
  const limpo = texto.replace(/```json/gi, '').replace(/```/g, '').trim()
  try {
    return JSON.parse(limpo)
  } catch (_) {
    // tenta achar o primeiro bloco {...}
    const ini = limpo.indexOf('{')
    const fim = limpo.lastIndexOf('}')
    if (ini !== -1 && fim !== -1 && fim > ini) {
      try {
        return JSON.parse(limpo.slice(ini, fim + 1))
      } catch (_) {
        return null
      }
    }
    return null
  }
}

/**
 * Valida e normaliza o conteúdo bruto retornado pela IA.
 * @param {string} rawContent - texto do campo content da resposta do modelo
 * @returns {{ ok: boolean, data: object|null }}
 */
export function validateResponse(rawContent) {
  const obj = extrairJson(rawContent)
  if (!obj || typeof obj !== 'object') return { ok: false, data: null }

  const message = typeof obj.message === 'string' ? obj.message.trim() : ''
  if (!message) return { ok: false, data: null }

  const intent = INTENTS_VALIDOS.has(obj.intent) ? obj.intent : 'general'

  return {
    ok: true,
    data: {
      message,
      intent,
      showMenuButton: obj.showMenuButton === true,
      handoff: obj.handoff === true,
      handoffReason: typeof obj.handoffReason === 'string' ? obj.handoffReason : '',
    },
  }
}
