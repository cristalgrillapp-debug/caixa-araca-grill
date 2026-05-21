// POST /api/escala-musica/analisar
// Recebe { image: "data:image/...;base64,..." } e retorna o JSON estruturado
// da escala. Usa o modelo multimodal via OpenRouter (mesma chave/wrapper da Allana).

import { SISTEMA_ESCALA } from '../../lib/escala/prompt.js'

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
const TIMEOUT_MS = 30000
const MAX_BYTES = 6 * 1024 * 1024  // 6MB já comprimido pelo cliente

function aplicarCors(req, res) {
  const permitido = process.env.ALLOWED_ORIGIN
  const origin = req.headers.origin
  if (permitido) {
    if (origin === permitido) res.setHeader('Access-Control-Allow-Origin', origin)
  } else {
    res.setHeader('Access-Control-Allow-Origin', origin || '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function extrairJSON(texto) {
  if (!texto) return null
  // O modelo às vezes embrulha em ```json ... ```
  const limpo = String(texto).replace(/```json\s*|```/g, '').trim()
  try { return JSON.parse(limpo) } catch (_) {}
  // Fallback: extrai o maior bloco { ... }
  const m = limpo.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch (_) { return null }
}

function validarPayload(data) {
  if (!data || typeof data !== 'object') return false
  if (!Array.isArray(data.dias)) return false
  for (const d of data.dias) {
    if (!d || typeof d !== 'object') return false
    if (!Array.isArray(d.musicos)) return false
  }
  return true
}

export default async function handler(req, res) {
  aplicarCors(req, res)
  if (req.method === 'OPTIONS') { res.status(204).end(); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método não permitido' }); return }

  const inicio = Date.now()
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    const imagem = body.image
    if (typeof imagem !== 'string' || !imagem.startsWith('data:image/')) {
      res.status(400).json({ error: 'Imagem ausente ou inválida' })
      return
    }
    if (imagem.length > MAX_BYTES) {
      res.status(413).json({ error: 'Imagem muito grande (max 6MB já comprimida)' })
      return
    }

    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) { res.status(500).json({ error: 'OPENROUTER_API_KEY ausente' }); return }

    // Modelo multimodal — o mesmo família da Allana, mas precisa de visão.
    const model = process.env.MODEL_VISAO || 'google/gemini-2.5-flash'

    const messages = [
      { role: 'system', content: SISTEMA_ESCALA },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analise esta escala e devolva o JSON conforme o schema.' },
          { type: 'image_url', image_url: { url: imagem } },
        ],
      },
    ]

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    let r
    try {
      r = await fetch(ENDPOINT, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.ALLOWED_ORIGIN || 'https://aracagrill.com',
          'X-Title': 'Escala Musical - Araca Grill',
        },
        body: JSON.stringify({
          model, messages,
          temperature: 0.1,
          max_tokens: 2000,
          response_format: { type: 'json_object' },
        }),
      })
    } catch (err) {
      clearTimeout(timer)
      res.status(504).json({ error: 'Timeout ou falha de rede' })
      return
    }
    clearTimeout(timer)

    if (!r.ok) {
      const txt = await r.text().catch(() => '')
      res.status(502).json({ error: `OpenRouter HTTP ${r.status}`, detalhe: txt.slice(0, 300) })
      return
    }
    const json = await r.json().catch(() => null)
    const content = json?.choices?.[0]?.message?.content
    const parsed = extrairJSON(content)
    if (!validarPayload(parsed)) {
      res.status(502).json({ error: 'Resposta da IA fora do schema esperado', bruto: content?.slice(0, 500) })
      return
    }

    const ms = Date.now() - inicio
    const tokens = json?.usage?.total_tokens ?? '-'
    console.log(`[escala] ok latencia=${ms}ms tokens=${tokens} dias=${parsed.dias.length}`)
    res.status(200).json({ ok: true, escala: parsed, latencia_ms: ms })
  } catch (err) {
    console.error('[escala] erro', err)
    res.status(500).json({ error: 'Falha interna' })
  }
}
