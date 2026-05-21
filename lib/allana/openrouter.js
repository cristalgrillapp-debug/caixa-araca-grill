// Wrapper das chamadas ao OpenRouter. Conforme itens 8 e 9 do brief.

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
const TIMEOUT_MS = 8000

// Erro com código HTTP anexado, para a camada de orquestração decidir retry.
class OpenRouterError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'OpenRouterError'
    this.status = status
  }
}

const STATUS_RETRYAVEL = new Set([429, 500, 502, 503])

export function isRetryable(err) {
  return err instanceof OpenRouterError && STATUS_RETRYAVEL.has(err.status)
}

/**
 * Chama um modelo via OpenRouter e retorna o texto cru do content.
 * @param {object} p
 * @param {string} p.model        - id do modelo
 * @param {string} p.system       - system prompt
 * @param {Array}  p.history      - mensagens anteriores [{role, content}]
 * @param {string} p.message      - mensagem atual do usuário
 * @returns {Promise<{ content: string, usage: object|undefined }>}
 */
export async function callModel({ model, system, history = [], message }) {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new OpenRouterError('OPENROUTER_API_KEY ausente', 500)

  // Últimas 6 mensagens do histórico (3 turnos completos) — mais contexto, mais fluidez
  const ultimas = history.slice(-6).filter(
    m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
  )

  const messages = [
    { role: 'system', content: system },
    ...ultimas,
    { role: 'user', content: message },
  ]

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let res
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.ALLOWED_ORIGIN || 'https://aracagrill.com',
        'X-Title': 'Allana - Araca Grill',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.55,
        top_p: 0.9,
        presence_penalty: 0.4,
        frequency_penalty: 0.3,
        max_tokens: 180,
        response_format: { type: 'json_object' },
      }),
    })
  } catch (err) {
    clearTimeout(timer)
    // abort (timeout) ou erro de rede → tratável como 503 (retryável)
    throw new OpenRouterError(`Falha de rede/timeout: ${err.message}`, 503)
  }
  clearTimeout(timer)

  if (!res.ok) {
    throw new OpenRouterError(`HTTP ${res.status}`, res.status)
  }

  const json = await res.json().catch(() => null)
  const content = json?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new OpenRouterError('Resposta sem content', 502)
  }

  return { content, usage: json?.usage }
}
