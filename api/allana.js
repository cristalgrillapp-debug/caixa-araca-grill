// Endpoint POST /api/allana — orquestra as 3 camadas da Allana.
// Vercel serverless function (Node 18+, fetch nativo).

import { SYSTEM_PROMPT } from '../lib/allana/systemPrompt.js'
import { matchCache } from '../lib/allana/cacheLayer.js'
import { callModel, isRetryable } from '../lib/allana/openrouter.js'
import { validateResponse } from '../lib/allana/validate.js'
import { checkRate } from '../lib/allana/rateLimit.js'

const MAX_CHARS = 500

const HANDOFF_EMERGENCIA = {
  message: 'Vou passar para nossa equipe verificar isso melhor 😊',
  intent: 'handoff',
  showMenuButton: false,
  handoff: true,
  handoffReason: 'Falha técnica — cliente aguarda atendimento',
}

const HANDOFF_RATE_LIMIT = {
  message: 'Recebemos muitas mensagens em sequência 😊 Para agilizar, fale com nossa equipe pelo WhatsApp.',
  intent: 'handoff',
  showMenuButton: false,
  handoff: true,
  handoffReason: 'Cliente atingiu limite de mensagens',
}

// Remove caracteres de controle (C0 + DEL), colapsa espaços e trunca em 500.
function sanitizar(texto) {
  const s = String(texto)
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    out += (code <= 31 || code === 127) ? ' ' : s[i]
  }
  return out.replace(/\s+/g, ' ').slice(0, MAX_CHARS).trim()
}

function getIp(req) {
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim()
  return req.socket?.remoteAddress || 'desconhecido'
}

function aplicarCors(req, res) {
  const permitido = process.env.ALLOWED_ORIGIN
  const origin = req.headers.origin
  if (permitido) {
    // só ecoa o origin se bater com o permitido
    if (origin === permitido) res.setHeader('Access-Control-Allow-Origin', origin)
  } else {
    res.setHeader('Access-Control-Allow-Origin', origin || '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function espera(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// Camada 2 (principal) com 1 retry; depois Camada 3 (fallback) sem retry.
async function chamarIA({ history, message }) {
  const primary = process.env.MODEL_PRIMARY || 'google/gemini-2.5-flash-lite'
  const fallback = process.env.MODEL_FALLBACK || 'google/gemini-2.5-flash'

  // ── Camada 2: principal + 1 retry ──
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      const { content, usage } = await callModel({
        model: primary, system: SYSTEM_PROMPT, history, message,
      })
      const { ok, data } = validateResponse(content)
      if (ok) return { data, camada: 'principal', usage }
      // JSON inválido conta como falha retryável
      if (tentativa === 0) { await espera(500); continue }
    } catch (err) {
      if (tentativa === 0 && isRetryable(err)) { await espera(500); continue }
      break // erro não-retryável ou já era o retry → vai pro fallback
    }
  }

  // ── Camada 3: fallback, sem retry ──
  try {
    const { content, usage } = await callModel({
      model: fallback, system: SYSTEM_PROMPT, history, message,
    })
    const { ok, data } = validateResponse(content)
    if (ok) return { data, camada: 'fallback', usage }
  } catch (_) { /* cai na emergência */ }

  // ── Emergência ──
  return { data: HANDOFF_EMERGENCIA, camada: 'emergencia', usage: undefined }
}

export default async function handler(req, res) {
  aplicarCors(req, res)
  if (req.method === 'OPTIONS') { res.status(204).end(); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método não permitido' }); return }

  const inicio = Date.now()

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    const mensagem = sanitizar(body.message || '')
    const history = Array.isArray(body.history) ? body.history : []
    const isFirstMessage = history.length === 0

    if (!mensagem) {
      res.status(200).json({
        message: 'Posso ajudar com sua reserva? 😊',
        intent: 'general', showMenuButton: false, handoff: false, handoffReason: '',
      })
      return
    }

    // Rate limit por IP
    const { allowed } = checkRate(getIp(req))
    if (!allowed) {
      log('rate-limit', inicio)
      res.status(429).json(HANDOFF_RATE_LIMIT)
      return
    }

    // Camada 1 — cache regex
    const cache = matchCache(mensagem, isFirstMessage)
    if (cache) {
      log('cache', inicio)
      res.status(200).json(cache)
      return
    }

    // Camadas 2/3/emergência
    const { data, camada, usage } = await chamarIA({ history, message: mensagem })
    log(camada, inicio, usage)
    res.status(200).json(data)
  } catch (err) {
    log('erro', inicio)
    res.status(200).json(HANDOFF_EMERGENCIA)
  }
}

// Log sem conteúdo de mensagem (LGPD): camada, latência, tokens.
function log(camada, inicio, usage) {
  const ms = Date.now() - inicio
  const tokens = usage?.total_tokens ?? '-'
  console.log(`[allana] camada=${camada} latencia=${ms}ms tokens=${tokens}`)
}
