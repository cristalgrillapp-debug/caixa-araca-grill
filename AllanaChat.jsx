import { useState, useEffect, useRef, useCallback } from 'react'

// ── CONFIG ──────────────────────────────────────────────────────────────────
const WHATSAPP = '5518991850160'
const AVATAR = '/allana-avatar.png'
const MENU_URL = import.meta.env.VITE_MENU_URL || 'https://pedido.brendi.com.br/araca-grill-aviacao'
const ASSINATURA = '— Allana do Araçá Grill'
const ENDPOINT = '/api/allana'
const TIMEOUT_MS = 8000

// ── DESIGN TOKENS (premium, marca preservada) ───────────────────────────────
const A = {
  // base
  bg:         '#0a0706',
  panel:      '#100b08',
  panelSoft:  '#15100b',
  surface:    '#1a1410',
  surfaceHi:  '#221912',
  // textos
  text:       '#f3ede3',
  textMuted:  '#a08c78',
  textDim:    '#6b5a48',
  // marca
  gold:       '#d4af6a',
  goldSoft:   '#b8945a',
  goldDim:    'rgba(212,175,106,0.18)',
  goldGlow:   'rgba(212,175,106,0.22)',
  // acentos quentes (mantidos)
  orange:     '#d2691e',
  orangeL:    '#e8853a',
  red:        '#b5392e',
  // bordas
  border:     'rgba(212,175,106,0.14)',
  borderSub:  'rgba(255,255,255,0.06)',
  // gradientes
  userGrad:   'linear-gradient(135deg, #b5392e 0%, #d2691e 100%)',
  goldGrad:   'linear-gradient(135deg, #d4af6a 0%, #b8945a 100%)',
  headerGrad: 'linear-gradient(180deg, #1d1410 0%, #120c08 100%)',
  online:     '#4ade80',
}

// Easings de qualidade Apple/Linear
const EASE = {
  spring:  'cubic-bezier(0.34, 1.32, 0.5, 1)',   // overshoot suave
  smooth:  'cubic-bezier(0.32, 0.72, 0, 1)',     // iOS-like
  out:     'cubic-bezier(0.22, 1, 0.36, 1)',
}

// ── ANIMAÇÕES ───────────────────────────────────────────────────────────────
const CSS = `
@keyframes allPanelIn {
  0%   { opacity: 0; transform: translateY(20px) scale(0.96); filter: blur(6px); }
  60%  { opacity: 1; filter: blur(0); }
  100% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
}
@keyframes allBackdropIn { from { opacity: 0 } to { opacity: 1 } }
@keyframes allFabIn { from { opacity: 0; transform: translateY(12px) scale(0.9) } to { opacity: 1; transform: translateY(0) scale(1) } }
@keyframes allMsgIn { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: translateY(0) } }
@keyframes allBreathe {
  0%, 100% { box-shadow: 0 8px 28px rgba(0,0,0,0.45), 0 0 0 0 rgba(212,175,106,0.0), inset 0 1px 0 rgba(255,255,255,0.06); }
  50%      { box-shadow: 0 10px 32px rgba(0,0,0,0.5),  0 0 22px 2px rgba(212,175,106,0.18), inset 0 1px 0 rgba(255,255,255,0.06); }
}
@keyframes allDot   { 0%, 80%, 100% { opacity: 0.25; transform: translateY(0) } 40% { opacity: 1; transform: translateY(-3px) } }
@keyframes allSpin  { to { transform: rotate(360deg) } }
@keyframes allRingPulse {
  0%   { transform: scale(1);   opacity: 0.45 }
  100% { transform: scale(1.6); opacity: 0 }
}
@keyframes allShimmer {
  0%   { background-position: -120% 0 }
  100% { background-position: 220% 0 }
}

.all-msg { animation: allMsgIn .32s ${EASE.out} both; }

.all-fab {
  transition: transform .25s ${EASE.spring}, box-shadow .35s ${EASE.smooth};
  -webkit-tap-highlight-color: transparent;
  box-shadow: 0 8px 28px rgba(0,0,0,0.45), 0 0 0 1px rgba(212,175,106,0.06), inset 0 1px 0 rgba(255,255,255,0.06);
}
.all-fab:active { transform: scale(0.94); }

.all-fab-ring {
  position: absolute; inset: -2px; border-radius: 999px;
  border: 1px solid ${A.gold}; opacity: 0; pointer-events: none;
}
.all-fab.is-pulse .all-fab-ring { animation: allRingPulse 1.6s ${EASE.out} 1; }

.all-close { transition: background .2s ${EASE.smooth}, transform .2s ${EASE.spring}; }
.all-close:hover { background: rgba(255,255,255,0.06); }
.all-close:active { transform: scale(0.92); }

.all-send {
  transition: transform .2s ${EASE.spring}, filter .2s ${EASE.smooth}, box-shadow .25s ${EASE.smooth};
}
.all-send:not(:disabled):hover  { filter: brightness(1.08); }
.all-send:not(:disabled):active { transform: scale(0.92); }

.all-input {
  transition: border-color .25s ${EASE.smooth}, background .25s ${EASE.smooth}, box-shadow .25s ${EASE.smooth};
}
.all-input:focus {
  border-color: ${A.gold};
  background: ${A.surfaceHi};
  box-shadow: 0 0 0 3px ${A.goldDim};
}

.all-action {
  transition: transform .18s ${EASE.spring}, background .2s ${EASE.smooth}, border-color .2s ${EASE.smooth};
}
.all-action:hover  { background: rgba(212,175,106,0.10); border-color: ${A.gold}; }
.all-action:active { transform: scale(0.96); }

.all-scroll::-webkit-scrollbar { width: 4px; }
.all-scroll::-webkit-scrollbar-track { background: transparent; }
.all-scroll::-webkit-scrollbar-thumb { background: rgba(212,175,106,0.18); border-radius: 4px; }

.all-typing-bubble {
  background: linear-gradient(110deg, ${A.surface} 0%, ${A.surfaceHi} 50%, ${A.surface} 100%);
  background-size: 220% 100%;
  animation: allShimmer 2.4s ${EASE.smooth} infinite;
}

@media (prefers-reduced-motion: reduce) {
  .all-fab, .all-fab.is-idle, .all-typing-bubble { animation: none !important; }
  .all-msg { animation: none !important; }
}
`

// ── UTIL ────────────────────────────────────────────────────────────────────
const temConteudoReal = txt => /[\p{L}\p{N}]/u.test(txt || '')
const haptic = (ms = 8) => { try { navigator.vibrate && navigator.vibrate(ms) } catch (_) {} }
function waUrl(reason) {
  const texto = reason && reason.trim() ? reason.trim() : 'Olá, gostaria de falar com a equipe do Araçá Grill.'
  return `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(texto)}`
}

// ── ÍCONES (SVG inline, sem dependências) ───────────────────────────────────
const IconSend = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 2 11 13" /><path d="m22 2-7 20-4-9-9-4 20-7Z" />
  </svg>
)
const IconClose = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 6 6 18" /><path d="m6 6 12 12" />
  </svg>
)
const IconSparkle = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2z" opacity=".95"/>
  </svg>
)
const IconMenu = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </svg>
)
const IconWhats = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20.5 3.5A11 11 0 0 0 3 17l-1 5 5.2-1.3A11 11 0 1 0 20.5 3.5zM12 20a8 8 0 0 1-4.1-1.1l-.3-.2-3.1.8.8-3-.2-.3A8 8 0 1 1 12 20zm4.6-5.8c-.3-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.2.2-.3.2-.6.1a6.5 6.5 0 0 1-3.2-2.8c-.2-.4 0-.5.2-.7l.4-.5c.1-.2.2-.3.3-.5 0-.2 0-.3 0-.5L9.8 8c-.1-.3-.3-.3-.5-.3H8.8c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.4s1.1 2.8 1.2 3a8.4 8.4 0 0 0 3.4 3c.5.2.9.3 1.2.4.5.2.9.1 1.3.1.4-.1 1.2-.5 1.4-1 .2-.4.2-.8.1-.9-.1-.1-.3-.2-.6-.3z"/>
  </svg>
)

// ── AVATAR PREMIUM ──────────────────────────────────────────────────────────
function AllanaAvatar({ size = 40, ring = true, online = false }) {
  const [erro, setErro] = useState(false)
  const ringStyle = ring ? {
    padding: 1.5,
    background: A.goldGrad,
    boxShadow: `0 0 0 1px rgba(0,0,0,0.4) inset, 0 4px 14px ${A.goldGlow}`,
  } : {}
  const inner = {
    width: size, height: size, borderRadius: '50%', display: 'block',
    objectFit: 'cover', background: A.surface,
  }
  return (
    <div style={{ position: 'relative', borderRadius: '50%', flexShrink: 0, ...ringStyle }}>
      {erro ? (
        <div style={{ ...inner, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: A.goldGrad, color: '#1a1410', fontWeight: 800, fontSize: size * 0.42,
          fontFamily: "'Inter',sans-serif", letterSpacing: '-0.02em' }}>
          A
        </div>
      ) : (
        <img src={AVATAR} alt="Allana" style={inner} onError={() => setErro(true)} />
      )}
      {online && (
        <span style={{
          position: 'absolute', right: -1, bottom: -1,
          width: Math.max(10, size * 0.28), height: Math.max(10, size * 0.28),
          borderRadius: '50%', background: A.online,
          border: `2px solid ${A.panel}`,
          boxShadow: `0 0 8px rgba(74,222,128,0.55)`,
        }} />
      )}
    </div>
  )
}

// ── DIGITANDO ───────────────────────────────────────────────────────────────
function Digitando() {
  return (
    <div className="all-msg" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 12 }}>
      <AllanaAvatar size={26} ring={false} />
      <div className="all-typing-bubble" style={{
        border: `1px solid ${A.borderSub}`,
        borderRadius: '16px 16px 16px 6px', padding: '12px 16px',
        display: 'flex', gap: 5, alignItems: 'center',
      }}>
        {[0, 1, 2].map(i => (
          <span key={i} style={{
            width: 6, height: 6, borderRadius: '50%', background: A.gold, display: 'inline-block',
            animation: `allDot 1.3s ${i * 0.16}s infinite ${EASE.smooth}`,
          }} />
        ))}
      </div>
    </div>
  )
}

// ── BOLHA ───────────────────────────────────────────────────────────────────
function Bolha({ msg, onMenu, onWhats }) {
  const ehUser = msg.role === 'user'
  if (ehUser) {
    return (
      <div className="all-msg" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <div style={{
          maxWidth: '80%', background: A.userGrad, color: '#fff',
          borderRadius: '18px 18px 6px 18px', padding: '11px 15px',
          fontSize: 14.5, lineHeight: 1.5, letterSpacing: '-0.005em',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          boxShadow: '0 1px 0 rgba(255,255,255,0.08) inset, 0 4px 14px rgba(181,57,46,0.18), 0 1px 3px rgba(0,0,0,0.4)',
        }}>
          {msg.content}
        </div>
      </div>
    )
  }
  return (
    <div className="all-msg" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 12 }}>
      <AllanaAvatar size={26} ring={false} />
      <div style={{ maxWidth: '82%' }}>
        <div style={{
          background: A.surface, border: `1px solid ${A.borderSub}`, color: A.text,
          borderRadius: '16px 16px 16px 6px', padding: '11px 15px',
          fontSize: 14.5, lineHeight: 1.55, letterSpacing: '-0.005em',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          boxShadow: '0 1px 0 rgba(255,255,255,0.03) inset, 0 2px 8px rgba(0,0,0,0.25)',
        }}>
          {msg.content}
        </div>
        {(msg.showMenuButton || msg.handoff) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            {msg.showMenuButton && (
              <button className="all-action" onClick={onMenu}
                style={{ padding: '8px 14px', border: `1px solid ${A.border}`, borderRadius: 12,
                  background: 'rgba(212,175,106,0.06)', color: A.gold, fontSize: 13, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 7,
                  letterSpacing: '-0.005em' }}>
                <IconMenu /> Ver cardápio
              </button>
            )}
            {msg.handoff && (
              <button className="all-action" onClick={onWhats}
                style={{ padding: '8px 14px', border: 'none', borderRadius: 12,
                  background: A.userGrad, color: '#fff', fontSize: 13, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 7,
                  boxShadow: `0 4px 14px rgba(181,57,46,0.28)`, letterSpacing: '-0.005em' }}>
                <IconWhats /> Falar no WhatsApp
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
  const [kbOffset, setKbOffset] = useState(0)

  const assinaturaUsada = useRef(false)
  const handoffsSemClique = useRef(0)
  const sessionId = useRef(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()))
  const scrollRef = useRef(null)
  const inputRef = useRef(null)
  const interagiu = useRef(false)

  // CSS injetado
  useEffect(() => {
    const el = document.createElement('style')
    el.textContent = CSS
    document.head.appendChild(el)
    return () => { document.head.removeChild(el) }
  }, [])

  // Micro-pulso após 30s sem interação (anel sutil, sem scale exagerado)
  useEffect(() => {
    const t = setTimeout(() => {
      if (!interagiu.current) { setPulso(true); setTimeout(() => setPulso(false), 1700) }
    }, 30000)
    return () => clearTimeout(t)
  }, [])

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [mensagens, carregando])

  // Reposiciona ao subir teclado virtual
  useEffect(() => {
    if (!aberto) return
    const vv = window.visualViewport
    if (!vv) return
    const atualizar = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      setKbOffset(kb)
    }
    vv.addEventListener('resize', atualizar)
    vv.addEventListener('scroll', atualizar)
    atualizar()
    return () => {
      vv.removeEventListener('resize', atualizar)
      vv.removeEventListener('scroll', atualizar)
      setKbOffset(0)
    }
  }, [aberto])

  // ESC fecha
  useEffect(() => {
    if (!aberto) return
    const onKey = (e) => { if (e.key === 'Escape') setAberto(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [aberto])

  const abrir = useCallback(() => {
    interagiu.current = true
    haptic(10)
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
  }, [])

  const fechar = useCallback(() => { haptic(6); setAberto(false) }, [])

  const adicionarBot = useCallback((data) => {
    let content = data.message || ''
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
    if (data.handoff) {
      handoffsSemClique.current += 1
      if (handoffsSemClique.current >= 3) setIaBloqueada(true)
    }
  }, [])

  const enviar = useCallback(async () => {
    const bruto = input.trim()
    if (!bruto || carregando) return
    interagiu.current = true
    haptic(6)
    const texto = bruto.slice(0, 500)
    setInput('')

    if (!temConteudoReal(texto)) {
      setMensagens(prev => [...prev, { role: 'user', content: texto }])
      adicionarBot({ message: 'Posso ajudar com sua reserva? 😊', intent: 'general' })
      return
    }

    const novaUser = { role: 'user', content: texto }
    setMensagens(prev => [...prev, novaUser])

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
      .slice(-10)
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

  const abrirMenu = () => { handoffsSemClique.current = 0; haptic(8); window.open(MENU_URL, '_blank') }
  const abrirWhats = (reason) => { handoffsSemClique.current = 0; haptic(8); window.open(waUrl(reason), '_blank') }
  const onKeyDown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar() } }

  // ── FAB (fechado) ─────────────────────────────────────────────────────────
  if (!aberto) {
    return (
      <button
        className={`all-fab${pulso ? ' is-pulse' : ''}`}
        onClick={abrir}
        aria-label="Abrir chat da Allana, atendente virtual do Araçá Grill"
        style={{
          position: 'fixed',
          right: 16,
          bottom: 'calc(20px + env(safe-area-inset-bottom, 0px))',
          zIndex: 150,
          width: 60, height: 60,
          padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `radial-gradient(120% 120% at 30% 20%, ${A.surfaceHi} 0%, ${A.panel} 60%, ${A.bg} 100%)`,
          border: `1px solid ${A.border}`,
          borderRadius: '50%',
          cursor: 'pointer',
          fontFamily: "'Inter',system-ui,sans-serif",
          animationName: 'allFabIn',
          animationDuration: '.45s',
          animationTimingFunction: EASE.spring,
          animationFillMode: 'both',
          WebkitBackdropFilter: 'blur(10px)',
          backdropFilter: 'blur(10px)',
        }}
      >
        <span className="all-fab-ring" />
        <AllanaAvatar size={48} ring online />
        <span aria-hidden="true" style={{
          position: 'absolute', top: -2, right: -2,
          width: 18, height: 18, borderRadius: '50%',
          background: A.goldGrad, color: '#1a1410',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: `0 2px 8px ${A.goldGlow}, 0 0 0 2px ${A.panel}`,
        }}>
          <IconSparkle size={10} />
        </span>
      </button>
    )
  }

  // ── PAINEL ABERTO ─────────────────────────────────────────────────────────
  return (
    <>
      {/* Backdrop com blur — foco no chat sem cobrir totalmente */}
      <div
        onClick={fechar}
        aria-hidden="true"
        style={{
          position: 'fixed', inset: 0, zIndex: 170,
          background: 'radial-gradient(120% 80% at 80% 100%, rgba(0,0,0,0.55), rgba(0,0,0,0.25))',
          WebkitBackdropFilter: 'blur(6px) saturate(120%)',
          backdropFilter: 'blur(6px) saturate(120%)',
          animation: `allBackdropIn .28s ${EASE.smooth} both`,
        }}
      />

      <div
        role="dialog"
        aria-label="Chat da Allana"
        style={{
          position: 'fixed', zIndex: 180,
          right: 16,
          bottom: `calc(20px + env(safe-area-inset-bottom, 0px) + ${kbOffset}px)`,
          width: 'min(384px, calc(100vw - 24px))',
          height: `min(600px, calc(100vh - 100px - ${kbOffset}px))`,
          display: 'flex', flexDirection: 'column',
          background: `linear-gradient(180deg, ${A.panel} 0%, ${A.bg} 100%)`,
          border: `1px solid ${A.border}`,
          borderRadius: 22,
          overflow: 'hidden',
          fontFamily: "'Inter',system-ui,sans-serif",
          color: A.text,
          boxShadow:
            '0 1px 0 rgba(255,255,255,0.04) inset, ' +
            '0 24px 60px rgba(0,0,0,0.6), ' +
            '0 8px 24px rgba(0,0,0,0.4), ' +
            `0 0 0 1px ${A.goldDim}`,
          animation: `allPanelIn .42s ${EASE.spring} both`,
          transformOrigin: 'bottom right',
          WebkitBackdropFilter: 'blur(20px) saturate(140%)',
          backdropFilter: 'blur(20px) saturate(140%)',
        }}
      >
        {/* Header refinado */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '14px 14px 14px 16px',
          background: A.headerGrad,
          borderBottom: `1px solid ${A.border}`,
          flexShrink: 0,
          position: 'relative',
        }}>
          {/* hairline dourada no topo */}
          <span style={{
            position: 'absolute', left: 16, right: 16, top: 0, height: 1,
            background: `linear-gradient(90deg, transparent, ${A.gold}, transparent)`,
            opacity: 0.6,
          }} />
          <AllanaAvatar size={40} ring online />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 15, fontWeight: 700, color: A.text,
              letterSpacing: '-0.015em', display: 'flex', alignItems: 'center', gap: 6,
            }}>
              Allana
              <span style={{ color: A.gold, display: 'inline-flex' }}><IconSparkle size={11} /></span>
            </div>
            <div style={{
              fontSize: 11.5, color: A.textMuted, display: 'flex', alignItems: 'center', gap: 6,
              letterSpacing: '0.005em', marginTop: 1,
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%', background: A.online,
                boxShadow: `0 0 6px rgba(74,222,128,0.7)`,
              }} />
              Atendente virtual · online
            </div>
          </div>
          <button className="all-close" onClick={fechar} aria-label="Fechar chat"
            style={{
              width: 32, height: 32, borderRadius: 10,
              border: `1px solid ${A.borderSub}`,
              background: 'rgba(255,255,255,0.02)', color: A.textMuted,
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
            <IconClose />
          </button>
        </div>

        {/* Mensagens */}
        <div
          ref={scrollRef}
          className="all-scroll"
          style={{
            flex: 1, overflowY: 'auto', padding: '18px 14px 8px',
            background: `radial-gradient(80% 50% at 50% 0%, rgba(212,175,106,0.04), transparent 70%)`,
            scrollBehavior: 'smooth',
          }}
        >
          {mensagens.map((m, i) => (
            <Bolha key={i} msg={m} onMenu={abrirMenu} onWhats={() => abrirWhats(m.handoffReason)} />
          ))}
          {carregando && <Digitando />}
        </div>

        {/* Input premium */}
        <div style={{
          display: 'flex', gap: 8, alignItems: 'flex-end',
          padding: '10px 12px calc(12px + env(safe-area-inset-bottom, 0px))',
          borderTop: `1px solid ${A.borderSub}`,
          background: `linear-gradient(180deg, ${A.panelSoft}, ${A.panel})`,
          flexShrink: 0,
        }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Pergunte algo à Allana…"
              maxLength={500}
              disabled={carregando}
              className="all-input"
              style={{
                width: '100%',
                padding: '13px 16px',
                border: `1px solid ${A.borderSub}`,
                borderRadius: 14,
                background: A.surface,
                color: A.text,
                fontSize: 14.5, fontFamily: 'inherit', outline: 'none',
                caretColor: A.gold,
                boxSizing: 'border-box',
                letterSpacing: '-0.005em',
              }}
            />
          </div>
          <button
            className="all-send"
            onClick={enviar}
            disabled={carregando || !input.trim()}
            aria-label="Enviar mensagem"
            style={{
              width: 46, height: 46, flexShrink: 0,
              border: 'none', borderRadius: 14,
              background: (carregando || !input.trim()) ? A.surface : A.goldGrad,
              color: (carregando || !input.trim()) ? A.textDim : '#1a1410',
              cursor: (carregando || !input.trim()) ? 'default' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: (carregando || !input.trim())
                ? 'none'
                : `0 4px 14px ${A.goldGlow}, 0 1px 0 rgba(255,255,255,0.2) inset`,
            }}
          >
            {carregando ? (
              <span style={{
                width: 16, height: 16,
                border: '2px solid rgba(255,255,255,0.25)',
                borderTopColor: A.gold,
                borderRadius: '50%', display: 'inline-block',
                animation: 'allSpin 0.8s linear infinite',
              }} />
            ) : <IconSend />}
          </button>
        </div>
      </div>
    </>
  )
}
