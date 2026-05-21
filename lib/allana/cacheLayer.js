// Camada 1 — respostas pré-cacheadas via regex (custo zero, sem IA).
//
// REGRA DE FLUIDEZ: o cache só atua na PRIMEIRA mensagem da sessão.
// A partir do segundo turno, qualquer pergunta — mesmo se bater com gatilho —
// vai para a IA, para que a resposta considere o contexto da conversa e varie
// o fraseado. Isso evita a sensação de "FAQ robótico" em follow-ups.
//
// Exceção: saudação isolada continua usando cache (com variações rotacionadas),
// porque é o ponto natural de entrada da conversa.

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

// escolhe aleatoriamente uma variação — gera leve fluidez mesmo no cache
function v(opcoes) {
  return opcoes[Math.floor(Math.random() * opcoes.length)]
}

// gatilhos por categoria — só usados na 1ª mensagem
const REGRAS = [
  {
    gatilhos: ['endereco', 'onde fica voces', 'onde voces ficam', 'onde fica o restaurante', 'onde fica araca', 'localizacao', 'como chegar'],
    build: () => resposta(v([
      'Estamos na Rua Aviação 335, Santana — Araçatuba-SP.',
      'Ficamos na Rua Aviação 335, bairro Santana, em Araçatuba.',
      'Nosso endereço: Rua Aviação 335, Santana, Araçatuba-SP.',
    ]), 'general'),
  },
  {
    gatilhos: ['horario de funcionamento', 'horario de atendimento', 'que horas abre', 'que horas fecha', 'qual horario', 'funcionamento'],
    build: () => resposta(v([
      'Seg a sex das 17h às 23h59. Sáb, dom e feriados das 11h às 23h59.',
      'De seg a sex abrimos às 17h; aos finais de semana e feriados, das 11h às 23h59.',
      'Durante a semana, 17h às 23h59. Sáb, dom e feriados, 11h às 23h59.',
    ]), 'hours'),
  },
  {
    gatilhos: ['cardapio', 'ver o menu', 'me manda o menu', 'qual o menu'],
    build: () => resposta(v([
      'Claro 😊 Veja nosso cardápio completo no botão abaixo.',
      'Pode ver o cardápio inteiro aqui embaixo 😊',
      'Nosso cardápio está no botão abaixo — dá uma olhada 😊',
    ]), 'menu_request', { showMenuButton: true }),
  },
  {
    gatilhos: ['instagram', 'qual instagram', 'rede social'],
    build: () => resposta(v([
      'Nos siga no @araca_grill 😊',
      'É @araca_grill no Instagram 😊',
      'Estamos no Instagram como @araca_grill.',
    ]), 'general'),
  },
  {
    gatilhos: ['estacionamento', 'estacionar', 'parking', 'tem onde estacionar'],
    build: () => resposta(v([
      'Não temos estacionamento próprio, mas há vagas na rua.',
      'Estacionamento próprio não temos — o pessoal estaciona na rua mesmo.',
      'Não temos estacionamento, mas a rua costuma ter vagas.',
    ]), 'general'),
  },
  {
    gatilhos: ['forma de pagamento', 'formas de pagamento', 'aceita pix', 'aceita cartao', 'aceita dinheiro', 'como posso pagar'],
    build: () => resposta(v([
      'Aceitamos crédito, débito, Pix, dinheiro, Puxe (antigo Sodexo) e BIC na função crédito.',
      'Crédito, débito, Pix, dinheiro, Puxe (Sodexo) e BIC (só crédito) — todos aceitos.',
    ]), 'general'),
  },
  {
    gatilhos: ['como reservar', 'como fazer reserva', 'como faco reserva', 'como faço reserva', 'como faz reserva', 'quero reservar', 'quero fazer reserva'],
    build: () => resposta(v([
      'Preencha o formulário aqui nesta página e clique em "Confirmar" — você será direcionado ao nosso WhatsApp e um atendente confirmará sua reserva 😊',
      'É só preencher o formulário desta página e tocar em "Confirmar"; em seguida levamos você ao WhatsApp para um atendente fechar a reserva 😊',
    ]), 'general'),
  },
  {
    gatilhos: ['qual whatsapp', 'qual o whatsapp', 'qual o zap', 'numero do whatsapp', 'numero whatsapp', 'numero do zap', 'tem whatsapp', 'tem zap', 'whatsapp de voces', 'zap de voces'],
    build: () => resposta(v([
      'Nosso WhatsApp é (18) 99185-0160 😊',
      'É o (18) 99185-0160 😊',
      'Pode salvar: (18) 99185-0160.',
    ]), 'general'),
  },
]

// saudações — variações rotacionadas para a 1ª mensagem
const SAUDACOES = ['oi', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'eai', 'opa']
const SAUDACOES_RESP = [
  'Olá! Posso ajudar com sua reserva no Araçá Grill? 😊',
  'Oi! Em que posso ajudar hoje no Araçá Grill? 😊',
  'Olá! Tudo certo? Posso te ajudar com reserva ou outra dúvida 😊',
]

function ehSaudacaoIsolada(norm) {
  return SAUDACOES.includes(norm)
}

/**
 * Tenta resolver a mensagem pela Camada 1.
 * @param {string} mensagem - texto cru do usuário
 * @param {boolean} isFirstMessage - se é a 1ª mensagem da sessão
 * @returns {object|null} JSON no formato padrão, ou null se não houver match
 */
export function matchCache(mensagem, isFirstMessage = false) {
  if (!mensagem || typeof mensagem !== 'string') return null
  const norm = normalizar(mensagem)
  if (!norm) return null

  // Saudação isolada — sempre usa cache, com variação. Assina só na 1ª.
  if (ehSaudacaoIsolada(norm)) {
    const texto = SAUDACOES_RESP[Math.floor(Math.random() * SAUDACOES_RESP.length)]
    const message = isFirstMessage ? `${texto}\n\n${ASSINATURA}` : texto
    return resposta(message, 'general')
  }

  // Demais gatilhos: cache só na primeira mensagem da sessão.
  // Em follow-ups deixamos a IA responder com contexto e fraseado natural.
  if (!isFirstMessage) return null

  // Regra de segurança dos 30 caracteres (evita falso positivo em frase longa)
  if (mensagem.trim().length > 30) return null

  for (const regra of REGRAS) {
    if (regra.gatilhos.some(g => norm.includes(g))) {
      return regra.build()
    }
  }

  return null
}
