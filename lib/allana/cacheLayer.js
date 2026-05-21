// Camada 1 — respostas pré-cacheadas via regex (custo zero, sem IA).
// Conforme item 7 do brief.
//
// REGRA DE SEGURANÇA: só dispara se a mensagem tiver no máximo 30 caracteres
// OU se a palavra-chave for uma saudação isolada. Mensagens longas vão direto
// para a Camada 2 (a IA tem contexto melhor para interpretar).

const ASSINATURA = '— Allana do Araçá Grill'

// normaliza: minúsculas, sem acentos, sem pontuação, espaços colapsados
function normalizar(texto) {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove diacríticos
    .replace(/[^\w\s@]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function resposta(message, intent, extra = {}) {
  return {
    message,
    intent,
    showMenuButton: false,
    handoff: false,
    handoffReason: '',
    ...extra,
  }
}

// gatilhos por categoria — cada um casa por substring na versão normalizada
const REGRAS = [
  {
    gatilhos: ['endereco', 'onde fica voces', 'onde voces ficam', 'onde fica o restaurante', 'onde fica araca', 'localizacao', 'como chegar'],
    build: () => resposta('Estamos na Rua Aviação 335, Santana — Araçatuba-SP.', 'general'),
  },
  {
    gatilhos: ['horario de funcionamento', 'horario de atendimento', 'que horas abre', 'que horas fecha', 'qual horario', 'funcionamento'],
    build: () => resposta('Seg a sex das 17h às 23h59. Sáb, dom e feriados das 11h às 23h59.', 'hours'),
  },
  {
    gatilhos: ['cardapio', 'ver o menu', 'me manda o menu', 'qual o menu'],
    build: () => resposta('Claro 😊 Veja nosso cardápio completo no botão abaixo.', 'menu_request', { showMenuButton: true }),
  },
  {
    gatilhos: ['instagram', 'qual instagram', 'rede social'],
    build: () => resposta('Nos siga no @araca_grill 😊', 'general'),
  },
  {
    gatilhos: ['estacionamento', 'estacionar', 'parking', 'tem onde estacionar'],
    build: () => resposta('Não temos estacionamento próprio, mas há vagas na rua.', 'general'),
  },
  {
    gatilhos: ['forma de pagamento', 'formas de pagamento', 'aceita pix', 'aceita cartao', 'aceita dinheiro', 'como posso pagar'],
    build: () => resposta('Aceitamos crédito, débito, Pix, dinheiro, Puxe (antigo Sodexo) e BIC na função crédito.', 'general'),
  },
  {
    gatilhos: ['como reservar', 'como fazer reserva', 'como faco reserva', 'como faço reserva', 'como faz reserva', 'quero reservar', 'quero fazer reserva'],
    build: () => resposta('Preencha o formulário aqui nesta página e clique em "Confirmar" — você será direcionado ao nosso WhatsApp e um atendente confirmará sua reserva 😊', 'general'),
  },
  {
    gatilhos: ['qual whatsapp', 'qual o whatsapp', 'qual o zap', 'numero do whatsapp', 'numero whatsapp', 'numero do zap', 'tem whatsapp', 'tem zap', 'whatsapp de voces', 'zap de voces'],
    build: () => resposta('Nosso WhatsApp é (18) 99185-0160 😊', 'general'),
  },
]

// saudações: só casam quando a mensagem inteira é uma saudação pura
const SAUDACOES = ['oi', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'eai', 'opa']

function ehSaudacaoIsolada(norm) {
  return SAUDACOES.includes(norm)
}

/**
 * Tenta resolver a mensagem pela Camada 1.
 * @param {string} mensagem - texto cru do usuário
 * @param {boolean} isFirstMessage - se é a 1ª mensagem da sessão (assinatura)
 * @returns {object|null} JSON no formato padrão, ou null se não houver match
 */
export function matchCache(mensagem, isFirstMessage = false) {
  if (!mensagem || typeof mensagem !== 'string') return null
  const norm = normalizar(mensagem)
  if (!norm) return null

  // Saudação isolada (independe do tamanho, mas precisa ser a frase inteira)
  if (ehSaudacaoIsolada(norm)) {
    const texto = 'Olá! Posso ajudar com sua reserva no Araçá Grill? 😊'
    const message = isFirstMessage ? `${texto}\n\n${ASSINATURA}` : texto
    return resposta(message, 'general')
  }

  // Demais gatilhos: regra de segurança dos 30 caracteres
  if (mensagem.trim().length > 30) return null

  for (const regra of REGRAS) {
    if (regra.gatilhos.some(g => norm.includes(g))) {
      return regra.build()
    }
  }

  return null
}
