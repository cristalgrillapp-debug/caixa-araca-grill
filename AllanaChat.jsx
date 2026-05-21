import { useState, useEffect, useRef, useCallback } from 'react'

// ── CONFIG ──────────────────────────────────────────────────────────────────
const WHATSAPP = '5518991850160'
const AVATAR = '/allana-avatar.png'
// TODO: substituir pela URL real do cardápio (ou definir VITE_MENU_URL na Vercel)
const MENU_URL = import.meta.env.VITE_MENU_URL || 'https://instagram.com/araca_grill'
const ASSINATURA = '— Allana do Araçá Grill'
const ENDPOINT = '/api/allana'
const TIMEOUT_MS = 8000

// ── CORES DA MARCA (marrom/preto + acentos vermelho/laranja) ────────────────
const A = {
  bg:        '#0c0906',
  panel:     '#120d09',
  header1:   '#3a2418',
  header2:   '#1d130d',
  botBubble: '#1b1610',
  border:    '#2e2218',
  borderSub: '#211a13',
  text:      '#f1ece4',
  textMuted: '#9a8674',
  textDim:   '#6a5848',
  orange:    '#d2691e',
  orangeL:   '#e8853a',
  red:       '#b5392e',
  gold:      '#c9a96e',
  userGrad:  'linear-gradient(135deg, #b5392e 0%, #d2691e 100%)',
  warmGlow:  'rgba(210,105,30,0.30)',
}

// ── ANIMAÇÕES (injetadas via <style>) ───────────────────────────────────────
const CSS = `
@keyframes allSlideUp { from{opacity:0;transform:translateY(24px) scale(0.96)} to{opacity:1;transform:translateY(0) scale(1)} }
@keyframes allFadeIn  { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
@keyframes allPulse   { 0%,100%{transform:scale(1)} 12%{transform:scale(1.06)} 24%{transform:scale(1)} 36%{transform:scale(1.04)} 48%{transform:scale(1)} }
@keyframes allBlink   { 0%,80%,100%{opacity:0.25;transform:translateY(0)} 40%{opacity:1;transform:translateY(-3px)} }
@keyframes allGlow    { 0%,100%{box-shadow:0 0 0 0 rgba(210,105,30,0)} 50%{box-shadow:0 0 18px 3px rgba(210,105,30,0.25)} }
@keyframes allSpin    { to{transform:rotate(360deg)} }
.all-msg{animation:allFadeIn .28s ease both}
.all-fab:hover{transform:translateY(-2px)}
.all-send:hover{filter:brightness(1.08)}
`

// ── UTIL ────────────────────────────────────────────────────────────────────
const temConteudoReal = txt => /[\p{L}\p{N}]/u.test(txt || '')

function waUrl(reason) {
  const texto = reason && reason.trim() ? reason.trim() : 'Olá, gostaria de falar com a equipe do Araçá Grill.'
  return `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(texto)}`
}

// ── AVATAR (com fallback gracioso) ──────────────────────────────────────────
function AllanaAvatar({ size = 40, ring = true }) {
  const [erro, setErro] = useState(false)
  const base = {
    width: size, height: size, borderRadius: '50%', flexShrink: 0,
    border: ring ? `1.5px solid ${A.orange}` : 'none',
    boxShadow: ring ? `0 0 14px ${A.warmGlow}` : 'none',
    objectFit: 'cover', display: 'block',
  }
  if (erro) {
    return (
      <div style={{ ...base, background: A.userGrad, color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 800, fontSize: size * 0.42, fontFamily: "'Inter',sans-serif" }}>
        A
      </div>
    )
  }
  return <img src={AVATAR} alt="Allana" style={base} onError={() => setErro(true)} />
}

// ── INDICADOR "DIGITANDO" ───────────────────────────────────────────────────
function Digitando() {
  return (
    <div className="all-msg" style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 10 }}>
      <AllanaAvatar size={28} ring={false} />
      <div style={{ background: A.botBubble, border: `1px solid ${A.border}`,
        borderRadius: '14px 14px 14px 4px', padding: '12px 16px', display: 'flex', gap: 5 }}>
        {[0, 1, 2].map(i => (
          <span key={i} style={{ width: 7, height: 7, borderRadius: '50%', background: A.orange,
            display: 'inline-block', animation: `allBlink 1.2s ${i * 0.18}s infinite ease-in-out` }} />
        ))}
      </div>
    </div>
  )
}

// ── BOLHA DE MENSAGEM ───────────────────────────────────────────────────────
function Bolha({ msg, onMenu, onWhats }) {
  const ehUser = msg.role === 'user'
  if (ehUser) {
    return (
      <div className="all-msg" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <div style={{ maxWidth: '80%', background: A.userGrad, color: '#fff',
          borderRadius: '14px 14px 4px 14px', padding: '10px 14px', fontSize: 14, lineHeight: 1.45,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
          {msg.content}
        </div>
      </div>
    )
  }
  return (
    <div className="all-msg" style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 10 }}>
      <AllanaAvatar size={28} ring={false} />
      <div style={{ maxWidth: '82%' }}>
        <div style={{ background: A.botBubble, border: `1px solid ${A.border}`, color: A.text,
          borderRadius: '14px 14px 14px 4px', padding: '10px 14px', fontSize: 14, lineHeight: 1.5,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {msg.content}
        </div>
        {(msg.showMenuButton || msg.handoff) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {msg.showMenuButton && (
              <button onClick={onMenu}
                style={{ padding: '9px 16px', border: `1px solid ${A.orange}`, borderRadius: 10,
                  background: 'rgba(210,105,30,0.10)', color: A.orangeL, fontSize: 13, fontWeight: 700,
                  cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6 }}>
                📖 Ver cardápio
              </button>
            )}
            {msg.handoff && (
              <button onClick={onWhats}
                style={{ padding: '9px 16px', border: 'none', borderRadius: 10,
                  background: A.userGrad, color: '#fff', fontSize: 13, fontWeight: 700,
                  cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6,
                  boxShadow: `0 2px 10px ${A.warmGlow}` }}>
                💬 Falar no WhatsApp
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── COMPONENTE PRINCIPAL ────────────────────────────────────────────────────
export default function AllanaChat() {
  const [aberto, setAberto] = useState(false)
  const [mensagens, setMensagens] = useState([])
  const [input, setInput] = useState('')
  const [carregando, setCarregando] = useState(false)
  const [pulso, setPulso] = useState(false)
  const [iaBloqueada, setIaBloqueada] = useState(false)

  const assinaturaUsada = useRef(false)
  const handoffsSemClique = useRef(0)
  const sessionId = useRef(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()))
  const scrollRef = useRef(null)
  const inputRef = useRef(null)
  const interagiu = useRef(false)

  // Injeta CSS
  useEffect(() => {
    const el = document.createElement('style')
    el.textContent = CSS
    document.head.appendChild(el)
    return () => { document.head.removeChild(el) }
  }, [])

  // Micro-pulso 1x após 30s sem interação
  useEffect(() => {
    const t = setTimeout(() => { if (!interagiu.current) { setPulso(true); setTimeout(() => setPulso(false), 1600) } }, 30000)
    return () => clearTimeout(t)
  }, [])

  // Auto-scroll ao chegar mensagem
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [mensagens, carregando])

  // Foco no input ao abrir + saudação inicial (1ª msg da sessão, com assinatura)
  const abrir = useCallback(() => {
    interagiu.current = true
    setAberto(true)
    setMensagens(prev => {
      if (prev.length > 0) return prev
      assinaturaUsada.current = true
      return [{
        role: 'assistant',
        content: `Olá! Sou a Allana 😊 Posso ajudar com dúvidas sobre o Araçá Grill.\n\n${ASSINATURA}`,
        showMenuButton: false, handoff: false, handoffReason: '',
      }]
    })
    setTimeout(() => inputRef.current?.focus(), 320)
  }, [])

  const adicionarBot = useCallback((data) => {
    let content = data.message || ''
    // Assinatura só na 1ª mensagem da sessão
    if (!assinaturaUsada.current) {
      assinaturaUsada.current = true
      if (!content.includes(ASSINATURA)) content = `${content}\n\n${ASSINATURA}`
    }
    setMensagens(prev => [...prev, {
      role: 'assistant', content,
      showMenuButton: !!data.showMenuButton,
      handoff: !!data.handoff,
      handoffReason: data.handoffReason || '',
    }])
    // Contador de handoffs sem clique
    if (data.handoff) {
      handoffsSemClique.current += 1
      if (handoffsSemClique.current >= 3) setIaBloqueada(true)
    }
  }, [])

  const enviar = useCallback(async () => {
    const bruto = input.trim()
    if (!bruto || carregando) return
    interagiu.current = true
    const texto = bruto.slice(0, 500)
    setInput('')

    // mensagem vazia / só emoji → resposta local
    if (!temConteudoReal(texto)) {
      setMensagens(prev => [...prev, { role: 'user', content: texto }])
      adicionarBot({ message: 'Posso ajudar com sua reserva? 😊', intent: 'general' })
      return
    }

    const novaUser = { role: 'user', content: texto }
    setMensagens(prev => [...prev, novaUser])

    // IA bloqueada após 3 handoffs sem clique
    if (iaBloqueada) {
      setMensagens(prev => [...prev, {
        role: 'assistant',
        content: 'Para sua reserva, fale direto com nossa equipe pelo botão do WhatsApp 😊',
        showMenuButton: false, handoff: true,
        handoffReason: 'Cliente direcionado ao WhatsApp após múltiplos atendimentos',
      }])
      return
    }

    setCarregando(true)
    const history = mensagens
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-6)
      .map(m => ({ role: m.role, content: m.content }))

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: texto, history, sessionId: sessionId.current }),
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      const data = await res.json()
      setCarregando(false)
      adicionarBot(data)
    } catch (_) {
      clearTimeout(timer)
      setCarregando(false)
      setMensagens(prev => [...prev, {
        role: 'assistant',
        content: 'Algo deu errado, tente novamente ou fale conosco no WhatsApp 😊',
        showMenuButton: false, handoff: true,
        handoffReason: 'Falha de conexão no chat',
      }])
    }
  }, [input, carregando, mensagens, iaBloqueada, adicionarBot])

  const abrirMenu = () => { handoffsSemClique.current = 0; window.open(MENU_URL, '_blank') }
  const abrirWhats = (reason) => { handoffsSemClique.current = 0; window.open(waUrl(reason), '_blank') }

  const onKeyDown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar() } }

  // ── BOTÃO FLUTUANTE (fechado) ──
  if (!aberto) {
    return (
      <button className="all-fab" onClick={abrir} aria-label="Abrir chat da Allana"
        style={{
          position: 'fixed', right: 16, bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
          zIndex: 150, display: 'flex', alignItems: 'center', gap: 10,
          background: `linear-gradient(135deg, ${A.header1}, ${A.header2})`,
          border: `1px solid ${A.border}`, borderRadius: 999, padding: '8px 16px 8px 8px',
          cursor: 'pointer', fontFamily: "'Inter',system-ui,sans-serif",
          boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
          transition: 'transform 0.2s ease', maxWidth: 'calc(100vw - 32px)',
          animation: pulso ? 'allPulse 1.6s ease' : 'none',
        }}>
        <AllanaAvatar size={40} />
        <span style={{ color: A.text, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
          Dúvidas? Fale com a Allana <span style={{ fontSize: 14 }}>😊</span>
        </span>
      </button>
    )
  }

  // ── PAINEL ABERTO ──
  return (
    <div style={{
      position: 'fixed', zIndex: 180,
      right: 16, bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
      width: 'min(380px, calc(100vw - 24px))',
      height: 'min(580px, calc(100vh - 90px))',
      display: 'flex', flexDirection: 'column',
      background: A.panel, border: `1px solid ${A.border}`, borderRadius: 20,
      overflow: 'hidden', boxShadow: '0 16px 50px rgba(0,0,0,0.6)',
      fontFamily: "'Inter',system-ui,sans-serif",
      animation: 'allSlideUp 0.26s cubic-bezier(0.34,1.4,0.64,1) both',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
        background: `linear-gradient(135deg, ${A.header1}, ${A.header2})`,
        borderBottom: `1px solid ${A.border}`, flexShrink: 0 }}>
        <AllanaAvatar size={42} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: A.text, letterSpacing: '-0.01em' }}>Allana</div>
          <div style={{ fontSize: 11, color: A.orangeL, display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#3fbf6a', display: 'inline-block' }} />
            Atendimento Araçá Grill
          </div>
        </div>
        <button onClick={() => setAberto(false)} aria-label="Fechar"
          style={{ width: 32, height: 32, borderRadius: 10, border: `1px solid ${A.border}`,
            background: 'rgba(0,0,0,0.2)', color: A.textMuted, fontSize: 18, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>
          ✕
        </button>
      </div>

      {/* Mensagens */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '16px 14px',
        background: `radial-gradient(circle at 50% 0%, ${A.header2}22, ${A.bg})` }}>
        {mensagens.map((m, i) => (
          <Bolha key={i} msg={m} onMenu={abrirMenu} onWhats={() => abrirWhats(m.handoffReason)} />
        ))}
        {carregando && <Digitando />}
      </div>

      {/* Input */}
      <div style={{ display: 'flex', gap: 8, padding: '12px 12px calc(12px + env(safe-area-inset-bottom, 0px))',
        borderTop: `1px solid ${A.border}`, background: A.panel, flexShrink: 0 }}>
        <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={onKeyDown}
          placeholder="Escreva sua dúvida..." maxLength={500} disabled={carregando}
          style={{ flex: 1, padding: '12px 14px', border: `1px solid ${A.border}`, borderRadius: 12,
            background: A.botBubble, color: A.text, fontSize: 14, fontFamily: 'inherit', outline: 'none',
            caretColor: A.orange, boxSizing: 'border-box' }} />
        <button className="all-send" onClick={enviar} disabled={carregando || !input.trim()} aria-label="Enviar"
          style={{ width: 46, height: 46, flexShrink: 0, border: 'none', borderRadius: 12,
            background: (carregando || !input.trim()) ? A.botBubble : A.userGrad,
            color: (carregando || !input.trim()) ? A.textDim : '#fff', fontSize: 18,
            cursor: (carregando || !input.trim()) ? 'default' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'filter 0.15s' }}>
          {carregando
            ? <span style={{ width: 16, height: 16, border: '2px solid rgba(255,255,255,0.3)',
                borderTopColor: '#fff', borderRadius: '50%', display: 'inline-block', animation: 'allSpin 0.8s linear infinite' }} />
            : '➤'}
        </button>
      </div>
    </div>
  )
}
