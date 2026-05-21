import { useState, useEffect, useMemo, useRef } from 'react'
import { db } from './firebase'
import { collection, addDoc } from 'firebase/firestore'
import AllanaChat from './AllanaChat.jsx'

// Número fixo para encaminhamento das reservas
const WHATSAPP_RESERVAS = '5518991850160'

// ── CORES ─────────────────────────────────────────────────────────────────
const C = {
  bg:        '#070503',
  bgCard:    '#0f0c09',
  bgCard2:   '#171310',
  bgCard3:   '#1e1a15',
  bgCard4:   '#251f19',
  border:    '#2a2118',
  borderSub: '#1e1812',
  gold:      '#c9a96e',
  goldL:     '#e4c17a',
  goldD:     '#8a6820',
  goldXD:    '#5a4210',
  text:      '#f0ece4',
  textMuted: '#7a6a58',
  textDim:   '#4a3a2a',
  danger:    '#a8322a',
  dangerBg:  'rgba(168,50,42,0.10)',
  success:   '#2e7d52',
  gold8:     'rgba(201,169,110,0.08)',
  gold15:    'rgba(201,169,110,0.15)',
  gold25:    'rgba(201,169,110,0.25)',
  gold40:    'rgba(201,169,110,0.40)',
}

// ── FERIADOS NACIONAIS ───────────────────────────────────────────────────
const FERIADOS = new Set([
  '2025-01-01','2025-03-03','2025-03-04','2025-04-18','2025-04-21',
  '2025-05-01','2025-06-19','2025-09-07','2025-10-12','2025-11-02',
  '2025-11-15','2025-11-20','2025-12-25',
  '2026-01-01','2026-02-16','2026-02-17','2026-04-03','2026-04-21',
  '2026-05-01','2026-06-04','2026-09-07','2026-10-12','2026-11-02',
  '2026-11-15','2026-11-20','2026-12-25',
])

// ── ESPAÇOS ──────────────────────────────────────────────────────────────
const ESPACOS = [
  { id:'kids',          icon:'🧸', titulo:'ESPAÇO KIDS',             sub:'Playground 2 Andares · Pula-pula', badge:'PERFEITO P/ FAMÍLIAS',
    gradient:'linear-gradient(145deg, #1a0f2e 0%, #2d1550 55%, #180c26 100%)',
    iconBig:'🧸', accent:'#c97ed8' },
  { id:'palco',         icon:'🎵', titulo:'PRÓXIMO AO PALCO',        sub:'Som Vibrante · Experiência Vivida',
    gradient:'linear-gradient(145deg, #0a0b22 0%, #15184a 55%, #080a1e 100%)',
    iconBig:'🎶', accent:'#7b84e8' },
  { id:'churrasqueira', icon:'🔥', titulo:'CHURRASQUEIRA + TV',      sub:'Sabor e entretenimento',
    gradient:'linear-gradient(145deg, #1e0500 0%, #3d0e00 55%, #220600 100%)',
    iconBig:'🔥', accent:'#e07840' },
  { id:'meio',          icon:'🌿', titulo:'MEIO DO SALÃO',           sub:'Teto Retrátil · Ar Livre',
    gradient:'linear-gradient(145deg, #051a0c 0%, #0c2d18 55%, #051a0c 100%)',
    iconBig:'🌿', accent:'#5db87a' },
  { id:'banheiros',     icon:'🚶', titulo:'FUNDO DO SALÃO',          sub:'Próx. aos banheiros',
    gradient:'linear-gradient(145deg, #0c0c14 0%, #181826 55%, #0c0c14 100%)',
    iconBig:'🏛️', accent:'#8aaccc' },
  { id:'qualquer',      icon:'✨', titulo:'SEM PREFERÊNCIAS',        sub:'Em qualquer lugar do salão',
    gradient:'linear-gradient(145deg, #18120400 0%, #2c1e04 55%, #18120400 100%)',
    iconBig:'✨', accent:'#c9a96e' },
]

// ── UTILS ─────────────────────────────────────────────────────────────────
const toDateStr = d => {
  const y = d.getFullYear()
  const m = String(d.getMonth()+1).padStart(2,'0')
  const day = String(d.getDate()).padStart(2,'0')
  return `${y}-${m}-${day}`
}

const getDow = dateStr => new Date(dateStr+'T12:00:00').getDay() // 0=Dom,6=Sab

const isFeriado = dateStr => FERIADOS.has(dateStr)

const isWeekendOuFeriado = dateStr => {
  const dow = getDow(dateStr)
  return dow === 0 || dow === 6 || isFeriado(dateStr)
}

const temAlmoco = dateStr => dateStr ? isWeekendOuFeriado(dateStr) : false

const gerarHorarios = (periodo, dateStr) => {
  if (!dateStr || !periodo) return []
  const dow = getDow(dateStr)
  const isWEF = isWeekendOuFeriado(dateStr)
  if (periodo === 'almoco') {
    if (!temAlmoco(dateStr)) return []
    return ['11:00','11:30','12:00','12:30']
  }
  if (periodo === 'jantar') {
    const startH = isWEF ? 19 : dow === 5 ? 18 : 17
    const slots = []
    for (let h = startH; h <= 20; h++) {
      slots.push(`${String(h).padStart(2,'0')}:00`)
      if (h < 20) slots.push(`${String(h).padStart(2,'0')}:30`)
    }
    slots.push('20:30')
    return [...new Set(slots)].sort()
  }
  return []
}

const fmtDataExtenso = dateStr => {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-')
  const dt = new Date(Number(y), Number(m)-1, Number(d))
  const dias = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado']
  const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro']
  return `${dias[dt.getDay()]}, ${d} de ${meses[dt.getMonth()]} de ${y}`
}

const fmtTelWhatsApp = tel => {
  const n = tel.replace(/\D/g,'')
  if (n.length === 11) return `+55 ${n.slice(0,2)} ${n.slice(2,7)}-${n.slice(7)}`
  if (n.length === 13 && n.startsWith('55')) return `+${n.slice(0,2)} ${n.slice(2,4)} ${n.slice(4,9)}-${n.slice(9)}`
  return tel
}

const fmtTelDisplay = raw => {
  const n = raw.replace(/\D/g,'').slice(0,11)
  if (n.length <= 2) return n
  if (n.length <= 7) return `(${n.slice(0,2)}) ${n.slice(2)}`
  return `(${n.slice(0,2)}) ${n.slice(2,7)}-${n.slice(7)}`
}

// ── CSS ANIMATIONS ───────────────────────────────────────────────────────
const ANIM_CSS = `
@keyframes fadeUp {
  from { opacity:0; transform:translateY(16px) }
  to   { opacity:1; transform:translateY(0) }
}
@keyframes goldGlow {
  0%,100% { box-shadow: 0 0 0 0 rgba(201,169,110,0.0) }
  50%      { box-shadow: 0 0 18px 4px rgba(201,169,110,0.18) }
}
@keyframes successPop {
  0%   { opacity:0; transform:scale(0.7) }
  60%  { transform:scale(1.08) }
  100% { opacity:1; transform:scale(1) }
}
@keyframes ripple {
  from { transform:scale(0); opacity:0.5 }
  to   { transform:scale(2.5); opacity:0 }
}
@keyframes shimmerSlide {
  0%   { background-position:-200% 0 }
  100% { background-position:200% 0 }
}
@keyframes spin {
  to { transform:rotate(360deg) }
}
.card-entrada { animation: fadeUp 0.4s ease both }
.espaco-card:hover { transform:translateY(-2px); transition:transform 0.2s ease }
`

// ── CALENDÁRIO ───────────────────────────────────────────────────────────
function Calendario({ selectedDate, onSelect, onClose }) {
  const hoje = toDateStr(new Date())
  const [mes, setMes] = useState(() => {
    if (selectedDate) {
      const [y,m] = selectedDate.split('-')
      return new Date(Number(y), Number(m)-1, 1)
    }
    return new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  })

  const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro']
  const nomeMes = `${MESES[mes.getMonth()]} ${mes.getFullYear()}`

  const diasGrid = useMemo(() => {
    const ano = mes.getFullYear(), m = mes.getMonth()
    const primeiro = new Date(ano, m, 1)
    const ultimo = new Date(ano, m+1, 0)
    const offset = (primeiro.getDay() + 6) % 7 // Mon=0 ... Sun=6
    const dias = Array(offset).fill(null)
    for (let d = 1; d <= ultimo.getDate(); d++) dias.push(toDateStr(new Date(ano, m, d)))
    return dias
  }, [mes])

  const podePrevMes = () => {
    const t = new Date(); return mes > new Date(t.getFullYear(), t.getMonth(), 1)
  }
  const prevM = () => podePrevMes() && setMes(m => new Date(m.getFullYear(), m.getMonth()-1, 1))
  const nextM = () => setMes(m => new Date(m.getFullYear(), m.getMonth()+1, 1))

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', zIndex:200,
      display:'flex', alignItems:'flex-end', backdropFilter:'blur(8px)' }}
      onClick={e => e.target===e.currentTarget && onClose()}>
      <div style={{ background:C.bgCard2, borderRadius:'24px 24px 0 0', padding:'20px 20px 40px',
        width:'100%', maxWidth:480, margin:'0 auto', border:`1px solid ${C.border}`, borderBottom:'none' }}>
        <div style={{ width:40, height:4, background:C.border, borderRadius:2, margin:'0 auto 20px' }} />

        {/* Nav mês */}
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <button onClick={prevM} disabled={!podePrevMes()}
            style={{ width:40, height:40, border:`1px solid ${C.border}`, borderRadius:12,
              background: podePrevMes()?C.bgCard3:'transparent',
              color: podePrevMes()?C.gold:C.textDim, fontSize:20, cursor:'pointer',
              display:'flex', alignItems:'center', justifyContent:'center' }}>‹</button>
          <span style={{ fontSize:16, fontWeight:700, color:C.text, letterSpacing:'-0.02em' }}>{nomeMes}</span>
          <button onClick={nextM}
            style={{ width:40, height:40, border:`1px solid ${C.border}`, borderRadius:12,
              background:C.bgCard3, color:C.gold, fontSize:20, cursor:'pointer',
              display:'flex', alignItems:'center', justifyContent:'center' }}>›</button>
        </div>

        {/* Cabeçalho dias */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:2, marginBottom:8 }}>
          {['SEG','TER','QUA','QUI','SEX','SÁB','DOM'].map(d => (
            <div key={d} style={{ textAlign:'center', fontSize:9, fontWeight:700,
              color: d==='SÁB'||d==='DOM' ? C.goldD : C.textDim,
              padding:'4px 0', letterSpacing:'0.04em' }}>{d}</div>
          ))}
        </div>

        {/* Grade de dias */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:4 }}>
          {diasGrid.map((ds, i) => {
            if (!ds) return <div key={i} />
            const passado = ds < hoje
            const isHoje = ds === hoje
            const isSel = ds === selectedDate
            const dow = getDow(ds)
            const isWE = dow===0||dow===6
            const isFer = isFeriado(ds)
            return (
              <button key={ds} onClick={() => !passado && onSelect(ds) && onClose()}
                disabled={passado}
                style={{ border: isSel ? `1.5px solid ${C.gold}` : `1px solid ${passado?'transparent':C.border}`,
                  borderRadius:10, padding:'9px 2px',
                  background: isSel ? C.gold15 : passado ? 'transparent' : isHoje ? C.gold8 : C.bgCard3,
                  color: passado ? C.textDim : isSel ? C.goldL : isWE||isFer ? C.gold+'bb' : C.text,
                  fontSize:13, fontWeight: isSel||isHoje ? 700 : 400,
                  cursor: passado ? 'default' : 'pointer',
                  position:'relative', transition:'all 0.15s',
                  boxShadow: isSel ? `0 0 12px ${C.gold25}` : 'none' }}>
                {new Date(ds+'T12:00:00').getDate()}
                {isHoje && !isSel && (
                  <div style={{ position:'absolute', bottom:3, left:'50%', transform:'translateX(-50%)',
                    width:4, height:4, borderRadius:'50%', background:C.gold }} />
                )}
                {isFer && (
                  <div style={{ position:'absolute', top:2, right:3,
                    width:4, height:4, borderRadius:'50%', background:'#e74c3c' }} />
                )}
              </button>
            )
          })}
        </div>

        <div style={{ marginTop:16, display:'flex', gap:12, fontSize:10, color:C.textDim, justifyContent:'center' }}>
          <span>● Hoje</span>
          <span style={{color:'#e74c3c'}}>● Feriado</span>
          <span style={{color:C.goldD}}>● Fim de semana</span>
        </div>
      </div>
    </div>
  )
}

// ── CARD DE ESPAÇO ────────────────────────────────────────────────────────
function EspacoCard({ espaco, selecionado, onSelect }) {
  const [pressed, setPressed] = useState(false)
  const [hovered, setHovered] = useState(false)
  return (
    <button
      className="espaco-card"
      onClick={() => { setPressed(true); setTimeout(()=>setPressed(false),200); onSelect(espaco.id) }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        border: selecionado ? `1.5px solid ${C.gold}` : `1px solid ${hovered ? espaco.accent+'55' : C.border}`,
        borderRadius:16,
        background: espaco.gradient,
        padding:0,
        cursor:'pointer', textAlign:'left', position:'relative', overflow:'hidden',
        height:155,
        boxShadow: selecionado
          ? `0 0 0 2px ${C.gold}, 0 0 28px rgba(201,169,110,0.22), 0 8px 24px rgba(0,0,0,0.55)`
          : hovered
            ? `0 6px 20px rgba(0,0,0,0.5), 0 0 0 1px ${espaco.accent}44`
            : '0 2px 10px rgba(0,0,0,0.4)',
        transform: pressed ? 'scale(0.96)' : hovered ? 'translateY(-3px)' : 'scale(1)',
        transition:'all 0.22s cubic-bezier(0.34,1.56,0.64,1)',
      }}>

      {/* Emoji decorativo de fundo */}
      <div style={{ position:'absolute', top:'50%', left:'50%',
        transform:'translate(-50%,-62%)',
        fontSize:74, opacity: selecionado ? 0.32 : hovered ? 0.22 : 0.14,
        filter:'blur(1px)', pointerEvents:'none', userSelect:'none',
        transition:'opacity 0.3s', lineHeight:1 }}>
        {espaco.iconBig}
      </div>

      {/* Gradiente escurecendo base */}
      <div style={{ position:'absolute', bottom:0, left:0, right:0, height:'68%',
        background:'linear-gradient(to top, rgba(0,0,0,0.88) 0%, transparent 100%)',
        pointerEvents:'none' }} />

      {/* Faixa de acento no topo quando selecionado */}
      {selecionado && (
        <div style={{ position:'absolute', top:0, left:0, right:0, height:2,
          background:`linear-gradient(to right, transparent, ${espaco.accent}, transparent)` }} />
      )}

      {/* Conteúdo no rodapé */}
      <div style={{ position:'absolute', bottom:0, left:0, right:0, padding:'10px 12px 12px' }}>
        <div style={{ fontSize:10, fontWeight:800,
          color: selecionado ? C.gold : C.text,
          letterSpacing:'0.06em', textTransform:'uppercase',
          marginBottom:2, transition:'color 0.2s', lineHeight:1.2 }}>
          {espaco.titulo}
        </div>
        <div style={{ fontSize:9.5, color: selecionado ? espaco.accent : C.textDim,
          lineHeight:1.35, transition:'color 0.2s' }}>
          {espaco.sub}
        </div>
        {espaco.badge && (
          <div style={{ marginTop:5, display:'inline-block',
            background:'rgba(201,169,110,0.14)',
            border:`1px solid rgba(201,169,110,0.28)`,
            borderRadius:4, padding:'2px 6px',
            fontSize:7, fontWeight:800, color:C.gold, letterSpacing:'0.06em' }}>
            {espaco.badge}
          </div>
        )}
      </div>

      {/* Checkmark selecionado */}
      {selecionado && (
        <div style={{ position:'absolute', top:8, right:8,
          width:22, height:22, borderRadius:'50%',
          background:`linear-gradient(135deg,${C.goldD},${C.gold})`,
          display:'flex', alignItems:'center', justifyContent:'center',
          fontSize:11, color:'#0a0806', fontWeight:900,
          boxShadow:`0 0 10px ${C.gold40}`, animation:'goldGlow 2s infinite' }}>
          ✓
        </div>
      )}
    </button>
  )
}

// ── MODAL CONFIRMAÇÃO ─────────────────────────────────────────────────────
function ModalConfirmacao({ dados, onFinalizar, onCancelar, loading }) {
  const [aceite, setAceite] = useState(false)
  const espaco = ESPACOS.find(e => e.id===dados.local)

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.88)', zIndex:300,
      display:'flex', alignItems:'flex-end', backdropFilter:'blur(16px)' }}>
      <div style={{ background:C.bgCard, borderRadius:'28px 28px 0 0',
        padding:'24px 24px 48px', width:'100%', maxWidth:480, margin:'0 auto',
        border:`1px solid ${C.border}`, borderBottom:'none',
        boxShadow:'0 -20px 60px rgba(0,0,0,0.6)',
        animation:'fadeUp 0.35s ease' }}>

        <div style={{ width:40, height:4, background:C.border, borderRadius:2, margin:'0 auto 24px' }} />

        {/* Título */}
        <div style={{ marginBottom:4 }}>
          <div style={{ fontSize:8, fontWeight:800, color:C.goldD, letterSpacing:'0.15em',
            textTransform:'uppercase', marginBottom:6 }}>ARACÁ GRILL</div>
          <div style={{ fontSize:22, fontWeight:800, color:C.text, letterSpacing:'-0.02em' }}>
            Confirmação da reserva
          </div>
          <div style={{ width:48, height:2, background:`linear-gradient(to right,${C.gold},transparent)`,
            marginTop:8, marginBottom:20 }} />
        </div>

        {/* Resumo da reserva */}
        <div style={{ background:C.bgCard2, border:`1px solid ${C.border}`, borderRadius:16,
          padding:'14px 16px', marginBottom:16 }}>
          {[
            ['👤 Nome', dados.nome],
            ['📱 Telefone', fmtTelWhatsApp(dados.telefone)],
            ['👥 Pessoas', `${dados.pessoas} pessoa${dados.pessoas>1?'s':''}`],
            ['📅 Data', fmtDataExtenso(dados.data)],
            ['🌅 Período', dados.periodo==='almoco'?'Almoço':'Jantar'],
            ['🕐 Horário', dados.horario],
            ['📍 Local', espaco?.titulo||dados.local],
          ].map(([k,v])=>(
            <div key={k} style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start',
              padding:'6px 0', borderBottom:`1px solid ${C.borderSub}` }}>
              <span style={{ fontSize:11, color:C.textMuted }}>{k}</span>
              <span style={{ fontSize:12, fontWeight:600, color:C.text, textAlign:'right', maxWidth:'60%' }}>{v}</span>
            </div>
          ))}
        </div>

        {/* Regras */}
        <div style={{ background:C.gold8, border:`1px solid ${C.gold15}`, borderRadius:16,
          padding:'16px', marginBottom:20 }}>
          <div style={{ fontSize:12, fontWeight:700, color:C.gold, marginBottom:8 }}>📋 Regras da reserva</div>
          <p style={{ color:C.textMuted, fontSize:12, lineHeight:1.7, margin:0 }}>
            Estou ciente de que todos os integrantes da reserva devem chegar até o horário limite informado.
            <br/><br/>
            <span style={{color:C.gold,fontWeight:600}}>Reservas de almoço:</span> Chegada até 12h30.
            <br/>
            <span style={{color:C.gold,fontWeight:600}}>Reservas de jantar:</span> Chegada até 20h30.
            <br/><br/>
            Após o horário limite, a reserva poderá ser cancelada automaticamente.
          </p>
        </div>

        {/* Checkbox aceite */}
        <label style={{ display:'flex', alignItems:'flex-start', gap:12, cursor:'pointer', marginBottom:20 }}>
          <div onClick={()=>setAceite(a=>!a)}
            style={{ width:22, height:22, borderRadius:6, flexShrink:0, marginTop:1,
              border: aceite ? `1.5px solid ${C.gold}` : `1.5px solid ${C.border}`,
              background: aceite ? C.gold : C.bgCard3,
              display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:13, cursor:'pointer', transition:'all 0.2s',
              boxShadow: aceite ? `0 0 10px ${C.gold25}` : 'none' }}>
            {aceite && <span style={{ color:'#0a0806', fontWeight:900, lineHeight:1 }}>✓</span>}
          </div>
          <span style={{ fontSize:13, color:C.text, lineHeight:1.5 }}>
            Li e estou ciente das regras da reserva
          </span>
        </label>

        {/* Botão finalizar */}
        <button onClick={() => aceite && !loading && onFinalizar()} disabled={!aceite||loading}
          style={{ width:'100%', padding:'18px',
            background: aceite
              ? `linear-gradient(135deg, ${C.goldXD} 0%, ${C.goldD} 40%, ${C.gold} 100%)`
              : C.bgCard3,
            border:`1px solid ${aceite?C.gold:C.border}`, borderRadius:16,
            fontSize:16, fontWeight:800, letterSpacing:'-0.01em',
            color: aceite ? '#050301' : C.textDim,
            cursor: aceite&&!loading ? 'pointer' : 'default',
            transition:'all 0.3s',
            boxShadow: aceite ? `0 4px 24px ${C.gold25}` : 'none' }}>
          {loading
            ? <span style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:10 }}>
                <span style={{ width:18, height:18, border:`2px solid rgba(5,3,1,0.3)`,
                  borderTopColor:'#050301', borderRadius:'50%', display:'inline-block',
                  animation:'spin 0.8s linear infinite' }} />
                Enviando...
              </span>
            : '✓ Finalizar reserva'}
        </button>

        <button onClick={onCancelar}
          style={{ width:'100%', marginTop:12, padding:'14px', background:'transparent',
            border:'none', color:C.textMuted, fontSize:14, cursor:'pointer', fontFamily:'inherit' }}>
          ← Voltar e editar
        </button>
      </div>
    </div>
  )
}

// ── TELA SUCESSO ──────────────────────────────────────────────────────────
function TelaSuccesso({ onNova }) {
  return (
    <div style={{ minHeight:'100vh', background:C.bg, display:'flex', flexDirection:'column',
      alignItems:'center', justifyContent:'center', padding:32, textAlign:'center',
      fontFamily:"'Inter',system-ui,sans-serif" }}>
      <div style={{ width:88, height:88, borderRadius:'50%',
        background:`radial-gradient(circle at 40% 40%, ${C.bgCard4}, ${C.bgCard2})`,
        border:`2px solid ${C.gold}`, display:'flex', alignItems:'center', justifyContent:'center',
        fontSize:40, marginBottom:28,
        boxShadow:`0 0 40px ${C.gold25}, 0 0 80px ${C.gold8}`,
        animation:'successPop 0.5s cubic-bezier(0.34,1.56,0.64,1) both' }}>
        ✓
      </div>
      <div style={{ fontSize:8, fontWeight:800, color:C.goldD, letterSpacing:'0.18em',
        textTransform:'uppercase', marginBottom:10 }}>ARACÁ GRILL</div>
      <h2 style={{ fontSize:26, fontWeight:800, color:C.gold, margin:'0 0 12px',
        letterSpacing:'-0.03em', animation:'fadeUp 0.4s ease 0.2s both' }}>
        Reserva enviada!
      </h2>
      <p style={{ fontSize:15, color:C.textMuted, lineHeight:1.7, maxWidth:300, margin:'0 0 12px',
        animation:'fadeUp 0.4s ease 0.3s both' }}>
        Sua reserva foi enviada com sucesso.
      </p>
      <p style={{ fontSize:13, color:C.textDim, lineHeight:1.6, maxWidth:280, margin:'0 0 36px',
        animation:'fadeUp 0.4s ease 0.4s both' }}>
        Você está sendo redirecionado ao WhatsApp do restaurante para confirmação da reserva.
      </p>
      <button onClick={onNova}
        style={{ padding:'14px 32px', border:`1px solid ${C.border}`, borderRadius:14,
          background:C.bgCard2, color:C.textMuted, fontSize:14, cursor:'pointer',
          fontFamily:'inherit', animation:'fadeUp 0.4s ease 0.5s both' }}>
        Fazer nova reserva
      </button>
    </div>
  )
}

// ── CAMPO DE INPUT PREMIUM ────────────────────────────────────────────────
function Campo({ label, children, icon }) {
  return (
    <div style={{ marginBottom:20 }}>
      <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:10 }}>
        {icon && <span style={{ fontSize:14 }}>{icon}</span>}
        <span style={{ fontSize:9, fontWeight:800, color:C.goldD, letterSpacing:'0.15em',
          textTransform:'uppercase' }}>{label}</span>
      </div>
      {children}
    </div>
  )
}

// ── INPUT ESTILIZADO ──────────────────────────────────────────────────────
function Input({ value, onChange, placeholder, type='text', inputMode, required }) {
  const [focused, setFocused] = useState(false)
  return (
    <input value={value} onChange={onChange} placeholder={placeholder}
      type={type} inputMode={inputMode}
      onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}
      style={{ width:'100%', padding:'16px 18px',
        border:`1.5px solid ${focused?(required&&!value?C.danger:C.gold):C.border}`,
        borderRadius:14, background:C.bgCard3, color:C.text,
        fontSize:16, fontFamily:'inherit', boxSizing:'border-box', outline:'none',
        transition:'border-color 0.2s, box-shadow 0.2s',
        boxShadow: focused ? `0 0 0 3px ${C.gold8}` : 'none',
        caretColor:C.gold }} />
  )
}

// ── SELETOR DE PESSOAS ────────────────────────────────────────────────────
function SeletorPessoas({ value, onChange }) {
  const quick = [2,4,6,8,10,15,20,30]
  const dec = () => onChange(Math.max(1, value - 1))
  const inc = () => onChange(Math.min(99, value + 1))
  return (
    <div>
      {/* Contador principal */}
      <div style={{ display:'flex', alignItems:'center', gap:16, marginBottom:14 }}>
        <div style={{ display:'flex', alignItems:'center', overflow:'hidden',
          background:C.bgCard3, border:`1px solid ${C.border}`, borderRadius:14 }}>
          <button onClick={dec} disabled={value<=1}
            style={{ width:52, height:56, border:'none', borderRight:`1px solid ${C.borderSub}`,
              background:'transparent', color: value<=1 ? C.textDim : C.gold,
              fontSize:26, fontWeight:300, cursor: value<=1?'not-allowed':'pointer',
              fontFamily:'inherit', transition:'color 0.15s', lineHeight:1 }}>
            −
          </button>
          <div style={{ minWidth:72, textAlign:'center', padding:'0 4px' }}>
            <span style={{ fontSize:28, fontWeight:800, color:C.text,
              fontVariantNumeric:'tabular-nums', letterSpacing:'-0.02em' }}>
              {value}
            </span>
          </div>
          <button onClick={inc} disabled={value>=99}
            style={{ width:52, height:56, border:'none', borderLeft:`1px solid ${C.borderSub}`,
              background:'transparent', color: value>=99 ? C.textDim : C.gold,
              fontSize:26, fontWeight:300, cursor: value>=99?'not-allowed':'pointer',
              fontFamily:'inherit', transition:'color 0.15s', lineHeight:1 }}>
            +
          </button>
        </div>
        <span style={{ fontSize:14, color:C.textMuted }}>
          pessoa{value>1?'s':''}
        </span>
      </div>
      {/* Atalhos rápidos */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:7 }}>
        {quick.map(n => (
          <button key={n} onClick={() => onChange(n)}
            style={{ padding:'7px 14px', border:`1.5px solid ${value===n?C.gold:C.border}`,
              borderRadius:10, background: value===n ? C.gold15 : C.bgCard3,
              color: value===n ? C.gold : C.textMuted,
              fontSize:12, fontWeight: value===n?700:400,
              cursor:'pointer', fontFamily:'inherit', transition:'all 0.15s',
              boxShadow: value===n ? `0 0 10px ${C.gold15}` : 'none' }}>
            {n}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── COMPONENTE PRINCIPAL ──────────────────────────────────────────────────
export default function PaginaReservas() {
  const [nome, setNome]           = useState('')
  const [telefone, setTelefone]   = useState('')
  const [pessoas, setPessoas]     = useState(2)
  const [dataSel, setDataSel]     = useState('')
  const [periodo, setPeriodo]     = useState('')
  const [horario, setHorario]     = useState('')
  const [obs, setObs]             = useState('')
  const [local, setLocal]         = useState('')
  const [mostraCalendario, setMostraCalendario] = useState(false)
  const [mostraModal, setMostraModal] = useState(false)
  const [loading, setLoading]     = useState(false)
  const [sucesso, setSucesso]     = useState(false)
  const whatsapp = WHATSAPP_RESERVAS
  const [grandeGrupoOk, setGrandeGrupoOk] = useState(false)
  const horarioRef = useRef(null)

  const handlePessoas = n => { setPessoas(n); setGrandeGrupoOk(false) }

  // Injeta CSS de animações
  useEffect(() => {
    const el = document.createElement('style')
    el.textContent = ANIM_CSS
    document.head.appendChild(el)
    return () => document.head.removeChild(el)
  }, [])

  // Auto-seleciona jantar quando data escolhida não tem almoço
  useEffect(() => {
    if (dataSel && !temAlmoco(dataSel)) {
      setPeriodo(prev => (prev === 'almoco' || prev === '') ? 'jantar' : prev)
    }
    setHorario('')
  }, [dataSel])

  useEffect(() => { setHorario('') }, [periodo])

  const horarios = useMemo(() => gerarHorarios(periodo, dataSel), [periodo, dataSel])

  const canAlmoco = dataSel ? temAlmoco(dataSel) : true

  const precisaConfirmarGrupo = pessoas > 25 && !grandeGrupoOk
  const podeEnviar = nome.trim() && telefone.trim().replace(/\D/g,'').length>=10
    && dataSel && periodo && horario && local && !precisaConfirmarGrupo

  const handleData = ds => { setDataSel(ds); setMostraCalendario(false) }

  const handleConfirmar = async () => {
    setLoading(true)
    const reserva = {
      nome: nome.trim(), telefone: telefone.trim(), pessoas: String(pessoas),
      data: dataSel, periodo, horario,
      observacoes: obs.trim() || '', local,
      status: 'Pendente', criado_em: new Date().toISOString(),
    }

    try {
      await addDoc(collection(db, 'reservas_clientes'), reserva)
    } catch(e) { console.warn('Firebase:', e) }

    const espaco = ESPACOS.find(e=>e.id===local)?.titulo || local
    const periodoLabel = periodo==='almoco' ? 'Almoço' : 'Jantar'
    const msg = `#PRE-RESERVA-ARACA

Olá 😊
Acabei de realizar minha pré-reserva pelo site do Araçá Grill e gostaria de continuar meu atendimento por aqui.

Nome:
${nome.trim()}

Telefone:
${fmtTelWhatsApp(telefone.trim())}

Quantidade de pessoas:
${pessoas} pessoa${pessoas>1?'s':''}

Data:
${fmtDataExtenso(dataSel)}

Período:
${periodoLabel}

Horário:
${horario}

Local desejado:
${espaco}

Observações:
${obs.trim()||'Nenhuma'}`

    setLoading(false)
    setMostraModal(false)
    setSucesso(true)
    setTimeout(() => {
      window.open(`https://wa.me/${whatsapp}?text=${encodeURIComponent(msg)}`, '_blank')
    }, 3000)
  }

  if (sucesso) return <TelaSuccesso onNova={()=>{
    setSucesso(false); setNome(''); setTelefone(''); setPessoas(2)
    setDataSel(''); setPeriodo(''); setHorario(''); setObs(''); setLocal('')
    setGrandeGrupoOk(false)
  }} />

  const inputBase = {
    width:'100%', padding:'16px 18px',
    border:`1.5px solid ${C.border}`, borderRadius:14,
    background:C.bgCard3, color:C.text, fontSize:16,
    fontFamily:'inherit', boxSizing:'border-box', outline:'none',
    caretColor:C.gold,
  }

  const sectionCard = {
    background:C.bgCard, border:`1px solid ${C.border}`, borderRadius:20,
    padding:'22px 20px', marginBottom:14,
    boxShadow:'0 4px 20px rgba(0,0,0,0.4)',
    animation:'fadeUp 0.4s ease both',
  }

  return (
    <div style={{ minHeight:'100vh', background:C.bg, fontFamily:"'Inter',system-ui,sans-serif",
      maxWidth:480, margin:'0 auto', paddingBottom:60 }}>

      {/* ── HEADER ─────────────────────────────────────────────── */}
      <div style={{ position:'relative', overflow:'hidden', padding:'52px 28px 44px' }}>
        {/* Glow radial de fundo */}
        <div style={{ position:'absolute', top:-60, left:'50%', transform:'translateX(-50%)',
          width:380, height:380, borderRadius:'50%',
          background:'radial-gradient(circle, rgba(201,169,110,0.11) 0%, transparent 68%)',
          pointerEvents:'none' }} />
        {/* Linhas decorativas laterais */}
        <div style={{ position:'absolute', top:0, left:0, right:0, height:1,
          background:`linear-gradient(to right, transparent, ${C.gold25}, transparent)` }} />

        <div style={{ textAlign:'center', position:'relative' }}>
          {/* Logo */}
          <div style={{ display:'flex', justifyContent:'center', marginBottom:22 }}>
            <div style={{
              width:106, height:106, borderRadius:'50%', overflow:'hidden',
              border:`2px solid ${C.gold}`,
              boxShadow:`0 0 0 4px ${C.gold8}, 0 0 40px rgba(201,169,110,0.28), 0 0 80px rgba(201,169,110,0.10)`,
              animation:'goldGlow 3.5s ease-in-out infinite',
              flexShrink:0,
            }}>
              <img src="/logo-araca.png" alt="Araçá Grill"
                style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }} />
            </div>
          </div>

          <h1 style={{ fontSize:28, fontWeight:900, color:C.gold, margin:'0 0 8px',
            letterSpacing:'-0.03em', lineHeight:1.1 }}>
            Faça sua reserva
          </h1>
          <p style={{ fontSize:13, color:C.textMuted, margin:0, fontStyle:'italic',
            letterSpacing:'0.03em' }}>
            Reserve seu momento conosco
          </p>

          {/* Ornamento */}
          <div style={{ display:'flex', alignItems:'center', justifyContent:'center',
            gap:10, marginTop:22 }}>
            <div style={{ flex:1, height:1, background:`linear-gradient(to right,transparent,${C.gold25})` }} />
            <span style={{ color:C.gold, fontSize:14 }}>✦</span>
            <div style={{ flex:1, height:1, background:`linear-gradient(to left,transparent,${C.gold25})` }} />
          </div>
        </div>
      </div>

      <div style={{ padding:'0 18px' }}>

        {/* ── 1. NOME ─────────────────────────────────────────── */}
        <div style={sectionCard}>
          <Campo label="Nome completo" icon="👤">
            <Input value={nome} onChange={e=>setNome(e.target.value)}
              placeholder="Seu nome completo" required />
          </Campo>

          <Campo label="Telefone" icon="📱">
            <Input value={telefone}
              onChange={e=>setTelefone(fmtTelDisplay(e.target.value))}
              placeholder="(18) 99999-9999"
              inputMode="tel" required />
          </Campo>
        </div>

        {/* ── 2. PESSOAS ─────────────────────────────────────── */}
        <div style={sectionCard}>
          <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:16 }}>
            <span style={{ fontSize:14 }}>👥</span>
            <span style={{ fontSize:9, fontWeight:800, color:C.goldD, letterSpacing:'0.15em',
              textTransform:'uppercase' }}>Quantidade de pessoas</span>
          </div>
          <SeletorPessoas value={pessoas} onChange={handlePessoas} />

          {/* Confirmação grupo grande */}
          {pessoas > 25 && !grandeGrupoOk && (
            <div style={{ marginTop:16, background:'rgba(201,169,110,0.06)',
              border:`1px solid ${C.gold25}`, borderRadius:14, padding:'16px 18px',
              animation:'fadeUp 0.3s ease' }}>
              <div style={{ fontSize:13, fontWeight:700, color:C.gold, marginBottom:6 }}>
                🎊 Reserva para grupo grande
              </div>
              <div style={{ fontSize:12, color:C.textMuted, lineHeight:1.6, marginBottom:14 }}>
                Você selecionou <strong style={{ color:C.text }}>{pessoas} pessoas</strong>.
                {' '}A quantidade está correta?
              </div>
              <div style={{ display:'flex', gap:10 }}>
                <button onClick={() => handlePessoas(Math.max(1, pessoas - 1))}
                  style={{ flex:1, padding:'10px', border:`1px solid ${C.border}`,
                    borderRadius:10, background:C.bgCard3, color:C.textMuted,
                    fontSize:13, cursor:'pointer', fontFamily:'inherit' }}>
                  Corrigir
                </button>
                <button onClick={() => setGrandeGrupoOk(true)}
                  style={{ flex:2, padding:'10px',
                    border:`1px solid ${C.gold}`, borderRadius:10,
                    background:`linear-gradient(135deg,${C.goldD},${C.gold})`,
                    color:'#050301', fontSize:13, fontWeight:700,
                    cursor:'pointer', fontFamily:'inherit' }}>
                  Confirmar {pessoas} pessoas ✓
                </button>
              </div>
            </div>
          )}

          {/* Agradecimento após confirmação */}
          {pessoas > 25 && grandeGrupoOk && (
            <div style={{ marginTop:16, background:'rgba(46,125,82,0.08)',
              border:'1px solid rgba(46,125,82,0.25)', borderRadius:14,
              padding:'12px 16px', animation:'fadeUp 0.3s ease',
              display:'flex', alignItems:'center', gap:12 }}>
              <span style={{ fontSize:20 }}>✅</span>
              <div>
                <div style={{ fontSize:12, fontWeight:700, color:'#5db87a', marginBottom:2 }}>
                  Quantidade confirmada!
                </div>
                <div style={{ fontSize:11, color:C.textDim }}>
                  Obrigado por informar. Reserva para {pessoas} pessoas registrada.
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── 3. DATA ─────────────────────────────────────────── */}
        <div style={sectionCard}>
          <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:14 }}>
            <span style={{ fontSize:14 }}>📅</span>
            <span style={{ fontSize:9, fontWeight:800, color:C.goldD, letterSpacing:'0.15em',
              textTransform:'uppercase' }}>Data da reserva</span>
          </div>
          <button onClick={()=>setMostraCalendario(true)}
            style={{ width:'100%', padding:'16px 20px',
              border:`1.5px solid ${dataSel?C.gold:C.border}`, borderRadius:14,
              background: dataSel ? C.gold8 : C.bgCard3,
              color: dataSel ? C.gold : C.textMuted, fontSize:15, fontWeight:dataSel?600:400,
              cursor:'pointer', textAlign:'left', fontFamily:'inherit',
              display:'flex', justifyContent:'space-between', alignItems:'center',
              transition:'all 0.2s',
              boxShadow: dataSel ? `0 0 0 3px ${C.gold8}` : 'none' }}>
            <span>{dataSel ? fmtDataExtenso(dataSel) : 'Escolher data'}</span>
            <span style={{ color:C.goldD, fontSize:18 }}>📆</span>
          </button>
        </div>

        {/* ── 4. PERÍODO ─────────────────────────────────────── */}
        <div style={sectionCard}>
          <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:14 }}>
            <span style={{ fontSize:14 }}>🌅</span>
            <span style={{ fontSize:9, fontWeight:800, color:C.goldD, letterSpacing:'0.15em',
              textTransform:'uppercase' }}>Período</span>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            {[
              { id:'almoco', label:'Almoço', icon:'☀️', info:'11h00 – 12h30', disabled:dataSel&&!canAlmoco },
              { id:'jantar', label:'Jantar', icon:'🌙', info: dataSel
                ? (isWeekendOuFeriado(dataSel)?'19h00 – 20h30': getDow(dataSel)===5?'18h00 – 20h30':'17h00 – 20h30')
                : '17h00 – 20h30',
                disabled:false },
            ].map(p => (
              <button key={p.id} onClick={()=>!p.disabled&&setPeriodo(p.id)}
                disabled={p.disabled}
                style={{ padding:'18px 12px', border:`1.5px solid ${periodo===p.id?C.gold:p.disabled?C.borderSub:C.border}`,
                  borderRadius:16, background: periodo===p.id ? C.gold15 : p.disabled ? C.bgCard2 : C.bgCard3,
                  cursor: p.disabled ? 'not-allowed' : 'pointer', textAlign:'center',
                  opacity: p.disabled ? 0.4 : 1, transition:'all 0.2s',
                  boxShadow: periodo===p.id ? `0 0 20px ${C.gold15}` : 'none',
                  fontFamily:'inherit' }}>
                <div style={{ fontSize:26, marginBottom:6,
                  filter:periodo===p.id?'drop-shadow(0 0 8px rgba(201,169,110,0.6))':'none',
                  transition:'filter 0.2s' }}>{p.icon}</div>
                <div style={{ fontSize:14, fontWeight:800, color:periodo===p.id?C.gold:p.disabled?C.textDim:C.text,
                  marginBottom:4, transition:'color 0.2s' }}>{p.label}</div>
                <div style={{ fontSize:10, color:C.textDim }}>{p.info}</div>
              </button>
            ))}
          </div>
          {dataSel && !canAlmoco && (
            <div style={{ marginTop:10, padding:'10px 14px', background:C.bgCard2,
              border:`1px solid ${C.border}`, borderRadius:10 }}>
              <div style={{ fontSize:11, color:C.textDim, fontStyle:'italic' }}>
                ℹ️ Almoço disponível apenas aos finais de semana e feriados
              </div>
            </div>
          )}
        </div>

        {/* ── 5. HORÁRIO ─────────────────────────────────────── */}
        {periodo && dataSel && (
          <div style={sectionCard} ref={horarioRef}>
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:14 }}>
              <span style={{ fontSize:14 }}>🕐</span>
              <span style={{ fontSize:9, fontWeight:800, color:C.goldD, letterSpacing:'0.15em',
                textTransform:'uppercase' }}>Horário de chegada</span>
            </div>

            {horarios.length === 0 ? (
              <div style={{ padding:16, textAlign:'center', color:C.textDim, fontSize:13 }}>
                Sem horários disponíveis para esta combinação
              </div>
            ) : (
              <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
                {horarios.map(h => (
                  <button key={h} onClick={()=>setHorario(h)}
                    style={{ padding:'11px 18px', border:`1.5px solid ${horario===h?C.gold:C.border}`,
                      borderRadius:12, background: horario===h
                        ? `linear-gradient(135deg,${C.goldD},${C.gold})`
                        : C.bgCard3,
                      color: horario===h ? '#0a0806' : C.textMuted,
                      fontSize:14, fontWeight:horario===h?800:500, cursor:'pointer',
                      fontFamily:'inherit', transition:'all 0.15s',
                      boxShadow: horario===h ? `0 0 14px ${C.gold25}` : 'none' }}>
                    {h}
                  </button>
                ))}
              </div>
            )}

            {/* Aviso elegante em vermelho */}
            <div style={{ marginTop:16, display:'flex', gap:10, alignItems:'flex-start',
              background:C.dangerBg, border:`1px solid rgba(168,50,42,0.2)`,
              borderRadius:12, padding:'12px 14px' }}>
              <span style={{ fontSize:14, flexShrink:0, marginTop:1 }}>⚠️</span>
              <span style={{ fontSize:11, color:'rgba(220,120,110,0.9)', lineHeight:1.5 }}>
                Todos os integrantes da reserva devem chegar até o horário limite informado.
              </span>
            </div>
          </div>
        )}

        {/* ── 6. OBSERVAÇÕES ─────────────────────────────────── */}
        <div style={sectionCard}>
          <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:14 }}>
            <span style={{ fontSize:14 }}>📝</span>
            <span style={{ fontSize:9, fontWeight:800, color:C.goldD, letterSpacing:'0.15em',
              textTransform:'uppercase' }}>Observações <span style={{ fontWeight:400, color:C.textDim }}>(opcional)</span></span>
          </div>
          <textarea value={obs} onChange={e=>setObs(e.target.value)}
            placeholder="Aniversários, preferência de mesa, restrições alimentares..."
            rows={3}
            style={{ ...inputBase, resize:'vertical', minHeight:90, lineHeight:1.6 }} />
        </div>

        {/* ── 7. ESPAÇO IDEAL ────────────────────────────────── */}
        <div style={sectionCard}>
          {/* Cabeçalho seção */}
          <div style={{ textAlign:'center', marginBottom:20 }}>
            <div style={{ fontSize:9, fontWeight:800, color:C.goldD, letterSpacing:'0.18em',
              textTransform:'uppercase', marginBottom:6 }}>ESCOLHA SEU</div>
            <div style={{ fontSize:20, fontWeight:900, color:C.text, letterSpacing:'-0.03em' }}>
              ESPAÇO IDEAL
            </div>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:8, marginTop:10 }}>
              <div style={{ flex:1, height:1, background:`linear-gradient(to right,transparent,${C.gold25})` }} />
              <span style={{ color:C.gold, fontSize:12 }}>✦</span>
              <div style={{ flex:1, height:1, background:`linear-gradient(to left,transparent,${C.gold25})` }} />
            </div>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            {ESPACOS.map(e => (
              <EspacoCard key={e.id} espaco={e} selecionado={local===e.id} onSelect={setLocal} />
            ))}
          </div>
        </div>

        {/* ── 8. BOTÃO CONFIRMAR ─────────────────────────────── */}
        <button onClick={()=>podeEnviar&&setMostraModal(true)} disabled={!podeEnviar}
          style={{ width:'100%', padding:'20px',
            background: podeEnviar
              ? `linear-gradient(135deg, ${C.goldXD} 0%, ${C.goldD} 35%, ${C.gold} 70%, ${C.goldL} 100%)`
              : C.bgCard2,
            border:`1px solid ${podeEnviar?C.gold:C.border}`, borderRadius:18,
            fontSize:17, fontWeight:900, letterSpacing:'-0.01em',
            color: podeEnviar ? '#030201' : C.textDim,
            cursor: podeEnviar ? 'pointer' : 'not-allowed',
            fontFamily:'inherit', marginBottom:28,
            boxShadow: podeEnviar ? `0 8px 32px ${C.gold25}, 0 2px 8px rgba(0,0,0,0.4)` : 'none',
            transition:'all 0.3s' }}>
          {podeEnviar ? '✓ Confirmar reserva' : 'Preencha todos os campos'}
        </button>

        {!podeEnviar && (
          <div style={{ textAlign:'center', marginTop:-16, marginBottom:28, fontSize:11, color:C.textDim }}>
            {[!nome.trim()&&'nome', !telefone.trim()&&'telefone', !dataSel&&'data',
              !periodo&&'período', !horario&&'horário', !local&&'espaço']
              .filter(Boolean).map((f,i,a)=>f+(i<a.length-2?', ':i<a.length-1?' e ':'')).join('')}
            {' '}pendente{[!nome.trim(),!telefone.trim(),!dataSel,!periodo,!horario,!local].filter(Boolean).length>1?'s':''}
          </div>
        )}

        {/* Nota de rodapé */}
        <div style={{ textAlign:'center', paddingBottom:16 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:8, marginBottom:12 }}>
            <div style={{ flex:1, height:1, background:`linear-gradient(to right,transparent,${C.borderSub})` }} />
            <span style={{ color:C.goldD, fontSize:12 }}>✦</span>
            <div style={{ flex:1, height:1, background:`linear-gradient(to left,transparent,${C.borderSub})` }} />
          </div>
          <div style={{ fontSize:10, color:C.textDim, lineHeight:1.6 }}>
            Após a confirmação, você será redirecionado ao WhatsApp
            <br />do restaurante para finalizar sua reserva.
          </div>
        </div>
      </div>

      {/* ── CALENDÁRIO MODAL ─────────────────────────────────── */}
      {mostraCalendario && (
        <Calendario selectedDate={dataSel} onSelect={handleData} onClose={()=>setMostraCalendario(false)} />
      )}

      {/* ── MODAL CONFIRMAÇÃO ────────────────────────────────── */}
      {mostraModal && (
        <ModalConfirmacao
          dados={{ nome, telefone, pessoas, data:dataSel, periodo, horario, obs, local }}
          onFinalizar={handleConfirmar}
          onCancelar={()=>setMostraModal(false)}
          loading={loading}
        />
      )}

      {/* ── CHATBOT ALLANA ───────────────────────────────────── */}
      <AllanaChat />
    </div>
  )
}
