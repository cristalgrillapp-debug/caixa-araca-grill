import { imprimirRecibos } from './impressao'
import { useState, useEffect, useRef, useMemo } from 'react'
import { db } from './firebase'
import { collection, addDoc, updateDoc, setDoc, doc, onSnapshot, deleteDoc, runTransaction, getDoc, query, where, orderBy, limit, getDocs, writeBatch } from 'firebase/firestore'
import Dashboard from './Dashboard'

const fmt = (cents) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((cents || 0) / 100)
const parseCents = (str) => parseInt(String(str).replace(/\D/g, '') || '0', 10)
const DIAS = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB']
const toDateStr = (d) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const DEFAULT_CONFIG = {
  nome_estabelecimento: 'ARACÁ GRILL',
  whatsapp_pix: '5518996530959',
  horario_virada_h: 2,
  horario_virada_m: 30,
  senha_mestre: '',
}

const todayOp = (cfg) => {
  const now = new Date()
  const h = now.getHours(), m = now.getMinutes()
  const vh = cfg?.horario_virada_h ?? 2
  const vm = cfg?.horario_virada_m ?? 30
  if (h < vh || (h === vh && m <= vm)) {
    const y = new Date(now); y.setDate(y.getDate() - 1); return toDateStr(y)
  }
  return toDateStr(now)
}
const dayLabel = (dateStr) => {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-')
  const dt = new Date(Number(y), Number(m) - 1, Number(d))
  return DIAS[dt.getDay()] + ' ' + String(dt.getDate()).padStart(2, '0') + '/' + String(dt.getMonth() + 1).padStart(2, '0')
}
const isWeekend = (dateStr) => { const d = new Date(dateStr + 'T12:00:00'); return [5, 6, 0].includes(d.getDay()) }
const calcNotes = (cents) => {
  let rem = Math.round(cents / 100)
  const n = { 100: 0, 50: 0, 20: 0, 10: 0, 5: 0 }
  ;[100, 50, 20, 10, 5].forEach(v => { n[v] = Math.floor(rem / v); rem = rem % v })
  return n
}

// trocos: [{ data, valor, descricao }]
const totalTrocos = (trocos) => (trocos || []).reduce((a, t) => a + t.valor, 0)

// ── Validações de chave Pix ──────────────────────────────────────────────────
function validarCPF(cpf) {
  const n = cpf.replace(/\D/g, '')
  if (n.length !== 11 || /^(\d)\1{10}$/.test(n)) return false
  let s = 0
  for (let i = 0; i < 9; i++) s += parseInt(n[i]) * (10 - i)
  let r = (s * 10) % 11; if (r === 10 || r === 11) r = 0
  if (r !== parseInt(n[9])) return false
  s = 0
  for (let i = 0; i < 10; i++) s += parseInt(n[i]) * (11 - i)
  r = (s * 10) % 11; if (r === 10 || r === 11) r = 0
  return r === parseInt(n[10])
}

function validarEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

function validarTelefone(tel) {
  const n = tel.replace(/\D/g, '')
  // Brasil: 11 dígitos (DDD + 9 dígitos), DDD entre 11 e 99
  if (n.length !== 11) return false
  const ddd = parseInt(n.slice(0, 2))
  if (ddd < 11 || ddd > 99) return false
  return n[2] === '9' // celular começa com 9
}

function validarChavePix(tipo, chave) {
  if (!chave.trim()) return { ok: false, msg: 'Chave obrigatória' }
  switch (tipo) {
    case 'CPF':
      if (!validarCPF(chave)) return { ok: false, msg: 'CPF inválido — verifique os 11 dígitos' }
      return { ok: true, msg: '' }
    case 'E-mail':
      if (!validarEmail(chave)) return { ok: false, msg: 'E-mail inválido — deve conter @ e domínio' }
      return { ok: true, msg: '' }
    case 'Telefone':
      if (!validarTelefone(chave)) return { ok: false, msg: 'Telefone inválido — 11 dígitos com DDD (ex: 11999999999)' }
      return { ok: true, msg: '' }
    case 'Aleatória':
      return { ok: true, msg: '' }
    default:
      return { ok: true, msg: '' }
  }
}

// Formata CPF enquanto digita: 000.000.000-00
function formatarCPF(valor) {
  return valor.replace(/[^0-9]/g, '').slice(0, 11)
}

function formatarTelefone(valor) {
  return valor.replace(/[^0-9]/g, '').slice(0, 11)
}


async function hashSenha(senha) {
  const encoder = new TextEncoder()
  const data = encoder.encode(senha + 'araca_salt_2024')
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

const AUTH_KEY = 'araca_usuario_logado'
const getUsuarioLogado = () => { try { const s = sessionStorage.getItem(AUTH_KEY); return s ? JSON.parse(s) : null } catch { return null } }
const setUsuarioLogado = (u) => { try { sessionStorage.setItem(AUTH_KEY, JSON.stringify(u)) } catch {} }
const logoutUsuario = () => { try { sessionStorage.removeItem(AUTH_KEY) } catch {} }

// Comprime a assinatura para ~3kb antes de salvar no Firestore
function comprimirAssinatura(base64DataUrl) {
  return new Promise((resolve) => {
    if (!base64DataUrl) return resolve(null)
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      // Reduz para no máximo 300x100px mantendo proporção
      const maxW = 300, maxH = 100
      let w = img.width, h = img.height
      if (w > maxW) { h = Math.round(h * maxW / w); w = maxW }
      if (h > maxH) { w = Math.round(w * maxH / h); h = maxH }
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0, w, h)
      // Qualidade 0.5 = ~3kb para assinatura simples
      resolve(canvas.toDataURL('image/jpeg', 0.5))
    }
    img.onerror = () => resolve(base64DataUrl)
    img.src = base64DataUrl
  })
}

// Wrapper mantendo o nome original para compatibilidade
async function uploadAssinatura(extraId, base64DataUrl) {
  if (!base64DataUrl) return null
  return await comprimirAssinatura(base64DataUrl)
}

// ── PALETA DE CORES ─────────────────────────────────────────────────────────
const C = {
  bg:        '#f7f6f3',   // fundo creme neutro
  bgCard:    '#ffffff',   // card branco limpo
  bgCard2:   '#f0ede8',   // card secundário bege suave
  border:    '#e4ddd4',   // borda quente discreta
  primary:   '#b5763a',   // âmbar caramelo remetendo à brasa
  secondary: '#3d6b8a',   // azul petróleo elegante
  accent:    '#5c4d8a',   // roxo suave para destaques
  gold:      '#9a7520',   // dourado escuro para avisos
  success:   '#2e6b47',   // verde floresta
  danger:    '#a83228',   // vermelho vinho
  text:      '#18181b',   // quase preto
  textMuted: '#6b6360',   // marrom acinzentado
  textDim:   '#a8a09a',   // texto fraco
}

// Cores das cédulas — refinadas, não neon
const NOTAS_CORES = {
  100: { bg: '#dbeafe', label: '#1d4ed8', emoji: '💙', nome: 'R$100' },
  50:  { bg: '#ffedd5', label: '#c2410c', emoji: '🟠', nome: 'R$50'  },
  20:  { bg: '#fef9c3', label: '#854d0e', emoji: '🟡', nome: 'R$20'  },
  10:  { bg: '#fce7f3', label: '#9d174d', emoji: '🩷', nome: 'R$10'  },
  5:   { bg: '#ede9fe', label: '#5b21b6', emoji: '💜', nome: 'R$5'   },
}

const S = {
  app: {
    minHeight: '100vh',
    background: C.bg,
    fontFamily: "'Inter', 'Geist', system-ui, -apple-system, sans-serif",
    maxWidth: 480,
    margin: '0 auto',
    color: C.text,
  },
  header: {
    background: '#1c1917',
    padding: '18px 20px 14px',
    color: '#fff',
    position: 'sticky',
    top: 0,
    zIndex: 100,
    borderBottom: '1px solid #2d2420',
    boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
  },
  content: { padding: '20px 18px', paddingBottom: 100 },
  nav: {
    position: 'fixed',
    bottom: 0,
    left: '50%',
    transform: 'translateX(-50%)',
    width: '100%',
    maxWidth: 480,
    background: '#ffffff',
    borderTop: `1px solid ${C.border}`,
    display: 'flex',
    zIndex: 100,
  },
  card: {
    background: C.bgCard,
    borderRadius: 16,
    padding: '18px 20px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04)',
    border: `1px solid ${C.border}`,
    marginBottom: 14,
  },
  input: {
    width: '100%',
    padding: '12px 16px',
    border: `1.5px solid ${C.border}`,
    borderRadius: 12,
    fontFamily: 'inherit',
    fontSize: 15,
    background: '#fafafa',
    boxSizing: 'border-box',
    color: C.text,
    outline: 'none',
    transition: 'border-color 0.2s',
  },
  label: {
    fontSize: 11,
    fontWeight: 700,
    color: C.textMuted,
    marginBottom: 6,
    display: 'block',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  btn: (bg, outline) => outline ? ({
    background: 'transparent',
    color: bg,
    border: `1.5px solid ${bg}`,
    borderRadius: 12,
    padding: '12px 20px',
    fontFamily: 'inherit',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
    flex: 1,
  }) : ({
    background: bg === C.danger
      ? `linear-gradient(to bottom, ${C.danger}, #8b2820)`
      : `linear-gradient(to bottom, ${bg}, ${bg}dd)`,
    color: '#fff',
    border: 'none',
    borderRadius: 12,
    padding: '12px 20px',
    fontFamily: 'inherit',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
    flex: 1,
    boxShadow: bg === C.primary
      ? '0 2px 8px rgba(181,118,58,0.3)'
      : bg === C.danger
        ? '0 2px 8px rgba(168,50,40,0.3)'
        : 'none',
  }),
  modal: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.45)',
    zIndex: 1000,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    backdropFilter: 'blur(6px)',
  },
  modalBox: {
    background: '#ffffff',
    borderRadius: '20px 20px 0 0',
    padding: '20px 20px 40px',
    width: '100%',
    maxWidth: 480,
    maxHeight: '92vh',
    overflowY: 'auto',
    boxShadow: '0 -4px 32px rgba(0,0,0,0.12)',
  },
}

const Badge = ({ children, color = C.primary }) => (
  <span style={{ background: color + '22', color, border: `1px solid ${color}44`, borderRadius: 6, padding: '3px 8px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', letterSpacing: '0.03em', display: 'inline-flex', alignItems: 'center' }}>{children}</span>
)

const Modal = ({ children, onClose, title }) => (
  <div style={S.modal} onClick={e => e.target === e.currentTarget && onClose()}>
    <div style={S.modalBox}>
      <div style={{ width: 36, height: 4, background: C.border, borderRadius: 2, margin: '0 auto 20px' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h3 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: C.text, letterSpacing: '-0.02em' }}>{title}</h3>
        <button onClick={onClose} style={{ background: C.bgCard2, border: 'none', borderRadius: '50%', width: 32, height: 32, cursor: 'pointer', color: C.textMuted, fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
      </div>
      {children}
    </div>
  </div>
)

const SignaturePad = ({ onSave, onCancel }) => {
  const ref = useRef(null)
  const drawing = useRef(false)
  const getPos = (e, c) => { const r = c.getBoundingClientRect(), t = e.touches ? e.touches[0] : e; return { x: t.clientX - r.left, y: t.clientY - r.top } }
  const start = (e) => { e.preventDefault(); drawing.current = true; const c = ref.current, ctx = c.getContext('2d'), p = getPos(e, c); ctx.beginPath(); ctx.moveTo(p.x, p.y) }
  const draw = (e) => { e.preventDefault(); if (!drawing.current) return; const c = ref.current, ctx = c.getContext('2d'), p = getPos(e, c); ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.strokeStyle = '#1a1a2e'; ctx.lineTo(p.x, p.y); ctx.stroke() }
  const end = (e) => { e.preventDefault(); drawing.current = false }
  const clear = () => { const c = ref.current; c.getContext('2d').clearRect(0, 0, c.width, c.height) }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ margin: 0, fontSize: 13, color: '#666' }}>Assine abaixo com o dedo:</p>
      <canvas ref={ref} width={320} height={150} style={{ border: '2px solid #c9a96e', borderRadius: 8, background: '#fafafa', touchAction: 'none', width: '100%', height: 150 }}
        onMouseDown={start} onMouseMove={draw} onMouseUp={end} onTouchStart={start} onTouchMove={draw} onTouchEnd={end} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={clear} style={S.btn('#999')}>Limpar</button>
        <button onClick={onCancel} style={S.btn('#666')}>Cancelar</button>
        <button onClick={() => onSave(ref.current.toDataURL())} style={{ ...S.btn('#c9a96e'), flex: 2, fontWeight: 700 }}>Confirmar</button>
      </div>
    </div>
  )
}

export default function App() {
  const [usuario, setUsuario] = useState(getUsuarioLogado)

  const handleLogin = (u) => { setUsuarioLogado(u); setUsuario(u) }
  const handleLogout = () => { logoutUsuario(); setUsuario(null) }

  if (!usuario) return <TelaLogin onLogin={handleLogin} />

  return <AppPrincipal usuario={usuario} onLogout={handleLogout} />
}

function AppPrincipal({ usuario, onLogout }) {
  const [tab, setTab] = useState('relatorios')
  const [extras, setExtras] = useState([])
  const [pessoas, setPessoas] = useState([])
  const [setores, setSetores] = useState([])
  const [modal, setModal] = useState(null)
  const [vales, setVales] = useState([])
  const [despesas, setDespesas] = useState([])
  const [categorias, setCategorias] = useState([])
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  const [turnoAtivo, setTurnoAtivo] = useState(null)   // { id, data_op, aberto_em, aberto_por }
  const [carregandoTurno, setCarregandoTurno] = useState(true)

  // today vem do turno ativo — se não tiver, usa data real
  const today = turnoAtivo?.data_op || toDateStr(new Date())

  const updateConfig = async (changes) => {
    const novo = { ...config, ...changes }
    setConfig(novo)
    await updateDoc(doc(db, 'configuracoes', 'geral'), novo)
  }

  // Avisa se tentar fechar com pagamentos pendentes
  useEffect(() => {
    const handler = (e) => {
      const pendentes = extras.filter(ex => ex.data_op === today && !ex.pago)
      if (pendentes.length > 0) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [extras, today])

  useEffect(() => {
    // Carrega apenas extras dos últimos 60 dias
    const sessenta = new Date()
    sessenta.setDate(sessenta.getDate() - 60)
    const dataLimite = toDateStr(sessenta)
    const qExtras = query(
      collection(db, 'extras'),
      where('data_op', '>=', dataLimite),
      orderBy('data_op', 'desc'),
      limit(500)
    )
    const qVales = query(
      collection(db, 'vales'),
      where('data_op', '>=', dataLimite),
      orderBy('data_op', 'desc'),
      limit(500)
    )
    const qDespesas = query(
      collection(db, 'despesas'),
      where('data_op', '>=', dataLimite),
      orderBy('data_op', 'desc'),
      limit(500)
    )

    const CATS_PADRAO = [
      // ── ESTOQUE ──
      { emoji:'🥑', nome:'Hortifruti / Alface',    grupo:'estoque',    cor:'#22c55e', favorita:true,  ordem:1, ativo:true, alertar_se_aumentar:false, threshold_mensal:0, descricoes_sugeridas:['Hortifruti','Alface','Verduras e legumes','Tomate','Cebola'] },
      { emoji:'🍌', nome:'Compra de Banana',        grupo:'estoque',    cor:'#eab308', favorita:false, ordem:2, ativo:true, alertar_se_aumentar:false, threshold_mensal:0, descricoes_sugeridas:['Banana prata','Banana nanica','Banana da terra'] },
      { emoji:'🍞', nome:'Compra de Pão',           grupo:'estoque',    cor:'#f97316', favorita:false, ordem:3, ativo:true, alertar_se_aumentar:false, threshold_mensal:0, descricoes_sugeridas:['Pão de hambúrguer','Pão francês','Pão de forma'] },
      { emoji:'🍔', nome:'Compra de Hambúrguer',    grupo:'estoque',    cor:'#b45309', favorita:true,  ordem:4, ativo:true, alertar_se_aumentar:false, threshold_mensal:0, descricoes_sugeridas:['Hambúrguer artesanal','Blend bovino','Hambúrguer congelado'] },
      { emoji:'⚡', nome:'Compra de Energético',    grupo:'estoque',    cor:'#7c3aed', favorita:false, ordem:5, ativo:true, alertar_se_aumentar:false, threshold_mensal:0, descricoes_sugeridas:['Red Bull','Monster','Energético TNT'] },
      { emoji:'🛒', nome:'Mercado',                 grupo:'estoque',    cor:'#0ea5e9', favorita:true,  ordem:6, ativo:true, alertar_se_aumentar:false, threshold_mensal:0, descricoes_sugeridas:['Compra no mercado','Supermercado','Atacado'] },
      // ── EMERGÊNCIA ──
      { emoji:'🚨', nome:'Compra Emergencial',      grupo:'emergencia', cor:'#ef4444', favorita:false, ordem:1, ativo:true, alertar_se_aumentar:true,  threshold_mensal:3, descricoes_sugeridas:['Faltou...','Compra urgente de...','Emergência de...'] },
      { emoji:'⏰', nome:'Reposição Urgente',        grupo:'emergencia', cor:'#f97316', favorita:false, ordem:2, ativo:true, alertar_se_aumentar:true,  threshold_mensal:2, descricoes_sugeridas:['Reposição urgente de...','Acabou...','Faltou estoque de...'] },
      // ── OPERACIONAL ──
      { emoji:'🛵', nome:'Motoboy Avulso',          grupo:'operacional', cor:'#0ea5e9', favorita:true,  ordem:1, ativo:true, alertar_se_aumentar:true,  threshold_mensal:8, descricoes_sugeridas:['Motoboy','Entrega avulsa','Frete moto'] },
      { emoji:'⛽', nome:'Combustível',              grupo:'operacional', cor:'#6b7280', favorita:false, ordem:2, ativo:true, alertar_se_aumentar:false, threshold_mensal:0, descricoes_sugeridas:['Gasolina','Combustível Allan','Combustível moto','Gasolina entrega'] },
      { emoji:'🔧', nome:'Manutenção',              grupo:'operacional', cor:'#78716c', favorita:false, ordem:3, ativo:true, alertar_se_aumentar:true,  threshold_mensal:2, descricoes_sugeridas:['Conserto','Manutenção equipamento','Reparo','Troca de peça'] },
      { emoji:'🎮', nome:'Fichas / Tokens',          grupo:'operacional', cor:'#8b5cf6', favorita:false, ordem:4, ativo:true, alertar_se_aumentar:false, threshold_mensal:0, descricoes_sugeridas:['Fichas','Tokens','Créditos sistema'] },
      { emoji:'🧹', nome:'Limpeza',                  grupo:'operacional', cor:'#06b6d4', favorita:false, ordem:5, ativo:true, alertar_se_aumentar:false, threshold_mensal:0, descricoes_sugeridas:['Material de limpeza','Produto limpeza','Desinfetante'] },
      // ── PESSOAL ──
      { emoji:'🍱', nome:'Alimentação da Equipe',   grupo:'pessoal',    cor:'#10b981', favorita:true,  ordem:1, ativo:true, alertar_se_aumentar:false, threshold_mensal:0, descricoes_sugeridas:['Almoço equipe','Jantar equipe','Lanche equipe','Refeição turno'] },
      { emoji:'🎁', nome:'Bonificação',              grupo:'pessoal',    cor:'#f59e0b', favorita:false, ordem:2, ativo:true, alertar_se_aumentar:false, threshold_mensal:0, descricoes_sugeridas:['Bonificação','Gratificação','Premiação','Bônus'] },
      { emoji:'⚖️', nome:'Diferença Salarial',      grupo:'financeiro', cor:'#6366f1', favorita:false, ordem:1, ativo:true, alertar_se_aumentar:false, threshold_mensal:0, descricoes_sugeridas:['Acerto salarial','Diferença','Complemento pagamento'] },
      // ── SAÚDE DA EQUIPE ──
      { emoji:'💊', nome:'Farmácia',                 grupo:'saude',      cor:'#ec4899', favorita:false, ordem:1, ativo:true, alertar_se_aumentar:true,  threshold_mensal:3, descricoes_sugeridas:['Remédio','Farmácia','Medicamento','Analgésico'] },
      // ── CORREÇÕES ──
      { emoji:'↩️', nome:'Devolução para Cliente',  grupo:'correcoes',  cor:'#ef4444', favorita:false, ordem:1, ativo:true, alertar_se_aumentar:true,  threshold_mensal:2, descricoes_sugeridas:['Devolução cliente','Estorno','Reembolso cliente'] },
      { emoji:'❌', nome:'Valor Cobrado Errado',     grupo:'correcoes',  cor:'#f97316', favorita:false, ordem:2, ativo:true, alertar_se_aumentar:true,  threshold_mensal:2, descricoes_sugeridas:['Cobrança errada','Cobrado a maior','Erro de cobrança'] },
      { emoji:'🔄', nome:'Devolução para Funcionário', grupo:'correcoes', cor:'#8b5cf6', favorita:false, ordem:3, ativo:true, alertar_se_aumentar:false, threshold_mensal:0, descricoes_sugeridas:['Devolução funcionário','Acerto interno','Estorno funcionário'] },
      { emoji:'✏️', nome:'Correção de Cobrança',    grupo:'correcoes',  cor:'#f59e0b', favorita:false, ordem:4, ativo:true, alertar_se_aumentar:true,  threshold_mensal:3, descricoes_sugeridas:['Correção','Ajuste cobrança','Desconto aplicado'] },
      // ── OUTROS ──
      { emoji:'📝', nome:'Outros',                   grupo:'outros',     cor:'#9ca3af', favorita:false, ordem:1, ativo:true, alertar_se_aumentar:false, threshold_mensal:0, descricoes_sugeridas:[] },
    ]

    const unsubs = [
      // Turno ativo — escuta em tempo real
      onSnapshot(
        query(collection(db, 'turnos'), where('status', '==', 'aberto'), limit(1)),
        s => {
          if (!s.empty) {
            setTurnoAtivo({ id: s.docs[0].id, ...s.docs[0].data() })
          } else {
            setTurnoAtivo(null)
          }
          setCarregandoTurno(false)
        }
      ),
      onSnapshot(qExtras, s => setExtras(s.docs.map(d => ({ id: d.id, ...d.data() })))),
      onSnapshot(qVales, s => setVales(s.docs.map(d => ({ id: d.id, ...d.data() })))),
      onSnapshot(qDespesas, s => setDespesas(s.docs.map(d => ({ id: d.id, ...d.data() })))),
      onSnapshot(collection(db, 'categorias_despesas'), async s => {
        if (s.empty) {
          for (const c of CATS_PADRAO) await addDoc(collection(db, 'categorias_despesas'), c)
        } else {
          const docs = s.docs.map(d => ({ id: d.id, ...d.data() }))
          // Se as categorias não têm campo "grupo", são antigas — migra automaticamente
          const precisaMigrar = docs.every(d => !d.grupo)
          if (precisaMigrar) {
            const batch = writeBatch(db)
            docs.forEach(d => batch.delete(doc(db, 'categorias_despesas', d.id)))
            await batch.commit()
            for (const c of CATS_PADRAO) await addDoc(collection(db, 'categorias_despesas'), c)
          } else {
            setCategorias(docs.filter(c => c.ativo))
          }
        }
      }),
      onSnapshot(collection(db, 'pessoas'), s => setPessoas(s.docs.map(d => ({ id: d.id, ...d.data() })))),
      onSnapshot(collection(db, 'setores'), s => {
        const data = s.docs.map(d => ({ id: d.id, ...d.data() }))
        if (data.length === 0) {
          ['Cozinha', 'Churrasqueira', 'Atendimento', 'Bar', 'Limpeza', 'Música'].forEach(nome =>
            addDoc(collection(db, 'setores'), { nome, ativo: true })
          )
        } else setSetores(data)
      }),
      onSnapshot(doc(db, 'configuracoes', 'geral'), async (snap) => {
        if (snap.exists()) {
          setConfig({ ...DEFAULT_CONFIG, ...snap.data() })
        } else {
          // Primeira vez: cria o documento com valores padrão
          await setDoc(doc(db, 'configuracoes', 'geral'), DEFAULT_CONFIG)
          setConfig(DEFAULT_CONFIG)
        }
      }),
    ]
    return () => unsubs.forEach(u => u())
  }, [])

  const addExtra = async (data) => await addDoc(collection(db, 'extras'), data)
  const updateExtra = async (id, data) => await updateDoc(doc(db, 'extras', id), data)
  const removeExtra = async (id) => await deleteDoc(doc(db, 'extras', id))
  const addPessoa = async (data) => await addDoc(collection(db, 'pessoas'), { ...data, trocos: [] })
  const updatePessoa = async (id, data) => await updateDoc(doc(db, 'pessoas', id), data)
  const removePessoa = async (id) => await deleteDoc(doc(db, 'pessoas', id))
  const addSetor = async (data) => await addDoc(collection(db, 'setores'), data)
  const updateSetor = async (id, data) => await updateDoc(doc(db, 'setores', id), data)
  const removeSetor = async (id) => await deleteDoc(doc(db, 'setores', id))

  const addVale = async (data) => await addDoc(collection(db, 'vales'), data)
  const updateVale = async (id, data) => await updateDoc(doc(db, 'vales', id), data)
  const removeVale = async (id) => await deleteDoc(doc(db, 'vales', id))

  const addDespesa = async (data) => await addDoc(collection(db, 'despesas'), data)
  const updateDespesa = async (id, data) => await updateDoc(doc(db, 'despesas', id), data)
  const removeDespesa = async (id) => await deleteDoc(doc(db, 'despesas', id))

  const addCategoria = async (data) => await addDoc(collection(db, 'categorias_despesas'), data)
  const updateCategoria = async (id, data) => await updateDoc(doc(db, 'categorias_despesas', id), data)
  const removeCategoria = async (id) => await deleteDoc(doc(db, 'categorias_despesas', id))

  const abrirTurno = async () => {
    const dataOp = toDateStr(new Date())
    const ref = await addDoc(collection(db, 'turnos'), {
      data_op:   dataOp,
      aberto_em: new Date().toISOString(),
      aberto_por: usuario.nome,
      status:    'aberto',
    })
    // turnoAtivo será atualizado pelo listener
  }

  const encerrarTurno = async () => {
    if (!turnoAtivo) return
    const pagos     = extras.filter(e => e.data_op === today && e.pago)
    const pendentes = extras.filter(e => e.data_op === today && !e.pago)

    if (pendentes.length > 0) {
      const msg = `Existem ${pendentes.length} pagamento(s) pendente(s):\n\n${pendentes.map(e => `• ${e.nome}: ${fmt(e.valor_final)}`).join('\n')}\n\nDeseja encerrar mesmo assim?`
      if (!confirm(msg)) return
    }

    const confirmacao = prompt(`Digite "ENCERRAR" para fechar o turno de ${dayLabel(today)}.`)
    if (confirmacao !== 'ENCERRAR') return

    try {
      const agora = new Date().toISOString()
      const batch = writeBatch(db)

      // Marca extras pagos como encerrados
      pagos.forEach(e => batch.update(doc(db, 'extras', e.id), {
        encerrado: true, data_encerramento: agora,
      }))

      // Fecha o turno
      batch.update(doc(db, 'turnos', turnoAtivo.id), {
        status:       'encerrado',
        encerrado_em: agora,
        encerrado_por: usuario.nome,
        total_extras:  pagos.reduce((a, e) => a + e.valor_final, 0),
        qtd_extras:    pagos.length,
      })

      await batch.commit()

      await addDoc(collection(db, 'logs'), {
        usuario_id: usuario.id, usuario_nome: usuario.nome,
        acao: 'encerramento_turno',
        detalhes: { data_op: today, pagos_encerrados: pagos.length, pendentes: pendentes.length },
        data: agora, data_op: today,
      })

      alert(`✅ Turno de ${dayLabel(today)} encerrado!\n${pagos.length} pagamento(s) registrado(s).`)
    } catch (err) {
      alert('Erro ao encerrar turno. Tente novamente.')
      console.error(err)
    }
  }

  const registrarLog = async (acao, detalhes = {}) => {
    try {
      await addDoc(collection(db, 'logs'), {
        usuario_id: usuario.id,
        usuario_nome: usuario.nome,
        usuario_login: usuario.usuario,
        acao,
        detalhes,
        data: new Date().toISOString(),
        data_op: today,
      })
    } catch (e) { console.warn('Log falhou:', e) }
  }

  const store = { extras, vales, despesas, categorias, pessoas, setores, config, turnoAtivo, updateConfig, addExtra, updateExtra, removeExtra, addPessoa, updatePessoa, removePessoa, addSetor, updateSetor, removeSetor, addVale, updateVale, removeVale, addDespesa, updateDespesa, removeDespesa, addCategoria, updateCategoria, removeCategoria, usuario, onLogout, registrarLog }

  const tabs = [
    { id: 'extras',    icon: '👤', label: 'Extras'      },
    { id: 'caixa',     icon: '💳', label: 'Caixa'       },
    { id: 'relatorios',icon: '📋', label: 'Relatórios'  },
    { id: 'dashboard', icon: '📊', label: 'Dashboard'   },
    ...(usuario?.role === 'admin' ? [{ id: 'config', icon: '⚙️', label: 'Config' }] : []),
  ]

  const ABAS_BLOQUEADAS = ['extras', 'caixa']

  return (
    <div style={S.app}>
      <div style={S.header}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, color: '#9a7520', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 2 }}>SISTEMA OPERACIONAL</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: '#ffffff', letterSpacing: '-0.03em' }}>{config.nome_estabelecimento}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            {turnoAtivo ? (
              <>
                <div style={{ fontSize: 10, color: '#22c55e', fontWeight: 700 }}>🟢 TURNO ABERTO</div>
                <div style={{ fontSize: 13, color: '#ffffff', fontWeight: 700 }}>{dayLabel(today)}</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>👤 {usuario.nome}</div>
                <button onClick={encerrarTurno}
                  style={{ background: '#a8322888', border: '1px solid #a8322899', borderRadius: 6, color: '#fca5a5', fontSize: 10, padding: '3px 8px', cursor: 'pointer', marginTop: 3, fontWeight: 700 }}>
                  🔒 Encerrar Turno
                </button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 10, color: '#f59e0b', fontWeight: 700 }}>⏸ SEM TURNO</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>👤 {usuario.nome}</div>
                <button onClick={onLogout} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 6, color: 'rgba(255,255,255,0.7)', fontSize: 10, padding: '3px 8px', cursor: 'pointer', marginTop: 3, fontWeight: 700 }}>Sair</button>
              </>
            )}
          </div>
        </div>
      </div>

      <div style={S.content}>
        {/* Tela de abertura de turno — abas operacionais bloqueadas */}
        {!carregandoTurno && !turnoAtivo && ABAS_BLOQUEADAS.includes(tab) && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: 16, padding: 24 }}>
            <div style={{ fontSize: 64 }}>⏸</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.text, textAlign: 'center' }}>Nenhum turno aberto</div>
            <div style={{ fontSize: 14, color: C.textMuted, textAlign: 'center', maxWidth: 280, lineHeight: 1.6 }}>
              Abra o turno para começar a lançar extras, pagamentos e saídas do dia.
            </div>
            <button onClick={abrirTurno}
              style={{ ...S.btn(C.success), fontSize: 18, fontWeight: 900, padding: '18px 40px', borderRadius: 16, boxShadow: '0 4px 20px rgba(46,107,71,0.4)' }}>
              🟢 Abrir Turno
            </button>
            <div style={{ fontSize: 12, color: C.textMuted }}>
              Será registrado como {dayLabel(toDateStr(new Date()))}
            </div>
          </div>
        )}

        {/* Conteúdo normal — turno aberto ou abas liberadas */}
        {(turnoAtivo || !ABAS_BLOQUEADAS.includes(tab)) && !carregandoTurno && (
          <>
            {tab === 'extras'      && <TabExtras store={store} today={today} setModal={setModal} />}
            {tab === 'caixa'       && <TabCaixa store={store} today={today} setModal={setModal} />}
            {tab === 'relatorios'  && <TabRelatoriosCentral store={store} today={today} />}
            {tab === 'dashboard'   && <Dashboard store={store} />}
            {tab === 'config'      && <TabConfig store={store} setModal={setModal} />}
          </>
        )}

        {carregandoTurno && (
          <div style={{ textAlign: 'center', padding: 60, color: C.textMuted }}>
            <div style={{ fontSize: 32 }}>⏳</div>
            <div style={{ marginTop: 8 }}>Verificando turno...</div>
          </div>
        )}
      </div>
      <div style={S.nav}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
              flex: 1, border: 'none', background: 'none',
              padding: '12px 4px 14px', cursor: 'pointer',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
              position: 'relative',
              borderTop: tab === t.id ? `3px solid ${C.primary}` : '3px solid transparent',
              marginTop: -1,
            }}>
            <span style={{ fontSize: 20, opacity: tab === t.id ? 1 : 0.45 }}>{t.icon}</span>
            <span style={{ fontSize: 9, color: tab === t.id ? C.primary : C.textDim, fontWeight: tab === t.id ? 800 : 500, fontFamily: 'inherit', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t.label}</span>
            {t.id === 'caixa' && extras.filter(e => e.data_op === today && !e.pago).length > 0 && (
              <span style={{ position: 'absolute', top: 6, right: '50%', marginRight: -18, background: C.danger, color: '#fff', borderRadius: 8, fontSize: 9, fontWeight: 800, padding: '1px 5px', minWidth: 16, textAlign: 'center' }}>
                {extras.filter(e => e.data_op === today && !e.pago).length}
              </span>
            )}
          </button>
        ))}
      </div>
      {modal?.type === 'addExtra'        && <ModalAddExtra store={store} today={today} onClose={() => setModal(null)} />}
      {modal?.type === 'editExtra'       && <ModalEditExtra store={store} extra={modal.extra} onClose={() => setModal(null)} />}
      {modal?.type === 'pagar'           && <ModalPagar store={store} extra={modal.extra} today={today} onClose={() => setModal(null)} />}
      {modal?.type === 'editarPagamento' && <ModalEditarPagamento store={store} extra={modal.extra} onClose={() => setModal(null)} />}
      {modal?.type === 'addPessoa'       && <ModalAddPessoa store={store} onClose={() => setModal(null)} />}
      {modal?.type === 'editPessoa'      && <ModalEditPessoa store={store} pessoa={modal.pessoa} onClose={() => setModal(null)} />}
      {modal?.type === 'limparBanco'     && <ModalLimparBanco store={store} onClose={() => setModal(null)} />}
      {modal?.type === 'redefinirSenha'  && <ModalRedefinirSenha store={store} onClose={() => setModal(null)} />}
      {modal?.type === 'addVale'         && <ModalNovoVale store={store} today={today} onClose={() => setModal(null)} />}
      {modal?.type === 'addDespesa'      && <ModalNovaDespesa store={store} today={today} onClose={() => setModal(null)} />}
    </div>
  )
}

// ─── ABA EXTRAS ───────────────────────────────────────────────────────────────

function TabExtras({ store, today, setModal }) {
  const { extras, pessoas, setores, removeExtra, addExtra } = store
  const todayExtras = useMemo(() => {
    const all = extras.filter(e => e.data_op === today)
    const naoLancados = all.filter(e => !e.lancado).sort((a,b) => a.nome.localeCompare(b.nome))
    const lancados = all.filter(e => e.lancado).sort((a,b) => a.nome.localeCompare(b.nome))
    return [...naoLancados, ...lancados]
  }, [extras, today])
  const total = useMemo(() => todayExtras.reduce((a, e) => a + e.valor_final, 0), [todayExtras])

  const duplicar = async () => {
    if (!confirm('Duplicar todos os extras de ontem para hoje? Os valores serão recalculados para ' + (isWeekend(today) ? 'fim de semana' : 'dia de semana') + '.')) return
    const ontem = toDateStr(new Date(new Date(today + 'T12:00:00').getTime() - 86400000))
    const ontemExtras = extras.filter(e => e.data_op === ontem)
    if (ontemExtras.length === 0) return alert('Nenhum extra ontem para duplicar.')
    
    // Proteção contra duplicação: verifica se já existem extras de hoje
    const todayExtras = extras.filter(e => e.data_op === today)
    const pessoasJaDuplicadas = new Set(todayExtras.map(e => e.pessoa_id))
    
    let duplicados = 0
    for (const e of ontemExtras) {
      // Pula se a pessoa já tem extra hoje (evita duplicação)
      if (e.pessoa_id && pessoasJaDuplicadas.has(e.pessoa_id)) continue
      
      const p = pessoas.find(x => x.id === e.pessoa_id)
      const val = p ? (isWeekend(today) ? p.val_sex_dom : p.val_seg_qui) : e.valor_original || e.valor_final
      // Cria explicitamente — nunca copia flags de pagamento do dia anterior
      await addExtra({
        pessoa_id:       e.pessoa_id,
        nome:            e.nome,
        funcao:          e.funcao,
        setor_id:        e.setor_id,
        turnos:          e.turnos,
        obs:             e.obs || '',
        data_op:         today,
        data_real:       toDateStr(new Date()),
        valor_extra:     val,
        valor_original:  val,
        valor_final:     val,
        pago:            false,
        previsao:        'indefinido',
        assinatura:      null,
        forma_pagamento: null,
        lancado:         false,
        trocos_descontados: [],
        troco_gerado:    0,
        desconto_troco:  0,
        valor_pago:      0,
      })
      duplicados++
    }
    alert(`✅ ${duplicados} extras duplicados com sucesso!`)
  }
  
  const hojeReal = toDateStr(new Date())
  const diaVirado = today !== hojeReal

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button onClick={() => setModal({ type: 'addExtra' })} style={{ ...S.btn(C.primary), flex: 3 }}>✦ Novo Extra</button>
        <button onClick={() => setModal({ type: 'addPessoa' })} style={{ ...S.btn(C.accent), flex: 2 }}>+ Pessoa</button>
        <button onClick={duplicar} style={{ ...S.btn(C.secondary, true), flex: 2 }}>📋 Duplicar</button>
      </div>
      <div style={{ ...S.card, background: 'linear-gradient(135deg,#1a1a2e,#2d2340)', color: '#fff' }}>
        <div style={{ fontSize: 11, color: '#c9a96e', textTransform: 'uppercase' }}>Total do Dia</div>
        <div style={{ fontSize: 28, fontWeight: 700, color: '#c9a96e' }}>{fmt(total)}</div>
        <div style={{ fontSize: 12, color: '#ffffff80' }}>{todayExtras.length} extras</div>
      </div>
      {todayExtras.length === 0 && <div style={{ ...S.card, textAlign: 'center', padding: 32, color: '#999' }}><div style={{ fontSize: 40 }}>🍖</div><div>Nenhum extra hoje</div></div>}
      {todayExtras.map(e => {
        const setor = store.setores.find(s => s.id === e.setor_id)
        const pessoa = store.pessoas.find(p => p.id === e.pessoa_id)
        const trocosTotal = totalTrocos(pessoa?.trocos)
        return (
          <div key={e.id} style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{e.nome}</div>
                <div style={{ fontSize: 13, color: '#8a7355' }}>{e.funcao}{setor ? ' · ' + setor.nome : ''}</div>
                {e.turnos && <Badge>{e.turnos}</Badge>}
                {e.obs ? <div style={{ fontSize: 12, color: '#aaa', marginTop: 2 }}>{e.obs}</div> : null}
                {trocosTotal > 0 && !e.pago && (
                  <div style={{ fontSize: 11, color: '#ef4444', marginTop: 3, fontWeight: 600 }}>
                    🔴 Troco a descontar: {fmt(trocosTotal)}
                  </div>
                )}
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#c9a96e' }}>{fmt(e.valor_final)}</div>
                {e.pago ? <Badge color="#22c55e">✓ Pago</Badge> : <Badge color="#f59e0b">Pendente</Badge>}
              </div>
            </div>
            {!e.pago && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button onClick={() => setModal({ type: 'editExtra', extra: e })} style={{ background: 'none', border: '1px solid #c9a96e', borderRadius: 6, padding: '4px 12px', fontSize: 12, color: '#c9a96e', cursor: 'pointer' }}>✏️ Editar</button>
                <button onClick={() => { if (confirm('Remover ' + e.nome + '?')) removeExtra(e.id) }} style={{ background: 'none', border: '1px solid #f0e8d8', borderRadius: 6, padding: '4px 10px', fontSize: 12, color: '#ef4444', cursor: 'pointer' }}>Remover</button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── MODAL NOVO EXTRA ─────────────────────────────────────────────────────────

function ModalAddExtra({ store, today, onClose }) {
  const { pessoas, setores, addExtra } = store
  const [pessoaId, setPessoaId] = useState('')
  const [nomeAvulso, setNomeAvulso] = useState('')
  const [modoAvulso, setModoAvulso] = useState(false)
  const [funcao, setFuncao] = useState('')
  const [setorId, setSetorId] = useState('')
  const [turnos, setTurnos] = useState('')
  const [valorDisplay, setValorDisplay] = useState('')
  const [obs, setObs] = useState('')

  const pessoa = pessoas.find(p => p.id === pessoaId)
  const nomeUsado = modoAvulso ? nomeAvulso : (pessoa?.nome || '')

  useEffect(() => {
    if (!pessoa) return
    setFuncao(pessoa.funcao || '')
    setSetorId(pessoa.setor_id || '')
    const base = isWeekend(today) ? pessoa.val_sex_dom : pessoa.val_seg_qui
    const mult = turnos === 'TD+TN' ? 2 : 1
    setValorDisplay(fmt(base * mult))
  }, [pessoaId, turnos])

  const trocarModo = () => {
    setModoAvulso(!modoAvulso)
    setPessoaId('')
    setNomeAvulso('')
    setFuncao('')
    setSetorId('')
    setValorDisplay('')
  }

  const save = async () => {
    if (!nomeUsado.trim()) return alert(modoAvulso ? 'Digite o nome do extra.' : 'Selecione uma pessoa cadastrada.')
    const v = parseCents(valorDisplay)
    if (!v || v < 100) return alert('Informe um valor válido (mínimo R$1,00).')
    await addExtra({
      pessoa_id:          modoAvulso ? null : (pessoaId || null),
      nome:               nomeUsado.trim(),
      funcao,
      setor_id:           setorId,
      data_op:            today,
      data_real:          toDateStr(new Date()),
      turnos,
      obs,
      valor_extra:        v,
      valor_original:     v,
      valor_final:        v,
      desconto_troco:     0,
      valor_pago:         0,
      troco_gerado:       0,
      pago:               false,
      previsao:           'indefinido',
      assinatura:         null,
      forma_pagamento:    null,
      lancado:            false,
      trocos_descontados: [],
    })
    onClose()
  }

  return (
    <Modal title="Novo Extra" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* Toggle cadastrado / avulso */}
        <div style={{ display: 'flex', background: '#f0e8d8', borderRadius: 10, padding: 4 }}>
          <button onClick={() => { if (modoAvulso) trocarModo() }}
            style={{ flex: 1, padding: '8px', border: 'none', borderRadius: 8, background: !modoAvulso ? '#fff' : 'transparent', cursor: 'pointer', fontSize: 13, fontWeight: !modoAvulso ? 700 : 400, color: !modoAvulso ? '#c9a96e' : '#999' }}>
            👤 Cadastrado
          </button>
          <button onClick={() => { if (!modoAvulso) trocarModo() }}
            style={{ flex: 1, padding: '8px', border: 'none', borderRadius: 8, background: modoAvulso ? '#fff' : 'transparent', cursor: 'pointer', fontSize: 13, fontWeight: modoAvulso ? 700 : 400, color: modoAvulso ? '#c9a96e' : '#999' }}>
            ✏️ Avulso
          </button>
        </div>

        {!modoAvulso ? (
          <div>
            <label style={S.label}>Selecionar pessoa *</label>
            <select value={pessoaId} onChange={e => setPessoaId(e.target.value)} style={{ ...S.input, fontWeight: pessoaId ? 700 : 400 }}>
              <option value="">— Escolha uma pessoa —</option>
              {pessoas.sort((a,b) => a.nome.localeCompare(b.nome)).map(p => (
                <option key={p.id} value={p.id}>{p.nome} · {p.funcao}</option>
              ))}
            </select>
            {pessoaId && (
              <div style={{ marginTop: 6, padding: '8px 10px', background: '#f5f0e8', borderRadius: 8, fontSize: 12, color: '#8a7355' }}>
                ✓ {pessoa?.nome} · {pessoa?.funcao}
                {pessoa?.setor_id && setores.find(s => s.id === pessoa.setor_id) && ' · ' + setores.find(s => s.id === pessoa.setor_id).nome}
                <br />Seg-Qui: {fmt(pessoa?.val_seg_qui)} · Sex-Dom: {fmt(pessoa?.val_sex_dom)}
              </div>
            )}
          </div>
        ) : (
          <div>
            <label style={S.label}>Nome do extra *</label>
            <input value={nomeAvulso} onChange={e => setNomeAvulso(e.target.value)} style={S.input} placeholder="Nome completo" autoFocus />
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Função</label>
            <input value={funcao} onChange={e => setFuncao(e.target.value)} style={S.input} placeholder="Churrasqueiro..." />
          </div>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Setor</label>
            <select value={setorId} onChange={e => setSetorId(e.target.value)} style={S.input}>
              <option value="">—</option>
              {setores.filter(s => s.ativo).map(s => <option key={s.id} value={s.id}>{s.nome}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label style={S.label}>Turno</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {['TD', 'TN', 'TD+TN', ''].map((t, i) => (
              <button key={i} onClick={() => setTurnos(t)}
                style={{ flex: 1, padding: '8px 4px', border: `2px solid ${turnos === t ? '#c9a96e' : '#e0d5c5'}`, borderRadius: 8, background: turnos === t ? '#c9a96e22' : '#fff', cursor: 'pointer', fontSize: 12, fontWeight: turnos === t ? 700 : 400, color: turnos === t ? '#c9a96e' : '#666' }}>
                {t || '—'}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label style={S.label}>Valor *</label>
          <input value={valorDisplay}
            onChange={e => { const r = e.target.value.replace(/\D/g, ''); setValorDisplay(r ? fmt(parseInt(r)) : '') }}
            style={{ ...S.input, fontSize: 18, fontWeight: 700 }} placeholder="R$ 0,00" inputMode="numeric" />
        </div>

        <div>
          <label style={S.label}>Observação</label>
          <input value={obs} onChange={e => setObs(e.target.value)} style={S.input} placeholder="Opcional..." />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={{ ...S.btn(C.textDim, true) }}>Cancelar</button>
          <button onClick={save} style={{ ...S.btn(C.primary), flex: 2 }}>Salvar</button>
        </div>
      </div>
    </Modal>
  )
}

// ─── MODAL EDITAR EXTRA ───────────────────────────────────────────────────────

function ModalEditExtra({ store, extra, onClose }) {
  const { setores, updateExtra } = store
  const [nome, setNome] = useState(extra.nome)
  const [funcao, setFuncao] = useState(extra.funcao || '')
  const [setorId, setSetorId] = useState(extra.setor_id || '')
  const [turnos, setTurnos] = useState(extra.turnos || '')
  const [valorDisplay, setValorDisplay] = useState(fmt(extra.valor_final))
  const [obs, setObs] = useState(extra.obs || '')

  const save = async () => {
    if (!nome.trim()) return alert('Nome obrigatório')
    const v = parseCents(valorDisplay)
    await updateExtra(extra.id, { nome: nome.trim(), funcao, setor_id: setorId, turnos, valor_final: v, valor_original: v, obs })
    onClose()
  }

  return (
    <Modal title="Editar Extra" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div><label style={S.label}>Nome *</label><input value={nome} onChange={e => setNome(e.target.value)} style={S.input} /></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}><label style={S.label}>Função</label><input value={funcao} onChange={e => setFuncao(e.target.value)} style={S.input} /></div>
          <div style={{ flex: 1 }}><label style={S.label}>Setor</label>
            <select value={setorId} onChange={e => setSetorId(e.target.value)} style={S.input}>
              <option value="">—</option>
              {setores.filter(s => s.ativo).map(s => <option key={s.id} value={s.id}>{s.nome}</option>)}
            </select>
          </div>
        </div>
        <div><label style={S.label}>Turno</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {['TD', 'TN', 'TD+TN', ''].map((t, i) => (
              <button key={i} onClick={() => setTurnos(t)} style={{ flex: 1, padding: '8px 4px', border: `2px solid ${turnos === t ? '#c9a96e' : '#e0d5c5'}`, borderRadius: 8, background: turnos === t ? '#c9a96e22' : '#fff', cursor: 'pointer', fontSize: 12, fontWeight: turnos === t ? 700 : 400, color: turnos === t ? '#c9a96e' : '#666' }}>{t || '—'}</button>
            ))}
          </div>
        </div>
        <div><label style={S.label}>Valor</label>
          <input value={valorDisplay} onChange={e => { const r = e.target.value.replace(/\D/g, ''); setValorDisplay(r ? fmt(parseInt(r)) : '') }} style={S.input} placeholder="R$ 0,00" inputMode="numeric" />
        </div>
        <div><label style={S.label}>Observação</label><input value={obs} onChange={e => setObs(e.target.value)} style={S.input} placeholder="Opcional..." /></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={{ ...S.btn(C.textDim, true) }}>Cancelar</button>
          <button onClick={save} style={{ ...S.btn(C.primary), flex: 2 }}>Salvar</button>
        </div>
      </div>
    </Modal>
  )
}

// ─── ABA CAIXA (Pagamentos + Lançamentos + Saídas) ───────────────────────────

function TabCaixa({ store, today, setModal }) {
  const { extras } = store
  const [subAba, setSubAba] = useState('pagamentos')
  const pendentesCount = extras.filter(e => e.data_op === today && !e.pago).length

  return (
    <div>
      <div style={{ display: 'flex', background: '#f0e8d8', padding: 4, borderRadius: 14, marginBottom: 14, gap: 4 }}>
        {[
          ['pagamentos', '💳 Pagamentos'],
          ['lancamentos', '📋 Lançar'],
          ['saidas',      '💸 Saídas'],
        ].map(([id, label]) => (
          <button key={id} onClick={() => setSubAba(id)}
            style={{ flex: 1, padding: '9px 4px', border: 'none', borderRadius: 10, position: 'relative',
              background: subAba === id ? '#fff' : 'transparent', cursor: 'pointer',
              fontSize: 11, fontWeight: subAba === id ? 800 : 400,
              color: subAba === id ? C.primary : '#999',
              boxShadow: subAba === id ? '0 1px 4px rgba(0,0,0,0.08)' : 'none' }}>
            {label}
            {id === 'pagamentos' && pendentesCount > 0 && (
              <span style={{ position: 'absolute', top: 4, right: 6, background: C.danger, color: '#fff',
                borderRadius: 8, fontSize: 9, fontWeight: 800, padding: '1px 5px', minWidth: 16, textAlign: 'center' }}>
                {pendentesCount}
              </span>
            )}
          </button>
        ))}
      </div>
      {subAba === 'pagamentos'  && <TabPagamentos store={store} today={today} setModal={setModal} />}
      {subAba === 'lancamentos' && <TabLancamentos store={store} today={today} />}
      {subAba === 'saidas'      && <TabVales store={store} today={today} setModal={setModal} />}
    </div>
  )
}

// ─── ABA PAGAMENTOS ───────────────────────────────────────────────────────────

function TabPagamentos({ store, today, setModal }) {
  const { extras, vales, despesas, setores, pessoas, updateExtra, config } = store
  const pendentes = useMemo(() => extras.filter(e => e.data_op === today && !e.pago).sort((a,b) => a.nome.localeCompare(b.nome)), [extras, today])
  const pagos = useMemo(() => extras.filter(e => e.data_op === today && e.pago).sort((a,b) => a.nome.localeCompare(b.nome)), [extras, today])
  const dinheiroTotal = useMemo(() => pendentes.filter(e => e.previsao !== 'pix').reduce((a, e) => a + e.valor_final, 0), [pendentes])
  const pixTotal = useMemo(() => pendentes.filter(e => e.previsao === 'pix').reduce((a, e) => a + e.valor_final, 0), [pendentes])
  const notes = useMemo(() => {
    const total = { 100: 0, 50: 0, 20: 0, 10: 0, 5: 0 }
    pendentes.filter(e => e.previsao !== 'pix').forEach(e => {
      const n = calcNotes(e.valor_final)
      Object.keys(total).forEach(k => { total[k] += n[Number(k)] || 0 })
    })
    return total
  }, [pendentes])
  const pendentesPorSetor = useMemo(() => {
    const sem = { id: '__sem__', nome: 'Sem setor' }
    const map = {}
    pendentes.forEach(e => {
      const setor = setores.find(s => s.id === e.setor_id) || sem
      if (!map[setor.id]) map[setor.id] = { setor, extras: [] }
      map[setor.id].extras.push(e)
    })
    return Object.values(map).sort((a, b) => a.setor.nome.localeCompare(b.setor.nome))
  }, [pendentes, setores])
  const [setoresAbertos, setSetoresAbertos] = useState({})
  useEffect(() => {
    const ini = {}
    pendentesPorSetor.forEach(g => { ini[g.setor.id] = true })
    setSetoresAbertos(ini)
  }, [pendentesPorSetor.length])
  const toggleSetor = (id) => setSetoresAbertos(prev => ({ ...prev, [id]: !prev[id] }))

  const coresNotas = { 100: { bg: '#1e3a5f', label: '#60a5fa', emoji: '💙' }, 50: { bg: '#3d1f00', label: '#fb923c', emoji: '🟠' }, 20: { bg: '#3d3000', label: '#fbbf24', emoji: '🟡' }, 10: { bg: '#3d0a2e', label: '#f472b6', emoji: '🩷' }, 5: { bg: '#1a2e1a', label: '#4ade80', emoji: '💚' } }

  return (
    <div>
      <div style={{ ...S.card, background: 'linear-gradient(135deg,#12122a,#1a0d2e)', color: '#fff' }}>
        <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: '#ffffff99', textTransform: 'uppercase', fontWeight: 700 }}>Dinheiro</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#10b981' }}>{fmt(dinheiroTotal)}</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: '#ffffff99', textTransform: 'uppercase', fontWeight: 700 }}>Pix</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#00c2cb' }}>{fmt(pixTotal)}</div>
          </div>
        </div>
        <div style={{ borderTop: '1px solid #ffffff20', paddingTop: 12 }}>
          <div style={{ fontSize: 11, color: '#ffffff60', marginBottom: 10, fontWeight: 700 }}>NOTAS NECESSARIAS</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(notes).filter(([, q]) => q > 0).map(([n, q]) => {
              const c = coresNotas[Number(n)] || { bg: '#1a1a2e', label: '#fff', emoji: '💵' }
              return (
                <div key={n} style={{ background: c.bg, borderRadius: 14, padding: '10px 14px', textAlign: 'center', minWidth: 60 }}>
                  <div style={{ fontSize: 20 }}>{c.emoji}</div>
                  <div style={{ fontSize: 22, fontWeight: 900, color: c.label }}>{q}x</div>
                  <div style={{ fontSize: 11, color: c.label, fontWeight: 700 }}>R${n}</div>
                </div>
              )
            })}
            {Object.values(notes).every(q => q === 0) && (
              <div style={{ fontSize: 13, color: '#ffffff40' }}>Nenhuma nota</div>
            )}
          </div>
        </div>
      </div>

      {pendentes.length === 0 && (
        <div style={{ ...S.card, textAlign: 'center', padding: 32 }}>
          <div style={{ fontSize: 36 }}>✅</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginTop: 8 }}>Todos pagos!</div>
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>Nenhum pendente hoje</div>
        </div>
      )}

      {pendentesPorSetor.map(grupo => (
        <div key={grupo.setor.id} style={{ marginBottom: 8 }}>
          <div onClick={() => toggleSetor(grupo.setor.id)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: C.bgCard2, borderRadius: 14, border: '1px solid ' + C.border, cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 10, height: 10, borderRadius: 5, background: C.primary }} />
              <span style={{ fontSize: 15, fontWeight: 800, color: C.text }}>{grupo.setor.nome}</span>
              <span style={{ fontSize: 12, color: C.textMuted, background: C.bgCard, borderRadius: 10, padding: '2px 8px', fontWeight: 700 }}>{grupo.extras.length}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 800, color: C.primary }}>{fmt(grupo.extras.reduce((a, e) => a + e.valor_final, 0))}</span>
              <span style={{ fontSize: 18, color: C.textMuted }}>v</span>
            </div>
          </div>

          {setoresAbertos[grupo.setor.id] && (
            <div style={{ border: '1px solid ' + C.border, borderTop: 'none', borderRadius: '0 0 14px 14px', overflow: 'hidden' }}>
              {grupo.extras.map((e, idx) => {
                const pessoa = pessoas.find(p => p.id === e.pessoa_id)
                const trocosTotal = totalTrocos(pessoa ? pessoa.trocos : null)
                const descontoAplicado = e.desconto_troco || 0
                const isLast = idx === grupo.extras.length - 1
                return (
                  <div key={e.id} style={{ background: C.bgCard, padding: '14px 16px', borderBottom: isLast ? 'none' : '1px solid ' + C.border }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: 16, color: C.text }}>{e.nome}</div>
                        <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>{e.funcao}{e.turnos ? ' · ' + e.turnos : ''}</div>
                        {descontoAplicado > 0 && <div style={{ fontSize: 12, color: C.success, marginTop: 2, fontWeight: 700 }}>desconto: -{fmt(descontoAplicado)}</div>}
                        {e.obs ? <div style={{ fontSize: 12, color: C.textMuted, fontStyle: 'italic', marginTop: 3 }}>{e.obs}</div> : null}
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 22, fontWeight: 900, color: C.primary }}>{fmt(e.valor_final)}</div>
                      </div>
                    </div>

                    {trocosTotal > 0 && (
                      <div style={{ background: '#2a0d0d', border: '1px solid #ef444444', borderRadius: 10, padding: '8px 12px', marginBottom: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div>
                            <div style={{ fontSize: 12, color: '#ef4444', fontWeight: 700 }}>Troco a descontar</div>
                            {(pessoa && pessoa.trocos ? pessoa.trocos : []).map((t, i) => (
                              <div key={i} style={{ fontSize: 11, color: '#ff6b6b', marginTop: 2 }}>{dayLabel(t.data)}: {fmt(t.valor)}</div>
                            ))}
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <div style={{ fontSize: 14, fontWeight: 800, color: '#ef4444' }}>{fmt(trocosTotal)}</div>
                            <button onClick={async () => {
                              if (!confirm('Aplicar desconto de ' + fmt(trocosTotal) + '?')) return
                              const novoValor = Math.max(0, e.valor_final - trocosTotal)
                              await updateExtra(e.id, { valor_final: novoValor, desconto_troco: (e.desconto_troco || 0) + trocosTotal, trocos_descontados: pessoa ? pessoa.trocos : [] })
                              if (pessoa) await store.updatePessoa(pessoa.id, { trocos: [] })
                            }} style={{ marginTop: 4, background: '#ef4444', color: '#fff', border: 'none', borderRadius: 8, padding: '4px 10px', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
                              Aplicar -{fmt(trocosTotal)}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                      {[['indefinido', 'Indefinido', '#666666'], ['dinheiro', 'Dinheiro', '#10b981'], ['pix', 'Pix', '#00c2cb']].map(([v, label, color]) => (
                        <button key={v} onClick={() => updateExtra(e.id, { previsao: v })}
                          style={{ flex: 1, padding: '8px 4px', border: '2px solid ' + (e.previsao === v ? color : C.border), borderRadius: 10, background: e.previsao === v ? color + '25' : C.bgCard2, cursor: 'pointer', fontSize: 12, color: e.previsao === v ? color : C.textMuted, fontWeight: e.previsao === v ? 800 : 400 }}>
                          {label}
                        </button>
                      ))}
                    </div>

                    <button onClick={() => setModal({ type: 'pagar', extra: e })} style={{ ...S.btn(C.primary), width: '100%', fontSize: 15 }}>
                      Pagar {fmt(e.valor_final)}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ))}

      {pagos.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 1, height: 1, background: C.success + '44' }} />
            <span style={{ fontSize: 11, color: C.success, fontWeight: 800, textTransform: 'uppercase' }}>Pagos ({pagos.length})</span>
            <div style={{ flex: 1, height: 1, background: C.success + '44' }} />
          </div>
          {pagos.map(e => (
            <div key={e.id} style={{ background: '#0d1f14', border: '1px solid #10b98133', borderRadius: 12, padding: '10px 14px', marginBottom: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: '#d1fae5' }}>{e.nome}</div>
                  <div style={{ fontSize: 12, color: '#6ee7b7' }}>
                    {e.forma_pagamento === 'pix' ? 'Pix' : 'Dinheiro'}
                    {(e.trocos_descontados || []).length > 0 && <span style={{ color: C.success }}> - {fmt(e.trocos_descontados.reduce((a, t) => a + t.valor, 0))} troco</span>}
                    {e.editado && <span style={{ color: C.gold }}> - editado</span>}
                  </div>
                  {e.obs && <div style={{ fontSize: 11, color: '#6ee7b7aa', fontStyle: 'italic', marginTop: 2 }}>{e.obs}</div>}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: '#34d399' }}>{fmt(e.valor_final)}</div>
                  <div style={{ display: 'flex', gap: 4, marginTop: 4, justifyContent: 'flex-end' }}>
                    <button onClick={() => setModal({ type: 'editarPagamento', extra: e })} style={{ background: 'none', border: '1px solid ' + C.gold + '55', borderRadius: 8, color: C.gold, fontSize: 11, padding: '3px 8px', cursor: 'pointer', fontWeight: 700 }}>
                      Editar
                    </button>
                    {(store.usuario?.role === 'admin' || store.usuario?.role === 'gerente') && (
                      <button onClick={() => { if (confirm('Desfazer pagamento de ' + e.nome + '? Ele voltará para Pendente.')) {
                        updateExtra(e.id, { pago: false, forma_pagamento: null, assinatura: null, valor_final: e.valor_original || e.valor_extra || e.valor_final, valor_pago: 0, desconto_troco: 0, trocos_descontados: [], troco_gerado: 0, previsao: 'indefinido' })
                      }}} style={{ background: 'none', border: '1px solid #f59e0b55', borderRadius: 8, color: '#f59e0b', fontSize: 11, padding: '3px 8px', cursor: 'pointer', fontWeight: 700 }}>
                        ↩ Desfazer
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ModalPagar({ store, extra, today, onClose }) {
  const { pessoas, updateExtra, updatePessoa, config } = store
  const pessoa = pessoas.find(p => p.id === extra.pessoa_id)
  const trocos = pessoa?.trocos || []
  const [step, setStep] = useState('escolha')
  const [forma, setForma] = useState(extra.previsao === 'pix' ? 'pix' : 'dinheiro')
  const [valorDisplay, setValorDisplay] = useState(fmt(extra.valor_final))
  const [assinatura, setAssinatura] = useState(null)
  // quais trocos o usuário marcou para descontar
  const [trocosSelecionados, setTrocosSelecionados] = useState([])

  const valorBase = extra.valor_final
  const totalTrocoSel = trocosSelecionados.reduce((a, t) => a + t.valor, 0)
  const valorSugerido = Math.max(0, valorBase - totalTrocoSel)
  const valorCents = parseCents(valorDisplay)

  // quando seleciona/deseleciona troco, atualiza valor sugerido no input
  useEffect(() => {
    setValorDisplay(fmt(valorSugerido))
  }, [trocosSelecionados])

  const toggleTroco = (t) => {
    setTrocosSelecionados(prev =>
      prev.find(x => x.data === t.data && x.valor === t.valor)
        ? prev.filter(x => !(x.data === t.data && x.valor === t.valor))
        : [...prev, t]
    )
  }

  const buildPixMsg = () => {
    const ref = dayLabel(extra.data_op)
    let msg = `Pagar ${extra.nome} referente a extra de ${extra.funcao}${extra.turnos ? ' — ' + extra.turnos : ''} — valor original ${fmt(valorBase)}.`
    if (extra.obs) msg += `\n\nObservação: ${extra.obs}`
    if (trocosSelecionados.length > 0) {
      msg += `\n\nDescontos de troco aplicados:`
      trocosSelecionados.forEach(t => { msg += `\n• ${dayLabel(t.data)}: −${fmt(t.valor)}` })
      msg += `\n\nValor final a pagar: ${fmt(valorCents)}`
    }
    msg += `\n\nREF: ${ref}\nTipo da chave: ${pessoa?.tipo_pix || '—'}\n\nCHAVE PIX:\n${pessoa?.chave_pix || '—'}`
    return msg
  }

  const validarPixAnviarWhatsApp = () => {
    if (!pessoa?.chave_pix) {
      alert('⚠️ Este funcionário não tem chave Pix cadastrada. Cadastre a chave Pix antes de enviar.')
      return false
    }
    return true
  }

  const finalizar = async () => {
    try {
      // Upload da assinatura para o Storage antes da transaction
      let assinaturaUrl = null
      if (assinatura) {
        assinaturaUrl = await uploadAssinatura(extra.id, assinatura)
      }

      await runTransaction(db, async (transaction) => {
        // 1. Lê o estado mais recente do extra no Firebase
        const extraRef = doc(db, 'extras', extra.id)
        const extraSnap = await transaction.get(extraRef)

        if (!extraSnap.exists()) throw new Error('Extra não encontrado.')
        if (extraSnap.data()?.pago) throw new Error('JÁ_PAGO')

        // 2. Calcula valores financeiros separados
        const totalDesconto = trocosSelecionados.reduce((a, t) => a + t.valor, 0)
        const valorPagoFinal = valorCents
        const trocoGeradoFinal = Math.max(0, valorPagoFinal - valorBase + totalDesconto)

        // 3. Atualiza o extra com valores separados
        transaction.update(extraRef, {
          pago:               true,
          forma_pagamento:    forma,
          valor_extra:        valorBase,        // valor contratado (imutável)
          desconto_troco:     totalDesconto,    // quanto foi descontado de troco
          valor_pago:         valorPagoFinal,   // quanto saiu do caixa
          troco_gerado:       trocoGeradoFinal, // novo troco gerado hoje
          valor_final:        valorPagoFinal,   // mantido por compatibilidade
          assinatura:         assinaturaUrl,    // URL do Storage (ou base64 fallback)
          data_pagamento:     new Date().toISOString(),
          trocos_descontados: trocosSelecionados,
        })

        // 4. Atualiza trocos do funcionário
        if (pessoa) {
          const pessoaRef = doc(db, 'pessoas', pessoa.id)
          const novosTrocos = [
            ...trocos.filter(t =>
              !trocosSelecionados.find(s => s.data === t.data && s.valor === t.valor)
            )
          ]
          if (trocoGeradoFinal > 0) {
            novosTrocos.push({
              data: today,
              valor: trocoGeradoFinal,
              descricao: `Troco do dia ${dayLabel(today)}`,
            })
          }
          transaction.update(pessoaRef, { trocos: novosTrocos })
        }
      })

      // 5. Envia Pix fora da transaction (efeito colateral)
      if (forma === 'pix') {
        if (!validarPixAnviarWhatsApp()) { setSalvando && setSalvando(false); return }
        const numero = config?.whatsapp_pix || DEFAULT_CONFIG.whatsapp_pix
        window.open(`https://wa.me/${numero}?text=${encodeURIComponent(buildPixMsg())}`, '_blank')
      }

      onClose()

    } catch (err) {
      if (err.message === 'JÁ_PAGO') {
        alert('⚠️ Este extra já foi pago em outro dispositivo.')
        onClose()
      } else {
        alert('Erro ao registrar pagamento. Tente novamente.')
        console.error(err)
      }
    }
  }

  if (step === 'assinatura') return (
    <Modal title="Assinatura" onClose={onClose}>
      <div style={{ marginBottom: 12 }}><div style={{ fontWeight: 600 }}>{extra.nome}</div><div style={{ fontSize: 13, color: '#8a7355' }}>{fmt(valorCents)} · {forma === 'pix' ? 'Pix' : 'Dinheiro'}</div></div>
      <SignaturePad onSave={sig => { setAssinatura(sig); setStep('escolha') }} onCancel={() => setStep('escolha')} />
    </Modal>
  )

  return (
    <Modal title="Efetuar Pagamento" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* Info do extra */}
        <div style={{ background: C.bgCard2, borderRadius: 14, padding: 14, border: `1px solid ${C.border}` }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: C.text }}>{extra.nome}</div>
          <div style={{ fontSize: 13, color: C.textMuted }}>{extra.funcao}{extra.turnos ? ' · ' + extra.turnos : ''}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, background: C.bgCard, padding: '10px 12px', borderRadius: 10, border: `1px solid ${C.border}`, minWidth: 90 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase' }}>Valor Combinado</div>
              <div style={{ fontSize: 17, fontWeight: 900, color: C.text }}>{fmt(extra.valor_extra || valorBase)}</div>
            </div>
            {trocosSelecionados.length > 0 && (
              <div style={{ flex: 1, background: '#fef2f2', padding: '10px 12px', borderRadius: 10, border: '1px solid #fecaca', minWidth: 90 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.danger, textTransform: 'uppercase' }}>Desconto Troco</div>
                <div style={{ fontSize: 17, fontWeight: 900, color: C.danger }}>−{fmt(totalTrocoSel)}</div>
              </div>
            )}
            {trocosSelecionados.length > 0 && (
              <div style={{ flex: 1, background: '#f0fdf4', padding: '10px 12px', borderRadius: 10, border: '1px solid #bbf7d0', minWidth: 90 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.success, textTransform: 'uppercase' }}>A Pagar</div>
                <div style={{ fontSize: 17, fontWeight: 900, color: C.success }}>{fmt(valorSugerido)}</div>
              </div>
            )}
          </div>
        </div>

        {/* Trocos pendentes */}
        {trocos.length > 0 && (
          <div style={{ background: '#fff5f5', border: '1px solid #fecaca', borderRadius: 10, padding: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#ef4444', marginBottom: 8 }}>
              🔴 Trocos a descontar (opcional)
            </div>
            {trocos.map((t, i) => {
              const sel = !!trocosSelecionados.find(s => s.data === t.data && s.valor === t.valor)
              return (
                <div key={i} onClick={() => toggleTroco(t)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: i < trocos.length - 1 ? '1px solid #fee2e2' : 'none', cursor: 'pointer' }}>
                  <div style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${sel ? '#ef4444' : '#fca5a5'}`, background: sel ? '#ef4444' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {sel && <span style={{ color: '#fff', fontSize: 12, fontWeight: 700 }}>✓</span>}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, color: '#b91c1c', fontWeight: 600 }}>−{fmt(t.valor)}</div>
                    <div style={{ fontSize: 11, color: '#ef4444' }}>{dayLabel(t.data)}</div>
                  </div>
                </div>
              )
            })}
            {trocosSelecionados.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 12, color: '#b91c1c', fontWeight: 600, textAlign: 'right' }}>
                Total a descontar: −{fmt(totalTrocoSel)} → Sugerido: {fmt(valorSugerido)}
              </div>
            )}
          </div>
        )}

        {/* Forma de pagamento */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setForma('dinheiro')} style={{ flex: 1, padding: '12px', border: `2px solid ${forma === 'dinheiro' ? '#22c55e' : '#e0d5c5'}`, borderRadius: 10, background: forma === 'dinheiro' ? '#22c55e20' : '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: forma === 'dinheiro' ? '#22c55e' : '#999' }}>💵 Dinheiro</button>
          <button onClick={() => setForma('pix')} style={{ flex: 1, padding: '12px', border: `2px solid ${forma === 'pix' ? '#3b82f6' : '#e0d5c5'}`, borderRadius: 10, background: forma === 'pix' ? '#3b82f620' : '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: forma === 'pix' ? '#3b82f6' : '#999' }}>📱 Pix</button>
        </div>

        {/* Valor pago */}
        <div>
          <label style={S.label}>Valor a pagar</label>
          <input value={valorDisplay}
            onChange={e => { const r = e.target.value.replace(/\D/g, ''); setValorDisplay(r ? fmt(parseInt(r)) : '') }}
            style={{ ...S.input, fontSize: 18, fontWeight: 700 }} inputMode="numeric" />
          {parseCents(valorDisplay) > valorBase && (
            <div style={{ fontSize: 11, color: '#ef4444', marginTop: 4, fontWeight: 600 }}>
              ⚠ Pagando {fmt(parseCents(valorDisplay) - valorBase)} a mais → vai gerar troco para próximo pagamento
            </div>
          )}
        </div>

        {/* Dados Pix */}
        {forma === 'pix' && pessoa && (
          <div style={{ ...S.card, background: '#eff6ff', border: '1px solid #bfdbfe' }}>
            <div style={{ fontSize: 12, color: '#1e40af', fontWeight: 600, marginBottom: 4 }}>Dados do Pix</div>
            <div style={{ fontSize: 13 }}><strong>Tipo:</strong> {pessoa.tipo_pix}</div>
            <div style={{ fontSize: 13 }}><strong>Chave:</strong> {pessoa.chave_pix}</div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>WhatsApp: {config?.whatsapp_pix}</div>
          </div>
        )}

        {/* Assinatura */}
        <div><label style={S.label}>Assinatura</label>
          {assinatura
            ? <div><img src={assinatura} alt="Assinatura" style={{ width: '100%', border: '1px solid #e0d5c5', borderRadius: 8 }} /><button onClick={() => setAssinatura(null)} style={{ background: 'none', border: 'none', color: '#999', fontSize: 12, cursor: 'pointer' }}>Refazer</button></div>
            : <button onClick={() => setStep('assinatura')} style={S.btn('#8a7355')}>✍️ Coletar Assinatura</button>}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={{ ...S.btn(C.textDim, true) }}>Cancelar</button>
          <button onClick={finalizar} style={{ ...S.btn(forma === 'pix' ? '#3b82f6' : '#22c55e'), flex: 2, fontWeight: 700 }}>
            {forma === 'pix' ? '📱 Enviar Pix' : '✓ Confirmar'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ─── ABA LANÇAMENTOS ──────────────────────────────────────────────────────────

function TabLancamentos({ store, today }) {
  const { extras, vales, despesas, updateExtra, updateVale, updateDespesa } = store
  const [copied, setCopied] = useState({})
  const [fotoModal, setFotoModal] = useState(null)

  const todayExtras = useMemo(() => {
    const all = extras.filter(e => e.data_op === today)
    return [...all.filter(e => !e.lancado).sort((a,b) => a.nome.localeCompare(b.nome)),
            ...all.filter(e =>  e.lancado).sort((a,b) => a.nome.localeCompare(b.nome))]
  }, [extras, today])

  const todayVales = useMemo(() => {
    const all = (vales||[]).filter(v => v.data_op === today)
    return [...all.filter(v => !v.lancado).sort((a,b) => a.nome.localeCompare(b.nome)),
            ...all.filter(v =>  v.lancado).sort((a,b) => a.nome.localeCompare(b.nome))]
  }, [vales, today])

  const todayDespesas = useMemo(() => {
    const all = (despesas||[]).filter(d => d.data_op === today)
    return [...all.filter(d => !d.lancado).sort((a,b) => a.descricao.localeCompare(b.descricao)),
            ...all.filter(d =>  d.lancado).sort((a,b) => a.descricao.localeCompare(b.descricao))]
  }, [despesas, today])

  const semNada = todayExtras.length === 0 && todayVales.length === 0 && todayDespesas.length === 0

  const copy = async (id, texto) => {
    try { await navigator.clipboard.writeText(texto) } catch {}
    setCopied(p => ({ ...p, [id]: true }))
    setTimeout(() => setCopied(p => ({ ...p, [id]: false })), 2000)
  }

  const Divisor = ({ label, cor, qtd }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, marginTop: 4 }}>
      <div style={{ flex: 1, height: 1, background: cor + '44' }} />
      <span style={{ fontSize: 11, color: cor, fontWeight: 800, textTransform: 'uppercase' }}>{label} ({qtd})</span>
      <div style={{ flex: 1, height: 1, background: cor + '44' }} />
    </div>
  )

  return (
    <div>
      {/* Modal foto em tela cheia */}
      {fotoModal && (
        <div onClick={() => setFotoModal(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <img src={fotoModal} alt="Nota fiscal" style={{ maxWidth: '100%', maxHeight: '85vh', borderRadius: 8, objectFit: 'contain' }} />
          <div style={{ position: 'absolute', bottom: 24, color: '#ffffff80', fontSize: 12 }}>Toque para fechar</div>
        </div>
      )}

      <div style={{ ...S.card, background: '#f5f0e8', marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: '#8a7355' }}>Copie e cole no sistema interno. Valores lançados manualmente.</div>
      </div>

      {semNada && (
        <div style={{ ...S.card, textAlign: 'center', padding: 32, color: '#999' }}>
          <div style={{ fontSize: 32 }}>📋</div><div>Nenhum lançamento hoje</div>
        </div>
      )}

      {/* EXTRAS */}
      {todayExtras.length > 0 && <>
        <Divisor label="Extras" cor={C.primary} qtd={todayExtras.length} />
        {todayExtras.map(e => {
          const texto = `EXTRA ${e.nome} ${e.funcao}${e.turnos ? ' ' + e.turnos : ''}`
          return (
            <div key={e.id} style={S.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontFamily: 'monospace', fontSize: 14, color: '#2d2d2d' }}>{texto}</div>
                  <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>{fmt(e.valor_final)} · {e.pago ? (e.forma_pagamento === 'pix' ? '📱 Pix' : '💵 Dinheiro') : '⏳ Pendente'}</div>
                  {(e.trocos_descontados||[]).length > 0 && <div style={{ fontSize: 11, color: '#ef4444' }}>Troco: −{fmt(e.trocos_descontados.reduce((a,t)=>a+t.valor,0))}</div>}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => copy(e.id, texto)} style={{ ...S.btn(copied[e.id] ? '#22c55e' : C.primary), flex: 'none', padding: '8px 12px' }}>{copied[e.id] ? '✓' : '📋'}</button>
                  <button onClick={() => updateExtra(e.id, { lancado: !e.lancado })} style={{ ...S.btn(e.lancado ? '#22c55e' : '#e0d5c5'), flex: 'none', padding: '8px 12px', color: e.lancado ? '#fff' : '#666' }}>{e.lancado ? '✓' : '○'}</button>
                </div>
              </div>
              {e.pago && <div style={{ marginTop: 6 }}>{e.lancado ? <Badge color="#22c55e">✓ Lançado</Badge> : <Badge color="#f59e0b">Não lançado</Badge>}</div>}
            </div>
          )
        })}
      </>}

      {/* VALES */}
      {todayVales.length > 0 && <>
        <Divisor label="Vales" cor={C.gold} qtd={todayVales.length} />
        {todayVales.map(v => {
          const texto = `VALE ${v.nome} ${v.funcao || ''}`
          return (
            <div key={v.id} style={{ ...S.card, borderColor: C.gold + '44' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontFamily: 'monospace', fontSize: 14, color: '#2d2d2d' }}>{texto}</div>
                  <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>{fmt(v.valor)} · {v.forma_pagamento === 'pix' ? '📱 Pix' : '💵 Dinheiro'} · <span style={{ color: C.gold }}>Vale</span></div>
                  {v.obs && <div style={{ fontSize: 11, color: '#aaa' }}>{v.obs}</div>}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => copy(v.id, texto)} style={{ ...S.btn(copied[v.id] ? '#22c55e' : C.gold), flex: 'none', padding: '8px 12px' }}>{copied[v.id] ? '✓' : '📋'}</button>
                  <button onClick={() => updateVale(v.id, { lancado: !v.lancado })} style={{ ...S.btn(v.lancado ? '#22c55e' : '#e0d5c5'), flex: 'none', padding: '8px 12px', color: v.lancado ? '#fff' : '#666' }}>{v.lancado ? '✓' : '○'}</button>
                </div>
              </div>
              <div style={{ marginTop: 6 }}>{v.lancado ? <Badge color="#22c55e">✓ Lançado</Badge> : <Badge color="#f59e0b">Não lançado</Badge>}</div>
            </div>
          )
        })}
      </>}

      {/* DESPESAS */}
      {todayDespesas.length > 0 && <>
        <Divisor label="Despesas" cor={C.accent} qtd={todayDespesas.length} />
        {todayDespesas.map(d => {
          const texto = d.descricao
          return (
            <div key={d.id} style={{ ...S.card, borderColor: C.accent + '44' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span style={{ fontSize: 16 }}>{d.categoria_emoji}</span>
                    <span style={{ fontSize: 11, color: C.accent, fontWeight: 700 }}>{d.categoria_nome}</span>
                  </div>
                  <div style={{ fontFamily: 'monospace', fontSize: 13, color: '#2d2d2d' }}>{texto}</div>
                  <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>{fmt(d.valor)} · {d.forma_pagamento === 'pix' ? '📱 Pix' : '💵 Dinheiro'} · <span style={{ color: C.accent }}>Despesa</span></div>
                  {!d.foto && d.obs && (
                    <div style={{ fontSize: 11, color: C.gold, marginTop: 2, fontStyle: 'italic' }}>⚠ Sem nota · {d.obs}</div>
                  )}
                  {d.foto && d.obs && <div style={{ fontSize: 11, color: '#aaa', marginTop: 2 }}>{d.obs}</div>}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button onClick={() => copy(d.id, texto)} style={{ ...S.btn(copied[d.id] ? '#22c55e' : C.accent), flex: 'none', padding: '8px 12px' }}>{copied[d.id] ? '✓' : '📋'}</button>
                  <button onClick={() => updateDespesa(d.id, { lancado: !d.lancado })} style={{ ...S.btn(d.lancado ? '#22c55e' : '#e0d5c5'), flex: 'none', padding: '8px 12px', color: d.lancado ? '#fff' : '#666' }}>{d.lancado ? '✓' : '○'}</button>
                </div>
              </div>
              {d.foto && (
                <img src={d.foto} alt="Nota" onClick={() => setFotoModal(d.foto)}
                  style={{ maxHeight: 60, marginTop: 8, border: '1px solid #e0d5c5', borderRadius: 6, cursor: 'zoom-in' }} />
              )}
              <div style={{ marginTop: 6 }}>{d.lancado ? <Badge color="#22c55e">✓ Lançado</Badge> : <Badge color="#f59e0b">Não lançado</Badge>}</div>
            </div>
          )
        })}
      </>}
    </div>
  )
}

// ─── ABA RELATÓRIOS ───────────────────────────────────────────────────────────

// ─── EXPORTAR RELATÓRIO ───────────────────────────────────────────────────────

// ─── RELATÓRIO COMPLETO DE SAÍDAS (PDF) ──────────────────────────────────────

function exportarRelatorioCompleto(extras, vales, despesas, pessoas, setores, config, from, to) {
  const DIAS2 = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb']
  const dl = (d) => { if (!d) return ''; const [y,m,dd] = d.split('-'); const dt = new Date(Number(y),Number(m)-1,Number(dd)); return DIAS2[dt.getDay()]+' '+String(dt.getDate()).padStart(2,'0')+'/'+String(dt.getMonth()+1).padStart(2,'0') }
  const fmt2 = (c) => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format((c||0)/100)
  const nomeEstab = config?.nome_estabelecimento || 'ARACÁ GRILL'
  const periodo = from === to ? dl(from) : `${dl(from)} a ${dl(to)}`

  const totalExtras   = extras.reduce((a,e) => a+(e.valor_final||0), 0)
  const totalValesV   = (vales||[]).reduce((a,v) => a+(v.valor||0), 0)
  const totalDespV    = (despesas||[]).reduce((a,d) => a+(d.valor||0), 0)
  const totalGeral    = totalExtras + totalValesV + totalDespV
  const totalDin      = extras.filter(e=>e.forma_pagamento==='dinheiro').reduce((a,e)=>a+e.valor_final,0)
                      + (vales||[]).filter(v=>v.forma_pagamento==='dinheiro').reduce((a,v)=>a+v.valor,0)
                      + (despesas||[]).filter(d=>(d.forma_pagamento||'dinheiro')==='dinheiro').reduce((a,d)=>a+d.valor,0)
  const totalPix      = totalGeral - totalDin

  // Por setor (extras)
  const porSetor = {}
  extras.forEach(e => { const s=setores.find(x=>x.id===e.setor_id); const n=s?.nome||'Sem setor'; if(!porSetor[n])porSetor[n]={total:0,qtd:0}; porSetor[n].total+=e.valor_final; porSetor[n].qtd++ })

  // Por categoria (despesas)
  const porCat = {}
  ;(despesas||[]).forEach(d => { const k=`${d.categoria_emoji||''} ${d.categoria_nome||'Outros'}`; if(!porCat[k])porCat[k]={total:0,qtd:0}; porCat[k].total+=d.valor; porCat[k].qtd++ })

  const linhasExtras = extras.sort((a,b)=>b.data_op.localeCompare(a.data_op)).map(e => {
    const s=setores.find(x=>x.id===e.setor_id)
    return `<tr><td>${dl(e.data_op)}</td><td><strong>${e.nome}</strong><br><small>${e.funcao||''} ${e.turnos||''}</small></td><td>${s?.nome||'—'}</td><td class="${e.forma_pagamento==='pix'?'pix':'din'}">${fmt2(e.valor_final)}</td><td>${e.forma_pagamento==='pix'?'Pix':'Din'}</td></tr>`
  }).join('')

  const linhasVales = (vales||[]).sort((a,b)=>b.data_op.localeCompare(a.data_op)).map(v => {
    return `<tr class="vrow"><td>${dl(v.data_op)}</td><td><strong>${v.nome}</strong><br><small>${v.funcao||''}</small></td><td>—</td><td class="val">${fmt2(v.valor)}</td><td>${v.forma_pagamento==='pix'?'Pix':'Din'}</td></tr>`
  }).join('')

  const linhasDespesas = (despesas||[]).sort((a,b)=>b.data_op.localeCompare(a.data_op)).map(d => {
    const s=setores.find(x=>x.id===d.setor_id)
    return `<tr class="drow"><td>${dl(d.data_op)}</td><td><strong>${d.descricao}</strong><br><small>${d.categoria_emoji||''} ${d.categoria_nome||''}</small></td><td>${s?.nome||'—'}</td><td class="desp">${fmt2(d.valor)}</td><td>${(d.forma_pagamento||'dinheiro')==='pix'?'Pix':'Din'}</td></tr>`
  }).join('')

  const linhasSetor = Object.entries(porSetor).sort((a,b)=>b[1].total-a[1].total).map(([n,d])=>`<tr><td>${n}</td><td>${d.qtd}</td><td>${fmt2(d.total)}</td></tr>`).join('')
  const linhasCat   = Object.entries(porCat).sort((a,b)=>b[1].total-a[1].total).map(([n,d])=>`<tr><td>${n}</td><td>${d.qtd}</td><td>${fmt2(d.total)}</td></tr>`).join('')

  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <title>${nomeEstab} — Saídas ${periodo}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;color:#18181b;padding:16px}
    .header{display:flex;justify-content:space-between;margin-bottom:14px;padding-bottom:10px;border-bottom:3px solid #b5763a}
    .logo{font-size:20px;font-weight:900;color:#b5763a}.sub{font-size:12px;color:#6b6360;margin-top:3px}
    .meta{text-align:right;font-size:10px;color:#6b6360;line-height:1.7}
    .cards{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-bottom:12px}
    .card{background:#f7f6f3;border-radius:8px;padding:8px;text-align:center;border:1px solid #e4ddd4}
    .cl{font-size:9px;font-weight:700;color:#6b6360;text-transform:uppercase;margin-bottom:2px}
    .cv{font-size:14px;font-weight:900}
    .card.tot{background:#1c1917}.card.tot .cl{color:#ffffff60}.card.tot .cv{color:#c9a96e}
    .card.ext .cv{color:#b5763a}.card.val .cv{color:#9a7520}.card.des .cv{color:#5c4d8a}
    .card.din .cv{color:#2e6b47}.card.pix .cv{color:#3d6b8a}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
    h2{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;margin:12px 0 6px;padding-bottom:3px;border-bottom:2px solid #e4ddd4}
    h2.hex{border-color:#b5763a;color:#b5763a}h2.hval{border-color:#9a7520;color:#9a7520}h2.hdes{border-color:#5c4d8a;color:#5c4d8a}h2.hsum{border-color:#444;color:#444}
    table{width:100%;border-collapse:collapse;margin-bottom:6px;font-size:10px}
    th{background:#1c1917;color:#fff;font-size:9px;font-weight:700;text-transform:uppercase;padding:5px 8px;text-align:left}
    td{padding:4px 8px;border-bottom:1px solid #f0ede8;vertical-align:top}
    tr:nth-child(even) td{background:#fafaf9}
    .vrow td{background:#fffbeb!important}.drow td{background:#f5f0ff!important}
    small{font-size:9px;color:#6b6360}.pix{color:#3d6b8a;font-weight:700}.din{color:#2e6b47;font-weight:700}
    .val{color:#9a7520;font-weight:700}.desp{color:#5c4d8a;font-weight:700}
    .rodape{background:#1c1917;border-radius:8px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;margin-top:10px}
    .footer{margin-top:10px;padding-top:8px;border-top:1px solid #e4ddd4;font-size:9px;color:#a8a09a;text-align:center}
    @media print{body{padding:6px}@page{margin:8mm;size:A4}}
  </style></head><body>
  <div class="header">
    <div><div class="logo">🔥 ${nomeEstab}</div><div class="sub">Relatório Completo de Saídas · ${periodo}</div></div>
    <div class="meta">Gerado em: ${new Date().toLocaleString('pt-BR')}<br>${extras.length} extras · ${(vales||[]).length} vales · ${(despesas||[]).length} despesas</div>
  </div>
  <div class="cards">
    <div class="card tot"><div class="cl">Total</div><div class="cv">${fmt2(totalGeral)}</div></div>
    <div class="card ext"><div class="cl">💼 Extras</div><div class="cv">${fmt2(totalExtras)}</div></div>
    <div class="card val"><div class="cl">💸 Vales</div><div class="cv">${fmt2(totalValesV)}</div></div>
    <div class="card des"><div class="cl">🧾 Despesas</div><div class="cv">${fmt2(totalDespV)}</div></div>
    <div class="card din"><div class="cl">💵 Dinheiro</div><div class="cv">${fmt2(totalDin)}</div></div>
    <div class="card pix"><div class="cl">📱 Pix</div><div class="cv">${fmt2(totalPix)}</div></div>
  </div>
  <div class="grid2">
    ${Object.keys(porSetor).length>0?`<div><h2 class="hsum">Extras por Setor</h2><table><thead><tr><th>Setor</th><th>Qtd</th><th>Total</th></tr></thead><tbody>${linhasSetor}</tbody></table></div>`:'<div></div>'}
    ${Object.keys(porCat).length>0?`<div><h2 class="hsum">Despesas por Categoria</h2><table><thead><tr><th>Categoria</th><th>Qtd</th><th>Total</th></tr></thead><tbody>${linhasCat}</tbody></table></div>`:'<div></div>'}
  </div>
  ${extras.length>0?`<h2 class="hex">💼 Extras (${extras.length})</h2><table><thead><tr><th>Data</th><th>Profissional</th><th>Setor</th><th>Valor</th><th>Forma</th></tr></thead><tbody>${linhasExtras}</tbody></table>`:''}
  ${(vales||[]).length>0?`<h2 class="hval">💸 Vales (${(vales||[]).length})</h2><table><thead><tr><th>Data</th><th>Funcionário</th><th>Setor</th><th>Valor</th><th>Forma</th></tr></thead><tbody>${linhasVales}</tbody></table>`:''}
  ${(despesas||[]).length>0?`<h2 class="hdes">🧾 Despesas (${(despesas||[]).length})</h2><table><thead><tr><th>Data</th><th>Descrição</th><th>Setor</th><th>Valor</th><th>Forma</th></tr></thead><tbody>${linhasDespesas}</tbody></table>`:''}
  <div class="rodape">
    <div style="font-size:11px;font-weight:700;color:#ffffff80">TOTAL SAÍDAS — ${periodo}</div>
    <div style="font-size:20px;font-weight:900;color:#c9a96e">${fmt2(totalGeral)}</div>
  </div>
  <div class="footer">${nomeEstab} · Sistema Operacional · ${new Date().getFullYear()}</div>
  <script>window.onload=()=>window.print()<\/script>
  </body></html>`

  const w = window.open('','_blank','width=1100,height=800')
  w.document.write(html); w.document.close()
}

// ─── EXPORTAR EXCEL ──────────────────────────────────────────────────────────

function exportarExcel(pagos, pessoas, setores, config, from, to) {
  const DIAS = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb']
  const dl = (d) => { if (!d) return ''; const [y,m,dd] = d.split('-'); const dt = new Date(Number(y),Number(m)-1,Number(dd)); return DIAS[dt.getDay()]+' '+String(dt.getDate()).padStart(2,'0')+'/'+String(dt.getMonth()+1).padStart(2,'0') }
  const fmt2 = (c) => ((c||0)/100).toFixed(2).replace('.',',')
  const nomeEstab = config?.nome_estabelecimento || 'ARACÁ GRILL'
  const periodo = from === to ? dl(from) : `${dl(from)} a ${dl(to)}`

  // Monta CSV com separador ; (abre corretamente no Excel BR)
  const rows = [
    [`${nomeEstab} — Relatório de Extras`],
    [`Período: ${periodo}`],
    [`Gerado em: ${new Date().toLocaleString('pt-BR')}`],
    [],
    ['Data','Nome','Função','Turno','Setor','Valor Combinado','Desconto Troco','Valor Pago','Forma','Observação','Editado'],
  ]

  pagos.sort((a,b) => b.data_op.localeCompare(a.data_op)).forEach(e => {
    const s = setores.find(x => x.id === e.setor_id)
    const desconto = (e.trocos_descontados || []).reduce((a,t) => a+t.valor, 0)
    rows.push([
      dl(e.data_op),
      e.nome,
      e.funcao || '',
      e.turnos || '',
      s?.nome || '',
      fmt2(e.valor_extra || e.valor_final),
      fmt2(desconto),
      fmt2(e.valor_pago || e.valor_final),
      e.forma_pagamento === 'pix' ? 'Pix' : 'Dinheiro',
      e.obs || '',
      e.editado ? `Sim — ${e.editado_por}` : 'Não',
    ])
  })

  // Linha de totais
  rows.push([])
  const total = pagos.reduce((a,e) => a+(e.valor_pago||e.valor_final), 0)
  const totalPix = pagos.filter(e => e.forma_pagamento==='pix').reduce((a,e) => a+(e.valor_pago||e.valor_final), 0)
  const totalDin = pagos.filter(e => e.forma_pagamento==='dinheiro').reduce((a,e) => a+(e.valor_pago||e.valor_final), 0)
  rows.push(['TOTAL GERAL','','','','','',''  ,fmt2(total),'','',''])
  rows.push(['Total Dinheiro','','','','','','',fmt2(totalDin),'','',''])
  rows.push(['Total Pix','','','','','','',fmt2(totalPix),'','',''])

  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(';')).join('\n')
  const bom = '﻿' // BOM para Excel reconhecer UTF-8
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${nomeEstab.replace(/\s+/g,'_')}_extras_${from}_${to}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ─── EXPORTAR PDF ─────────────────────────────────────────────────────────────

function exportarPDF(pagos, pessoas, setores, config, from, to) {
  const DIAS = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb']
  const dl = (d) => { if (!d) return ''; const [y,m,dd] = d.split('-'); const dt = new Date(Number(y),Number(m)-1,Number(dd)); return DIAS[dt.getDay()]+' '+String(dt.getDate()).padStart(2,'0')+'/'+String(dt.getMonth()+1).padStart(2,'0') }
  const fmt2 = (c) => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format((c||0)/100)
  const nomeEstab = config?.nome_estabelecimento || 'ARACÁ GRILL'
  const periodo = from === to ? dl(from) : `${dl(from)} a ${dl(to)}`
  const total = pagos.reduce((a,e) => a+(e.valor_pago||e.valor_final), 0)
  const totalPix = pagos.filter(e => e.forma_pagamento==='pix').reduce((a,e) => a+(e.valor_pago||e.valor_final), 0)
  const totalDin = pagos.filter(e => e.forma_pagamento==='dinheiro').reduce((a,e) => a+(e.valor_pago||e.valor_final), 0)

  // Por setor
  const porSetor = {}
  pagos.forEach(e => {
    const s = setores.find(x => x.id === e.setor_id)
    const nome = s?.nome || 'Sem setor'
    if (!porSetor[nome]) porSetor[nome] = { total: 0, qtd: 0 }
    porSetor[nome].total += (e.valor_pago||e.valor_final)
    porSetor[nome].qtd++
  })

  const linhasTabela = pagos.sort((a,b) => b.data_op.localeCompare(a.data_op)).map(e => {
    const s = setores.find(x => x.id === e.setor_id)
    const desconto = (e.trocos_descontados||[]).reduce((a,t)=>a+t.valor,0)
    return `
      <tr>
        <td>${dl(e.data_op)}</td>
        <td><strong>${e.nome}</strong><br><span class="sub">${e.funcao||''} ${e.turnos||''}</span></td>
        <td>${s?.nome||'—'}</td>
        <td>${fmt2(e.valor_extra||e.valor_final)}</td>
        <td>${desconto > 0 ? '−'+fmt2(desconto) : '—'}</td>
        <td class="${e.forma_pagamento==='pix'?'pix':'din'}">${fmt2(e.valor_pago||e.valor_final)}</td>
        <td class="forma">${e.forma_pagamento==='pix'?'📱 Pix':'💵 Din'}</td>
        ${e.obs ? `<td class="obs">${e.obs}</td>` : '<td>—</td>'}
      </tr>`
  }).join('')

  const linhasSetor = Object.entries(porSetor).sort((a,b)=>b[1].total-a[1].total).map(([nome,dados]) => `
    <tr class="setor-row">
      <td>${nome}</td>
      <td>${dados.qtd} extras</td>
      <td>${fmt2(dados.total)}</td>
    </tr>`).join('')

  const html = `<!DOCTYPE html><html lang="pt-BR"><head>
  <meta charset="UTF-8">
  <title>${nomeEstab} — Relatório ${periodo}</title>
  <style>
    body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11px; color: #18181b; background: #fff; padding: 16px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 3px solid #b5763a; }
    .logo { font-size: 24px; font-weight: 900; color: #b5763a; letter-spacing: -0.5px; }
    .subtitle { font-size: 12px; color: #6b6360; margin-top: 4px; }
    .meta { text-align: right; font-size: 10px; color: #6b6360; line-height: 1.6; }
    .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 14px; }
    .card { background: #f7f6f3; border-radius: 10px; padding: 10px; border: 1px solid #e4ddd4; }
    .card-label { font-size: 9px; font-weight: 700; color: #6b6360; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 3px; }
    .card-value { font-size: 18px; font-weight: 900; color: #b5763a; }
    .card.din .card-value { color: #2e6b47; }
    .card.pix .card-value { color: #3d6b8a; }
    h2 { font-size: 11px; font-weight: 800; color: #18181b; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; margin-top: 12px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
    th { background: #1c1917; color: #fff; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; padding: 6px 8px; text-align: left; }
    td { padding: 5px 8px; border-bottom: 1px solid #f0ede8; font-size: 10px; vertical-align: top; }
    tr:nth-child(even) td { background: #fafaf9; }
    .sub { font-size: 9px; color: #6b6360; }
    .pix { color: #3d6b8a; font-weight: 700; }
    .din { color: #2e6b47; font-weight: 700; }
    .forma { font-size: 10px; }
    .obs { font-style: italic; color: #6b6360; font-size: 9px; }
    .setor-row td { font-weight: 600; }
    .footer { margin-top: 16px; padding-top: 8px; border-top: 1px solid #e4ddd4; font-size: 9px; color: #a8a09a; text-align: center; }
    @media print {
      body { padding: 6px; }
      @page { margin: 8mm; size: A4; }
    }
  </style>
  </head><body>
  <div class="header">
    <div>
      <div class="logo">🔥 ${nomeEstab}</div>
      <div class="subtitle">Relatório de Extras · ${periodo}</div>
    </div>
    <div class="meta">
      Gerado em: ${new Date().toLocaleString('pt-BR')}<br>
      Total de registros: ${pagos.length}
    </div>
  </div>

  <div class="cards">
    <div class="card">
      <div class="card-label">Total Geral</div>
      <div class="card-value">${fmt2(total)}</div>
    </div>
    <div class="card din">
      <div class="card-label">💵 Dinheiro</div>
      <div class="card-value">${fmt2(totalDin)}</div>
    </div>
    <div class="card pix">
      <div class="card-label">📱 Pix</div>
      <div class="card-value">${fmt2(totalPix)}</div>
    </div>
  </div>

  <h2>Por Setor</h2>
  <table>
    <thead><tr><th>Setor</th><th>Qtd</th><th>Total</th></tr></thead>
    <tbody>${linhasSetor}</tbody>
  </table>

  <h2>Detalhamento Completo</h2>
  <table>
    <thead>
      <tr>
        <th>Data</th><th>Profissional</th><th>Setor</th>
        <th>Combinado</th><th>Desconto</th><th>Pago</th><th>Forma</th><th>Obs</th>
      </tr>
    </thead>
    <tbody>${linhasTabela}</tbody>
  </table>

  <div class="footer">${nomeEstab} · Sistema Operacional de Extras · ${new Date().getFullYear()}</div>

  <script>window.onload = () => window.print()<\/script>
  </body></html>`

  const w = window.open('', '_blank', 'width=1100,height=700')
  w.document.write(html)
  w.document.close()
}

function exportarRelatorio(pagos, pessoas, setores, config, from, to) {
  const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
  const dl = (d) => { if (!d) return ''; const [y,m,dd] = d.split('-'); const dt = new Date(Number(y),Number(m)-1,Number(dd)); return DIAS[dt.getDay()]+' '+String(dt.getDate()).padStart(2,'0')+'/'+String(dt.getMonth()+1).padStart(2,'0') }
  const fmt2 = (c) => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format((c||0)/100)
  const nomeEstab = config?.nome_estabelecimento || 'ARACÁ GRILL'
  const periodo = from === to ? dl(from) : `${dl(from)} até ${dl(to)}`
  const total = pagos.reduce((a,e) => a+e.valor_final, 0)
  const totalDin = pagos.filter(e => e.forma_pagamento === 'dinheiro').reduce((a,e) => a+e.valor_final, 0)
  const totalPix = pagos.filter(e => e.forma_pagamento === 'pix').reduce((a,e) => a+e.valor_final, 0)

  // Por funcionário
  const porFunc = {}
  pagos.forEach(e => {
    if (!porFunc[e.nome]) porFunc[e.nome] = { nome: e.nome, pagamentos: [], total: 0 }
    porFunc[e.nome].pagamentos.push(e)
    porFunc[e.nome].total += e.valor_final
  })

  // Por setor
  const porSetor = {}
  pagos.forEach(e => {
    const s = setores.find(x => x.id === e.setor_id)
    const nome = s?.nome || 'Sem setor'
    if (!porSetor[nome]) porSetor[nome] = { nome, total: 0, qtd: 0 }
    porSetor[nome].total += e.valor_final
    porSetor[nome].qtd++
  })

  let txt = `${nomeEstab} — RELATÓRIO DE EXTRAS
`
  txt += `Período: ${periodo}
`
  txt += `Gerado em: ${new Date().toLocaleString('pt-BR')}
`
  txt += `${'═'.repeat(40)}

`
  txt += `RESUMO FINANCEIRO
`
  txt += `Total geral: ${fmt2(total)}
`
  txt += `Dinheiro: ${fmt2(totalDin)}
`
  txt += `Pix: ${fmt2(totalPix)}
`
  txt += `Qtd pagamentos: ${pagos.length}

`

  txt += `${'─'.repeat(40)}
POR SETOR
`
  Object.values(porSetor).sort((a,b) => b.total-a.total).forEach(s => {
    txt += `${s.nome}: ${fmt2(s.total)} (${s.qtd} extras)
`
  })

  txt += `
${'─'.repeat(40)}
POR FUNCIONÁRIO
`
  Object.values(porFunc).sort((a,b) => b.total-a.total).forEach(p => {
    txt += `
${p.nome} — ${fmt2(p.total)} (${p.pagamentos.length}×)
`
    p.pagamentos.forEach(e => {
      const s = setores.find(x => x.id === e.setor_id)
      txt += `  ${dl(e.data_op)} | ${e.funcao || ''}${e.turnos ? ' '+e.turnos : ''} | ${fmt2(e.valor_final)} | ${e.forma_pagamento === 'pix' ? 'Pix' : 'Dinheiro'}`
      if (e.obs) txt += ` | Obs: ${e.obs}`
      if (e.editado) txt += ` | ✏️ Editado por ${e.editado_por}`
      txt += '\n'
    })
  })

  txt += `
${'─'.repeat(40)}
DETALHAMENTO COMPLETO
`
  pagos.sort((a,b) => b.data_op.localeCompare(a.data_op)).forEach(e => {
    const s = setores.find(x => x.id === e.setor_id)
    txt += `${dl(e.data_op)} | ${e.nome} | ${e.funcao || ''}${e.turnos ? ' '+e.turnos : ''} | ${s?.nome || ''} | ${fmt2(e.valor_final)} | ${e.forma_pagamento === 'pix' ? 'Pix' : 'Dinheiro'}`
    if (e.obs) txt += ` | ${e.obs}`
    if (e.editado) txt += ` | Editado`
    txt += '\n'
  })

  // Download
  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${nomeEstab.replace(/\s+/g,'_')}_extras_${from}_${to}.txt`
  a.click()
  URL.revokeObjectURL(url)
}

// ─── PESQUISA POR FUNCIONÁRIO ─────────────────────────────────────────────────

function PesquisaFuncionario({ store, extras, setores, from, to, config }) {
  const { pessoas } = store
  const [busca, setBusca] = useState('')
  const [pessoaSel, setPessoaSel] = useState(null)

  const sugestoes = useMemo(() => {
    if (!busca.trim()) return []
    return pessoas.filter(p => p.nome.toLowerCase().includes(busca.toLowerCase())).slice(0, 6)
  }, [busca, pessoas])

  const pagamentosFunc = useMemo(() => {
    if (!pessoaSel) return []
    return extras.filter(e => e.pessoa_id === pessoaSel.id && e.pago && e.data_op >= from && e.data_op <= to)
      .sort((a,b) => b.data_op.localeCompare(a.data_op))
  }, [pessoaSel, extras, from, to])

  const totalFunc = pagamentosFunc.reduce((a,e) => a+e.valor_final, 0)

  return (
    <div style={{ ...S.card, marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: C.text, marginBottom: 10 }}>🔍 Pesquisar funcionário</div>
      <div style={{ position: 'relative' }}>
        <input
          value={pessoaSel ? pessoaSel.nome : busca}
          onChange={e => { setBusca(e.target.value); setPessoaSel(null) }}
          style={{ ...S.input }}
          placeholder="Digite o nome do funcionário..."
        />
        {sugestoes.length > 0 && !pessoaSel && (
          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: C.bgCard2, border: `1px solid ${C.border}`, borderRadius: 10, zIndex: 50, overflow: 'hidden', marginTop: 4 }}>
            {sugestoes.map(p => (
              <div key={p.id} onClick={() => { setPessoaSel(p); setBusca('') }}
                style={{ padding: '10px 14px', cursor: 'pointer', borderBottom: `1px solid ${C.border}`, fontSize: 14, color: C.text }}>
                <div style={{ fontWeight: 700 }}>{p.nome}</div>
                <div style={{ fontSize: 11, color: C.textMuted }}>{p.funcao} {p.interno_casa ? '· 🏠 Interno' : ''}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {pessoaSel && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div>
              <div style={{ fontWeight: 800, fontSize: 15, color: C.text }}>{pessoaSel.nome}</div>
              <div style={{ fontSize: 12, color: C.textMuted }}>{pessoaSel.funcao} · {pagamentosFunc.length} pagamentos no período</div>
              {pessoaSel.obs_fixa && <div style={{ fontSize: 11, color: C.gold, fontStyle: 'italic' }}>⚠ {pessoaSel.obs_fixa}</div>}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 22, fontWeight: 900, color: C.primary }}>{fmt(totalFunc)}</div>
              <button onClick={() => setPessoaSel(null)}
                style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: 11, cursor: 'pointer' }}>✕ Limpar</button>
            </div>
          </div>

          {pagamentosFunc.length === 0 && (
            <div style={{ textAlign: 'center', padding: 16, color: C.textMuted, fontSize: 13 }}>Nenhum pagamento no período</div>
          )}

          {pagamentosFunc.map((e, i) => {
            const setor = setores.find(s => s.id === e.setor_id)
            const desconto = (e.trocos_descontados || []).reduce((a,t) => a+t.valor, 0)
            return (
              <div key={i} style={{ padding: '10px 0', borderTop: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, color: C.text }}>{dayLabel(e.data_op)}</div>
                    <div style={{ fontSize: 12, color: C.textMuted }}>{e.funcao}{e.turnos ? ' · '+e.turnos : ''}{setor ? ' · '+setor.nome : ''}</div>
                    {e.obs && <div style={{ fontSize: 11, color: C.textMuted, fontStyle: 'italic', marginTop: 2 }}>📝 {e.obs}</div>}
                    {e.editado && <div style={{ fontSize: 10, color: C.gold, marginTop: 1 }}>✏️ Editado — {e.motivo_edicao}</div>}
                    {desconto > 0 && <div style={{ fontSize: 11, color: C.success }}>−{fmt(desconto)} troco</div>}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 15, fontWeight: 800, color: C.primary }}>{fmt(e.valor_final)}</div>
                    <Badge color={e.forma_pagamento === 'pix' ? C.secondary : C.success}>{e.forma_pagamento === 'pix' ? '📱 Pix' : '💵 Din'}</Badge>
                  </div>
                </div>
              </div>
            )
          })}

          {pagamentosFunc.length > 0 && (
            <button
              onClick={() => exportarRelatorio(pagamentosFunc, [pessoaSel], setores, config, from, to)}
              style={{ ...S.btn(C.accent), marginTop: 10 }}>
              📤 Exportar histórico de {pessoaSel.nome}
            </button>
          )}
        </div>
      )}
    </div>
  )
}


// ─── ABA RELATÓRIOS CENTRAL ──────────────────────────────────────────────────

function TabRelatoriosCentral({ store, today }) {
  const { extras, vales, despesas, pessoas, setores, config } = store
  const [cat, setCat] = useState('financeiro')

  const [filtro, setFiltro]         = useState('semana')
  const [dataInicio, setDataInicio] = useState(today)
  const [dataFim, setDataFim]       = useState(today)

  const ontem      = toDateStr(new Date(new Date(today+'T12:00:00').getTime()-86400000))
  const weekStart  = toDateStr(new Date(new Date(today+'T12:00:00').setDate(new Date(today+'T12:00:00').getDate()-6)))
  const monthStart = today.slice(0,7)+'-01'
  const ranges     = { hoje:[today,today], ontem:[ontem,ontem], semana:[weekStart,today], mes:[monthStart,today], livre:[dataInicio,dataFim] }
  const [from, to] = ranges[filtro]||[weekStart,today]

  const pagos        = useMemo(()=>extras.filter(e=>e.pago&&e.data_op>=from&&e.data_op<=to),[extras,from,to])
  const valesPeriodo = useMemo(()=>(vales||[]).filter(v=>v.data_op>=from&&v.data_op<=to),[vales,from,to])
  const despPeriodo  = useMemo(()=>(despesas||[]).filter(d=>d.data_op>=from&&d.data_op<=to),[despesas,from,to])

  const totalExtras   = pagos.reduce((a,e)=>a+e.valor_final,0)
  const totalVales    = valesPeriodo.reduce((a,v)=>a+v.valor,0)
  const totalDespesas = despPeriodo.reduce((a,d)=>a+d.valor,0)
  const totalCusto    = totalExtras+totalVales+totalDespesas

  const agrupadoVales = useMemo(()=>{
    const map={}
    valesPeriodo.forEach(v=>{
      if(!map[v.nome])map[v.nome]={nome:v.nome,funcao:v.funcao||'',total:0,vales:[]}
      map[v.nome].total+=v.valor;map[v.nome].vales.push(v)
    })
    return Object.values(map).sort((a,b)=>b.total-a.total)
  },[valesPeriodo])

  const FiltroBar = () => (
    <div style={{marginBottom:14}}>
      <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:filtro==='livre'?8:0}}>
        {[['hoje','Hoje'],['ontem','Ontem'],['semana','7 dias'],['mes','Mês'],['livre','Livre']].map(([id,label])=>(
          <button key={id} onClick={()=>setFiltro(id)}
            style={{padding:'6px 12px',border:`1px solid ${filtro===id?C.primary:C.border}`,borderRadius:16,
              background:filtro===id?C.primary:'transparent',color:filtro===id?'#fff':C.textMuted,
              fontSize:11,cursor:'pointer',fontWeight:filtro===id?700:400}}>
            {label}
          </button>
        ))}
      </div>
      {filtro==='livre'&&(
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <input type="date" value={dataInicio} onChange={e=>setDataInicio(e.target.value)} style={{...S.input,flex:1}}/>
          <span style={{color:C.textMuted}}>→</span>
          <input type="date" value={dataFim} onChange={e=>setDataFim(e.target.value)} style={{...S.input,flex:1}}/>
        </div>
      )}
    </div>
  )

  return (
    <div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,marginBottom:14}}>
        {[['financeiro','💰','Financeiro'],['equipe','👥','Equipe'],['operacional','📋','Operacional'],['inteligentes','📊','Inteligentes']].map(([id,icon,label])=>(
          <button key={id} onClick={()=>setCat(id)}
            style={{padding:'12px 8px',border:`1px solid ${cat===id?C.primary:C.border}`,borderRadius:12,
              background:cat===id?C.primary:'transparent',cursor:'pointer',textAlign:'center',
              display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
            <span style={{fontSize:20}}>{icon}</span>
            <span style={{fontSize:11,fontWeight:cat===id?800:500,color:cat===id?'#fff':C.textMuted}}>{label}</span>
          </button>
        ))}
      </div>

      {cat==='financeiro'&&(
        <div>
          <FiltroBar/>
          <div style={{...S.card,background:'linear-gradient(135deg,#1a1200,#2d2000)',color:'#fff',marginBottom:12}}>
            <div style={{fontSize:11,color:'#c9a96e80',textTransform:'uppercase'}}>Total do período</div>
            <div style={{fontSize:28,fontWeight:700,color:'#c9a96e'}}>{fmt(totalCusto)}</div>
            <div style={{display:'flex',gap:12,marginTop:6}}>
              <span style={{fontSize:11,color:'#ffffff70'}}>💼 {fmt(totalExtras)}</span>
              <span style={{fontSize:11,color:'#ffffff70'}}>💸 {fmt(totalVales)}</span>
              <span style={{fontSize:11,color:'#ffffff70'}}>🧾 {fmt(totalDespesas)}</span>
            </div>
          </div>
          <div style={{...S.card,marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:6}}>🖨️ Recibos do turno (80mm)</div>
            <div style={{fontSize:11,color:C.textMuted,marginBottom:10}}>Separados por forma de pagamento</div>
            <div style={{display:'flex',gap:8}}>
              <button onClick={()=>imprimirRecibos(extras.filter(e=>e.data_op===today),vales.filter(v=>v.data_op===today),despesas.filter(d=>d.data_op===today),pessoas,setores,config,'dinheiro')}
                style={{...S.btn(C.success),flex:1}}>💵 Dinheiro</button>
              <button onClick={()=>imprimirRecibos(extras.filter(e=>e.data_op===today),vales.filter(v=>v.data_op===today),despesas.filter(d=>d.data_op===today),pessoas,setores,config,'pix')}
                style={{...S.btn(C.secondary),flex:1}}>📱 Pix</button>
            </div>
          </div>
          <div style={{...S.card,marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:6}}>📄 PDF completo de saídas</div>
            <div style={{fontSize:11,color:C.textMuted,marginBottom:10}}>Extras + vales + despesas do período</div>
            <button onClick={()=>exportarRelatorioCompleto(pagos,valesPeriodo,despPeriodo,pessoas,setores,config,from,to)}
              style={{...S.btn(C.primary),width:'100%'}}>📤 Exportar PDF completo</button>
          </div>
          <div style={S.card}>
            <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:12}}>💸 Vales do período</div>
            <RelatorioValesCompacto vales={valesPeriodo} agrupado={agrupadoVales} from={from} to={to} config={config}/>
          </div>
        </div>
      )}

      {cat==='equipe'&&(
        <div>
          <FiltroBar/>
          <div style={{display:'flex',gap:8,marginBottom:12}}>
            <button onClick={()=>exportarExcel(pagos,pessoas,setores,config,from,to)}
              style={{...S.btn(C.success),flex:1}}>📊 Excel extras</button>
            <button onClick={()=>exportarPDF(pagos,pessoas,setores,config,from,to)}
              style={{...S.btn(C.danger,true),flex:1}}>📄 PDF extras</button>
          </div>
          <PesquisaFuncionario store={store} extras={extras} setores={setores} from={from} to={to} config={config}/>
        </div>
      )}

      {cat==='operacional'&&(
        <div>
          <FiltroBar/>
          <div style={{...S.card,marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:12}}>🔍 Pesquisa de vales e despesas</div>
            <PesquisaValeDespesa vales={valesPeriodo} despesas={despPeriodo} setores={setores} pessoas={pessoas}/>
          </div>
          <div style={S.card}>
            <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:12}}>📋 Despesas por categoria</div>
            {(()=>{
              const porCat={}
              despPeriodo.forEach(d=>{
                const k=`${d.categoria_emoji||'📝'} ${d.categoria_nome||'Outros'}`
                if(!porCat[k])porCat[k]={total:0,qtd:0}
                porCat[k].total+=d.valor;porCat[k].qtd++
              })
              const cats=Object.entries(porCat).sort((a,b)=>b[1].total-a[1].total)
              const maxC=cats[0]?.[1].total||1
              return cats.length===0
                ?<div style={{color:C.textMuted,fontSize:13,textAlign:'center',padding:16}}>Nenhuma despesa no período</div>
                :cats.map(([nome,v],i)=>(
                  <div key={i} style={{marginBottom:10}}>
                    <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                      <span style={{fontSize:13,color:C.text}}>{nome}</span>
                      <span style={{fontSize:13,fontWeight:700,color:C.primary}}>{fmt(v.total)} <span style={{fontSize:11,color:C.textMuted,fontWeight:400}}>({v.qtd}x)</span></span>
                    </div>
                    <div style={{height:6,background:C.bgCard2,borderRadius:3,overflow:'hidden'}}>
                      <div style={{height:'100%',width:(v.total/maxC*100)+'%',background:C.primary,borderRadius:3}}/>
                    </div>
                  </div>
                ))
            })()}
          </div>
        </div>
      )}

      {cat==='inteligentes'&&(
        <div>
          <FiltroBar/>
          <RelatoriosInteligentes
            pagos={pagos} valesPeriodo={valesPeriodo} despPeriodo={despPeriodo}
            extrasAll={extras} setores={setores} pessoas={pessoas}
            from={from} to={to} today={today}
            totalCusto={totalCusto} totalExtras={totalExtras} totalVales={totalVales} totalDespesas={totalDespesas}
          />
        </div>
      )}
    </div>
  )
}

function PesquisaValeDespesa({ vales, despesas, setores, pessoas }) {
  const [modo, setModo] = useState('vales')
  const [busca, setBusca] = useState('')
  const itens = useMemo(()=>{
    if(modo==='vales')return vales.filter(v=>!busca||v.nome?.toLowerCase().includes(busca.toLowerCase())||v.obs?.toLowerCase().includes(busca.toLowerCase())).sort((a,b)=>b.data_op.localeCompare(a.data_op))
    return despesas.filter(d=>!busca||d.descricao?.toLowerCase().includes(busca.toLowerCase())||d.categoria_nome?.toLowerCase().includes(busca.toLowerCase())).sort((a,b)=>b.data_op.localeCompare(a.data_op))
  },[vales,despesas,modo,busca])
  return(
    <div>
      <div style={{display:'flex',gap:4,background:'#f0e8d8',padding:4,borderRadius:10,marginBottom:10}}>
        {[['vales','💸 Vales'],['despesas','🧾 Despesas']].map(([id,label])=>(
          <button key={id} onClick={()=>{setModo(id);setBusca('')}}
            style={{flex:1,padding:'7px',border:'none',borderRadius:8,background:modo===id?'#fff':'transparent',cursor:'pointer',fontSize:12,fontWeight:modo===id?700:400,color:modo===id?C.gold:'#999'}}>
            {label}
          </button>
        ))}
      </div>
      <input value={busca} onChange={e=>setBusca(e.target.value)} style={{...S.input,marginBottom:10}}
        placeholder={modo==='vales'?'Buscar por nome...':'Buscar por descrição ou categoria...'}/>
      {itens.slice(0,30).map((item,i)=>(
        <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',padding:'9px 0',borderBottom:`1px solid ${C.border}`}}>
          <div>
            <div style={{fontSize:13,fontWeight:600,color:C.text}}>{modo==='vales'?item.nome:item.descricao}</div>
            <div style={{fontSize:11,color:C.textMuted}}>
              {dayLabel(item.data_op)}
              {modo==='despesas'&&item.categoria_emoji&&` · ${item.categoria_emoji} ${item.categoria_nome}`}
              {item.obs&&` · ${item.obs}`}
            </div>
          </div>
          <div style={{textAlign:'right',flexShrink:0}}>
            <div style={{fontSize:14,fontWeight:700,color:C.primary}}>{fmt(item.valor)}</div>
            <div style={{fontSize:10,color:item.forma_pagamento==='pix'?C.secondary:C.success}}>{item.forma_pagamento==='pix'?'📱 Pix':'💵 Din'}</div>
          </div>
        </div>
      ))}
      {itens.length===0&&<div style={{color:C.textMuted,fontSize:13,textAlign:'center',padding:16}}>Nenhum resultado</div>}
      {itens.length>30&&<div style={{color:C.textMuted,fontSize:12,textAlign:'center',padding:8}}>Mostrando 30 de {itens.length}. Refine a busca.</div>}
    </div>
  )
}

function RelatorioValesCompacto({ vales, agrupado, from, to, config }) {
  const [modo, setModo] = useState('resumido')
  return(
    <div>
      <div style={{display:'flex',gap:4,background:'#f0e8d8',padding:4,borderRadius:10,marginBottom:12}}>
        {[['resumido','Resumido'],['detalhado','Detalhado']].map(([id,label])=>(
          <button key={id} onClick={()=>setModo(id)}
            style={{flex:1,padding:'6px',border:'none',borderRadius:8,background:modo===id?'#fff':'transparent',cursor:'pointer',fontSize:12,fontWeight:modo===id?700:400,color:modo===id?C.gold:'#999'}}>
            {label}
          </button>
        ))}
      </div>
      {agrupado.length===0&&<div style={{color:C.textMuted,fontSize:13,textAlign:'center',padding:16}}>Nenhum vale no período</div>}
      {agrupado.map((p,i)=>(
        <div key={i} style={{marginBottom:12,paddingBottom:12,borderBottom:`1px solid ${C.border}`}}>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:modo==='detalhado'?8:0}}>
            <div>
              <div style={{fontSize:13,fontWeight:700,color:C.text}}>{p.nome}</div>
              {p.funcao&&<div style={{fontSize:11,color:C.textMuted}}>{p.funcao}</div>}
            </div>
            <div style={{textAlign:'right'}}>
              <div style={{fontSize:15,fontWeight:700,color:C.primary}}>{fmt(p.total)}</div>
              <div style={{fontSize:10,color:C.textMuted}}>{p.vales.length} vale{p.vales.length!==1?'s':''}</div>
            </div>
          </div>
          {modo==='detalhado'&&p.vales.sort((a,b)=>b.data_op.localeCompare(a.data_op)).map((v,j)=>(
            <div key={j} style={{display:'flex',justifyContent:'space-between',padding:'5px 8px',background:C.bgCard2,borderRadius:6,marginBottom:4}}>
              <span style={{fontSize:11,color:C.textMuted}}>{dayLabel(v.data_op)}{v.obs?` · ${v.obs}`:''}</span>
              <span style={{fontSize:11,fontWeight:600,color:C.primary}}>{fmt(v.valor)}</span>
            </div>
          ))}
        </div>
      ))}
      {agrupado.length>0&&(
        <button onClick={()=>exportarRelatorioValesPDF(agrupado,from,to,modo,config)}
          style={{...S.btn(C.accent),width:'100%',marginTop:4}}>
          📤 Exportar PDF de vales ({modo})
        </button>
      )}
    </div>
  )
}

function RelatoriosInteligentes({ pagos, valesPeriodo, despPeriodo, extrasAll, setores, pessoas, from, to, today, totalCusto, totalExtras, totalVales, totalDespesas }) {
  const extrasComPessoa = useMemo(()=>pagos.map(e=>{const p=pessoas.find(x=>x.id===e.pessoa_id);return{...e,interno_casa:p?.interno_casa||false}}),[pagos,pessoas])
  const internos=extrasComPessoa.filter(e=>e.interno_casa)
  const externos=extrasComPessoa.filter(e=>!e.interno_casa)
  const porSetor = useMemo(()=>setores.map(s=>({nome:s.nome,total:pagos.filter(e=>e.setor_id===s.id).reduce((a,e)=>a+e.valor_final,0),qtd:pagos.filter(e=>e.setor_id===s.id).length,internos:extrasComPessoa.filter(e=>e.setor_id===s.id&&e.interno_casa).length,externos:extrasComPessoa.filter(e=>e.setor_id===s.id&&!e.interno_casa).length})).filter(s=>s.qtd>0).sort((a,b)=>b.total-a.total),[pagos,setores,extrasComPessoa])
  const porTurno = useMemo(()=>{const t={TD:{label:'Turno Dia',qtd:0,total:0},TN:{label:'Turno Noite',qtd:0,total:0},'TD+TN':{label:'Dia+Noite',qtd:0,total:0},outro:{label:'Sem turno',qtd:0,total:0}};pagos.forEach(e=>{const k=['TD','TN','TD+TN'].includes(e.turnos)?e.turnos:'outro';t[k].qtd++;t[k].total+=e.valor_final});return Object.values(t).filter(t=>t.qtd>0)},[pagos])
  const DIAS_L=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb']
  const porDia = useMemo(()=>{const dias=Array(7).fill(null).map((_,i)=>({dia:DIAS_L[i],total:0,qtd:0}));pagos.forEach(e=>{const[y,m,d]=e.data_op.split('-');const dow=new Date(Number(y),Number(m)-1,Number(d)).getDay();dias[dow].total+=e.valor_final;dias[dow].qtd++});return dias},[pagos])
  const maxDia=Math.max(...porDia.map(d=>d.total),1)
  const ranking=useMemo(()=>{const map={};extrasComPessoa.forEach(e=>{if(!map[e.nome])map[e.nome]={nome:e.nome,total:0,qtd:0,interno:e.interno_casa};map[e.nome].total+=e.valor_final;map[e.nome].qtd++});return Object.values(map).sort((a,b)=>b.qtd-a.qtd).slice(0,8)},[extrasComPessoa])
  const semAnteriorFim=toDateStr(new Date(new Date(from+'T12:00:00').getTime()-86400000))
  const semAnteriorStart=toDateStr(new Date(new Date(semAnteriorFim+'T12:00:00').getTime()-6*86400000))
  const totalAntSem=useMemo(()=>extrasAll.filter(e=>e.pago&&e.data_op>=semAnteriorStart&&e.data_op<=semAnteriorFim).reduce((a,e)=>a+e.valor_final,0),[extrasAll])
  const variacaoSem=totalAntSem>0?Math.round(((totalCusto-totalAntSem)/totalAntSem)*100):0
  const pctInternos=pagos.length>0?Math.round(internos.length/pagos.length*100):0
  const alertas=[]
  if(variacaoSem>20)alertas.push({cor:'#ef4444',titulo:`Custo ${variacaoSem}% acima da semana anterior`,motivo:'Você gastou mais com pessoal do que no mesmo período. Revise escalas e jornadas duplas.'})
  if(variacaoSem<-15)alertas.push({cor:'#22c55e',titulo:`Custo ${Math.abs(variacaoSem)}% abaixo da semana anterior`,motivo:'Menos saídas com pessoal — pode ser movimento menor ou escala otimizada.'})
  if(pctInternos>40)alertas.push({cor:'#f59e0b',titulo:`${pctInternos}% dos extras são da casa`,motivo:'Alta participação de internos aumenta custo fixo.'})
  const jduplas=pagos.filter(e=>e.turnos==='TD+TN')
  if(jduplas.length>3)alertas.push({cor:'#f59e0b',titulo:`${jduplas.length} jornadas duplas no período`,motivo:'TD+TN custa o dobro. Avalie escalar 2 pessoas por turno.'})
  const maxS=porSetor[0]?.total||1
  return(
    <div>
      {alertas.length>0&&<div style={{marginBottom:12}}>{alertas.map((a,i)=><AlertaCard key={i} alerta={a}/>)}</div>}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
        <div style={{...S.card,margin:0,textAlign:'center'}}>
          <div style={{fontSize:10,color:C.textMuted,textTransform:'uppercase'}}>🏠 Da casa</div>
          <div style={{fontSize:22,fontWeight:700,color:'#3b82f6'}}>{internos.length}</div>
          <div style={{fontSize:10,color:pctInternos>40?'#f59e0b':C.textMuted}}>{pctInternos}% do total</div>
        </div>
        <div style={{...S.card,margin:0,textAlign:'center'}}>
          <div style={{fontSize:10,color:C.textMuted,textTransform:'uppercase'}}>🚶 Externos</div>
          <div style={{fontSize:22,fontWeight:700,color:C.textMuted}}>{externos.length}</div>
          <div style={{fontSize:10,color:C.textMuted}}>{pagos.length>0?100-pctInternos:0}% do total</div>
        </div>
      </div>
      {porTurno.length>0&&<div style={S.card}><div style={{fontSize:12,fontWeight:700,color:C.textMuted,marginBottom:10}}>🌙 Por turno</div>{porTurno.map((t,i)=>{const pct=pagos.length>0?Math.round(t.qtd/pagos.length*100):0;return(<div key={i} style={{marginBottom:10}}><div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}><span style={{fontSize:13,color:C.text}}>{t.label}</span><span style={{fontSize:13,fontWeight:700,color:C.primary}}>{fmt(t.total)} <span style={{fontSize:10,color:C.textMuted,fontWeight:400}}>({pct}%)</span></span></div><div style={{height:6,background:C.bgCard2,borderRadius:3,overflow:'hidden'}}><div style={{height:'100%',width:pct+'%',background:C.primary,borderRadius:3}}/></div></div>)})}</div>}
      <div style={S.card}><div style={{fontSize:12,fontWeight:700,color:C.textMuted,marginBottom:10}}>📅 Por dia da semana</div>{porDia.map((d,i)=>(<div key={i} style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}><div style={{width:28,fontSize:11,color:[0,5,6].includes(i)?C.primary:C.textMuted,fontWeight:[0,5,6].includes(i)?700:400}}>{d.dia}</div><div style={{flex:1,height:12,background:C.bgCard2,borderRadius:3,overflow:'hidden'}}><div style={{height:'100%',width:d.total>0?(d.total/maxDia*100)+'%':'0%',background:[0,5,6].includes(i)?C.primary:C.secondary,borderRadius:3,transition:'width 0.3s'}}/></div><div style={{width:60,fontSize:11,textAlign:'right',color:C.textMuted}}>{d.total>0?fmt(d.total):'—'}</div></div>))}</div>
      {porSetor.length>0&&<div style={S.card}><div style={{fontSize:12,fontWeight:700,color:C.textMuted,marginBottom:10}}>📁 Por setor</div>{porSetor.map((s,i)=>(<div key={i} style={{marginBottom:12}}><div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}><span style={{fontSize:13,color:C.text}}>{s.nome}</span><span style={{fontSize:13,fontWeight:700,color:C.primary}}>{fmt(s.total)}</span></div><div style={{height:6,background:C.bgCard2,borderRadius:3,overflow:'hidden'}}><div style={{height:'100%',width:(s.total/maxS*100)+'%',background:C.primary,borderRadius:3}}/></div><div style={{display:'flex',gap:8,marginTop:4}}><span style={{fontSize:10,color:'#3b82f6'}}>🏠 {s.internos}</span><span style={{fontSize:10,color:C.textMuted}}>🚶 {s.externos}</span></div></div>))}</div>}
      {ranking.length>0&&<div style={S.card}><div style={{fontSize:12,fontWeight:700,color:C.textMuted,marginBottom:10}}>🏆 Ranking no período</div>{ranking.map((p,i)=>(<div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:`1px solid ${C.border}`}}><div style={{display:'flex',alignItems:'center',gap:10}}><span style={{fontSize:13,color:i<3?C.primary:C.textDim,fontWeight:800}}>#{i+1}</span><div><div style={{fontSize:13,fontWeight:600,color:C.text}}>{p.nome}</div><div style={{fontSize:10,color:C.textMuted}}>{p.qtd} escala{p.qtd!==1?'s':''} · {p.interno?'🏠':'🚶'}</div></div></div><div style={{fontSize:14,fontWeight:700,color:C.primary}}>{fmt(p.total)}</div></div>))}</div>}
      {pagos.length===0&&<div style={{...S.card,textAlign:'center',padding:32,color:C.textMuted}}>Nenhum dado no período selecionado</div>}
    </div>
  )
}

// ─── ALERTA CARD (expansível) ─────────────────────────────────────────────────

function AlertaCard({ alerta }) {
  const [aberto, setAberto] = useState(false)
  return (
    <div onClick={() => setAberto(!aberto)}
      style={{ background: alerta.cor + '12', border: `1px solid ${alerta.cor}44`, borderRadius: 10, padding: '10px 12px', marginBottom: 6, cursor: 'pointer' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: alerta.cor, fontWeight: 700 }}>{alerta.titulo}</span>
        <span style={{ fontSize: 11, color: alerta.cor, opacity: 0.7 }}>{aberto ? '▲' : '▼'}</span>
      </div>
      {aberto && (
        <div style={{ fontSize: 12, color: alerta.cor, opacity: 0.85, marginTop: 6, lineHeight: 1.5, borderTop: `1px solid ${alerta.cor}33`, paddingTop: 6 }}>
          {alerta.motivo}
        </div>
      )}
    </div>
  )
}

function TabRelatorios({ store }) {
  const { extras, vales, despesas, pessoas, setores, config } = store
  const [subTela, setSubTela] = useState('financeiro')
  const [pessoaSelecionada, setPessoaSelecionada] = useState(null)
  const today = todayOp(config)

  const [filtro, setFiltro] = useState('semana')
  const [dataInicio, setDataInicio] = useState(today)
  const [dataFim, setDataFim] = useState(today)

  const ontem = toDateStr(new Date(new Date(today + 'T12:00:00').getTime() - 86400000))
  const weekStart = toDateStr(new Date(new Date(today + 'T12:00:00').setDate(new Date(today + 'T12:00:00').getDate() - 6)))
  const monthStart = today.slice(0, 7) + '-01'
  const semAnteriorFim   = toDateStr(new Date(new Date(weekStart + 'T12:00:00').getTime() - 86400000))
  const semAnteriorStart = toDateStr(new Date(new Date(semAnteriorFim + 'T12:00:00').getTime() - 6 * 86400000))

  const ranges = { hoje: [today, today], ontem: [ontem, ontem], semana: [weekStart, today], mes: [monthStart, today], livre: [dataInicio, dataFim] }
  const [from, to] = ranges[filtro] || [weekStart, today]

  const pagos        = useMemo(() => extras.filter(e => e.pago && e.data_op >= from && e.data_op <= to), [extras, from, to])
  const valesPeriodo = useMemo(() => (vales||[]).filter(v => v.data_op >= from && v.data_op <= to), [vales, from, to])
  const despPeriodo  = useMemo(() => (despesas||[]).filter(d => d.data_op >= from && d.data_op <= to), [despesas, from, to])

  // Semana anterior — inclui extras + vales + despesas para comparar igual com igual
  const pagosAntSem  = useMemo(() => extras.filter(e => e.pago && e.data_op >= semAnteriorStart && e.data_op <= semAnteriorFim), [extras])
  const valesAntSem  = useMemo(() => (vales||[]).filter(v => v.data_op >= semAnteriorStart && v.data_op <= semAnteriorFim), [vales])
  const despAntSem   = useMemo(() => (despesas||[]).filter(d => d.data_op >= semAnteriorStart && d.data_op <= semAnteriorFim), [despesas])

  const pagosHoje    = useMemo(() => extras.filter(e => e.pago && e.data_op === today), [extras, today])

  const totalExtras   = useMemo(() => pagos.reduce((a,e) => a+e.valor_final, 0), [pagos])
  const totalVales    = useMemo(() => valesPeriodo.reduce((a,v) => a+v.valor, 0), [valesPeriodo])
  const totalDespesas = useMemo(() => despPeriodo.reduce((a,d) => a+d.valor, 0), [despPeriodo])
  const totalCusto    = totalExtras + totalVales + totalDespesas

  // Semana anterior — mesmo critério: extras + vales + despesas
  const totalAntSem = useMemo(() =>
    pagosAntSem.reduce((a,e) => a+e.valor_final, 0) +
    valesAntSem.reduce((a,v) => a+v.valor, 0) +
    despAntSem.reduce((a,d) => a+d.valor, 0)
  , [pagosAntSem, valesAntSem, despAntSem])

  // Enriquece extras com dados da pessoa
  const extrasComPessoa = useMemo(() => pagos.map(e => {
    const p = pessoas.find(x => x.id === e.pessoa_id)
    return { ...e, interno_casa: p?.interno_casa || false, obs_fixa: p?.obs_fixa || '' }
  }), [pagos, pessoas])

  const internos = useMemo(() => extrasComPessoa.filter(e => e.interno_casa), [extrasComPessoa])
  const externos = useMemo(() => extrasComPessoa.filter(e => !e.interno_casa), [extrasComPessoa])

  // Pix e Dinheiro incluem extras + vales + despesas
  const totalDin = useMemo(() =>
    pagos.filter(e => e.forma_pagamento === 'dinheiro').reduce((a,e) => a+e.valor_final, 0) +
    valesPeriodo.filter(v => v.forma_pagamento === 'dinheiro').reduce((a,v) => a+v.valor, 0) +
    despPeriodo.filter(d => (d.forma_pagamento||'dinheiro') === 'dinheiro').reduce((a,d) => a+d.valor, 0)
  , [pagos, valesPeriodo, despPeriodo])

  const totalPix = useMemo(() =>
    pagos.filter(e => e.forma_pagamento === 'pix').reduce((a,e) => a+e.valor_final, 0) +
    valesPeriodo.filter(v => v.forma_pagamento === 'pix').reduce((a,v) => a+v.valor, 0) +
    despPeriodo.filter(d => d.forma_pagamento === 'pix').reduce((a,d) => a+d.valor, 0)
  , [pagos, valesPeriodo, despPeriodo])

  // Variação vs semana anterior (agora compara grandezas iguais)
  const variacaoSem = totalAntSem > 0 ? Math.round(((totalCusto - totalAntSem) / totalAntSem) * 100) : 0
  const corVariacao = variacaoSem > 15 ? '#ef4444' : variacaoSem > 0 ? '#f59e0b' : '#22c55e'

  // Média por dia — considera todos os dias com qualquer tipo de lançamento
  const diasUnicos = useMemo(() => {
    const todos = [
      ...pagos.map(e => e.data_op),
      ...valesPeriodo.map(v => v.data_op),
      ...despPeriodo.map(d => d.data_op),
    ]
    return [...new Set(todos)]
  }, [pagos, valesPeriodo, despPeriodo])
  const mediaCustoPorDia = diasUnicos.length > 0 ? Math.round(totalCusto / diasUnicos.length) : 0

  // Por setor
  const porSetor = useMemo(() => setores.map(s => ({
    nome: s.nome,
    total: pagos.filter(e => e.setor_id === s.id).reduce((a, e) => a + e.valor_final, 0),
    qtd: pagos.filter(e => e.setor_id === s.id).length,
    internos: extrasComPessoa.filter(e => e.setor_id === s.id && e.interno_casa).length,
    externos: extrasComPessoa.filter(e => e.setor_id === s.id && !e.interno_casa).length,
  })).filter(s => s.qtd > 0).sort((a, b) => b.total - a.total), [pagos, setores, extrasComPessoa])

  // Por turno
  const porTurno = useMemo(() => {
    const turnos = { TD: { label: 'Turno Dia', qtd: 0, total: 0 }, TN: { label: 'Turno Noite', qtd: 0, total: 0 }, 'TD+TN': { label: 'Dia+Noite', qtd: 0, total: 0 }, outro: { label: 'Sem turno', qtd: 0, total: 0 } }
    pagos.forEach(e => {
      const k = ['TD','TN','TD+TN'].includes(e.turnos) ? e.turnos : 'outro'
      turnos[k].qtd++; turnos[k].total += e.valor_final
    })
    return Object.values(turnos).filter(t => t.qtd > 0)
  }, [pagos])

  // Por dia da semana
  const DIAS_LABEL = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
  const porDiaSemana = useMemo(() => {
    const dias = Array(7).fill(null).map((_, i) => ({ dia: DIAS_LABEL[i], total: 0, qtd: 0, count: 0 }))
    pagos.forEach(e => {
      const [y, m, d] = e.data_op.split('-')
      const dow = new Date(Number(y), Number(m)-1, Number(d)).getDay()
      dias[dow].total += e.valor_final; dias[dow].qtd++; dias[dow].count++
    })
    return dias
  }, [pagos])

  // Ranking funcionários
  const rankingFuncionarios = useMemo(() => {
    const map = {}
    extrasComPessoa.forEach(e => {
      if (!map[e.nome]) map[e.nome] = { nome: e.nome, total: 0, qtd: 0, interno: e.interno_casa, obs: e.obs_fixa }
      map[e.nome].total += e.valor_final; map[e.nome].qtd++
    })
    return Object.values(map).sort((a, b) => b.qtd - a.qtd).slice(0, 10)
  }, [extrasComPessoa])

  // Alertas inteligentes
  const alertas = useMemo(() => {
    const lista = []
    if (variacaoSem > 20) lista.push({
      cor: '#ef4444',
      titulo: `Custo ${variacaoSem}% acima da semana passada`,
      motivo: 'Você gastou significativamente mais com pessoal do que no mesmo período anterior. Vale revisar se houve mais turnos, mais extras escalados ou jornadas duplas.',
    })
    if (variacaoSem < -15) lista.push({
      cor: '#22c55e',
      titulo: `Custo ${Math.abs(variacaoSem)}% abaixo da semana passada`,
      motivo: 'Boa notícia: menos saídas com pessoal. Pode ser movimento menor ou otimização da escala.',
    })
    const pctInternos = pagos.length > 0 ? Math.round((internos.length / pagos.length) * 100) : 0
    if (pctInternos > 40) lista.push({
      cor: '#f59e0b',
      titulo: `${pctInternos}% dos extras são funcionários da casa`,
      motivo: 'Mais de 40% dos escalados são internos. Isso aumenta o custo fixo — verifique se o movimento justifica tantos extras do quadro.',
    })
    const cozinhaExternos = extrasComPessoa.filter(e => { const s = setores.find(x => x.id === e.setor_id); return s?.nome?.toLowerCase().includes('cozinha') && !e.interno_casa })
    if (cozinhaExternos.length > 5) lista.push({
      cor: '#f59e0b',
      titulo: `Cozinha com ${cozinhaExternos.length} externos no período`,
      motivo: 'Alta dependência de extras externos na cozinha pode indicar falta de mão de obra fixa ou escala mal dimensionada para o movimento.',
    })
    const ndExtras = pagos.filter(e => e.turnos === 'TD+TN')
    if (ndExtras.length > 3) lista.push({
      cor: '#f59e0b',
      titulo: `${ndExtras.length} jornadas duplas (TD+TN) no período`,
      motivo: 'Jornadas Dia+Noite custam o dobro. Se são frequentes, vale avaliar se é melhor escalar duas pessoas por turno em vez de uma em jornada dupla.',
    })
    const obsImportantes = extrasComPessoa.filter(e => e.obs_fixa && e.obs_fixa.length > 0)
    if (obsImportantes.length > 0) lista.push({
      cor: '#3b82f6',
      titulo: `${obsImportantes.length} extras com observação cadastrada`,
      motivo: 'Há pessoas na escala com anotações importantes (atrasos, restrições, preferências). Confira antes de fechar o pagamento.',
    })
    if (pagosHoje.length === 0 && filtro === 'hoje') lista.push({
      cor: '#8a7355',
      titulo: 'Nenhum pagamento registrado hoje ainda',
      motivo: 'O turno está aberto mas ainda não foi confirmado nenhum pagamento. Normal se o dia ainda está em andamento.',
    })
    return lista
  }, [pagos, internos, variacaoSem, extrasComPessoa, setores, pagosHoje])

  // Por funcionário para sub-tela
  const porFuncionario = useMemo(() => pessoas.map(p => ({
    id: p.id, nome: p.nome, funcao: p.funcao,
    interno_casa: p.interno_casa || false,
    obs_fixa: p.obs_fixa || '',
    pagamentos: pagos.filter(e => e.pessoa_id === p.id).sort((a,b) => b.data_op.localeCompare(a.data_op)),
    total: pagos.filter(e => e.pessoa_id === p.id).reduce((a, e) => a + e.valor_final, 0),
    qtd: pagos.filter(e => e.pessoa_id === p.id).length,
    trocos: totalTrocos(p.trocos),
    historico_trocos: p.trocos || [],
  })).filter(p => p.qtd > 0).sort((a, b) => b.total - a.total), [pagos, pessoas])

  const maxSetor = porSetor.length > 0 ? porSetor[0].total : 1
  const maxDia = Math.max(...porDiaSemana.map(d => d.total), 1)

  return (
    <>
      {/* Header Dashboard */}
      <div style={{ ...S.card, background: 'linear-gradient(135deg,#1a1a2e,#2d2340)', color: '#fff', marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: '#c9a96e', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Dashboard Operacional</div>
        <div style={{ fontSize: 11, color: '#ffffff50', marginTop: 2 }}>Inteligência de extras em tempo real</div>
      </div>

      {/* Filtro de período — sempre visível */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
        {[['hoje','Hoje'],['ontem','Ontem'],['semana','7 dias'],['mes','Mês'],['livre','Livre']].map(([id, label]) => (
          <button key={id} onClick={() => setFiltro(id)}
            style={{ padding: '6px 12px', border: `2px solid ${filtro === id ? C.primary : C.border}`, borderRadius: 20, background: filtro === id ? C.primary : C.bgCard, color: filtro === id ? '#fff' : C.textMuted, fontSize: 12, fontWeight: filtro === id ? 700 : 400, cursor: 'pointer' }}>
            {label}
          </button>
        ))}
      </div>
      {filtro === 'livre' && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <div style={{ flex: 1 }}><label style={S.label}>De</label><input type="date" value={dataInicio} onChange={e => setDataInicio(e.target.value)} style={S.input} /></div>
          <div style={{ flex: 1 }}><label style={S.label}>Até</label><input type="date" value={dataFim} onChange={e => setDataFim(e.target.value)} style={S.input} /></div>
        </div>
      )}

      {/* Botões exportação */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <button onClick={() => exportarExcel(pagos, pessoas, setores, config, from, to)}
          style={{ background: '#2e6b4733', border: '1px solid #2e6b4755', borderRadius: 8, color: '#6ee7b7', fontSize: 11, padding: '6px 10px', cursor: 'pointer', fontWeight: 700 }}>
          📊 Excel
        </button>
        <button onClick={() => exportarPDF(pagos, pessoas, setores, config, from, to)}
          style={{ background: '#a8322833', border: '1px solid #a8322855', borderRadius: 8, color: '#fca5a5', fontSize: 11, padding: '6px 10px', cursor: 'pointer', fontWeight: 700 }}>
          📄 PDF Extras
        </button>
        <button onClick={() => exportarRelatorioCompleto(pagos, valesPeriodo, despPeriodo, pessoas, setores, config, from, to)}
          style={{ background: '#9a752033', border: '1px solid #9a752055', borderRadius: 8, color: '#c9a96e', fontSize: 11, padding: '6px 10px', cursor: 'pointer', fontWeight: 700 }}>
          📤 Saídas
        </button>
      </div>

      {/* Sub-navegação */}
      <div style={{ display: 'flex', gap: 4, background: '#f0e8d8', padding: 4, borderRadius: 12, marginBottom: 14 }}>
        {[['financeiro','💰 Financeiro'],['equipe','👥 Equipe'],['analise','📋 Análise']].map(([id, label]) => (
          <button key={id} onClick={() => setSubTela(id)}
            style={{ flex: 1, padding: '8px 2px', border: 'none', borderRadius: 8, background: subTela === id ? '#fff' : 'transparent', cursor: 'pointer', fontSize: 11, fontWeight: subTela === id ? 700 : 400, color: subTela === id ? '#c9a96e' : '#999' }}>
            {label}
          </button>
        ))}
      </div>

      {/* ─── FINANCEIRO ─── */}
      {subTela === 'financeiro' && <>
        {/* Alertas */}
        {alertas.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
              ⚡ Atenção
            </div>
            {alertas.map((a, i) => (
              <AlertaCard key={i} alerta={a} />
            ))}
          </div>
        )}

        {/* Cards principais */}
        <div style={{ ...S.card, margin: 0, marginBottom: 8, background: 'linear-gradient(135deg,#1a1200,#2d2000)', color: '#fff' }}>
          <div style={{ fontSize: 10, color: '#c9a96e80', textTransform: 'uppercase', letterSpacing: '0.1em' }}>💰 Total saindo do caixa</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#c9a96e' }}>{fmt(totalCusto)}</div>
          {variacaoSem !== 0 && <div style={{ fontSize: 10, color: corVariacao, fontWeight: 600, marginTop: 2 }}>{variacaoSem > 0 ? '↑' : '↓'} {Math.abs(variacaoSem)}% vs semana passada</div>}
          <div style={{ display: 'flex', gap: 12, marginTop: 8, paddingTop: 8, borderTop: '1px solid #ffffff15' }}>
            <div style={{ fontSize: 11, color: '#ffffff70' }}>💼 Extras: <strong style={{ color: '#c9a96e' }}>{fmt(totalExtras)}</strong></div>
            <div style={{ fontSize: 11, color: '#ffffff70' }}>💸 Vales: <strong style={{ color: '#c9a96e' }}>{fmt(totalVales)}</strong></div>
            {totalDespesas > 0 && <div style={{ fontSize: 11, color: '#ffffff70' }}>🧾 Despesas: <strong style={{ color: '#c9a96e' }}>{fmt(totalDespesas)}</strong></div>}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
          <div style={{ ...S.card, margin: 0, textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: '#8a7355', textTransform: 'uppercase' }}>👥 Pessoas escaladas</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e' }}>{pagos.length}</div>
            <div style={{ fontSize: 10, color: '#8a7355' }}>no período</div>
          </div>
          <div style={{ ...S.card, margin: 0, textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: '#8a7355', textTransform: 'uppercase' }}>📅 Custo médio/dia</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: C.accent }}>{mediaCustoPorDia > 0 ? fmt(mediaCustoPorDia) : '—'}</div>
            <div style={{ fontSize: 10, color: '#8a7355' }}>{diasUnicos.length} dia{diasUnicos.length !== 1 ? 's' : ''} com saída</div>
          </div>
          <div style={{ ...S.card, margin: 0, textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: '#8a7355', textTransform: 'uppercase' }}>🏠 Da casa</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#3b82f6' }}>{internos.length}</div>
            <div style={{ fontSize: 10, color: pagos.length > 0 && (internos.length/pagos.length) > 0.4 ? '#f59e0b' : '#8a7355' }}>
              {pagos.length > 0 ? Math.round((internos.length/pagos.length)*100) : 0}% dos escalados
            </div>
          </div>
          <div style={{ ...S.card, margin: 0, textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: '#8a7355', textTransform: 'uppercase' }}>🚶 Extras externos</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#8a7355' }}>{externos.length}</div>
            <div style={{ fontSize: 10, color: '#8a7355' }}>{pagos.length > 0 ? Math.round((externos.length/pagos.length)*100) : 0}% dos escalados</div>
          </div>
        </div>

        {/* Pix vs Dinheiro */}
        <div style={S.card}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#8a7355', marginBottom: 4 }}>💳 Como o dinheiro saiu</div>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10 }}>Proporção entre Dinheiro e Pix em todas as saídas do período</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: '#22c55e' }}>💵 Dinheiro</div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{fmt(totalDin)}</div>
              <div style={{ fontSize: 10, color: C.textMuted }}>{totalCusto > 0 ? Math.round(totalDin/totalCusto*100) : 0}%</div>
            </div>
            <div style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: '#3b82f6' }}>📱 Pix</div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{fmt(totalPix)}</div>
              <div style={{ fontSize: 10, color: C.textMuted }}>{totalCusto > 0 ? Math.round(totalPix/totalCusto*100) : 0}%</div>
            </div>
          </div>
          {totalCusto > 0 && (
            <div style={{ height: 8, background: '#f0e8d8', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: Math.min(100, Math.round(totalDin/totalCusto*100))+'%', background: '#22c55e', borderRadius: 4 }} />
            </div>
          )}
        </div>

        {/* Heatmap por dia da semana */}
        <div style={S.card}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#8a7355', marginBottom: 4 }}>📅 Dias mais caros da semana</div>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10 }}>Mostra em quais dias você gasta mais com pessoal. Fins de semana destacados em dourado.</div>
          {porDiaSemana.map((d, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <div style={{ width: 28, fontSize: 11, color: [0,5,6].includes(i) ? '#c9a96e' : '#666', fontWeight: [0,5,6].includes(i) ? 700 : 400 }}>{d.dia}</div>
              <div style={{ flex: 1, height: 14, background: '#f0e8d8', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: d.total > 0 ? (d.total/maxDia*100)+'%' : '0%', background: [0,5,6].includes(i) ? '#c9a96e' : '#8a7355', borderRadius: 4, transition: 'width 0.3s' }} />
              </div>
              <div style={{ width: 55, fontSize: 11, textAlign: 'right', color: '#8a7355' }}>{d.total > 0 ? fmt(d.total) : '—'}</div>
            </div>
          ))}
        </div>
      </>}

      {/* ─── EQUIPE ─── */}
      {subTela === 'equipe' && <>
        {/* Pesquisa por funcionário */}
        <PesquisaFuncionario store={store} extras={extras} setores={setores} from={from} to={to} config={config} />

        <div style={S.card}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#8a7355', marginBottom: 10 }}>🏠 Internos vs 🚶 Externos</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 1, background: '#eff6ff', borderRadius: 10, padding: 10, textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: '#3b82f6' }}>Funcionários da casa</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: '#1e40af' }}>{internos.length}</div>
              <div style={{ fontSize: 11, color: '#3b82f6' }}>{fmt(internos.reduce((a,e) => a+e.valor_final, 0))}</div>
            </div>
            <div style={{ flex: 1, background: '#f5f0e8', borderRadius: 10, padding: 10, textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: '#8a7355' }}>Extras externos</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: '#1a1a2e' }}>{externos.length}</div>
              <div style={{ fontSize: 11, color: '#8a7355' }}>{fmt(externos.reduce((a,e) => a+e.valor_final, 0))}</div>
            </div>
          </div>
          {pagos.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: '#8a7355', marginBottom: 4 }}>Dependência de externos</div>
              <div style={{ height: 12, background: '#f0e8d8', borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: (externos.length/pagos.length*100)+'%', background: externos.length/pagos.length > 0.7 ? '#ef4444' : externos.length/pagos.length > 0.5 ? '#f59e0b' : '#22c55e', borderRadius: 6 }} />
              </div>
              <div style={{ fontSize: 10, color: '#8a7355', marginTop: 2 }}>{Math.round(externos.length/pagos.length*100)}% externos</div>
            </div>
          )}
        </div>

        <div style={S.card}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#8a7355', marginBottom: 10 }}>🏆 Mais escalados no período</div>
          <div style={{ fontSize: 11, color: '#8a7355', marginBottom: 8 }}>Toque para ver histórico completo</div>
          {porFuncionario.slice(0, 8).map((p, i) => (
            <div key={p.nome} onClick={() => setPessoaSelecionada(p)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #f0e8d8', cursor: 'pointer' }}>
              <div style={{ width: 24, height: 24, borderRadius: 12, background: i < 3 ? '#c9a96e' : '#f0e8d8', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: i < 3 ? '#fff' : '#8a7355' }}>
                {i+1}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{p.nome} {p.interno_casa ? '🏠' : ''}</div>
                <div style={{ fontSize: 11, color: '#8a7355' }}>{p.funcao} · {p.qtd}× escalado</div>
                {p.obs_fixa && <div style={{ fontSize: 10, color: '#f59e0b', fontStyle: 'italic' }}>⚠ {p.obs_fixa}</div>}
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#c9a96e' }}>{fmt(p.total)}</div>
                <div style={{ fontSize: 10, color: '#3b82f6' }}>Ver →</div>
              </div>
            </div>
          ))}
        </div>
      </>}

      {/* ─── TURNOS ─── */}
      {/* ─── ANÁLISE (Turnos + Setores) ─── */}
      {subTela === 'analise' && <>
        <div style={S.card}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#8a7355', marginBottom: 12 }}>🌙 Custo por turno</div>
          {porTurno.map((t, i) => (
            <div key={i} style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t.label}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#c9a96e' }}>{fmt(t.total)}</span>
              </div>
              <div style={{ height: 10, background: '#f0e8d8', borderRadius: 5, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: totalCusto > 0 ? (t.total/totalCusto*100)+'%' : '0%', background: t.label.includes('Noite') ? '#1a1a2e' : t.label.includes('Dia+Noite') ? '#c9a96e' : '#8a7355', borderRadius: 5 }} />
              </div>
              <div style={{ fontSize: 11, color: '#8a7355', marginTop: 2 }}>{t.qtd} extras · {totalCusto > 0 ? Math.round(t.total/totalCusto*100) : 0}% do custo</div>
            </div>
          ))}
        </div>

        <div style={S.card}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#8a7355', marginBottom: 10 }}>📊 Distribuição N vs D no período</div>
          {(() => {
            const noite = pagos.filter(e => e.turnos === 'TN' || e.turnos === 'TD+TN')
            const dia = pagos.filter(e => e.turnos === 'TD' || e.turnos === 'TD+TN')
            const custoN = noite.reduce((a,e) => a+e.valor_final, 0)
            const custoD = dia.reduce((a,e) => a+e.valor_final, 0)
            return (
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1, background: '#1a1a2e', borderRadius: 10, padding: 12, textAlign: 'center', color: '#fff' }}>
                  <div style={{ fontSize: 11, color: '#c9a96e' }}>🌙 Noite</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#c9a96e' }}>{noite.length}</div>
                  <div style={{ fontSize: 11, color: '#ffffff60' }}>{fmt(custoN)}</div>
                </div>
                <div style={{ flex: 1, background: '#f5f0e8', borderRadius: 10, padding: 12, textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: '#8a7355' }}>☀️ Dia</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{dia.length}</div>
                  <div style={{ fontSize: 11, color: '#8a7355' }}>{fmt(custoD)}</div>
                </div>
              </div>
            )
          })()}
        </div>

      {/* ─── SETORES ─── */}
        <div style={{ fontSize: 12, fontWeight: 700, color: '#8a7355', marginBottom: 10, marginTop: 4 }}>📁 Por Setor</div>
        {porSetor.map(s => (
          <div key={s.nome} style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{s.nome}</div>
                <div style={{ fontSize: 11, color: '#8a7355' }}>{s.qtd} extras · {fmt(s.total)}</div>
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#c9a96e' }}>{fmt(s.total)}</div>
            </div>
            <div style={{ height: 8, background: '#f0e8d8', borderRadius: 4, marginBottom: 8 }}>
              <div style={{ height: '100%', width: (s.total/maxSetor*100)+'%', background: '#c9a96e', borderRadius: 4 }} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, background: '#eff6ff', borderRadius: 6, padding: '4px 8px', textAlign: 'center' }}>
                <div style={{ fontSize: 10, color: '#3b82f6' }}>🏠 Internos</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#1e40af' }}>{s.internos}</div>
              </div>
              <div style={{ flex: 1, background: '#f5f0e8', borderRadius: 6, padding: '4px 8px', textAlign: 'center' }}>
                <div style={{ fontSize: 10, color: '#8a7355' }}>🚶 Externos</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{s.externos}</div>
              </div>
              <div style={{ flex: 1, background: s.externos > s.internos * 2 ? '#fff5f5' : '#f0fdf4', borderRadius: 6, padding: '4px 8px', textAlign: 'center' }}>
                <div style={{ fontSize: 10, color: s.externos > s.internos * 2 ? '#ef4444' : '#22c55e' }}>Dependência</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: s.externos > s.internos * 2 ? '#ef4444' : '#22c55e' }}>
                  {s.qtd > 0 ? Math.round(s.externos/s.qtd*100) : 0}%
                </div>
              </div>
            </div>
          </div>
        ))}
        {porSetor.length === 0 && <div style={{ ...S.card, textAlign: 'center', padding: 32, color: '#999' }}>Sem dados no período</div>}
      </>}

      {/* Modal histórico funcionário */}
      {pessoaSelecionada && (
        <ModalHistoricoFuncionario
          pessoa={pessoaSelecionada}
          from={from} to={to}
          setores={setores}
          config={config}
          onClose={() => setPessoaSelecionada(null)}
        />
      )}
    </>
  )
}


function ModalHistoricoFuncionario({ pessoa, from, to, setores, config, onClose }) {
  const totalGeral = pessoa.pagamentos.reduce((a, e) => a + e.valor_final, 0)
  const totalDin = pessoa.pagamentos.filter(e => e.forma_pagamento === 'dinheiro').reduce((a, e) => a + e.valor_final, 0)
  const totalPix = pessoa.pagamentos.filter(e => e.forma_pagamento === 'pix').reduce((a, e) => a + e.valor_final, 0)

  const imprimir = () => {
    const nomeEstab = config?.nome_estabelecimento || 'ARACÁ GRILL'
    const periodoLabel = from === to ? dayLabel(from) : `${dayLabel(from)} até ${dayLabel(to)}`
    const linhas = pessoa.pagamentos.map(e => {
      const setor = setores.find(s => s.id === e.setor_id)
      const desconto = (e.trocos_descontados || []).reduce((a, t) => a + t.valor, 0)
      return `
        <div class="linha">
          <div class="row">
            <span class="negrito">${dayLabel(e.data_op)}</span>
            <span class="negrito valor">${fmt(e.valor_final)}</span>
          </div>
          <div class="row sub">
            <span>${e.funcao || ''}${setor ? ' · ' + setor.nome : ''}${e.turnos ? ' · ' + e.turnos : ''}</span>
            <span>${e.forma_pagamento === 'pix' ? '📱 Pix' : '💵 Dinheiro'}</span>
          </div>
          ${desconto > 0 ? `<div class="row sub"><span>Troco descontado</span><span style="color:#22c55e">−${fmt(desconto)}</span></div>` : ''}
          ${e.troco_gerado > 0 ? `<div class="row sub"><span>Troco gerado</span><span style="color:#f59e0b">+${fmt(e.troco_gerado)}</span></div>` : ''}
          ${e.assinatura ? `<img src="${e.assinatura}" style="max-width:60mm;max-height:15mm;object-fit:contain;margin-top:4px;" />` : ''}
        </div>`
    }).join('')

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>
      * { margin:0; padding:0; box-sizing:border-box; }
      body { font-family:'Courier New',monospace; font-size:11px; width:72mm; margin:0 auto; color:#000; }
      .centro { text-align:center; }
      .negrito { font-weight:bold; }
      .grande { font-size:14px; }
      .valor { font-size:14px; }
      .sep { border-top:1px dashed #000; margin:6px 0; }
      .row { display:flex; justify-content:space-between; }
      .sub { font-size:10px; color:#555; margin-top:1px; }
      .linha { padding:6px 0; border-bottom:1px solid #eee; }
      @media print { @page { size:80mm auto; margin:2mm; } }
    </style></head><body>
    <div class="centro negrito grande">${nomeEstab}</div>
    <div class="centro">HISTÓRICO DE PAGAMENTOS</div>
    <div class="sep"></div>
    <div class="negrito grande">${pessoa.nome}</div>
    <div style="font-size:10px;color:#555">${pessoa.funcao || ''}</div>
    <div style="font-size:10px;color:#555">Período: ${periodoLabel}</div>
    <div class="sep"></div>
    ${linhas}
    <div class="sep"></div>
    <div class="row negrito"><span>💵 Dinheiro</span><span>${fmt(totalDin)}</span></div>
    <div class="row negrito"><span>📱 Pix</span><span>${fmt(totalPix)}</span></div>
    <div class="sep"></div>
    <div class="row negrito grande"><span>TOTAL</span><span>${fmt(totalGeral)}</span></div>
    <div style="margin-top:6px;font-size:10px;color:#999;text-align:center">${pessoa.qtd} pagamentos</div>
    <script>window.onload=()=>window.print()<\/script>
    </body></html>`

    const w = window.open('', '_blank', 'width=400,height=700')
    w.document.write(html)
    w.document.close()
  }

  return (
    <Modal title={pessoa.nome} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

        {/* Resumo */}
        <div style={{ ...S.card, background: 'linear-gradient(135deg,#1a1a2e,#2d2340)', color: '#fff', marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: '#c9a96e60' }}>{pessoa.qtd} pagamentos no período</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#c9a96e' }}>{fmt(totalGeral)}</div>
          <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
            <div style={{ fontSize: 12, color: '#c9a96e80' }}>💵 {fmt(totalDin)}</div>
            <div style={{ fontSize: 12, color: '#60a5fa80' }}>📱 {fmt(totalPix)}</div>
          </div>
          {pessoa.trocos > 0 && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 4 }}>🔴 Troco pendente: {fmt(pessoa.trocos)}</div>}
        </div>

        {/* Histórico */}
        {pessoa.pagamentos.map((e, i) => {
          const setor = setores.find(s => s.id === e.setor_id)
          const desconto = (e.trocos_descontados || []).reduce((a, t) => a + t.valor, 0)
          return (
            <div key={i} style={{ padding: '10px 0', borderBottom: '1px solid #f0e8d8' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{dayLabel(e.data_op)}</div>
                  <div style={{ fontSize: 12, color: '#8a7355' }}>{e.funcao}{e.turnos ? ' · ' + e.turnos : ''}{setor ? ' · ' + setor.nome : ''}</div>
                  {e.obs && <div style={{ fontSize: 11, color: C.textMuted, fontStyle: 'italic', marginTop: 2 }}>📝 {e.obs}</div>}
                  {e.editado && <div style={{ fontSize: 10, color: C.gold, marginTop: 1 }}>✏️ Editado por {e.editado_por} — {e.motivo_edicao}</div>}
                  {desconto > 0 && <div style={{ fontSize: 11, color: C.success }}>−{fmt(desconto)} troco descontado</div>}
                  {e.troco_gerado > 0 && <div style={{ fontSize: 11, color: C.gold }}>+{fmt(e.troco_gerado)} troco gerado</div>}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#c9a96e' }}>{fmt(e.valor_final)}</div>
                  {e.forma_pagamento === 'pix' ? <Badge color="#3b82f6">📱 Pix</Badge> : <Badge color="#22c55e">💵 Din</Badge>}
                </div>
              </div>
              {e.assinatura && <img src={e.assinatura} alt="Ass." style={{ maxHeight: 40, marginTop: 4, border: '1px solid #e0d5c5', borderRadius: 4 }} />}
            </div>
          )
        })}

        <button onClick={imprimir} style={{ ...S.btn(C.accent), marginTop: 16 }}>
          🖨️ Imprimir histórico
        </button>
      </div>
    </Modal>
  )
}

// ─── MODAL ADICIONAR PESSOA ───────────────────────────────────────────────────

function CampoPix({ tipoPix, chavePix, setChavePix }) {
  const erro = chavePix ? validarChavePix(tipoPix, chavePix) : { ok: true, msg: '' }

  const handleChange = (val) => {
    if (tipoPix === 'CPF') setChavePix(formatarCPF(val))
    else if (tipoPix === 'Telefone') setChavePix(formatarTelefone(val))
    else setChavePix(val)
  }

  return (
    <div>
      <input
        value={chavePix}
        onChange={e => handleChange(e.target.value)}
        style={{ ...S.input, borderColor: chavePix && !erro.ok ? '#ef4444' : '#e0d5c5' }}
        placeholder={
          tipoPix === 'CPF' ? '000.000.000-00' :
          tipoPix === 'Telefone' ? '(11) 99999-9999' :
          tipoPix === 'E-mail' ? 'exemplo@email.com' :
          'Chave aleatória'
        }
        inputMode={tipoPix === 'CPF' || tipoPix === 'Telefone' ? 'numeric' : 'text'}
      />
      {chavePix && !erro.ok && (
        <div style={{ fontSize: 11, color: '#ef4444', marginTop: 3 }}>⚠ {erro.msg}</div>
      )}
      {chavePix && erro.ok && (
        <div style={{ fontSize: 11, color: '#22c55e', marginTop: 3 }}>✓ Chave válida</div>
      )}
    </div>
  )
}

function ModalAddPessoa({ store, onClose }) {
  const { addPessoa, setores } = store
  const [nome, setNome] = useState('')
  const [funcao, setFuncao] = useState('')
  const [tel, setTel] = useState('')
  const [setorId, setSetorId] = useState('')
  const [valSQ, setValSQ] = useState('')
  const [valSD, setValSD] = useState('')
  const [tipoPix, setTipoPix] = useState('CPF')
  const [chavePix, setChavePix] = useState('')
  const [internoCasa, setInternoCasa] = useState(false)
  const [obsFixa, setObsFixa] = useState('')

  const save = async () => {
    if (!nome.trim()) return alert('Nome obrigatório')
    if (chavePix.trim()) {
      const v = validarChavePix(tipoPix, chavePix)
      if (!v.ok) return alert('Chave Pix inválida: ' + v.msg)
    }
    await addPessoa({ nome: nome.trim(), funcao, telefone: tel, setor_id: setorId, val_seg_qui: parseCents(valSQ), val_sex_dom: parseCents(valSD), tipo_pix: tipoPix, chave_pix: chavePix.trim(), interno_casa: internoCasa, obs_fixa: obsFixa.trim() })
    onClose()
  }

  return (
    <Modal title="Nova Pessoa" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div><label style={S.label}>Nome *</label><input value={nome} onChange={e => setNome(e.target.value)} style={S.input} /></div>
        <div><label style={S.label}>Telefone WhatsApp</label><input value={tel} onChange={e => setTel(e.target.value)} style={S.input} placeholder="18999999999" inputMode="numeric" /></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}><label style={S.label}>Função</label><input value={funcao} onChange={e => setFuncao(e.target.value)} style={S.input} /></div>
          <div style={{ flex: 1 }}><label style={S.label}>Setor</label>
            <select value={setorId} onChange={e => setSetorId(e.target.value)} style={S.input}>
              <option value="">—</option>
              {setores.filter(s => s.ativo).map(s => <option key={s.id} value={s.id}>{s.nome}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}><label style={S.label}>Seg-Qui</label><input value={valSQ} onChange={e => { const r = e.target.value.replace(/\D/g, ''); setValSQ(r ? fmt(parseInt(r)) : '') }} style={S.input} placeholder="R$ 0,00" inputMode="numeric" /></div>
          <div style={{ flex: 1 }}><label style={S.label}>Sex-Dom</label><input value={valSD} onChange={e => { const r = e.target.value.replace(/\D/g, ''); setValSD(r ? fmt(parseInt(r)) : '') }} style={S.input} placeholder="R$ 0,00" inputMode="numeric" /></div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}><label style={S.label}>Tipo Pix</label>
            <select value={tipoPix} onChange={e => setTipoPix(e.target.value)} style={S.input}>
              {['CPF', 'Telefone', 'E-mail', 'Aleatória'].map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div style={{ flex: 2 }}>
            <label style={S.label}>Chave Pix</label>
            <CampoPix tipoPix={tipoPix} chavePix={chavePix} setChavePix={setChavePix} />
          </div>
        </div>
        <div>
          <label style={S.label}>Observação permanente</label>
          <input value={obsFixa} onChange={e => setObsFixa(e.target.value)} style={S.input} placeholder="Ex: sempre atrasa, só Pix, não trabalha domingo..." />
        </div>
        <div onClick={() => setInternoCasa(!internoCasa)}
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: internoCasa ? '#eff6ff' : '#f5f0e8', border: `2px solid ${internoCasa ? '#3b82f6' : '#e0d5c5'}`, borderRadius: 10, cursor: 'pointer' }}>
          <div style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${internoCasa ? '#3b82f6' : '#ccc'}`, background: internoCasa ? '#3b82f6' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {internoCasa && <span style={{ color: '#fff', fontSize: 13, fontWeight: 700 }}>✓</span>}
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13, color: internoCasa ? '#1e40af' : '#666' }}>🏠 Funcionário da casa</div>
            <div style={{ fontSize: 11, color: '#8a7355' }}>Marque se essa pessoa é funcionário fixo que também faz extra</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={{ ...S.btn(C.textDim, true) }}>Cancelar</button>
          <button onClick={save} style={{ ...S.btn(C.primary), flex: 2 }}>Salvar</button>
        </div>
      </div>
    </Modal>
  )
}

// ─── MODAL EDITAR PESSOA ──────────────────────────────────────────────────────

function ModalEditPessoa({ store, pessoa, onClose }) {
  const { updatePessoa, setores } = store
  const [nome, setNome] = useState(pessoa.nome)
  const [funcao, setFuncao] = useState(pessoa.funcao || '')
  const [tel, setTel] = useState(pessoa.telefone || '')
  const [setorId, setSetorId] = useState(pessoa.setor_id || '')
  const [valSQ, setValSQ] = useState(fmt(pessoa.val_seg_qui || 0))
  const [valSD, setValSD] = useState(fmt(pessoa.val_sex_dom || 0))
  const [tipoPix, setTipoPix] = useState(pessoa.tipo_pix || 'CPF')
  const [chavePix, setChavePix] = useState(pessoa.chave_pix || '')
  const [internoCasa, setInternoCasa] = useState(pessoa.interno_casa || false)
  const [obsFixa, setObsFixa] = useState(pessoa.obs_fixa || '')

  const save = async () => {
    if (!nome.trim()) return alert('Nome obrigatório')
    if (chavePix.trim()) {
      const v = validarChavePix(tipoPix, chavePix)
      if (!v.ok) return alert('Chave Pix inválida: ' + v.msg)
    }
    await updatePessoa(pessoa.id, { nome: nome.trim(), funcao, telefone: tel, setor_id: setorId, val_seg_qui: parseCents(valSQ), val_sex_dom: parseCents(valSD), tipo_pix: tipoPix, chave_pix: chavePix.trim(), interno_casa: internoCasa, obs_fixa: obsFixa.trim() })
    onClose()
  }

  return (
    <Modal title="Editar Pessoa" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div><label style={S.label}>Nome *</label><input value={nome} onChange={e => setNome(e.target.value)} style={S.input} /></div>
        <div><label style={S.label}>Telefone WhatsApp</label><input value={tel} onChange={e => setTel(e.target.value)} style={S.input} placeholder="18999999999" inputMode="numeric" /></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}><label style={S.label}>Função</label><input value={funcao} onChange={e => setFuncao(e.target.value)} style={S.input} /></div>
          <div style={{ flex: 1 }}><label style={S.label}>Setor</label>
            <select value={setorId} onChange={e => setSetorId(e.target.value)} style={S.input}>
              <option value="">—</option>
              {setores.filter(s => s.ativo).map(s => <option key={s.id} value={s.id}>{s.nome}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}><label style={S.label}>Seg-Qui</label><input value={valSQ} onChange={e => { const r = e.target.value.replace(/\D/g, ''); setValSQ(r ? fmt(parseInt(r)) : '') }} style={S.input} placeholder="R$ 0,00" inputMode="numeric" /></div>
          <div style={{ flex: 1 }}><label style={S.label}>Sex-Dom</label><input value={valSD} onChange={e => { const r = e.target.value.replace(/\D/g, ''); setValSD(r ? fmt(parseInt(r)) : '') }} style={S.input} placeholder="R$ 0,00" inputMode="numeric" /></div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}><label style={S.label}>Tipo Pix</label>
            <select value={tipoPix} onChange={e => setTipoPix(e.target.value)} style={S.input}>
              {['CPF', 'Telefone', 'E-mail', 'Aleatória'].map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div style={{ flex: 2 }}>
            <label style={S.label}>Chave Pix</label>
            <CampoPix tipoPix={tipoPix} chavePix={chavePix} setChavePix={setChavePix} />
          </div>
        </div>
        <div>
          <label style={S.label}>Observação permanente</label>
          <input value={obsFixa} onChange={e => setObsFixa(e.target.value)} style={S.input} placeholder="Ex: sempre atrasa, só Pix, não trabalha domingo..." />
        </div>
        <div onClick={() => setInternoCasa(!internoCasa)}
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: internoCasa ? '#eff6ff' : '#f5f0e8', border: `2px solid ${internoCasa ? '#3b82f6' : '#e0d5c5'}`, borderRadius: 10, cursor: 'pointer' }}>
          <div style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${internoCasa ? '#3b82f6' : '#ccc'}`, background: internoCasa ? '#3b82f6' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {internoCasa && <span style={{ color: '#fff', fontSize: 13, fontWeight: 700 }}>✓</span>}
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13, color: internoCasa ? '#1e40af' : '#666' }}>🏠 Funcionário da casa</div>
            <div style={{ fontSize: 11, color: '#8a7355' }}>Marque se essa pessoa é funcionário fixo que também faz extra</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={{ ...S.btn(C.textDim, true) }}>Cancelar</button>
          <button onClick={save} style={{ ...S.btn(C.primary), flex: 2 }}>Salvar</button>
        </div>
      </div>
    </Modal>
  )
}

// ─── ABA CONFIG ───────────────────────────────────────────────────────────────

function SecaoAssinaturas({ store }) {
  const { extras, updateExtra } = store
  const [periodo, setPeriodo] = useState(30)
  const [limpando, setLimpando] = useState(false)
  const [resultado, setResultado] = useState('')

  const extrasComAssinatura = extras.filter(e => e.assinatura && e.assinatura.length > 0)
  const hoje = new Date()

  const limpar = async () => {
    if (!confirm(`Apagar assinaturas de extras com mais de ${periodo} dias? O restante dos dados fica salvo.`)) return
    setLimpando(true)
    setResultado('')
    let count = 0
    for (const e of extrasComAssinatura) {
      const dataExtra = new Date(e.data_op + 'T12:00:00')
      const diffDias = Math.floor((hoje - dataExtra) / (1000 * 60 * 60 * 24))
      if (diffDias >= periodo) {
        await updateExtra(e.id, { assinatura: null })
        count++
      }
    }
    setLimpando(false)
    setResultado(`✓ ${count} assinatura${count !== 1 ? 's' : ''} apagada${count !== 1 ? 's' : ''}`)
    setTimeout(() => setResultado(''), 4000)
  }

  const totalKb = Math.round(extrasComAssinatura.reduce((a, e) => a + (e.assinatura?.length || 0), 0) / 1024)

  return (
    <div style={S.card}>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>✍️ Assinaturas</div>
      <div style={{ fontSize: 13, color: '#8a7355', marginBottom: 12 }}>
        {extrasComAssinatura.length} assinatura{extrasComAssinatura.length !== 1 ? 's' : ''} salvas · ~{totalKb}kb no banco
      </div>

      <label style={S.label}>Apagar assinaturas mais antigas que</label>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {[7, 15, 30, 60, 90].map(d => (
          <button key={d} onClick={() => setPeriodo(d)}
            style={{ padding: '6px 12px', border: `2px solid ${periodo === d ? '#c9a96e' : '#e0d5c5'}`, borderRadius: 20, background: periodo === d ? '#c9a96e' : '#fff', color: periodo === d ? '#fff' : '#666', fontSize: 12, fontWeight: periodo === d ? 700 : 400, cursor: 'pointer' }}>
            {d} dias
          </button>
        ))}
      </div>

      <div style={{ fontSize: 12, color: '#999', marginBottom: 12 }}>
        {extrasComAssinatura.filter(e => {
          const diff = Math.floor((hoje - new Date(e.data_op + 'T12:00:00')) / (1000 * 60 * 60 * 24))
          return diff >= periodo
        }).length} assinatura{extrasComAssinatura.filter(e => Math.floor((hoje - new Date(e.data_op + 'T12:00:00')) / (1000 * 60 * 60 * 24)) >= periodo).length !== 1 ? 's' : ''} serão apagadas
      </div>

      <button onClick={limpar} disabled={limpando}
        style={{ ...S.btn(limpando ? '#ccc' : '#ef4444'), fontWeight: 700 }}>
        {limpando ? 'Limpando...' : `🗑 Limpar assinaturas +${periodo} dias`}
      </button>

      {resultado ? (
        <div style={{ marginTop: 10, fontSize: 13, color: '#22c55e', fontWeight: 600, textAlign: 'center' }}>{resultado}</div>
      ) : null}
    </div>
  )
}

function TabConfig({ store, setModal }) {
  const { setores, addSetor, updateSetor, removeSetor, pessoas, removePessoa, config, updateConfig } = store
  const [subConfig, setSubConfig] = useState('geral')
  const [novoSetor, setNovoSetor] = useState('')
  const [nomeEstab, setNomeEstab] = useState(config.nome_estabelecimento)
  const [whatsapp, setWhatsapp] = useState(config.whatsapp_pix)
  const [savedMsg, setSavedMsg] = useState('')

  const salvarGeral = () => {
    updateConfig({
      nome_estabelecimento: nomeEstab.trim() || 'ARACÁ GRILL',
      whatsapp_pix: whatsapp.replace(/\D/g, ''),
    })
    setSavedMsg('✓ Salvo!')
    setTimeout(() => setSavedMsg(''), 2500)
  }

  return (
    <div>
      {/* Sub-navegação */}
      <div style={{ display: 'flex', gap: 3, background: '#f0e8d8', padding: 4, borderRadius: 14, marginBottom: 14 }}>
        {[['geral','🏠 Geral'],['pessoas','👥 Pessoas'],['operacional','📁 Operacional'],['dados','🗄️ Dados']].map(([id, label]) => (
          <button key={id} onClick={() => setSubConfig(id)}
            style={{ flex: 1, padding: '8px 2px', border: 'none', borderRadius: 10, background: subConfig === id ? '#fff' : 'transparent',
              cursor: 'pointer', fontSize: 10, fontWeight: subConfig === id ? 800 : 400,
              color: subConfig === id ? C.primary : '#999',
              boxShadow: subConfig === id ? '0 1px 4px rgba(0,0,0,0.08)' : 'none' }}>
            {label}
          </button>
        ))}
      </div>

      {/* ─── GERAL ─── */}
      {subConfig === 'geral' && (
        <div>
          <div style={S.card}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14 }}>🏠 Estabelecimento</div>
            <div style={{ marginBottom: 10 }}>
              <label style={S.label}>Nome do estabelecimento</label>
              <input value={nomeEstab} onChange={e => setNomeEstab(e.target.value)} style={S.input} placeholder="Ex: ARACÁ GRILL" />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={S.label}>WhatsApp para envio do Pix</label>
              <input value={whatsapp} onChange={e => setWhatsapp(e.target.value)} style={S.input} placeholder="5518999999999" inputMode="numeric" />
              <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>Com DDI+DDD, sem espaços. Ex: 5518996530959</div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={S.label}>Senha mestre de emergência</label>
              <input type="password" value={config.senha_mestre || ''}
                onChange={e => updateConfig({ senha_mestre: e.target.value })}
                style={S.input} placeholder="Deixe em branco para desativar" />
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
                Com essa senha qualquer usuário consegue logar como admin de emergência.
              </div>
            </div>
            <button onClick={salvarGeral} style={{ ...S.btn(savedMsg ? C.success : C.primary) }}>
              {savedMsg || 'Salvar configurações'}
            </button>
          </div>
          <div style={{ ...S.card, background: C.bgCard2, border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 12, color: C.secondary, fontWeight: 700 }}>ℹ️ {config.nome_estabelecimento} v2.0</div>
            <div style={{ fontSize: 12, color: C.textMuted }}>Sistema operacional de extras · Firebase Firestore</div>
          </div>
        </div>
      )}

      {/* ─── PESSOAS ─── */}
      {subConfig === 'pessoas' && (
        <div>
          <div style={S.card}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>👤 Funcionários ({pessoas.length})</div>
            {pessoas.length === 0 && <div style={{ fontSize: 13, color: '#999', textAlign: 'center', padding: 16 }}>Nenhuma pessoa cadastrada</div>}
            {pessoas.map(p => (
              <div key={p.id} style={{ padding: '10px 0', borderBottom: '1px solid #f0e8d8' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{p.nome} {p.interno_casa ? '🏠' : ''}</div>
                    <div style={{ fontSize: 12, color: '#8a7355' }}>{p.funcao}</div>
                    <div style={{ fontSize: 12, color: '#8a7355' }}>Seg-Qui: {fmt(p.val_seg_qui)} · Sex-Dom: {fmt(p.val_sex_dom)}</div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>{p.tipo_pix}: {p.chave_pix}</div>
                    {p.telefone ? <div style={{ fontSize: 12, color: '#3b82f6' }}>📱 {p.telefone}</div> : null}
                    {totalTrocos(p.trocos) > 0 && (
                      <div style={{ fontSize: 11, color: '#ef4444', fontWeight: 600, marginTop: 2 }}>
                        🔴 Troco pendente: {fmt(totalTrocos(p.trocos))}
                        {(p.trocos || []).map((t, i) => (
                          <span key={i} style={{ display: 'block', marginLeft: 8, fontWeight: 400 }}>• {dayLabel(t.data)}: {fmt(t.valor)}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => setModal({ type: 'editPessoa', pessoa: p })}
                      style={{ background: 'none', border: '1px solid #c9a96e', borderRadius: 6, padding: '4px 10px', fontSize: 12, color: '#c9a96e', cursor: 'pointer' }}>✏️</button>
                    <button onClick={() => { if (confirm('Remover ' + p.nome + '?')) removePessoa(p.id) }}
                      style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: 18, cursor: 'pointer' }}>🗑</button>
                  </div>
                </div>
              </div>
            ))}
            <button onClick={() => setModal({ type: 'addPessoa' })} style={{ ...S.btn(C.accent), marginTop: 12 }}>+ Nova Pessoa</button>
          </div>
          <SecaoUsuarios />
        </div>
      )}

      {/* ─── OPERACIONAL ─── */}
      {subConfig === 'operacional' && (
        <div>
          <div style={S.card}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>📁 Setores</div>
            {setores.map(s => (
              <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f0e8d8' }}>
                <span style={{ fontSize: 14 }}>{s.nome}</span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button onClick={() => updateSetor(s.id, { ativo: !s.ativo })}
                    style={{ background: 'none', border: `1px solid ${s.ativo ? '#22c55e' : '#ccc'}`, borderRadius: 6, padding: '3px 10px', fontSize: 11, color: s.ativo ? '#22c55e' : '#999', cursor: 'pointer', fontWeight: 600 }}>
                    {s.ativo ? 'Ativo' : 'Inativo'}
                  </button>
                  <button onClick={() => { if (confirm('Remover setor ' + s.nome + '?')) removeSetor(s.id) }}
                    style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: 16, cursor: 'pointer' }}>🗑</button>
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <input value={novoSetor} onChange={e => setNovoSetor(e.target.value)} style={{ ...S.input, flex: 1 }} placeholder="Novo setor..." />
              <button onClick={() => { if (novoSetor.trim()) { addSetor({ nome: novoSetor.trim(), ativo: true }); setNovoSetor('') } }}
                style={{ ...S.btn(C.primary), flex: 'none', padding: '10px 18px' }}>+</button>
            </div>
          </div>
          <SecaoCategorias store={store} />
        </div>
      )}

      {/* ─── DADOS ─── */}
      {subConfig === 'dados' && (
        <div>
          <SecaoAssinaturas store={store} />
          <SecaoFotos store={store} />
          <div style={{ ...S.card, border: `1px solid ${C.danger}44`, background: '#1a0808' }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: C.danger, marginBottom: 14 }}>⚠️ Zona de Perigo</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button onClick={() => setModal({ type: 'redefinirSenha' })}
                style={{ ...S.btn(C.gold, true), textAlign: 'left', padding: '12px 16px' }}>
                🔑 Redefinir senha de usuário
              </button>
              <button onClick={() => setModal({ type: 'limparBanco' })}
                style={{ ...S.btn(C.danger, true), textAlign: 'left', padding: '12px 16px' }}>
                🗑 Limpar banco de dados
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


// ─── MODAL EDITAR PAGAMENTO JÁ EFETUADO ──────────────────────────────────────

function ModalEditarPagamento({ store, extra, onClose }) {
  const { updateExtra, registrarLog, usuario } = store
  const [valorDisplay, setValorDisplay] = useState(fmt(extra.valor_final))
  const [forma, setForma] = useState(extra.forma_pagamento || 'dinheiro')
  const [obs, setObs] = useState(extra.obs || '')
  const [motivoEdicao, setMotivoEdicao] = useState('')
  const [salvando, setSalvando] = useState(false)

  const salvar = async () => {
    if (!motivoEdicao.trim()) return alert('Informe o motivo da edição.')
    setSalvando(true)
    const novoValor = parseCents(valorDisplay)
    const valorOriginal = extra.valor_extra || extra.valor_original || extra.valor_final
    const trocoAnterior = extra.troco_gerado || 0

    // Recalcula troco: se pagou menos ou igual ao combinado, zera troco
    const novoTroco = novoValor > valorOriginal ? novoValor - valorOriginal : 0

    const alteracoes = {
      valor_final: novoValor,
      valor_pago: novoValor,
      forma_pagamento: forma,
      obs: obs.trim(),
      editado: true,
      editado_por: usuario?.nome || 'desconhecido',
      editado_em: new Date().toISOString(),
      motivo_edicao: motivoEdicao.trim(),
      troco_gerado: novoTroco,
    }
    await updateExtra(extra.id, alteracoes)

    // Atualiza trocos do funcionário se mudou
    if (pessoa && novoTroco !== trocoAnterior) {
      const trocosFiltrados = (pessoa.trocos || []).filter(t =>
        !(t.descricao && t.descricao.includes(dayLabel(extra.data_op)))
      )
      if (novoTroco > 0) {
        trocosFiltrados.push({ data: extra.data_op, valor: novoTroco, descricao: `Troco editado — ${dayLabel(extra.data_op)}` })
      }
      await updatePessoa(pessoa.id, { trocos: trocosFiltrados })
    }

    await registrarLog('edicao_pagamento', {
      extra_id: extra.id,
      nome: extra.nome,
      valor_anterior: extra.valor_final,
      valor_novo: novoValor,
      troco_anterior: trocoAnterior,
      troco_novo: novoTroco,
      forma_anterior: extra.forma_pagamento,
      forma_nova: forma,
      motivo: motivoEdicao.trim(),
    })
    setSalvando(false)
    onClose()
  }

  return (
    <Modal title="Editar Pagamento" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Info do extra */}
        <div style={{ background: C.bgCard2, borderRadius: 12, padding: 12, border: `1px solid ${C.border}` }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: C.text }}>{extra.nome}</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>{extra.funcao}{extra.turnos ? ' · ' + extra.turnos : ''} · {dayLabel(extra.data_op)}</div>
          {extra.editado && (
            <div style={{ fontSize: 11, color: C.gold, marginTop: 4 }}>
              ⚠ Já editado por {extra.editado_por} em {new Date(extra.editado_em).toLocaleDateString('pt-BR')}
            </div>
          )}
        </div>

        {/* Valor */}
        <div>
          <label style={S.label}>Valor pago</label>
          <input value={valorDisplay}
            onChange={e => { const r = e.target.value.replace(/\D/g, ''); setValorDisplay(r ? fmt(parseInt(r)) : '') }}
            style={{ ...S.input, fontSize: 20, fontWeight: 800 }} inputMode="numeric" />
        </div>

        {/* Forma */}
        <div>
          <label style={S.label}>Forma de pagamento</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setForma('dinheiro')}
              style={{ flex: 1, padding: '12px', border: `2px solid ${forma === 'dinheiro' ? C.success : C.border}`, borderRadius: 12, background: forma === 'dinheiro' ? C.success + '25' : C.bgCard2, cursor: 'pointer', fontSize: 13, fontWeight: 800, color: forma === 'dinheiro' ? C.success : C.textMuted }}>
              💵 Dinheiro
            </button>
            <button onClick={() => setForma('pix')}
              style={{ flex: 1, padding: '12px', border: `2px solid ${forma === 'pix' ? C.secondary : C.border}`, borderRadius: 12, background: forma === 'pix' ? C.secondary + '25' : C.bgCard2, cursor: 'pointer', fontSize: 13, fontWeight: 800, color: forma === 'pix' ? C.secondary : C.textMuted }}>
              📱 Pix
            </button>
          </div>
        </div>

        {/* Observação do recibo */}
        <div>
          <label style={S.label}>Observação do recibo</label>
          <input value={obs} onChange={e => setObs(e.target.value)}
            style={S.input} placeholder="Ex: trabalhou direto, ficou além do turno..." />
        </div>

        {/* Motivo da edição — obrigatório */}
        <div>
          <label style={{ ...S.label, color: C.danger }}>Motivo da edição *</label>
          <input value={motivoEdicao} onChange={e => setMotivoEdicao(e.target.value)}
            style={{ ...S.input, borderColor: motivoEdicao ? C.border : C.danger + '88' }}
            placeholder="Por que está editando este pagamento?" />
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Obrigatório — ficará salvo no log com seu nome</div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={{ ...S.btn(C.textDim, true) }}>Cancelar</button>
          <button onClick={salvar} disabled={salvando}
            style={{ ...S.btn(salvando ? C.textDim : C.gold), flex: 2 }}>
            {salvando ? 'Salvando...' : '✏️ Salvar edição'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
// ─── MODAL LIMPAR BANCO ───────────────────────────────────────────────────────

function ModalLimparBanco({ store, onClose }) {
  const { registrarLog, usuario } = store
  const [opcoes, setOpcoes] = useState({
    extras: true,
    logs: true,
    pessoas: false,
    setores: false,
    usuarios: false,
    config: false,
  })
  const [confirmacao, setConfirmacao] = useState('')
  const [limpando, setLimpando] = useState(false)
  const [resultado, setResultado] = useState('')

  const toggleOpcao = (k) => setOpcoes(p => ({ ...p, [k]: !p[k] }))

  const limpar = async () => {
    if (confirmacao !== 'LIMPAR') return alert('Digite LIMPAR em maiúsculas para confirmar.')
    setLimpando(true)
    try {
      for (const [col, ativo] of Object.entries(opcoes)) {
        if (!ativo) continue
        const snap = await getDocs(collection(db, col))
        const lote = []
        snap.forEach(d => lote.push(deleteDoc(doc(db, col, d.id))))
        await Promise.all(lote)
      }
      await registrarLog('limpeza_banco', { opcoes, usuario: usuario?.nome })
      setResultado('✅ Dados apagados com sucesso!')
      setTimeout(() => { onClose(); window.location.reload() }, 2000)
    } catch (e) {
      setResultado('❌ Erro ao limpar: ' + e.message)
    }
    setLimpando(false)
  }

  const itens = [
    { key: 'extras',   label: 'Extras e pagamentos', desc: 'Todo histórico de extras e pagamentos', danger: true },
    { key: 'logs',     label: 'Logs de atividade',   desc: 'Histórico de ações e edições', danger: false },
    { key: 'pessoas',  label: 'Pessoas cadastradas', desc: 'Todos os funcionários extras', danger: true },
    { key: 'setores',  label: 'Setores',             desc: 'Cozinha, Bar, Churrasqueira...', danger: false },
    { key: 'usuarios', label: 'Usuários do sistema', desc: 'Contas de acesso (cuidado!)', danger: true },
    { key: 'config',   label: 'Configurações',       desc: 'Nome, WhatsApp, horário de virada', danger: false },
  ]

  return (
    <Modal title="⚠️ Limpar Banco de Dados" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ background: '#2a0d0d', border: '1px solid #ef444455', borderRadius: 12, padding: 12 }}>
          <div style={{ fontSize: 13, color: '#ff6b6b', fontWeight: 700 }}>⚠️ Atenção — ação irreversível!</div>
          <div style={{ fontSize: 12, color: '#ffaaaa', marginTop: 4 }}>Os dados apagados não poderão ser recuperados.</div>
        </div>

        <label style={S.label}>O que apagar:</label>
        {itens.map(item => (
          <div key={item.key} onClick={() => toggleOpcao(item.key)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: opcoes[item.key] ? (item.danger ? '#2a0d0d' : C.bgCard2) : C.bgCard, border: `1px solid ${opcoes[item.key] ? (item.danger ? '#ef4444' : C.primary) : C.border}`, borderRadius: 10, cursor: 'pointer' }}>
            <div style={{ width: 20, height: 20, borderRadius: 5, border: `2px solid ${opcoes[item.key] ? (item.danger ? '#ef4444' : C.primary) : C.border}`, background: opcoes[item.key] ? (item.danger ? '#ef4444' : C.primary) : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {opcoes[item.key] && <span style={{ color: '#fff', fontSize: 13, fontWeight: 800 }}>✓</span>}
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: opcoes[item.key] && item.danger ? '#ff6b6b' : C.text }}>{item.label}</div>
              <div style={{ fontSize: 11, color: C.textMuted }}>{item.desc}</div>
            </div>
          </div>
        ))}

        <div>
          <label style={{ ...S.label, color: C.danger }}>Digite LIMPAR para confirmar</label>
          <input value={confirmacao} onChange={e => setConfirmacao(e.target.value)}
            style={{ ...S.input, borderColor: confirmacao === 'LIMPAR' ? C.danger : C.border, color: C.danger, fontWeight: 800, textAlign: 'center', fontSize: 16 }}
            placeholder="LIMPAR" autoCapitalize="characters" />
        </div>

        {resultado && <div style={{ fontSize: 14, fontWeight: 700, textAlign: 'center', color: resultado.includes('✅') ? C.success : C.danger }}>{resultado}</div>}

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={{ ...S.btn(C.textDim, true) }}>Cancelar</button>
          <button onClick={limpar} disabled={limpando || confirmacao !== 'LIMPAR'}
            style={{ ...S.btn(confirmacao === 'LIMPAR' ? C.danger : C.textDim), flex: 2 }}>
            {limpando ? 'Apagando...' : '🗑 Confirmar limpeza'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
// ─── MODAL REDEFINIR SENHA ────────────────────────────────────────────────────

function ModalRedefinirSenha({ store, onClose }) {
  const { registrarLog, usuario } = store
  const [usuarios, setUsuarios] = useState([])
  const [usuarioSel, setUsuarioSel] = useState('')
  const [novaSenha, setNovaSenha] = useState('')
  const [senhaRep, setSenhaRep] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    getDocs(collection(db, 'usuarios')).then(snap => {
      setUsuarios(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
  }, [])

  const salvar = async () => {
    if (!usuarioSel) return setMsg('Selecione um usuário.')
    if (novaSenha.length < 4) return setMsg('Senha precisa ter pelo menos 4 caracteres.')
    if (novaSenha !== senhaRep) return setMsg('As senhas não coincidem.')
    setSalvando(true)
    const hash = await hashSenha(novaSenha)
    await updateDoc(doc(db, 'usuarios', usuarioSel), { senha: hash })
    await registrarLog('redefinicao_senha', { usuario_alvo: usuarios.find(u => u.id === usuarioSel)?.usuario })
    setMsg('✅ Senha redefinida com sucesso!')
    setSalvando(false)
    setTimeout(onClose, 2000)
  }

  return (
    <Modal title="🔑 Redefinir Senha" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label style={S.label}>Usuário</label>
          <select value={usuarioSel} onChange={e => setUsuarioSel(e.target.value)} style={S.input}>
            <option value="">— Selecionar —</option>
            {usuarios.map(u => <option key={u.id} value={u.id}>{u.nome} (@{u.usuario})</option>)}
          </select>
        </div>
        <div>
          <label style={S.label}>Nova senha</label>
          <input type="password" value={novaSenha} onChange={e => setNovaSenha(e.target.value)} style={S.input} placeholder="Mínimo 4 caracteres" />
        </div>
        <div>
          <label style={S.label}>Confirmar nova senha</label>
          <input type="password" value={senhaRep} onChange={e => setSenhaRep(e.target.value)} style={S.input} placeholder="Repita a senha" />
        </div>
        {msg && <div style={{ fontSize: 13, fontWeight: 700, textAlign: 'center', color: msg.includes('✅') ? C.success : C.danger }}>{msg}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={{ ...S.btn(C.textDim, true) }}>Cancelar</button>
          <button onClick={salvar} disabled={salvando} style={{ ...S.btn(C.primary), flex: 2 }}>
            {salvando ? 'Salvando...' : '🔑 Redefinir'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
// ─── TELA DE LOGIN ────────────────────────────────────────────────────────────

function TelaLogin({ onLogin }) {
  const [modo, setModo] = useState('login') // 'login' | 'cadastro' | 'aguardando'
  const [login, setLogin] = useState('')
  const [senha, setSenha] = useState('')
  const [nome, setNome] = useState('')
  const [erro, setErro] = useState('')
  const [loading, setLoading] = useState(false)

  const entrar = async () => {
    if (!login.trim() || !senha.trim()) return setErro('Preencha usuário e senha.')
    setLoading(true); setErro('')
    try {
      // Verifica senha mestre primeiro
      const configSnap = await getDoc(doc(db, 'configuracoes', 'geral'))
      const senhaMestre = configSnap.exists() ? configSnap.data().senha_mestre : ''
      if (senhaMestre && senha === senhaMestre) {
        // Loga como admin mestre sem verificar usuário
        const hashMestre = await hashSenha(senha)
        const qMestre = query(collection(db, 'usuarios'), where('role', '==', 'admin'))
        const snapMestre = await getDocs(qMestre)
        if (!snapMestre.empty) {
          onLogin({ id: snapMestre.docs[0].id, ...snapMestre.docs[0].data() })
          setLoading(false); return
        }
      }
      const hash = await hashSenha(senha)
      const q = query(collection(db, 'usuarios'), where('usuario', '==', login.trim().toLowerCase()), where('senha', '==', hash))
      const snap = await getDocs(q)
      if (snap.empty) { setErro('Usuário ou senha incorretos.'); setLoading(false); return }
      const u = { id: snap.docs[0].id, ...snap.docs[0].data() }
      if (u.status === 'pendente') { setErro('Seu cadastro ainda não foi aprovado pelo administrador.'); setLoading(false); return }
      if (u.status === 'rejeitado') { setErro('Seu acesso foi negado. Entre em contato com o administrador.'); setLoading(false); return }
      onLogin(u)
    } catch (e) { setErro('Erro ao conectar. Verifique sua internet.') }
    setLoading(false)
  }

  const cadastrar = async () => {
    if (!nome.trim() || !login.trim() || !senha.trim()) return setErro('Preencha todos os campos.')
    if (senha.length < 4) return setErro('Senha precisa ter pelo menos 4 caracteres.')
    setLoading(true); setErro('')
    try {
      // Verifica se usuário já existe
      const q = query(collection(db, 'usuarios'), where('usuario', '==', login.trim().toLowerCase()))
      const snap = await getDocs(q)
      if (!snap.empty) { setErro('Esse usuário já existe. Escolha outro.'); setLoading(false); return }
      // Verifica se é o primeiro usuário (vira admin automaticamente)
      const todos = await getDocs(collection(db, 'usuarios'))
      const hash = await hashSenha(senha)
      const role = todos.empty ? 'admin' : 'operador'
      const status = todos.empty ? 'aprovado' : 'pendente'
      await addDoc(collection(db, 'usuarios'), {
        nome: nome.trim(),
        usuario: login.trim().toLowerCase(),
        senha: hash,
        role,
        status,
        criado_em: new Date().toISOString(),
      })
      if (todos.empty) {
        // Primeiro usuário — loga direto
        const snap2 = await getDocs(query(collection(db, 'usuarios'), where('usuario', '==', login.trim().toLowerCase())))
        const u = { id: snap2.docs[0].id, ...snap2.docs[0].data() }
        onLogin(u)
      } else {
        setModo('aguardando')
      }
    } catch (e) { setErro('Erro ao cadastrar. Tente novamente.') }
    setLoading(false)
  }

  const S2 = {
    tela: {
      minHeight: '100vh',
      background: `linear-gradient(135deg, ${C.bg} 0%, #e4ddd4 100%)`,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: 24,
      fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
    },
    card: {
      background: '#ffffff',
      borderRadius: 24,
      padding: '40px 32px',
      width: '100%', maxWidth: 400,
      boxShadow: '0 10px 40px rgba(0,0,0,0.08)',
      border: `1px solid ${C.border}`,
      textAlign: 'center',
    },
    input: {
      width: '100%', padding: '14px 18px',
      border: `1.5px solid ${C.border}`,
      borderRadius: 12,
      fontFamily: 'inherit', fontSize: 15,
      background: '#fafafa',
      boxSizing: 'border-box', marginBottom: 12,
      color: C.text, outline: 'none',
    },
    btn: (bg) => ({
      width: '100%', padding: '15px',
      background: bg === C.textDim ? C.bgCard2 : `linear-gradient(to bottom, ${bg}, ${bg}dd)`,
      color: bg === C.textDim ? C.textMuted : '#fff',
      border: 'none', borderRadius: 12,
      fontFamily: 'inherit', fontSize: 15, fontWeight: 800,
      cursor: 'pointer', marginBottom: 10,
      boxShadow: bg === C.primary ? '0 4px 16px rgba(181,118,58,0.3)' : 'none',
    }),
    erro: { color: C.danger, fontSize: 13, textAlign: 'center', marginBottom: 10, fontWeight: 600 },
    link: { color: C.secondary, fontSize: 13, textAlign: 'center', cursor: 'pointer', fontWeight: 600 },
  }

  const Deco = () => null // decorações removidas no novo design limpo

  if (modo === 'aguardando') return (
    <div style={S2.tela}>
      <div style={S2.card}>
        <div style={{ fontSize: 56, marginBottom: 16 }}>⏳</div>
        <div style={{ fontWeight: 800, fontSize: 20, color: C.text, marginBottom: 8 }}>Cadastro enviado!</div>
        <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 24, lineHeight: 1.6 }}>Aguarde o administrador aprovar seu acesso. Volte em breve.</div>
        <button onClick={() => setModo('login')} style={S2.btn(C.secondary)}>← Voltar ao login</button>
      </div>
    </div>
  )

  return (
    <div style={S2.tela}>
      <div style={S2.card}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🔥</div>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 900, letterSpacing: '-0.04em', color: C.text }}>Aracá Grill</h1>
        <p style={{ color: C.textMuted, fontSize: 14, marginTop: 6, marginBottom: 28 }}>
          {modo === 'login' ? 'Gestão Operacional de Extras' : 'Solicitar Acesso ao Sistema'}
        </p>
        <div style={{ textAlign: 'left' }}>
        {modo === 'cadastro' && (
          <input value={nome} onChange={e => setNome(e.target.value)} style={S2.input} placeholder="Seu nome completo" />
        )}
        <input value={login} onChange={e => setLogin(e.target.value)} style={S2.input} placeholder="Usuário" autoCapitalize="none" />
        <input value={senha} onChange={e => setSenha(e.target.value)} style={S2.input} placeholder="Senha" type="password" />
        {erro ? <div style={S2.erro}>{erro}</div> : null}
        <button onClick={modo === 'login' ? entrar : cadastrar} disabled={loading}
          style={S2.btn(loading ? C.textDim : C.primary)}>
          {loading ? 'Aguarde...' : modo === 'login' ? 'Entrar no Sistema' : 'Solicitar Acesso'}
        </button>
        <div style={{ ...S2.link, marginTop: 4 }} onClick={() => { setErro(''); setModo(modo === 'login' ? 'cadastro' : 'login') }}>
          {modo === 'login' ? 'Não tenho acesso? Solicitar cadastro' : 'Já tenho cadastro — Entrar'}
        </div>
        </div>
      </div>
    </div>
  )
}

// ─── SEÇÃO USUÁRIOS NO CONFIG (só admin) ──────────────────────────────────────

function SecaoUsuarios() {
  const [usuarios, setUsuarios] = useState([])

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'usuarios'), s => {
      setUsuarios(s.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return unsub
  }, [])

  const aprovar = async (id) => await updateDoc(doc(db, 'usuarios', id), { status: 'aprovado' })
  const rejeitar = async (id) => await updateDoc(doc(db, 'usuarios', id), { status: 'rejeitado' })
  const tornarAdmin = async (id) => await updateDoc(doc(db, 'usuarios', id), { role: 'admin' })
  const remover = async (id) => { if (confirm('Remover usuário?')) await deleteDoc(doc(db, 'usuarios', id)) }

  const pendentes = usuarios.filter(u => u.status === 'pendente')
  const aprovados = usuarios.filter(u => u.status === 'aprovado')
  const rejeitados = usuarios.filter(u => u.status === 'rejeitado')

  return (
    <div style={S.card}>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>👥 Usuários do Sistema</div>

      {pendentes.length > 0 && <>
        <div style={{ fontSize: 12, color: '#f59e0b', fontWeight: 700, marginBottom: 6 }}>⏳ Aguardando aprovação ({pendentes.length})</div>
        {pendentes.map(u => (
          <div key={u.id} style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 12px', marginBottom: 8 }}>
            <div style={{ fontWeight: 600 }}>{u.nome}</div>
            <div style={{ fontSize: 12, color: '#92400e' }}>@{u.usuario}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button onClick={() => aprovar(u.id)} style={{ ...S.btn('#22c55e'), fontSize: 12, padding: '6px 10px' }}>✓ Aprovar</button>
              <button onClick={() => rejeitar(u.id)} style={{ ...S.btn('#ef4444'), fontSize: 12, padding: '6px 10px' }}>✕ Rejeitar</button>
            </div>
          </div>
        ))}
      </>}

      {aprovados.length > 0 && <>
        <div style={{ fontSize: 12, color: '#22c55e', fontWeight: 700, marginBottom: 6, marginTop: 8 }}>✓ Aprovados ({aprovados.length})</div>
        {aprovados.map(u => (
          <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f0e8d8' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{u.nome}</div>
              <div style={{ fontSize: 11, color: '#8a7355' }}>@{u.usuario} · {u.role === 'admin' ? '👑 Admin' : 'Operador'}</div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {u.role !== 'admin' && <button onClick={() => tornarAdmin(u.id)} style={{ background: 'none', border: '1px solid #c9a96e', borderRadius: 6, padding: '3px 8px', fontSize: 10, color: '#c9a96e', cursor: 'pointer' }}>👑</button>}
              <button onClick={() => remover(u.id)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: 16, cursor: 'pointer' }}>🗑</button>
            </div>
          </div>
        ))}
      </>}

      {rejeitados.length > 0 && <>
        <div style={{ fontSize: 12, color: '#ef4444', fontWeight: 700, marginBottom: 6, marginTop: 8 }}>✕ Rejeitados ({rejeitados.length})</div>
        {rejeitados.map(u => (
          <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0' }}>
            <div style={{ fontSize: 13, color: '#999' }}>{u.nome} (@{u.usuario})</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => aprovar(u.id)} style={{ background: 'none', border: '1px solid #22c55e', borderRadius: 6, padding: '3px 8px', fontSize: 10, color: '#22c55e', cursor: 'pointer' }}>Aprovar</button>
              <button onClick={() => remover(u.id)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: 16, cursor: 'pointer' }}>🗑</button>
            </div>
          </div>
        ))}
      </>}
    </div>
  )
}


// ─── RELATÓRIO DE SAÍDAS DO DIA (PDF) ────────────────────────────────────────

function exportarRelatorioDiaPDF(extrasDia, valesDia, pessoas, setores, config, data) {
  const DIAS2 = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb']
  const dl = (d) => { if (!d) return ''; const [y,m,dd] = d.split('-'); const dt = new Date(Number(y),Number(m)-1,Number(dd)); return DIAS2[dt.getDay()]+' '+String(dt.getDate()).padStart(2,'0')+'/'+String(dt.getMonth()+1).padStart(2,'0') }
  const fmt2 = (c) => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format((c||0)/100)
  const nomeEstab = config?.nome_estabelecimento || 'ARACÁ GRILL'
  const dataLabel = dl(data)

  const totalExtras = extrasDia.reduce((a,e) => a+(e.valor_final||0), 0)
  const totalValesVal = valesDia.reduce((a,v) => a+(v.valor||0), 0)
  const totalGeral = totalExtras + totalValesVal
  const totalDin = [...extrasDia.filter(e=>e.forma_pagamento==='dinheiro').map(e=>e.valor_final||0), ...valesDia.filter(v=>v.forma_pagamento==='dinheiro').map(v=>v.valor||0)].reduce((a,x)=>a+x,0)
  const totalPix = [...extrasDia.filter(e=>e.forma_pagamento==='pix').map(e=>e.valor_final||0), ...valesDia.filter(v=>v.forma_pagamento==='pix').map(v=>v.valor||0)].reduce((a,x)=>a+x,0)

  const linhasExtras = extrasDia.map(e => {
    const s = setores.find(x => x.id === e.setor_id)
    return `<tr><td><strong>${e.nome}</strong><br><span class="sub">${e.funcao||''} ${e.turnos||''}</span></td><td>${s?.nome||'—'}</td><td class="${e.forma_pagamento==='pix'?'pix':'din'}">${fmt2(e.valor_final)}</td><td>${e.forma_pagamento==='pix'?'Pix':'Dinheiro'}</td></tr>`
  }).join('')

  const linhasVales = valesDia.map(v => {
    const s = setores.find(x => x.id === v.setor_id)
    return `<tr class="vale-row"><td><strong>${v.nome}</strong><br><span class="sub">${v.funcao||''}</span></td><td>${s?.nome||'—'}</td><td class="vale-val">${fmt2(v.valor)}</td><td>${v.forma_pagamento==='pix'?'Pix':'Dinheiro'}</td></tr>`
  }).join('')

  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <title>${nomeEstab} — Saídas ${dataLabel}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;color:#18181b;background:#fff;padding:20px}
    .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;padding-bottom:12px;border-bottom:3px solid #b5763a}
    .logo{font-size:24px;font-weight:900;color:#b5763a}.subtitle{font-size:13px;color:#6b6360;margin-top:4px}
    .meta{text-align:right;font-size:11px;color:#6b6360;line-height:1.6}
    .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
    .card{background:#f7f6f3;border-radius:10px;padding:12px;border:1px solid #e4ddd4;text-align:center}
    .card-label{font-size:10px;font-weight:700;color:#6b6360;text-transform:uppercase;margin-bottom:4px}
    .card-value{font-size:18px;font-weight:900}
    .card.total{background:#1c1917}.card.total .card-label{color:#ffffff80}.card.total .card-value{color:#c9a96e}
    .card.ext .card-value{color:#b5763a}.card.val .card-value{color:#9a7520}.card.din .card-value{color:#2e6b47}
    h2{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;margin:14px 0 8px;padding-bottom:4px;border-bottom:2px solid #e4ddd4}
    h2.eh{border-color:#b5763a;color:#b5763a}h2.vh{border-color:#c9a96e;color:#9a7520}
    table{width:100%;border-collapse:collapse;margin-bottom:8px}
    th{background:#1c1917;color:#fff;font-size:10px;font-weight:700;text-transform:uppercase;padding:7px 10px;text-align:left}
    td{padding:6px 10px;border-bottom:1px solid #f0ede8;font-size:11px;vertical-align:top}
    tr:nth-child(even) td{background:#fafaf9}.vale-row td{background:#fffbeb!important}
    .sub{font-size:10px;color:#6b6360}.pix{color:#3d6b8a;font-weight:700}.din{color:#2e6b47;font-weight:700}.vale-val{color:#9a7520;font-weight:700}
    .subtotal{text-align:right;font-size:12px;font-weight:700;margin-bottom:12px;padding:6px 10px;background:#f7f6f3;border-radius:6px}
    .rodape-total{background:#1c1917;border-radius:10px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;margin-top:8px}
    .footer{margin-top:16px;padding-top:10px;border-top:1px solid #e4ddd4;font-size:10px;color:#a8a09a;text-align:center}
    @media print{body{padding:8px}@page{margin:10mm;size:A4}}
  </style></head><body>
  <div class="header">
    <div><div class="logo">🔥 ${nomeEstab}</div><div class="subtitle">Relatório de Saídas · ${dataLabel}</div></div>
    <div class="meta">Gerado em: ${new Date().toLocaleString('pt-BR')}<br>Extras: ${extrasDia.length} · Vales: ${valesDia.length}</div>
  </div>
  <div class="cards">
    <div class="card total"><div class="card-label">Total Saídas</div><div class="card-value">${fmt2(totalGeral)}</div></div>
    <div class="card ext"><div class="card-label">💼 Extras</div><div class="card-value">${fmt2(totalExtras)}</div></div>
    <div class="card val"><div class="card-label">💸 Vales</div><div class="card-value">${fmt2(totalValesVal)}</div></div>
    <div class="card din"><div class="card-label">💵 Dinheiro</div><div class="card-value">${fmt2(totalDin)}</div></div>
  </div>
  ${extrasDia.length > 0 ? `<h2 class="eh">💼 Pagamentos de Extras (${extrasDia.length})</h2><table><thead><tr><th>Profissional</th><th>Setor</th><th>Valor</th><th>Forma</th></tr></thead><tbody>${linhasExtras}</tbody></table><div class="subtotal" style="color:#b5763a">Subtotal extras: ${fmt2(totalExtras)}</div>` : '<p style="color:#999;font-size:12px;margin-bottom:12px">Nenhum pagamento de extra nesta data.</p>'}
  ${valesDia.length > 0 ? `<h2 class="vh">💸 Vales (${valesDia.length})</h2><table><thead><tr><th>Funcionário</th><th>Setor</th><th>Valor</th><th>Forma</th></tr></thead><tbody>${linhasVales}</tbody></table><div class="subtotal" style="color:#9a7520">Subtotal vales: ${fmt2(totalValesVal)}</div>` : '<p style="color:#999;font-size:12px;margin-bottom:12px">Nenhum vale nesta data.</p>'}
  <div class="rodape-total">
    <div style="font-size:13px;font-weight:700;color:#ffffff80">TOTAL DE SAÍDAS — ${dataLabel}</div>
    <div style="font-size:24px;font-weight:900;color:#c9a96e">${fmt2(totalGeral)}</div>
  </div>
  <div class="footer">${nomeEstab} · Sistema Operacional · ${new Date().getFullYear()}</div>
  <script>window.onload=()=>window.print()<\/script>
  </body></html>`

  const w = window.open('', '_blank', 'width=900,height=700')
  w.document.write(html)
  w.document.close()
}

// ─── ABA VALES ────────────────────────────────────────────────────────────────

function TabVales({ store, today, setModal }) {
  const { vales, despesas, extras, pessoas, setores, updateVale, removeVale, updateDespesa, removeDespesa, config } = store
  const [subTela, setSubTela] = useState('lista')
  const [filtro, setFiltro] = useState('hoje')
  const [dataInicio, setDataInicio] = useState(today)
  const [dataFim, setDataFim] = useState(today)
  const [modoPesquisa, setModoPesquisa] = useState('pessoa')
  const [buscaPessoa, setBuscaPessoa] = useState('')
  const [pessoaSel, setPessoaSel] = useState(null)
  const [dataPesquisa, setDataPesquisa] = useState(today)
  const [dataRelatorio, setDataRelatorio] = useState(today)
  const [copied, setCopied] = useState({})
  const [fotoModal, setFotoModal] = useState(null)
  const [despDe, setDespDe] = useState(today.slice(0,7)+'-01')
  const [despAte, setDespAte] = useState(today)
  const [despCategoria, setDespCategoria] = useState('')

  const ontem = toDateStr(new Date(new Date(today + 'T12:00:00').getTime() - 86400000))
  const weekStart = toDateStr(new Date(new Date(today + 'T12:00:00').setDate(new Date(today + 'T12:00:00').getDate() - 6)))
  const monthStart = today.slice(0, 7) + '-01'
  const ranges = { hoje: [today, today], ontem: [ontem, ontem], semana: [weekStart, today], mes: [monthStart, today], livre: [dataInicio, dataFim] }
  const [from, to] = ranges[filtro] || [today, today]

  const valesFiltrados = useMemo(() =>
    vales.filter(v => v.data_op >= from && v.data_op <= to)
      .sort((a, b) => b.data_op.localeCompare(a.data_op) || a.nome.localeCompare(b.nome)),
    [vales, from, to]
  )
  const totalVales = useMemo(() => valesFiltrados.reduce((a, v) => a + v.valor, 0), [valesFiltrados])
  const totalDinLista = useMemo(() => valesFiltrados.filter(v => v.forma_pagamento === 'dinheiro').reduce((a, v) => a + v.valor, 0), [valesFiltrados])
  const totalPixLista = useMemo(() => valesFiltrados.filter(v => v.forma_pagamento === 'pix').reduce((a, v) => a + v.valor, 0), [valesFiltrados])

  // Agrupado por pessoa (todos os vales)
  const porPessoa = useMemo(() => {
    const map = {}
    vales.forEach(v => {
      const key = v.pessoa_id || v.nome
      if (!map[key]) map[key] = { pessoa_id: v.pessoa_id, nome: v.nome, funcao: v.funcao, vales: [], total: 0 }
      map[key].vales.push(v)
      map[key].total += v.valor
    })
    return Object.values(map).sort((a, b) => b.total - a.total)
  }, [vales])

  const sugestoesPessoa = useMemo(() => {
    if (!buscaPessoa.trim()) return []
    return porPessoa.filter(p => p.nome.toLowerCase().includes(buscaPessoa.toLowerCase())).slice(0, 6)
  }, [buscaPessoa, porPessoa])

  const valesDaData = useMemo(() =>
    vales.filter(v => v.data_op === dataPesquisa).sort((a, b) => a.nome.localeCompare(b.nome)),
    [vales, dataPesquisa]
  )
  const totalDaData = useMemo(() => valesDaData.reduce((a, v) => a + v.valor, 0), [valesDaData])

  const getText = (v) => `VALE ${v.nome} ${v.funcao || ''}`
  const copy = async (v) => {
    try { await navigator.clipboard.writeText(getText(v)) } catch {}
    setCopied(p => ({ ...p, [v.id]: true }))
    setTimeout(() => setCopied(p => ({ ...p, [v.id]: false })), 2000)
  }

  // Card reutilizável para cada vale
  const CardVale = ({ v }) => {
    const setor = setores.find(s => s.id === v.setor_id)
    return (
      <div style={S.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{v.nome}</div>
            <div style={{ fontSize: 13, color: '#8a7355' }}>{v.funcao}{setor ? ' · ' + setor.nome : ''}</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{dayLabel(v.data_op)}</div>
            {v.obs && <div style={{ fontSize: 12, color: '#aaa', marginTop: 2 }}>{v.obs}</div>}
            <div style={{ marginTop: 6 }}>
              <Badge color={v.forma_pagamento === 'pix' ? C.secondary : C.success}>
                {v.forma_pagamento === 'pix' ? '📱 Pix' : '💵 Dinheiro'}
              </Badge>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: C.gold }}>{fmt(v.valor)}</div>
            {v.lancado ? <Badge color={C.success}>✓ Lançado</Badge> : <Badge color="#f59e0b">Não lançado</Badge>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          <button onClick={() => copy(v)}
            style={{ ...S.btn(copied[v.id] ? '#22c55e' : C.gold, !copied[v.id]), flex: 'none', padding: '8px 14px' }}>
            {copied[v.id] ? '✓' : '📋'}
          </button>
          <button onClick={() => updateVale(v.id, { lancado: !v.lancado })}
            style={{ ...S.btn(v.lancado ? '#22c55e' : '#e0d5c5'), flex: 'none', padding: '8px 14px', color: v.lancado ? '#fff' : '#666' }}>
            {v.lancado ? '✓' : '○'}
          </button>
          <button onClick={() => { if (confirm('Remover vale de ' + v.nome + '?')) removeVale(v.id) }}
            style={{ background: 'none', border: '1px solid #f0e8d8', borderRadius: 12, padding: '8px 14px', fontSize: 13, color: '#ef4444', cursor: 'pointer' }}>
            🗑
          </button>
        </div>
        {v.assinatura && <img src={v.assinatura} alt="Ass." style={{ maxHeight: 36, marginTop: 8, border: '1px solid #e0d5c5', borderRadius: 4 }} />}
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button onClick={() => setModal({ type: 'addVale' })} style={{ ...S.btn(C.gold), flex: 1 }}>💸 Novo Vale</button>
        <button onClick={() => setModal({ type: 'addDespesa' })} style={{ ...S.btn(C.accent), flex: 1 }}>🧾 Novo Lançamento</button>
      </div>

      {/* Sub-navegação */}
      <div style={{ display: 'flex', gap: 4, background: '#f0e8d8', padding: 4, borderRadius: 12, marginBottom: 14 }}>
        {[['lista','📋 Lista'],['pesquisa','🔍 Pesquisa']].map(([id, label]) => (
          <button key={id} onClick={() => setSubTela(id)}
            style={{ flex: 1, padding: '8px 2px', border: 'none', borderRadius: 8, background: subTela === id ? '#fff' : 'transparent', cursor: 'pointer', fontSize: 11, fontWeight: subTela === id ? 700 : 400, color: subTela === id ? C.gold : '#999' }}>
            {label}
          </button>
        ))}
      </div>

      {/* ─── LISTA ─── */}
      {subTela === 'lista' && <>
        {(() => {
          const despesasFiltradas = (despesas||[]).filter(d => d.data_op >= from && d.data_op <= to)
            .sort((a,b) => b.data_op.localeCompare(a.data_op))
          const totalDespesas = despesasFiltradas.reduce((a,d) => a+d.valor, 0)
          const totalGeral = totalVales + totalDespesas
          return (<>
            <div style={{ ...S.card, background: 'linear-gradient(135deg,#1a1200,#2d2000)', color: '#fff' }}>
              <div style={{ fontSize: 11, color: '#c9a96e', textTransform: 'uppercase' }}>Total Saídas</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#c9a96e' }}>{fmt(totalGeral)}</div>
              <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
                <div style={{ fontSize: 12, color: '#ffffff80' }}>💸 Vales: {fmt(totalVales)}</div>
                <div style={{ fontSize: 12, color: '#ffffff80' }}>🧾 Despesas: {fmt(totalDespesas)}</div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
              {[['hoje','Hoje'],['ontem','Ontem'],['semana','7 dias'],['mes','Mês'],['livre','Livre']].map(([id, label]) => (
                <button key={id} onClick={() => setFiltro(id)}
                  style={{ padding: '6px 12px', border: `2px solid ${filtro === id ? C.gold : C.border}`, borderRadius: 20, background: filtro === id ? C.gold : C.bgCard, color: filtro === id ? '#fff' : C.textMuted, fontSize: 12, fontWeight: filtro === id ? 700 : 400, cursor: 'pointer' }}>
                  {label}
                </button>
              ))}
            </div>

            {filtro === 'livre' && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <div style={{ flex: 1 }}><label style={S.label}>De</label><input type="date" value={dataInicio} onChange={e => setDataInicio(e.target.value)} style={S.input} /></div>
                <div style={{ flex: 1 }}><label style={S.label}>Até</label><input type="date" value={dataFim} onChange={e => setDataFim(e.target.value)} style={S.input} /></div>
              </div>
            )}

            {/* Vales */}
            {valesFiltrados.length > 0 && <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <div style={{ flex: 1, height: 1, background: C.gold + '44' }} />
                <span style={{ fontSize: 11, color: C.gold, fontWeight: 800, textTransform: 'uppercase' }}>Vales ({valesFiltrados.length})</span>
                <div style={{ flex: 1, height: 1, background: C.gold + '44' }} />
              </div>
              {valesFiltrados.map(v => <CardVale key={v.id} v={v} />)}
            </>}

            {/* Despesas */}
            {despesasFiltradas.length > 0 && <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, marginTop: valesFiltrados.length > 0 ? 8 : 0 }}>
                <div style={{ flex: 1, height: 1, background: C.accent + '44' }} />
                <span style={{ fontSize: 11, color: C.accent, fontWeight: 800, textTransform: 'uppercase' }}>Lançamentos ({despesasFiltradas.length})</span>
                <div style={{ flex: 1, height: 1, background: C.accent + '44' }} />
              </div>
              {despesasFiltradas.map(d => {
                const setor = setores.find(s => s.id === d.setor_id)
                return (
                  <div key={d.id} style={{ ...S.card, borderColor: C.accent + '44' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                          <span style={{ fontSize: 16 }}>{d.categoria_emoji}</span>
                          <span style={{ fontSize: 11, color: C.accent, fontWeight: 700 }}>{d.categoria_nome}</span>
                          <span style={{ fontSize: 11, color: C.textMuted }}>· {dayLabel(d.data_op)}</span>
                        </div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{d.descricao}</div>
                        {setor && <div style={{ fontSize: 12, color: C.textMuted }}>{setor.nome}</div>}
                        {!d.foto && d.obs && <div style={{ fontSize: 11, color: C.gold, marginTop: 2, fontStyle: 'italic' }}>⚠ {d.obs}</div>}
                        {d.foto && d.obs && <div style={{ fontSize: 11, color: '#aaa', marginTop: 2 }}>{d.obs}</div>}
                        <div style={{ marginTop: 6 }}>
                          <Badge color={d.forma_pagamento === 'pix' ? C.secondary : C.success}>
                            {d.forma_pagamento === 'pix' ? '📱 Pix' : '💵 Dinheiro'}
                          </Badge>
                        </div>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontSize: 20, fontWeight: 700, color: C.accent }}>{fmt(d.valor)}</div>
                        {d.lancado ? <Badge color={C.success}>✓ Lançado</Badge> : <Badge color="#f59e0b">Não lançado</Badge>}
                      </div>
                    </div>
                    {d.foto && (
                      <img src={d.foto} alt="Nota" onClick={() => window.open(d.foto,'_blank')}
                        style={{ maxHeight: 60, marginTop: 8, border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer' }} />
                    )}
                    <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                      <button onClick={() => updateDespesa(d.id, { lancado: !d.lancado })}
                        style={{ ...S.btn(d.lancado ? '#22c55e' : '#e0d5c5'), flex: 'none', padding: '8px 14px', color: d.lancado ? '#fff' : '#666' }}>
                        {d.lancado ? '✓' : '○'}
                      </button>
                      <button onClick={() => { if (confirm('Excluir lançamento "' + d.descricao + '"?')) removeDespesa(d.id) }}
                        style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 12, padding: '8px 14px', fontSize: 13, color: '#ef4444', cursor: 'pointer' }}>
                        🗑
                      </button>
                    </div>
                  </div>
                )
              })}
            </>}

            {valesFiltrados.length === 0 && despesasFiltradas.length === 0 && (
              <div style={{ ...S.card, textAlign: 'center', padding: 32, color: '#999' }}>
                <div style={{ fontSize: 40 }}>💸</div><div>Nenhuma saída no período</div>
              </div>
            )}
          </>)
        })()}
      </>}

      {/* ─── PESQUISA ─── */}
      {subTela === 'pesquisa' && <>
        <div style={{ display: 'flex', gap: 4, background: '#f0e8d8', padding: 4, borderRadius: 10, marginBottom: 14 }}>
          {[['pessoa','👤 Por Pessoa'],['data','📅 Por Data'],['despesas','🧾 Despesas']].map(([id, label]) => (
            <button key={id} onClick={() => { setModoPesquisa(id); setPessoaSel(null); setBuscaPessoa('') }}
              style={{ flex: 1, padding: '8px', border: 'none', borderRadius: 8, background: modoPesquisa === id ? '#fff' : 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: modoPesquisa === id ? 700 : 400, color: modoPesquisa === id ? C.gold : '#999' }}>
              {label}
            </button>
          ))}
        </div>

        {/* Por pessoa */}
        {modoPesquisa === 'pessoa' && (
          <div>
            {!pessoaSel && (
              <div style={{ position: 'relative', marginBottom: 12 }}>
                <input
                  value={buscaPessoa}
                  onChange={e => setBuscaPessoa(e.target.value)}
                  style={S.input}
                  placeholder="Buscar funcionário pelo nome..."
                />
                {sugestoesPessoa.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: C.bgCard2, border: `1px solid ${C.border}`, borderRadius: 10, zIndex: 50, overflow: 'hidden', marginTop: 4 }}>
                    {sugestoesPessoa.map((p, i) => (
                      <div key={i} onClick={() => { setPessoaSel(p); setBuscaPessoa('') }}
                        style={{ padding: '10px 14px', cursor: 'pointer', borderBottom: `1px solid ${C.border}` }}>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>{p.nome}</div>
                        <div style={{ fontSize: 11, color: C.textMuted }}>{p.funcao} · {p.vales.length} vale{p.vales.length !== 1 ? 's' : ''} · {fmt(p.total)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Ranking geral quando não há busca */}
            {!pessoaSel && !buscaPessoa && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Todos com vale registrado
                </div>
                {porPessoa.length === 0 && (
                  <div style={{ ...S.card, textAlign: 'center', padding: 24, color: '#999' }}>Nenhum vale registrado ainda</div>
                )}
                {porPessoa.map((p, i) => (
                  <div key={i} onClick={() => setPessoaSel(p)} style={{ ...S.card, cursor: 'pointer', marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 15 }}>{p.nome}</div>
                        <div style={{ fontSize: 12, color: C.textMuted }}>{p.funcao} · {p.vales.length} vale{p.vales.length !== 1 ? 's' : ''}</div>
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                          {[...new Set(p.vales.map(v => dayLabel(v.data_op)))].slice(0, 3).join(' · ')}
                          {p.vales.length > 3 && ` +${p.vales.length - 3} dias`}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 18, fontWeight: 700, color: C.gold }}>{fmt(p.total)}</div>
                        <div style={{ fontSize: 10, color: C.secondary }}>Ver detalhes →</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Detalhe da pessoa selecionada */}
            {pessoaSel && (
              <div>
                <div style={{ ...S.card, background: 'linear-gradient(135deg,#1a1200,#2d2000)', color: '#fff', marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 800, color: '#c9a96e' }}>{pessoaSel.nome}</div>
                      <div style={{ fontSize: 12, color: '#ffffff80' }}>{pessoaSel.funcao}</div>
                      <div style={{ fontSize: 11, color: '#ffffff50', marginTop: 4 }}>
                        {pessoaSel.vales.length} vale{pessoaSel.vales.length !== 1 ? 's' : ''} registrados
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 24, fontWeight: 700, color: '#c9a96e' }}>{fmt(pessoaSel.total)}</div>
                      <button onClick={() => setPessoaSel(null)}
                        style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', fontSize: 11, cursor: 'pointer', marginTop: 4 }}>
                        ✕ Voltar
                      </button>
                    </div>
                  </div>
                </div>
                {pessoaSel.vales.sort((a,b) => b.data_op.localeCompare(a.data_op)).map(v => <CardVale key={v.id} v={v} />)}
              </div>
            )}
          </div>
        )}

        {/* Por data */}
        {modoPesquisa === 'data' && (
          <div>
            <div style={{ marginBottom: 12 }}>
              <label style={S.label}>Selecionar data</label>
              <input type="date" value={dataPesquisa} onChange={e => setDataPesquisa(e.target.value)} style={S.input} />
            </div>
            <div style={{ ...S.card, background: 'linear-gradient(135deg,#1a1200,#2d2000)', color: '#fff', marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: '#c9a96e', textTransform: 'uppercase' }}>{dayLabel(dataPesquisa)}</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: '#c9a96e' }}>{fmt(totalDaData)}</div>
              <div style={{ fontSize: 12, color: '#ffffff80' }}>{valesDaData.length} vale{valesDaData.length !== 1 ? 's' : ''}</div>
            </div>
            {valesDaData.length === 0 && (
              <div style={{ ...S.card, textAlign: 'center', padding: 24, color: '#999' }}>
                <div style={{ fontSize: 32 }}>💸</div><div>Nenhum vale em {dayLabel(dataPesquisa)}</div>
              </div>
            )}
            {valesDaData.map(v => <CardVale key={v.id} v={v} />)}
          </div>
        )}

        {/* DESPESAS */}
        {modoPesquisa === 'despesas' && (() => {
          const cats = [...new Set((despesas||[]).map(d => d.categoria_nome).filter(Boolean))]
          const despFiltradas = (despesas||[])
            .filter(d => d.data_op >= despDe && d.data_op <= despAte)
            .filter(d => !despCategoria || d.categoria_nome === despCategoria)
            .sort((a,b) => b.data_op.localeCompare(a.data_op))
          const totalDesp = despFiltradas.reduce((a,d) => a+d.valor, 0)

          return (
            <div>
              {fotoModal && (
                <div onClick={() => setFotoModal(null)}
                  style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', padding: 16 }}>
                  <img src={fotoModal} alt="Nota fiscal" style={{ maxWidth: '100%', maxHeight: '82vh', borderRadius: 8, objectFit: 'contain' }} />
                  <div style={{ color: '#ffffff80', fontSize: 12, marginTop: 12 }}>Toque para fechar</div>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={S.label}>De</label>
                  <input type="date" value={despDe} onChange={e => setDespDe(e.target.value)} style={S.input} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={S.label}>Até</label>
                  <input type="date" value={despAte} max={today} onChange={e => setDespAte(e.target.value)} style={S.input} />
                </div>
              </div>

              {cats.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <label style={S.label}>Filtrar categoria</label>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <button onClick={() => setDespCategoria('')}
                      style={{ padding: '5px 10px', border: `2px solid ${!despCategoria ? C.accent : C.border}`, borderRadius: 16, background: !despCategoria ? C.accent : C.bgCard2, color: !despCategoria ? '#fff' : C.textMuted, fontSize: 11, fontWeight: !despCategoria ? 700 : 400, cursor: 'pointer' }}>
                      Todas
                    </button>
                    {cats.map(cat => (
                      <button key={cat} onClick={() => setDespCategoria(cat === despCategoria ? '' : cat)}
                        style={{ padding: '5px 10px', border: `2px solid ${despCategoria===cat ? C.accent : C.border}`, borderRadius: 16, background: despCategoria===cat ? C.accent : C.bgCard2, color: despCategoria===cat ? '#fff' : C.textMuted, fontSize: 11, fontWeight: despCategoria===cat ? 700 : 400, cursor: 'pointer' }}>
                        {cat}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ ...S.card, background: 'linear-gradient(135deg,#0d0020,#1a0035)', color: '#fff', marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: '#a78bfa', textTransform: 'uppercase' }}>Total Despesas</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#a78bfa' }}>{fmt(totalDesp)}</div>
                <div style={{ fontSize: 12, color: '#ffffff60' }}>{despFiltradas.length} lançamento{despFiltradas.length!==1?'s':''}</div>
              </div>

              {despFiltradas.length === 0 && (
                <div style={{ ...S.card, textAlign: 'center', padding: 24, color: '#999' }}>
                  <div style={{ fontSize: 32 }}>🧾</div><div>Nenhuma despesa no período</div>
                </div>
              )}

              {despFiltradas.map(d => {
                const setor = setores.find(s => s.id === d.setor_id)
                return (
                  <div key={d.id} style={{ ...S.card, borderColor: C.accent + '44' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                          <span style={{ fontSize: 16 }}>{d.categoria_emoji}</span>
                          <span style={{ fontSize: 11, color: C.accent, fontWeight: 700 }}>{d.categoria_nome}</span>
                          <span style={{ fontSize: 11, color: C.textMuted }}>· {dayLabel(d.data_op)}</span>
                        </div>
                        <div style={{ fontSize: 14, fontWeight: 700 }}>{d.descricao}</div>
                        {setor && <div style={{ fontSize: 12, color: C.textMuted }}>{setor.nome}</div>}
                        {d.obs && <div style={{ fontSize: 11, color: d.foto ? '#aaa' : C.gold, marginTop: 2, fontStyle: 'italic' }}>{d.foto ? d.obs : '⚠ '+d.obs}</div>}
                        <div style={{ marginTop: 6 }}>
                          <Badge color={d.forma_pagamento==='pix'?C.secondary:C.success}>
                            {d.forma_pagamento==='pix'?'📱 Pix':'💵 Dinheiro'}
                          </Badge>
                        </div>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontSize: 18, fontWeight: 700, color: C.accent }}>{fmt(d.valor)}</div>
                        {d.foto
                          ? <button onClick={() => setFotoModal(d.foto)}
                              style={{ marginTop: 4, background: C.accent+'22', border: `1px solid ${C.accent}44`, borderRadius: 8, padding: '4px 10px', fontSize: 11, color: C.accent, cursor: 'pointer', fontWeight: 700 }}>
                              🖼 Ver nota
                            </button>
                          : <div style={{ fontSize: 10, color: C.gold, marginTop: 4 }}>Sem nota</div>
                        }
                      </div>
                    </div>
                    {d.foto && (
                      <img src={d.foto} alt="Nota" onClick={() => setFotoModal(d.foto)}
                        style={{ maxHeight: 60, marginTop: 8, border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'zoom-in', display: 'block' }} />
                    )}
                  </div>
                )
              })}
            </div>
          )
        })()}
      </>}

      {/* ─── RELATÓRIO ─── */}
    </div>
  )
}

// ─── RELATÓRIO DE VALES ───────────────────────────────────────────────────────

function exportarRelatorioValesPDF(agrupado, from, to, modo, config) {
  const DIAS2 = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb']
  const dl = (d) => { if (!d) return ''; const [y,m,dd] = d.split('-'); const dt = new Date(Number(y),Number(m)-1,Number(dd)); return DIAS2[dt.getDay()]+' '+String(dt.getDate()).padStart(2,'0')+'/'+String(dt.getMonth()+1).padStart(2,'0') }
  const fmt2 = (c) => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format((c||0)/100)
  const nomeEstab = config?.nome_estabelecimento || 'ARACÁ GRILL'
  const periodo = from === to ? dl(from) : `${dl(from)} a ${dl(to)}`
  const totalGeral = agrupado.reduce((a,p) => a+p.total, 0)
  const totalQtd   = agrupado.reduce((a,p) => a+p.vales.length, 0)

  const linhasPessoas = agrupado.map(p => {
    const resumo = `<tr>
      <td><strong>${p.nome}</strong><br><small>${p.funcao||''}</small></td>
      <td style="text-align:center">${p.vales.length}</td>
      <td style="text-align:right;font-weight:700;color:#9a7520">${fmt2(p.total)}</td>
    </tr>`

    if (modo === 'resumido') return resumo

    const detalhes = p.vales.sort((a,b)=>b.data_op.localeCompare(a.data_op)).map(v => `
      <tr style="background:#fffbeb">
        <td style="padding-left:24px;font-size:10px;color:#6b6360">${dl(v.data_op)}</td>
        <td style="font-size:10px;color:#6b6360">${v.forma_pagamento==='pix'?'📱 Pix':'💵 Dinheiro'}${v.obs?' · '+v.obs:''}</td>
        <td style="text-align:right;font-size:10px;color:#9a7520">${fmt2(v.valor)}</td>
      </tr>`).join('')

    return resumo + detalhes
  }).join('')

  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <title>${nomeEstab} — Vales ${periodo}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;color:#18181b;padding:16px}
    .header{display:flex;justify-content:space-between;margin-bottom:14px;padding-bottom:10px;border-bottom:3px solid #9a7520}
    .logo{font-size:20px;font-weight:900;color:#9a7520}.sub{font-size:12px;color:#6b6360;margin-top:3px}
    .meta{text-align:right;font-size:10px;color:#6b6360;line-height:1.7}
    .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px}
    .card{background:#f7f6f3;border-radius:8px;padding:10px;text-align:center;border:1px solid #e4ddd4}
    .cl{font-size:9px;font-weight:700;color:#6b6360;text-transform:uppercase;margin-bottom:2px}
    .cv{font-size:18px;font-weight:900}
    .card.tot{background:#1a1200}.card.tot .cl{color:#c9a96e80}.card.tot .cv{color:#c9a96e}
    .card.qtd .cv{color:#9a7520}.card.pes .cv{color:#5c4d8a}
    table{width:100%;border-collapse:collapse;margin-bottom:6px}
    thead tr{background:#1c1917}
    th{color:#fff;font-size:9px;font-weight:700;text-transform:uppercase;padding:6px 10px;text-align:left}
    td{padding:6px 10px;border-bottom:1px solid #f0ede8;vertical-align:top}
    tr:nth-child(even) td{background:#fafaf9}
    small{font-size:9px;color:#6b6360}
    .rodape{background:#1c1917;border-radius:8px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;margin-top:12px}
    .footer{margin-top:10px;padding-top:8px;border-top:1px solid #e4ddd4;font-size:9px;color:#a8a09a;text-align:center}
    @media print{body{padding:6px}@page{margin:8mm;size:A4}}
  </style></head><body>
  <div class="header">
    <div>
      <div class="logo">💸 ${nomeEstab}</div>
      <div class="sub">Relatório de Vales · ${periodo} · ${modo === 'detalhado' ? 'Detalhado' : 'Resumido'}</div>
    </div>
    <div class="meta">Gerado em: ${new Date().toLocaleString('pt-BR')}<br>${agrupado.length} funcionário${agrupado.length!==1?'s':''} · ${totalQtd} vale${totalQtd!==1?'s':''}</div>
  </div>
  <div class="cards">
    <div class="card tot"><div class="cl">Total Vales</div><div class="cv">${fmt2(totalGeral)}</div></div>
    <div class="card qtd"><div class="cl">Quantidade</div><div class="cv">${totalQtd}</div></div>
    <div class="card pes"><div class="cl">Funcionários</div><div class="cv">${agrupado.length}</div></div>
  </div>
  <table>
    <thead><tr>
      <th>Funcionário</th>
      <th style="text-align:center">Qtd</th>
      <th style="text-align:right">Total</th>
    </tr></thead>
    <tbody>${linhasPessoas}</tbody>
  </table>
  <div class="rodape">
    <div style="font-size:11px;font-weight:700;color:#ffffff80">TOTAL — ${periodo}</div>
    <div style="font-size:20px;font-weight:900;color:#c9a96e">${fmt2(totalGeral)}</div>
  </div>
  <div class="footer">${nomeEstab} · Sistema Operacional · ${new Date().getFullYear()}</div>
  <script>window.onload=()=>window.print()<\/script>
  </body></html>`

  const w = window.open('','_blank','width=900,height=700')
  w.document.write(html); w.document.close()
}

function RelatorioVales({ vales, setores, config, today }) {
  const [de, setDe] = useState(today.slice(0,7) + '-01')
  const [ate, setAte] = useState(today)
  const [modo, setModo] = useState('resumido')

  const agrupado = useMemo(() => {
    const filtrados = (vales||[]).filter(v => v.data_op >= de && v.data_op <= ate)
    const map = {}
    filtrados.forEach(v => {
      const key = v.pessoa_id || v.nome
      if (!map[key]) map[key] = { nome: v.nome, funcao: v.funcao||'', vales: [], total: 0 }
      map[key].vales.push(v)
      map[key].total += v.valor
    })
    return Object.values(map).sort((a,b) => b.total - a.total)
  }, [vales, de, ate])

  const totalGeral = agrupado.reduce((a,p) => a+p.total, 0)
  const totalQtd   = agrupado.reduce((a,p) => a+p.vales.length, 0)

  return (
    <div>
      {/* Período */}
      <div style={S.card}>
        <div style={{ fontSize: 13, fontWeight: 800, color: C.text, marginBottom: 12 }}>📄 Relatório de Vales por Período</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={S.label}>De</label>
            <input type="date" value={de} onChange={e => setDe(e.target.value)} style={S.input} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Até</label>
            <input type="date" value={ate} max={today} onChange={e => setAte(e.target.value)} style={S.input} />
          </div>
        </div>

        {/* Modo resumido/detalhado */}
        <div style={{ display: 'flex', gap: 4, background: '#f0e8d8', padding: 4, borderRadius: 10, marginBottom: 12 }}>
          {[['resumido','📋 Resumido'],['detalhado','🔍 Detalhado']].map(([id,label]) => (
            <button key={id} onClick={() => setModo(id)}
              style={{ flex: 1, padding: '8px', border: 'none', borderRadius: 8, background: modo===id?'#fff':'transparent', cursor: 'pointer', fontSize: 12, fontWeight: modo===id?700:400, color: modo===id?C.gold:'#999' }}>
              {label}
            </button>
          ))}
        </div>

        {/* Totalizadores */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
          <div style={{ background: '#1a1200', borderRadius: 10, padding: 10, textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: '#c9a96e80', textTransform: 'uppercase' }}>Total</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#c9a96e' }}>{fmt(totalGeral)}</div>
          </div>
          <div style={{ background: C.bgCard2, borderRadius: 10, padding: 10, textAlign: 'center', border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase' }}>Vales</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.gold }}>{totalQtd}</div>
          </div>
          <div style={{ background: C.bgCard2, borderRadius: 10, padding: 10, textAlign: 'center', border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase' }}>Pessoas</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.accent }}>{agrupado.length}</div>
          </div>
        </div>

        <button onClick={() => exportarRelatorioValesPDF(agrupado, de, ate, modo, config)}
          disabled={agrupado.length === 0}
          style={{ ...S.btn(agrupado.length === 0 ? C.textDim : C.gold), width: '100%' }}>
          📄 Exportar PDF {modo === 'detalhado' ? 'Detalhado' : 'Resumido'}
        </button>
      </div>

      {/* Preview na tela */}
      {agrupado.length === 0 && (
        <div style={{ ...S.card, textAlign: 'center', padding: 24, color: '#999' }}>
          <div style={{ fontSize: 32 }}>💸</div>
          <div>Nenhum vale no período</div>
        </div>
      )}

      {agrupado.map((p, i) => (
        <div key={i} style={{ ...S.card, borderColor: C.gold + '44' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontWeight: 800, fontSize: 15 }}>{p.nome}</div>
              <div style={{ fontSize: 12, color: C.textMuted }}>{p.funcao} · {p.vales.length} vale{p.vales.length!==1?'s':''}</div>
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.gold }}>{fmt(p.total)}</div>
          </div>

          {/* Detalhes */}
          {modo === 'detalhado' && (
            <div style={{ marginTop: 10, borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
              {p.vales.sort((a,b) => b.data_op.localeCompare(a.data_op)).map((v,j) => (
                <div key={j} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: j < p.vales.length-1 ? `1px solid ${C.border}` : 'none' }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{dayLabel(v.data_op)}</div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                      <Badge color={v.forma_pagamento==='pix'?C.secondary:C.success}>
                        {v.forma_pagamento==='pix'?'📱 Pix':'💵 Din'}
                      </Badge>
                      {v.obs && <span style={{ fontSize: 10, color: C.textMuted, fontStyle: 'italic' }}>{v.obs}</span>}
                    </div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.gold }}>{fmt(v.valor)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── MODAL NOVO VALE ──────────────────────────────────────────────────────────

function ModalNovoVale({ store, today, onClose }) {
  const { pessoas, setores, addVale, config } = store
  const [pessoaId, setPessoaId] = useState('')
  const [funcao, setFuncao] = useState('')
  const [setorId, setSetorId] = useState('')
  const [valorDisplay, setValorDisplay] = useState('')
  const [forma, setForma] = useState('dinheiro')
  const [obs, setObs] = useState('')
  const [assinatura, setAssinatura] = useState(null)
  const [dataVale, setDataVale] = useState(today)
  const [step, setStep] = useState('form')
  const [salvando, setSalvando] = useState(false)

  const pessoa = pessoas.find(p => p.id === pessoaId)

  useEffect(() => {
    if (!pessoa) return
    setFuncao(pessoa.funcao || '')
    setSetorId(pessoa.setor_id || '')
  }, [pessoaId])

  const buildPixMsg = () => {
    const v = parseCents(valorDisplay)
    let msg = `💸 VALE — ${pessoa?.nome || '?'}`
    if (funcao) msg += ` · ${funcao}`
    msg += `\nValor: ${fmt(v)}`
    msg += `\nData: ${dayLabel(dataVale)}`
    if (obs) msg += `\nObs: ${obs}`
    msg += `\n\nTipo da chave: ${pessoa?.tipo_pix || '—'}\n\nCHAVE PIX:\n${pessoa?.chave_pix || '—'}`
    return msg
  }

  const save = async () => {
    if (!pessoaId) return alert('Selecione uma pessoa.')
    const v = parseCents(valorDisplay)
    if (!v || v < 100) return alert('Informe um valor válido (mínimo R$1,00).')
    setSalvando(true)
    try {
      let assinaturaUrl = null
      if (assinatura) assinaturaUrl = await uploadAssinatura('vale_' + Date.now(), assinatura)
      await addVale({
        pessoa_id:       pessoaId,
        nome:            pessoa?.nome || '',
        funcao,
        setor_id:        setorId,
        data_op:         dataVale,
        data_real:       toDateStr(new Date()),
        obs,
        valor:           v,
        forma_pagamento: forma,
        assinatura:      assinaturaUrl,
        lancado:         false,
        data_pagamento:  new Date().toISOString(),
      })
      if (forma === 'pix') {
        if (!pessoa?.chave_pix) { alert('⚠️ Este funcionário não tem chave Pix cadastrada.') }
        else {
          const numero = config?.whatsapp_pix || DEFAULT_CONFIG.whatsapp_pix
          window.open(`https://wa.me/${numero}?text=${encodeURIComponent(buildPixMsg())}`, '_blank')
        }
      }
      onClose()
    } catch (err) { alert('Erro ao registrar vale. Tente novamente.'); console.error(err) }
    setSalvando(false)
  }

  if (step === 'assinatura') return (
    <Modal title="Assinatura" onClose={onClose}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 600 }}>{pessoa?.nome}</div>
        <div style={{ fontSize: 13, color: '#8a7355' }}>{fmt(parseCents(valorDisplay))} · Vale</div>
      </div>
      <SignaturePad onSave={sig => { setAssinatura(sig); setStep('form') }} onCancel={() => setStep('form')} />
    </Modal>
  )

  return (
    <Modal title="💸 Novo Vale" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label style={S.label}>Funcionário da casa *</label>
          <select value={pessoaId} onChange={e => setPessoaId(e.target.value)} style={{ ...S.input, fontWeight: pessoaId ? 700 : 400 }}>
            <option value="">— Escolha uma pessoa —</option>
            {pessoas.filter(p => p.interno_casa).sort((a,b) => a.nome.localeCompare(b.nome)).map(p => (
              <option key={p.id} value={p.id}>{p.nome} · {p.funcao}</option>
            ))}
          </select>
          {pessoas.filter(p => p.interno_casa).length === 0 && (
            <div style={{ fontSize: 12, color: C.gold, marginTop: 6 }}>⚠ Nenhum funcionário marcado como "da casa". Marque em Config → Pessoas.</div>
          )}
          {pessoaId && pessoa && (
            <div style={{ marginTop: 6, padding: '8px 10px', background: '#f5f0e8', borderRadius: 8, fontSize: 12, color: '#8a7355' }}>
              ✓ {pessoa.nome} · {pessoa.funcao}
              {pessoa.chave_pix && <><br />{pessoa.tipo_pix}: {pessoa.chave_pix}</>}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Função</label>
            <input value={funcao} onChange={e => setFuncao(e.target.value)} style={S.input} placeholder="Garçom..." />
          </div>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Setor</label>
            <select value={setorId} onChange={e => setSetorId(e.target.value)} style={S.input}>
              <option value="">—</option>
              {setores.filter(s => s.ativo).map(s => <option key={s.id} value={s.id}>{s.nome}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label style={S.label}>Data do vale</label>
          <input
            type="date"
            value={dataVale}
            max={today}
            onChange={e => setDataVale(e.target.value)}
            style={S.input}
          />
          {dataVale !== today && (
            <div style={{ fontSize: 11, color: C.gold, marginTop: 4, fontWeight: 600 }}>
              📅 Lançamento retroativo: {dayLabel(dataVale)}
            </div>
          )}
        </div>

        <div>
          <label style={S.label}>Valor *</label>
          <input value={valorDisplay}
            onChange={e => { const r = e.target.value.replace(/\D/g, ''); setValorDisplay(r ? fmt(parseInt(r)) : '') }}
            style={{ ...S.input, fontSize: 18, fontWeight: 700 }} placeholder="R$ 0,00" inputMode="numeric" />
        </div>

        <div>
          <label style={S.label}>Forma de pagamento</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setForma('dinheiro')} style={{ flex: 1, padding: '12px', border: `2px solid ${forma === 'dinheiro' ? '#22c55e' : C.border}`, borderRadius: 10, background: forma === 'dinheiro' ? '#22c55e20' : C.bgCard2, cursor: 'pointer', fontSize: 13, fontWeight: 700, color: forma === 'dinheiro' ? '#22c55e' : C.textMuted }}>💵 Dinheiro</button>
            <button onClick={() => setForma('pix')} style={{ flex: 1, padding: '12px', border: `2px solid ${forma === 'pix' ? '#3b82f6' : C.border}`, borderRadius: 10, background: forma === 'pix' ? '#3b82f620' : C.bgCard2, cursor: 'pointer', fontSize: 13, fontWeight: 700, color: forma === 'pix' ? '#3b82f6' : C.textMuted }}>📱 Pix</button>
          </div>
        </div>

        {forma === 'pix' && pessoa?.chave_pix && (
          <div style={{ ...S.card, background: '#eff6ff', border: '1px solid #bfdbfe' }}>
            <div style={{ fontSize: 12, color: '#1e40af', fontWeight: 600, marginBottom: 4 }}>Dados do Pix</div>
            <div style={{ fontSize: 13 }}><strong>Tipo:</strong> {pessoa.tipo_pix}</div>
            <div style={{ fontSize: 13 }}><strong>Chave:</strong> {pessoa.chave_pix}</div>
          </div>
        )}

        <div>
          <label style={S.label}>Observação</label>
          <input value={obs} onChange={e => setObs(e.target.value)} style={S.input} placeholder="Opcional..." />
        </div>

        <div>
          <label style={S.label}>Assinatura</label>
          {assinatura
            ? <div><img src={assinatura} alt="Assinatura" style={{ width: '100%', border: '1px solid #e0d5c5', borderRadius: 8 }} /><button onClick={() => setAssinatura(null)} style={{ background: 'none', border: 'none', color: '#999', fontSize: 12, cursor: 'pointer' }}>Refazer</button></div>
            : <button onClick={() => setStep('assinatura')} style={S.btn('#8a7355')}>✍️ Coletar Assinatura</button>
          }
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={{ ...S.btn(C.textDim, true) }}>Cancelar</button>
          <button onClick={save} disabled={salvando}
            style={{ ...S.btn(salvando ? C.textDim : C.gold), flex: 2, fontWeight: 700 }}>
            {salvando ? 'Salvando...' : forma === 'pix' ? '📱 Registrar e Enviar Pix' : '💸 Registrar Vale'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ─── SEÇÃO FOTOS DE NOTAS FISCAIS (Config) ───────────────────────────────────

function SecaoFotos({ store }) {
  const { despesas, updateDespesa } = store
  const [periodo, setPeriodo] = useState(30)
  const [modoLivre, setModoLivre] = useState(false)
  const [dataDe, setDataDe] = useState(toDateStr(new Date()))
  const [dataAte, setDataAte] = useState(toDateStr(new Date()))
  const [limpando, setLimpando] = useState(false)
  const [resultado, setResultado] = useState('')

  const hoje = new Date()
  const comFoto = despesas.filter(d => d.foto && d.foto.length > 0)
  const totalKb = Math.round(comFoto.reduce((a, d) => a + (d.foto?.length || 0), 0) / 1024)

  const aApagar = comFoto.filter(d => {
    if (modoLivre) return d.data_op >= dataDe && d.data_op <= dataAte
    const diff = Math.floor((hoje - new Date(d.data_op + 'T12:00:00')) / (1000 * 60 * 60 * 24))
    return diff >= periodo
  })

  const limpar = async () => {
    if (!confirm(`Apagar ${aApagar.length} foto(s)? O lançamento continua salvo.`)) return
    setLimpando(true)
    setResultado('')
    for (const d of aApagar) await updateDespesa(d.id, { foto: null })
    setLimpando(false)
    setResultado(`✓ ${aApagar.length} foto${aApagar.length !== 1 ? 's' : ''} apagada${aApagar.length !== 1 ? 's' : ''}`)
    setTimeout(() => setResultado(''), 4000)
  }

  return (
    <div style={S.card}>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>📷 Fotos de Notas Fiscais</div>
      <div style={{ fontSize: 13, color: '#8a7355', marginBottom: 12 }}>
        {comFoto.length} foto{comFoto.length !== 1 ? 's' : ''} salva{comFoto.length !== 1 ? 's' : ''} · ~{totalKb}kb no banco
      </div>

      <label style={S.label}>Apagar fotos mais antigas que</label>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {[7, 15, 30, 60, 90].map(d => (
          <button key={d} onClick={() => { setPeriodo(d); setModoLivre(false) }}
            style={{ padding: '6px 12px', border: `2px solid ${!modoLivre && periodo === d ? C.accent : C.border}`, borderRadius: 20, background: !modoLivre && periodo === d ? C.accent : '#fff', color: !modoLivre && periodo === d ? '#fff' : '#666', fontSize: 12, fontWeight: !modoLivre && periodo === d ? 700 : 400, cursor: 'pointer' }}>
            {d} dias
          </button>
        ))}
        <button onClick={() => setModoLivre(true)}
          style={{ padding: '6px 12px', border: `2px solid ${modoLivre ? C.accent : C.border}`, borderRadius: 20, background: modoLivre ? C.accent : '#fff', color: modoLivre ? '#fff' : '#666', fontSize: 12, fontWeight: modoLivre ? 700 : 400, cursor: 'pointer' }}>
          Livre
        </button>
      </div>

      {modoLivre && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={S.label}>De</label>
              <input type="date" value={dataDe} onChange={e => setDataDe(e.target.value)} style={S.input} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={S.label}>Até</label>
              <input type="date" value={dataAte} onChange={e => setDataAte(e.target.value)} style={S.input} />
            </div>
          </div>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
            Fotos de lançamentos entre {dayLabel(dataDe)} e {dayLabel(dataAte)}.
          </div>
        </div>
      )}

      <div style={{ fontSize: 12, color: '#999', marginBottom: 12 }}>
        {aApagar.length} foto{aApagar.length !== 1 ? 's' : ''} serão apagadas · o lançamento e a descrição ficam intactos
      </div>

      <button onClick={limpar} disabled={limpando || aApagar.length === 0}
        style={{ ...S.btn(limpando || aApagar.length === 0 ? '#ccc' : C.danger), fontWeight: 700 }}>
        {limpando ? 'Limpando...' : `🗑 Limpar ${aApagar.length} foto${aApagar.length !== 1 ? 's' : ''}`}
      </button>

      {resultado && (
        <div style={{ marginTop: 10, fontSize: 13, color: '#22c55e', fontWeight: 600, textAlign: 'center' }}>{resultado}</div>
      )}
    </div>
  )
}

// ─── SEÇÃO CATEGORIAS DE DESPESAS (Config) ───────────────────────────────────

const EMOJIS_COMUNS = ['🛒','🎮','🔧','🧹','🚗','📦','💊','📝','🍺','🧃','🍖','🧂','🧊','💡','🔌','🪣','🧴','🛠️','🎯','📱','💰','🏪','🏬','🍕','☕','🥤','🧺','🪴','🔑','📋']

function SecaoCategorias({ store }) {
  const { addCategoria, removeCategoria, updateCategoria } = store
  const [cats, setCats] = useState([])
  const [editandoId, setEditandoId] = useState(null)
  const [novoNome, setNovoNome]   = useState('')
  const [novoEmoji, setNovoEmoji] = useState('📝')
  const [novoGrupo, setNovoGrupo] = useState('outros')
  const [novoCor, setNovoCor]     = useState('#9ca3af')
  const [mostrarForm, setMostrarForm] = useState(false)

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'categorias_despesas'), s => {
      setCats(s.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return unsub
  }, [])

  const GRUPOS = [
    { id:'estoque',    label:'📦 Estoque'      },
    { id:'emergencia', label:'🚨 Emergência'    },
    { id:'operacional',label:'⚙️ Operacional'   },
    { id:'pessoal',    label:'👥 Pessoal'       },
    { id:'saude',      label:'💊 Saúde equipe'  },
    { id:'financeiro', label:'💰 Financeiro'    },
    { id:'correcoes',  label:'↩️ Correções'     },
    { id:'outros',     label:'📝 Outros'        },
  ]
  const GRUPO_LABEL = Object.fromEntries(GRUPOS.map(g => [g.id, g.label]))

  const catsPorGrupo = useMemo(() => {
    const map = {}
    cats.sort((a,b)=>(a.ordem||99)-(b.ordem||99)).forEach(c => {
      const g = c.grupo || 'outros'
      if (!map[g]) map[g] = []
      map[g].push(c)
    })
    return map
  }, [cats])

  const adicionar = async () => {
    if (!novoNome.trim()) return alert('Digite o nome da categoria.')
    await addCategoria({
      emoji: novoEmoji, nome: novoNome.trim(), grupo: novoGrupo, cor: novoCor,
      ativo: true, favorita: false, ordem: 99, alertar_se_aumentar: false,
      threshold_mensal: 0, descricoes_sugeridas: [],
    })
    setNovoNome(''); setNovoEmoji('📝'); setNovoGrupo('outros'); setNovoCor('#9ca3af')
    setMostrarForm(false)
  }

  const toggle = (id, campo, valor) => updateCategoria(id, { [campo]: valor })

  return (
    <div style={S.card}>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>🏷️ Categorias de Despesas</div>
      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>
        {cats.filter(c=>c.ativo).length} ativas · {cats.filter(c=>c.favorita).length} favoritas
      </div>

      {GRUPOS.map(({ id: grupoId, label: grupoLabel }) => {
        const lista = catsPorGrupo[grupoId] || []
        if (!lista.length) return null
        return (
          <div key={grupoId} style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
              {grupoLabel}
            </div>
            {lista.map(c => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 0', borderBottom: `1px solid ${C.border}` }}>
                <span style={{ fontSize: 20, width: 28 }}>{c.emoji}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: c.ativo ? C.text : C.textDim }}>{c.nome}</div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
                    {c.alertar_se_aumentar && (
                      <span style={{ fontSize: 9, background: '#ef444420', color: '#ef4444', borderRadius: 8, padding: '2px 6px', fontWeight: 700 }}>
                        ⚠️ Alerta se &gt;{c.threshold_mensal}x/mês
                      </span>
                    )}
                    {c.favorita && (
                      <span style={{ fontSize: 9, background: '#f59e0b20', color: '#f59e0b', borderRadius: 8, padding: '2px 6px', fontWeight: 700 }}>
                        ⭐ Favorita
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {/* Toggle favorita */}
                  <button onClick={() => toggle(c.id, 'favorita', !c.favorita)}
                    title="Favorita (aparece no topo)"
                    style={{ fontSize: 14, background: 'none', border: 'none', cursor: 'pointer', opacity: c.favorita ? 1 : 0.3 }}>
                    ⭐
                  </button>
                  {/* Toggle ativo */}
                  <button onClick={() => toggle(c.id, 'ativo', !c.ativo)}
                    style={{ background: 'none', border: `1px solid ${c.ativo ? '#22c55e' : '#ccc'}`, borderRadius: 6, padding: '3px 8px', fontSize: 10, color: c.ativo ? '#22c55e' : '#999', cursor: 'pointer', fontWeight: 600 }}>
                    {c.ativo ? 'Ativa' : 'Inativa'}
                  </button>
                  {/* Remover */}
                  <button onClick={() => { if (confirm(`Remover "${c.nome}"?`)) removeCategoria(c.id) }}
                    style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: 16, cursor: 'pointer' }}>🗑</button>
                </div>
              </div>
            ))}
          </div>
        )
      })}

      {/* Botão nova categoria */}
      <button onClick={() => setMostrarForm(!mostrarForm)}
        style={{ ...S.btn(mostrarForm ? C.textDim : C.accent), width: '100%', marginTop: 8 }}>
        {mostrarForm ? '✕ Cancelar' : '+ Nova categoria'}
      </button>

      {mostrarForm && (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10, background: C.bgCard2, borderRadius: 12, padding: 14, border: `1px solid ${C.border}` }}>
          <div>
            <label style={S.label}>Emoji</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {EMOJIS_COMUNS.map(e => (
                <button key={e} onClick={() => setNovoEmoji(e)}
                  style={{ fontSize: 20, background: novoEmoji === e ? C.primary + '22' : 'transparent', border: novoEmoji === e ? `2px solid ${C.primary}` : '2px solid transparent', borderRadius: 8, padding: '4px 6px', cursor: 'pointer' }}>
                  {e}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={S.label}>Nome</label>
            <input value={novoNome} onChange={e => setNovoNome(e.target.value)} style={S.input} placeholder="Nome da categoria..." />
          </div>
          <div>
            <label style={S.label}>Grupo operacional</label>
            <select value={novoGrupo} onChange={e => setNovoGrupo(e.target.value)} style={S.input}>
              {GRUPOS.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
            </select>
          </div>
          <button onClick={adicionar} style={{ ...S.btn(C.primary) }}>+ Adicionar categoria</button>
        </div>
      )}
    </div>
  )
}

// ─── MODAL NOVA DESPESA ───────────────────────────────────────────────────────

function comprimirFoto(file) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = (ev) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        const MAX = 800
        let w = img.width, h = img.height
        if (w > MAX) { h = Math.round(h * MAX / w); w = MAX }
        if (h > MAX) { w = Math.round(w * MAX / h); h = MAX }
        canvas.width = w; canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.6))
      }
      img.src = ev.target.result
    }
    reader.readAsDataURL(file)
  })
}

function ModalNovaDespesa({ store, today, onClose }) {
  const { setores, addDespesa, categorias, despesas } = store
  const [descricao, setDescricao] = useState('')
  const [categoriaId, setCategoriaId] = useState('')
  const [setorId, setSetorId] = useState('')
  const [valorDisplay, setValorDisplay] = useState('')
  const [obs, setObs] = useState('')
  const [foto, setFoto] = useState(null)
  const [forma, setForma] = useState('dinheiro')
  const [salvando, setSalvando] = useState(false)
  const [busca, setBusca] = useState('')
  const fotoRef = useRef(null)
  const galeriaRef = useRef(null)

  // Ordenação inteligente: favorita → mais usada nos últimos 30 dias → ordem
  const catsOrdenadas = useMemo(() => {
    const trinta = toDateStr(new Date(new Date().getTime() - 30 * 86400000))
    const usoMap = {}
    ;(despesas || []).filter(d => d.data_op >= trinta).forEach(d => {
      usoMap[d.categoria_id] = (usoMap[d.categoria_id] || 0) + 1
    })
    return [...categorias]
      .filter(c => !busca || c.nome.toLowerCase().includes(busca.toLowerCase()))
      .sort((a, b) => {
        if (a.favorita !== b.favorita) return a.favorita ? -1 : 1
        const ua = usoMap[a.id] || 0, ub = usoMap[b.id] || 0
        if (ua !== ub) return ub - ua
        return (a.ordem || 99) - (b.ordem || 99)
      })
  }, [categorias, despesas, busca])

  // Sugestões de descrição da categoria selecionada
  const sugestoes = useMemo(() => {
    if (!catSel?.descricoes_sugeridas?.length) return []
    return catSel.descricoes_sugeridas
  }, [catSel])

  const [assinatura, setAssinatura] = useState(null)
  const [mostrarAssinatura, setMostrarAssinatura] = useState(false)

  const handleFoto = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const comprimida = await comprimirFoto(file)
    setFoto(comprimida)
  }

  const temComprovante = foto || assinatura || obs.trim()

  const save = async () => {
    if (!categoriaId) return alert('Selecione uma categoria.')
    const v = parseCents(valorDisplay)
    if (!v || v < 100) return alert('Informe um valor válido (mínimo R$1,00).')
    if (!descricao.trim()) return alert('Digite o texto da sangria.')
    if (!temComprovante) return alert('Adicione uma nota fiscal, assinatura ou observação.')
    setSalvando(true)
    try {
      await addDespesa({
        descricao:            descricao.trim(),
        categoria_id:         categoriaId,
        categoria_nome:       catSel?.nome || '',
        categoria_emoji:      catSel?.emoji || '📝',
        categoria_grupo:      catSel?.grupo || 'outros',
        categoria_cor:        catSel?.cor || '#9ca3af',
        setor_id:             setorId,
        data_op:              today,
        data_real:            toDateStr(new Date()),
        valor:                v,
        forma_pagamento:      forma,
        obs:                  obs.trim(),
        foto:                 foto || null,
        assinatura:           assinatura || null,
        lancado:              false,
        criado_em:            new Date().toISOString(),
      })
      onClose()
    } catch (err) { alert('Erro ao salvar. Tente novamente.'); console.error(err) }
    setSalvando(false)
  }

  const GRUPOS_LABEL = {
    estoque:'📦 Estoque', emergencia:'🚨 Emergência', operacional:'⚙️ Operacional',
    pessoal:'👥 Pessoal', saude:'💊 Saúde equipe', financeiro:'💰 Financeiro',
    correcoes:'↩️ Correções', outros:'📝 Outros',
  }

  // Agrupa para exibição
  const catsPorGrupo = useMemo(() => {
    if (busca) return { 'Resultados': catsOrdenadas }
    const map = {}
    catsOrdenadas.forEach(c => {
      const g = GRUPOS_LABEL[c.grupo] || '📝 Outros'
      if (!map[g]) map[g] = []
      map[g].push(c)
    })
    // Favoritas sempre no topo como grupo separado
    const favs = catsOrdenadas.filter(c => c.favorita)
    const resultado = {}
    if (favs.length) resultado['⭐ Mais usadas'] = favs
    Object.entries(map).forEach(([g, cats]) => {
      resultado[g] = cats.filter(c => !c.favorita)
    })
    return resultado
  }, [catsOrdenadas, busca])

  return (
    <Modal title="🧾 Novo Lançamento" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* Busca de categoria */}
        <div>
          <label style={S.label}>Categoria *</label>
          <input value={busca} onChange={e => setBusca(e.target.value)}
            style={{ ...S.input, marginBottom: 8 }} placeholder="🔍 Buscar categoria..." />

          {Object.entries(catsPorGrupo).map(([grupo, cats]) => cats.length === 0 ? null : (
            <div key={grupo} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                {grupo}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {cats.map(c => (
                  <button key={c.id} onClick={() => { setCategoriaId(c.id); setBusca('') }}
                    style={{ padding: '7px 12px', border: `2px solid ${categoriaId === c.id ? c.cor || C.accent : C.border}`,
                      borderRadius: 20, background: categoriaId === c.id ? (c.cor || C.accent) + '22' : C.bgCard2,
                      cursor: 'pointer', fontSize: 12, fontWeight: categoriaId === c.id ? 700 : 400,
                      color: categoriaId === c.id ? c.cor || C.accent : C.textMuted }}>
                    {c.emoji} {c.nome}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Sugestões de descrição */}
        {catSel && sugestoes.length > 0 && !descricao && (
          <div>
            <label style={S.label}>Sugestões rápidas</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {sugestoes.map((s, i) => (
                <button key={i} onClick={() => setDescricao(s)}
                  style={{ padding: '6px 12px', border: `1px solid ${C.border}`, borderRadius: 16,
                    background: C.bgCard2, cursor: 'pointer', fontSize: 12, color: C.textMuted }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Descrição livre */}
        <div>
          <label style={S.label}>Descrição *</label>
          <input value={descricao} onChange={e => setDescricao(e.target.value)}
            style={S.input}
            placeholder={catSel ? `${catSel.emoji} Descreva...` : 'Selecione uma categoria primeiro'} />
        </div>

        {/* Valor + Setor */}
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Valor *</label>
            <input value={valorDisplay}
              onChange={e => { const r = e.target.value.replace(/\D/g,''); setValorDisplay(r ? fmt(parseInt(r)) : '') }}
              style={{ ...S.input, fontSize: 18, fontWeight: 700 }} placeholder="R$ 0,00" inputMode="numeric" />
          </div>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Setor</label>
            <select value={setorId} onChange={e => setSetorId(e.target.value)} style={S.input}>
              <option value="">—</option>
              {setores.filter(s => s.ativo).map(s => <option key={s.id} value={s.id}>{s.nome}</option>)}
            </select>
          </div>
        </div>

        <div style={{ background: C.bgCard2, borderRadius: 10, padding: '10px 14px', border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 12, color: C.textMuted }}>📅 Data: <strong>{dayLabel(today)}</strong></div>
        </div>

        {/* Forma de pagamento */}
        <div>
          <label style={S.label}>Forma de pagamento</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setForma('dinheiro')} style={{ flex: 1, padding: '12px', border: `2px solid ${forma === 'dinheiro' ? '#22c55e' : C.border}`, borderRadius: 10, background: forma === 'dinheiro' ? '#22c55e20' : C.bgCard2, cursor: 'pointer', fontSize: 13, fontWeight: 700, color: forma === 'dinheiro' ? '#22c55e' : C.textMuted }}>💵 Dinheiro</button>
            <button onClick={() => setForma('pix')} style={{ flex: 1, padding: '12px', border: `2px solid ${forma === 'pix' ? '#3b82f6' : C.border}`, borderRadius: 10, background: forma === 'pix' ? '#3b82f620' : C.bgCard2, cursor: 'pointer', fontSize: 13, fontWeight: 700, color: forma === 'pix' ? '#3b82f6' : C.textMuted }}>📱 Pix</button>
          </div>
        </div>

        {/* Descrição — texto da sangria */}
        <div>
          <label style={S.label}>Texto da sangria *</label>
          <input value={descricao} onChange={e => setDescricao(e.target.value)}
            style={S.input}
            placeholder={catSel ? `${catSel.emoji} Este texto aparecerá na sangria...` : 'Selecione uma categoria primeiro'} />
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
            Este texto aparecerá na sangria e nos relatórios.
          </div>
        </div>

        {/* Valor + Setor */}
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Valor *</label>
            <input value={valorDisplay}
              onChange={e => { const r = e.target.value.replace(/\D/g,''); setValorDisplay(r ? fmt(parseInt(r)) : '') }}
              style={{ ...S.input, fontSize: 18, fontWeight: 700 }} placeholder="R$ 0,00" inputMode="numeric" />
          </div>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Setor</label>
            <select value={setorId} onChange={e => setSetorId(e.target.value)} style={S.input}>
              <option value="">—</option>
              {setores.filter(s => s.ativo).map(s => <option key={s.id} value={s.id}>{s.nome}</option>)}
            </select>
          </div>
        </div>

        <div style={{ background: C.bgCard2, borderRadius: 10, padding: '10px 14px', border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 12, color: C.textMuted }}>📅 Data: <strong>{dayLabel(today)}</strong></div>
        </div>

        {/* Forma de pagamento */}
        <div>
          <label style={S.label}>Forma de pagamento</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setForma('dinheiro')} style={{ flex: 1, padding: '12px', border: `2px solid ${forma === 'dinheiro' ? '#22c55e' : C.border}`, borderRadius: 10, background: forma === 'dinheiro' ? '#22c55e20' : C.bgCard2, cursor: 'pointer', fontSize: 13, fontWeight: 700, color: forma === 'dinheiro' ? '#22c55e' : C.textMuted }}>💵 Dinheiro</button>
            <button onClick={() => setForma('pix')} style={{ flex: 1, padding: '12px', border: `2px solid ${forma === 'pix' ? '#3b82f6' : C.border}`, borderRadius: 10, background: forma === 'pix' ? '#3b82f620' : C.bgCard2, cursor: 'pointer', fontSize: 13, fontWeight: 700, color: forma === 'pix' ? '#3b82f6' : C.textMuted }}>📱 Pix</button>
          </div>
        </div>

        {/* Comprovante — foto, assinatura ou observação */}
        <div>
          <label style={S.label}>
            Comprovante *
            <span style={{ fontSize: 10, color: C.textMuted, fontWeight: 400, marginLeft: 6 }}>
              foto, assinatura ou observação
            </span>
          </label>

          {/* Indicador do que já foi preenchido */}
          {temComprovante && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {foto      && <span style={{ fontSize: 11, background: '#22c55e20', color: '#22c55e', borderRadius: 10, padding: '3px 10px', fontWeight: 700 }}>📷 Foto ✓</span>}
              {assinatura && <span style={{ fontSize: 11, background: '#3b82f620', color: '#3b82f6', borderRadius: 10, padding: '3px 10px', fontWeight: 700 }}>✍️ Assinatura ✓</span>}
              {obs.trim() && <span style={{ fontSize: 11, background: C.primary+'20', color: C.primary, borderRadius: 10, padding: '3px 10px', fontWeight: 700 }}>📝 Obs ✓</span>}
            </div>
          )}

          {/* Foto */}
          {foto ? (
            <div style={{ marginBottom: 8 }}>
              <img src={foto} alt="Nota" style={{ width: '100%', borderRadius: 10, border: `1px solid ${C.border}`, maxHeight: 180, objectFit: 'cover' }} />
              <button onClick={() => setFoto(null)} style={{ background: 'none', border: 'none', color: '#999', fontSize: 12, cursor: 'pointer', marginTop: 4 }}>🗑 Remover foto</button>
            </div>
          ) : (
            <div style={{ marginBottom: 8 }}>
              <input ref={fotoRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={handleFoto} />
              <input ref={galeriaRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFoto} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => fotoRef.current?.click()}
                  style={{ ...S.btn(C.secondary, true), flex: 1 }}>
                  📷 Câmera
                </button>
                <button onClick={() => galeriaRef.current?.click()}
                  style={{ ...S.btn(C.secondary, true), flex: 1 }}>
                  🖼️ Galeria
                </button>
              </div>
            </div>
          )}

          {/* Assinatura */}
          {mostrarAssinatura ? (
            <SignaturePad
              onSave={sig => { setAssinatura(sig); setMostrarAssinatura(false) }}
              onCancel={() => setMostrarAssinatura(false)}
            />
          ) : assinatura ? (
            <div style={{ marginBottom: 8 }}>
              <img src={assinatura} alt="Assinatura" style={{ width: '100%', border: `1px solid ${C.border}`, borderRadius: 8, maxHeight: 100, objectFit: 'contain' }} />
              <button onClick={() => setAssinatura(null)} style={{ background: 'none', border: 'none', color: '#999', fontSize: 12, cursor: 'pointer', marginTop: 4 }}>🗑 Remover assinatura</button>
            </div>
          ) : (
            <button onClick={() => setMostrarAssinatura(true)}
              style={{ ...S.btn(C.gold, true), width: '100%', marginBottom: 8 }}>
              ✍️ Coletar Assinatura
            </button>
          )}

          {/* Observação */}
          <div>
            <label style={{ ...S.label, color: !temComprovante ? C.danger : C.textMuted }}>
              Observação {!foto && !assinatura ? '(obrigatória sem foto ou assinatura)' : '(opcional)'}
            </label>
            <input value={obs} onChange={e => setObs(e.target.value)}
              style={{ ...S.input, borderColor: !temComprovante ? C.danger + '88' : C.border }}
              placeholder={!foto && !assinatura ? 'Ex: não pediu nota, compra urgente...' : 'Detalhe adicional...'} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={{ ...S.btn(C.textDim, true) }}>Cancelar</button>
          <button onClick={save} disabled={salvando}
            style={{ ...S.btn(salvando ? C.textDim : C.accent), flex: 2, fontWeight: 700 }}>
            {salvando ? 'Salvando...' : '🧾 Registrar Lançamento'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
