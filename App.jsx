import { imprimirRecibos } from './impressao'
import { useState, useEffect, useRef, useMemo } from 'react'
import { db } from './firebase'
import { collection, addDoc, updateDoc, setDoc, doc, onSnapshot, deleteDoc, runTransaction, getDoc, query, where, orderBy, limit, getDocs, writeBatch } from 'firebase/firestore'

const fmt = (cents) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((cents || 0) / 100)
const parseCents = (str) => parseInt(String(str).replace(/\D/g, '') || '0', 10)
const DIAS = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB']
const toDateStr = (d) => d.toISOString().slice(0, 10)

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
  let rem = cents
  const n = { 100: 0, 50: 0, 20: 0, 10: 0 }
  ;[100, 50, 20, 10].forEach(v => { n[v] = Math.floor(rem / (v * 100)); rem = rem % (v * 100) })
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
  const n = valor.replace(/\D/g, '').slice(0, 11)
  if (n.length <= 3) return n
  if (n.length <= 6) return n.slice(0,3) + '.' + n.slice(3)
  if (n.length <= 9) return n.slice(0,3) + '.' + n.slice(3,6) + '.' + n.slice(6)
  return n.slice(0,3) + '.' + n.slice(3,6) + '.' + n.slice(6,9) + '-' + n.slice(9)
}

// Formata telefone enquanto digita: (11) 99999-9999
function formatarTelefone(valor) {
  const n = valor.replace(/\D/g, '').slice(0, 11)
  if (n.length <= 2) return n.length ? '(' + n : n
  if (n.length <= 7) return '(' + n.slice(0,2) + ') ' + n.slice(2)
  return '(' + n.slice(0,2) + ') ' + n.slice(2,7) + '-' + n.slice(7)
}

// Hash simples para senha (não use em sistemas bancários, ok para uso interno)
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
  const [tab, setTab] = useState('extras')
  const [extras, setExtras] = useState([])
  const [pessoas, setPessoas] = useState([])
  const [setores, setSetores] = useState([])
  const [modal, setModal] = useState(null)
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  const today = todayOp(config)

  const updateConfig = async (changes) => {
    const novo = { ...config, ...changes }
    setConfig(novo)
    await updateDoc(doc(db, 'configuracoes', 'geral'), novo)
  }

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

    const unsubs = [
      onSnapshot(qExtras, s => setExtras(s.docs.map(d => ({ id: d.id, ...d.data() })))),
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

  const store = { extras, pessoas, setores, config, updateConfig, addExtra, updateExtra, removeExtra, addPessoa, updatePessoa, removePessoa, addSetor, updateSetor, removeSetor, usuario, onLogout, registrarLog }

  const tabs = [
    { id: 'extras', icon: '👤', label: 'Extras' },
    { id: 'pagamentos', icon: '💳', label: 'Pagamentos' },
    { id: 'lancamentos', icon: '📋', label: 'Lançamentos' },
    { id: 'relatorios', icon: '📊', label: 'Dashboard' },
    ...(usuario?.role === 'admin' ? [{ id: 'config', icon: '⚙️', label: 'Config' }] : []),
  ]

  return (
    <div style={S.app}>
      <div style={S.header}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, color: '#9a7520', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 2 }}>SISTEMA OPERACIONAL</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: '#ffffff', letterSpacing: '-0.03em' }}>{config.nome_estabelecimento}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>Data operacional</div>
            <div style={{ fontSize: 13, color: '#ffffff', fontWeight: 700 }}>{dayLabel(today)}</div>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>👤 {usuario.nome}</div>
            <button onClick={onLogout} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 6, color: 'rgba(255,255,255,0.7)', fontSize: 10, padding: '3px 8px', cursor: 'pointer', marginTop: 3, fontWeight: 700 }}>Sair</button>
          </div>
        </div>
      </div>
      <div style={S.content}>
        {tab === 'extras'      && <TabExtras store={store} today={today} setModal={setModal} />}
        {tab === 'pagamentos'  && <TabPagamentos store={store} today={today} setModal={setModal} />}
        {tab === 'lancamentos' && <TabLancamentos store={store} today={today} />}
        {tab === 'relatorios'  && <TabRelatorios store={store} />}
        {tab === 'config'      && <TabConfig store={store} setModal={setModal} />}
      </div>
      <div style={S.nav}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
              flex: 1, border: 'none', background: 'none',
              padding: '12px 4px 14px', cursor: 'pointer',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
              borderTop: tab === t.id ? `3px solid ${C.primary}` : '3px solid transparent',
              marginTop: -1,
            }}>
            <span style={{ fontSize: 20, opacity: tab === t.id ? 1 : 0.45 }}>{t.icon}</span>
            <span style={{ fontSize: 9, color: tab === t.id ? C.primary : C.textDim, fontWeight: tab === t.id ? 800 : 500, fontFamily: 'inherit', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t.label}</span>
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
    </div>
  )
}

// ─── ABA EXTRAS ───────────────────────────────────────────────────────────────

function TabExtras({ store, today, setModal }) {
  const { extras, pessoas, setores, removeExtra, addExtra } = store
  const todayExtras = useMemo(() => extras.filter(e => e.data_op === today), [extras, today])
  const total = useMemo(() => todayExtras.reduce((a, e) => a + e.valor_final, 0), [todayExtras])

  const duplicar = async () => {
    const ontem = toDateStr(new Date(new Date(today + 'T12:00:00').getTime() - 86400000))
    const ontemExtras = extras.filter(e => e.data_op === ontem)
    if (ontemExtras.length === 0) return alert('Nenhum extra ontem para duplicar.')
    for (const e of ontemExtras) {
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
    }
  }

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
    if (!v) return alert('Informe o valor.')
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

// ─── ABA PAGAMENTOS ───────────────────────────────────────────────────────────

function TabPagamentos({ store, today, setModal }) {
  const { extras, setores, pessoas, updateExtra, config } = store
  const pendentes = useMemo(() => extras.filter(e => e.data_op === today && !e.pago).sort((a,b) => a.nome.localeCompare(b.nome)), [extras, today])
  const pagos = useMemo(() => extras.filter(e => e.data_op === today && e.pago).sort((a,b) => a.nome.localeCompare(b.nome)), [extras, today])
  const dinheiroTotal = useMemo(() => pendentes.filter(e => e.previsao !== 'pix').reduce((a, e) => a + e.valor_final, 0), [pendentes])
  const pixTotal = useMemo(() => pendentes.filter(e => e.previsao === 'pix').reduce((a, e) => a + e.valor_final, 0), [pendentes])
  const notes = useMemo(() => calcNotes(dinheiroTotal), [dinheiroTotal])

  // Agrupa pendentes por setor em ordem alfabética
  const pendentesPorSetor = useMemo(() => {
    const semSetor = { id: '__sem_setor__', nome: 'Sem setor' }
    const setoresUsados = {}
    pendentes.forEach(e => {
      const setor = setores.find(s => s.id === e.setor_id) || semSetor
      if (!setoresUsados[setor.id]) setoresUsados[setor.id] = { setor, extras: [] }
      setoresUsados[setor.id].extras.push(e)
    })
    return Object.values(setoresUsados).sort((a, b) => a.setor.nome.localeCompare(b.setor.nome))
  }, [pendentes, setores])

  // Controla quais setores estão abertos (todos abertos por padrão)
  const [setoresAbertos, setSetoresAbertos] = useState({})
  useEffect(() => {
    const inicial = {}
    pendentesPorSetor.forEach(g => { inicial[g.setor.id] = true })
    setSetoresAbertos(inicial)
  }, [pendentesPorSetor.length])

  const toggleSetor = (id) => setSetoresAbertos(prev => ({ ...prev, [id]: !prev[id] }))

  return (
    <div>
      {/* Card resumo financeiro */}
      <div style={{ ...S.card, background: 'linear-gradient(135deg,#12122a,#1a0d2e)', color: '#fff' }}>
        <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: '#ffffff99', textTransform: 'uppercase', fontWeight: 700 }}>💵 Dinheiro</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#10b981' }}>{fmt(dinheiroTotal)}</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: '#ffffff99', textTransform: 'uppercase', fontWeight: 700 }}>📱 Pix</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#00c2cb' }}>{fmt(pixTotal)}</div>
          </div>
        </div>
        <div style={{ borderTop: '1px solid #ffffff20', paddingTop: 12 }}>
          <div style={{ fontSize: 11, color: '#ffffff60', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}>Notas necessárias</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(notes).filter(([, q]) => q > 0).map(([n, q]) => {
              const cores = { 100: { bg: '#1e3a5f', label: '#60a5fa', emoji: '💙' }, 50: { bg: '#3d1f00', label: '#fb923c', emoji: '🟠' }, 20: { bg: '#3d3000', label: '#fbbf24', emoji: '🟡' }, 10: { bg: '#3d0a2e', label: '#f472b6', emoji: '🩷' } }
              const c = cores[Number(n)] || { bg: '#1a1a2e', label: '#fff', emoji: '💵' }
              return (
                <div key={n} style={{ background: c.bg, border: `2px solid ${c.label}44`, borderRadius: 14, padding: '10px 14px', textAlign: 'center', minWidth: 60 }}>
                  <div style={{ fontSize: 20 }}>{c.emoji}</div>
                  <div style={{ fontSize: 22, fontWeight: 900, color: c.label, lineHeight: 1 }}>{q}×</div>
                  <div style={{ fontSize: 11, color: c.label + 'aa', marginTop: 2, fontWeight: 700 }}>R${n}</div>
                </div>
              )
            })}
            {Object.values(notes).every(q => q === 0) && <div style={{ fontSize: 13, color: '#ffffff40' }}>Nenhuma nota necessária</div>}
          </div>
        </div>
      </div>

      {/* Botões de impressão */}
      {pagos.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button onClick={() => imprimirRecibos(extras, pessoas, setores, config, 'dinheiro')}
            style={{ ...S.btn(C.success), flex: 1, fontSize: 13 }}>🖨️ Imprimir Dinheiro</button>
          <button onClick={() => imprimirRecibos(extras, pessoas, setores, config, 'pix')}
            style={{ ...S.btn(C.secondary), flex: 1, fontSize: 13 }}>🖨️ Imprimir Pix</button>
        </div>
      )}

      {/* ── PENDENTES agrupados por setor ── */}
      {pendentes.length === 0 && (
        <div style={{ ...S.card, textAlign: 'center', padding: 32 }}>
          <div style={{ fontSize: 36 }}>✅</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginTop: 8 }}>Todos pagos!</div>
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>Nenhum pendente hoje</div>
        </div>
      )}

      {pendentesPorSetor.map(grupo => (
        <div key={grupo.setor.id} style={{ marginBottom: 8 }}>
          {/* Cabeçalho do setor — clicável */}
          <div onClick={() => toggleSetor(grupo.setor.id)}
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: C.bgCard2, borderRadius: setoresAbertos[grupo.setor.id] ? '14px 14px 0 0' : 14, border: `1px solid ${C.border}`, cursor: 'pointer', userSelect: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 10, height: 10, borderRadius: 5, background: C.primary }} />
              <span style={{ fontSize: 15, fontWeight: 800, color: C.text }}>{grupo.setor.nome}</span>
              <span style={{ fontSize: 12, color: C.textMuted, background: C.bgCard, borderRadius: 10, padding: '2px 8px', fontWeight: 700 }}>{grupo.extras.length}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 800, color: C.primary }}>{fmt(grupo.extras.reduce((a, e) => a + e.valor_final, 0))}</span>
              <span style={{ fontSize: 18, color: C.textMuted, transform: setoresAbertos[grupo.setor.id] ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>⌄</span>
            </div>
          </div>

          {/* Extras do setor */}
          {setoresAbertos[grupo.setor.id] && (
            <div style={{ border: `1px solid ${C.border}`, borderTop: 'none', borderRadius: '0 0 14px 14px', overflow: 'hidden' }}>
              {grupo.extras.map((e, idx) => {
                const pessoa = pessoas.find(p => p.id === e.pessoa_id)
                const trocosTotal = totalTrocos(pessoa?.trocos)
                const descontoAplicado = e.desconto_troco || 0
                const isLast = idx === grupo.extras.length - 1
                return (
                  <div key={e.id} style={{ background: C.bgCard, padding: '14px 16px', borderBottom: isLast ? 'none' : `1px solid ${C.border}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: 16, color: C.text }}>{e.nome}</div>
                        <div style={{ fontSize: 13, color: '#aaaacc', marginTop: 2 }}>
                          {e.funcao}{e.turnos ? ' · ' + e.turnos : ''}
                        </div>
                        {descontoAplicado > 0 && <div style={{ fontSize: 12, color: C.success, marginTop: 2, fontWeight: 700 }}>✓ −{fmt(descontoAplicado)} descontado</div>}
                        {e.obs ? <div style={{ fontSize: 12, color: '#aaaacc', fontStyle: 'italic', marginTop: 3 }}>📝 {e.obs}</div> : null}
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 22, fontWeight: 900, color: C.primary }}>{fmt(e.valor_final)}</div>
                      </div>
                    </div>

                    {/* Troco pendente */}
                    {trocosTotal > 0 && (
                      <div style={{ background: '#2a0d0d', border: '1px solid #ef444444', borderRadius: 10, padding: '8px 12px', marginBottom: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div>
                            <div style={{ fontSize: 12, color: '#ef4444', fontWeight: 700 }}>🔴 Troco a descontar</div>
                            {(pessoa?.trocos || []).map((t, i) => (
                              <div key={i} style={{ fontSize: 11, color: '#ff6b6b', marginTop: 2 }}>• {dayLabel(t.data)}: {fmt(t.valor)}</div>
                            ))}
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <div style={{ fontSize: 14, fontWeight: 800, color: '#ef4444' }}>{fmt(trocosTotal)}</div>
                            <button
                              onClick={async () => {
                                if (!confirm(`Aplicar desconto de ${fmt(trocosTotal)}?`)) return
                                const novoValor = Math.max(0, e.valor_final - trocosTotal)
                                await updateExtra(e.id, { valor_final: novoValor, desconto_troco: (e.desconto_troco || 0) + trocosTotal, trocos_descontados: pessoa?.trocos || [] })
                                if (pessoa) await store.updatePessoa(pessoa.id, { trocos: [] })
                              }}
                              style={{ marginTop: 4, background: '#ef4444', color: '#fff', border: 'none', borderRadius: 8, padding: '4px 10px', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
                              Aplicar −{fmt(trocosTotal)}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Forma de pagamento */}
                    <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                      {[['indefinido', '❓', '#666666'], ['dinheiro', '💵 Dinheiro', '#10b981'], ['pix', '📱 Pix', '#00c2cb']].map(([v, label, color]) => (
                        <button key={v} onClick={() => updateExtra(e.id, { previsao: v })}
                          style={{ flex: 1, padding: '8px 4px', border: `2px solid ${e.previsao === v ? color : C.border}`, borderRadius: 10, background: e.previsao === v ? color + '25' : C.bgCard2, cursor: 'pointer', fontSize: 12, color: e.previsao === v ? color : C.textMuted, fontWeight: e.previsao === v ? 800 : 400 }}>
                          {label}
                        </button>
                      ))}
                    </div>

                    <button onClick={() => setModal({ type: 'pagar', extra: e })}
                      style={{ ...S.btn(C.primary), width: '100%', fontSize: 15 }}>
                      💰 Pagar {fmt(e.valor_final)}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ))}

      {/* ── PAGOS — compactos, embaixo ── */}
      {pagos.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 1, height: 1, background: C.success + '44' }} />
            <span style={{ fontSize: 11, color: C.success, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em' }}>✓ Pagos ({pagos.length})</span>
            <div style={{ flex: 1, height: 1, background: C.success + '44' }} />
          </div>
          {pagos.map(e => (
            <div key={e.id} style={{ background: '#0d1f14', border: '1px solid #10b98133', borderRadius: 12, padding: '10px 14px', marginBottom: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: '#d1fae5' }}>{e.nome}</div>
                  <div style={{ fontSize: 12, color: '#6ee7b7' }}>
                    {e.forma_pagamento === 'pix' ? '📱 Pix' : '💵 Dinheiro'}
                    {(e.trocos_descontados || []).length > 0 && <span style={{ color: C.success }}> · −{fmt(e.trocos_descontados.reduce((a, t) => a + t.valor, 0))} troco</span>}
                    {e.editado && <span style={{ color: C.gold }}> · ✏️ editado</span>}
                  </div>
                  {e.obs && <div style={{ fontSize: 11, color: '#6ee7b7aa', fontStyle: 'italic', marginTop: 2 }}>"{e.obs}"</div>}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: '#34d399' }}>{fmt(e.valor_final)}</div>
                  <button onClick={() => setModal({ type: 'editarPagamento', extra: e })}
                    style={{ background: 'none', border: `1px solid ${C.gold}55`, borderRadius: 8, color: C.gold, fontSize: 11, padding: '3px 8px', cursor: 'pointer', marginTop: 4, fontWeight: 700 }}>
                    ✏️ Editar
                  </button>
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
    if (trocosSelecionados.length > 0) {
      msg += `\n\nDescontos de troco aplicados:`
      trocosSelecionados.forEach(t => { msg += `\n• ${dayLabel(t.data)}: −${fmt(t.valor)}` })
      msg += `\n\nValor final a pagar: ${fmt(valorCents)}`
    }
    msg += `\n\nREF: ${ref}\nTipo da chave: ${pessoa?.tipo_pix || '—'}\n\nCHAVE PIX:\n${pessoa?.chave_pix || '—'}`
    return msg
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
        <div style={{ ...S.card, background: '#f5f0e8' }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{extra.nome}</div>
          <div style={{ fontSize: 13, color: '#8a7355' }}>{extra.funcao}{extra.turnos ? ' · ' + extra.turnos : ''}</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#c9a96e' }}>{fmt(valorBase)}</div>
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
  const { extras, updateExtra } = store
  const todayExtras = useMemo(() => extras.filter(e => e.data_op === today), [extras, today])
  const [copied, setCopied] = useState({})
  const getText = (e) => `EXTRA ${e.nome} ${e.funcao}${e.turnos ? ' ' + e.turnos : ''}`
  const copy = async (e) => {
    try { await navigator.clipboard.writeText(getText(e)) } catch { }
    setCopied(p => ({ ...p, [e.id]: true }))
    setTimeout(() => setCopied(p => ({ ...p, [e.id]: false })), 2000)
  }
  return (
    <div>
      <div style={{ ...S.card, background: '#f5f0e8', marginBottom: 12 }}><div style={{ fontSize: 13, color: '#8a7355' }}>Copie o texto e cole no sistema interno. O valor deve ser lançado manualmente.</div></div>
      {todayExtras.length === 0 && <div style={{ ...S.card, textAlign: 'center', padding: 32, color: '#999' }}><div style={{ fontSize: 32 }}>📋</div><div>Nenhum extra hoje</div></div>}
      {todayExtras.map(e => (
        <div key={e.id} style={S.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontFamily: 'monospace', fontSize: 14, color: '#2d2d2d' }}>{getText(e)}</div>
              <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>{fmt(e.valor_final)} · {e.pago ? (e.forma_pagamento === 'pix' ? '📱 Pix' : '💵 Dinheiro') : '⏳ Pendente'}</div>
              {(e.trocos_descontados || []).length > 0 && (
                <div style={{ fontSize: 11, color: '#ef4444' }}>Troco descontado: −{fmt(e.trocos_descontados.reduce((a, t) => a + t.valor, 0))}</div>
              )}
              {e.troco_gerado > 0 && (
                <div style={{ fontSize: 11, color: '#f59e0b' }}>Troco gerado: +{fmt(e.troco_gerado)}</div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => copy(e)} style={{ ...S.btn(copied[e.id] ? '#22c55e' : '#c9a96e'), flex: 'none', padding: '8px 12px' }}>{copied[e.id] ? '✓' : '📋'}</button>
              <button onClick={() => updateExtra(e.id, { lancado: !e.lancado })} style={{ ...S.btn(e.lancado ? '#22c55e' : '#e0d5c5'), flex: 'none', padding: '8px 12px', color: e.lancado ? '#fff' : '#666' }}>{e.lancado ? '✓' : '○'}</button>
            </div>
          </div>
          {e.pago && <div style={{ marginTop: 6 }}>{e.lancado ? <Badge color="#22c55e">✓ Lançado</Badge> : <Badge color="#f59e0b">Não lançado</Badge>}</div>}
        </div>
      ))}
    </div>
  )
}

// ─── ABA RELATÓRIOS ───────────────────────────────────────────────────────────

// ─── EXPORTAR RELATÓRIO ───────────────────────────────────────────────────────

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


function TabRelatorios({ store }) {
  const { extras, pessoas, setores, config } = store
  const [subTela, setSubTela] = useState('geral')
  const [pessoaSelecionada, setPessoaSelecionada] = useState(null)
  const today = todayOp(config)

  // Datas para filtros
  const [filtro, setFiltro] = useState('semana')
  const [dataInicio, setDataInicio] = useState(today)
  const [dataFim, setDataFim] = useState(today)

  const ontem = toDateStr(new Date(new Date(today + 'T12:00:00').getTime() - 86400000))
  const weekStart = toDateStr(new Date(new Date(today + 'T12:00:00').setDate(new Date(today + 'T12:00:00').getDate() - 6)))
  const monthStart = today.slice(0, 7) + '-01'
  const semAnteriorFim = toDateStr(new Date(new Date(weekStart + 'T12:00:00').getTime() - 86400000))
  const semAnteriorStart = toDateStr(new Date(new Date(semAnteriorFim + 'T12:00:00').getTime() - 6 * 86400000))
  const mesAnteriorStart = new Date(today).getFullYear() + '-' + String(new Date(today).getMonth()).padStart(2,'0') + '-01'

  const ranges = { hoje: [today, today], ontem: [ontem, ontem], semana: [weekStart, today], mes: [monthStart, today], livre: [dataInicio, dataFim] }
  const [from, to] = ranges[filtro] || [weekStart, today]

  const pagos = useMemo(() => extras.filter(e => e.pago && e.data_op >= from && e.data_op <= to), [extras, from, to])
  const pagosAntSem = useMemo(() => extras.filter(e => e.pago && e.data_op >= semAnteriorStart && e.data_op <= semAnteriorFim), [extras])
  const pagosAntMes = useMemo(() => extras.filter(e => e.pago && e.data_op >= mesAnteriorStart && e.data_op < monthStart), [extras])
  const pagosHoje = useMemo(() => extras.filter(e => e.pago && e.data_op === today), [extras, today])

  const totalCusto = useMemo(() => pagos.reduce((a, e) => a + e.valor_final, 0), [pagos])
  const totalAntSem = useMemo(() => pagosAntSem.reduce((a, e) => a + e.valor_final, 0), [pagosAntSem])

  // Enriquece extras com dados da pessoa
  const extrasComPessoa = useMemo(() => pagos.map(e => {
    const p = pessoas.find(x => x.id === e.pessoa_id)
    return { ...e, interno_casa: p?.interno_casa || false, obs_fixa: p?.obs_fixa || '' }
  }), [pagos, pessoas])

  const internos = useMemo(() => extrasComPessoa.filter(e => e.interno_casa), [extrasComPessoa])
  const externos = useMemo(() => extrasComPessoa.filter(e => !e.interno_casa), [extrasComPessoa])
  const totalPix = useMemo(() => pagos.filter(e => e.forma_pagamento === 'pix').reduce((a, e) => a + e.valor_final, 0), [pagos])
  const totalDin = useMemo(() => pagos.filter(e => e.forma_pagamento === 'dinheiro').reduce((a, e) => a + e.valor_final, 0), [pagos])

  // Variação vs semana anterior
  const variacaoSem = totalAntSem > 0 ? Math.round(((totalCusto - totalAntSem) / totalAntSem) * 100) : 0
  const corVariacao = variacaoSem > 15 ? '#ef4444' : variacaoSem > 0 ? '#f59e0b' : '#22c55e'

  // Custo médio por turno
  const diasUnicos = useMemo(() => [...new Set(pagos.map(e => e.data_op))], [pagos])
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
    if (variacaoSem > 20) lista.push({ cor: '#ef4444', msg: `Custo ${variacaoSem}% acima da semana anterior` })
    if (variacaoSem < -15) lista.push({ cor: '#22c55e', msg: `Custo ${Math.abs(variacaoSem)}% abaixo da semana anterior` })
    const pctInternos = pagos.length > 0 ? Math.round((internos.length / pagos.length) * 100) : 0
    if (pctInternos > 40) lista.push({ cor: '#f59e0b', msg: `${pctInternos}% dos extras são funcionários da casa` })
    const cozinhaExternos = extrasComPessoa.filter(e => { const s = setores.find(x => x.id === e.setor_id); return s?.nome?.toLowerCase().includes('cozinha') && !e.interno_casa })
    if (cozinhaExternos.length > 5) lista.push({ cor: '#f59e0b', msg: `Cozinha com alta dependência de externos (${cozinhaExternos.length} extras)` })
    const ndExtras = pagos.filter(e => e.turnos === 'TD+TN')
    if (ndExtras.length > 3) lista.push({ cor: '#f59e0b', msg: `${ndExtras.length} extras em jornada dupla (Dia+Noite)` })
    const obsImportantes = extrasComPessoa.filter(e => e.obs_fixa && e.obs_fixa.length > 0)
    if (obsImportantes.length > 0) lista.push({ cor: '#3b82f6', msg: `${obsImportantes.length} extras com observações importantes` })
    if (pagosHoje.length === 0 && today === from) lista.push({ cor: '#8a7355', msg: 'Nenhum pagamento registrado hoje ainda' })
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
    <div>
      {/* Header Dashboard */}
      <div style={{ ...S.card, background: 'linear-gradient(135deg,#1a1a2e,#2d2340)', color: '#fff', marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: '#c9a96e', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Dashboard Operacional</div>
        <div style={{ fontSize: 11, color: '#ffffff50', marginTop: 2 }}>Inteligência de extras em tempo real</div>
      </div>

      {/* Filtro período */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {[['hoje','Hoje'],['ontem','Ontem'],['semana','7 dias'],['mes','Mês'],['livre','📅']].map(([f, label]) => (
          <button key={f} onClick={() => setFiltro(f)}
            style={{ padding: '5px 10px', border: `2px solid ${filtro === f ? '#c9a96e' : '#e0d5c5'}`, borderRadius: 20, background: filtro === f ? '#c9a96e' : '#fff', color: filtro === f ? '#fff' : '#666', fontSize: 12, fontWeight: filtro === f ? 700 : 400, cursor: 'pointer' }}>
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

      {/* Sub-navegação */}
      <div style={{ display: 'flex', gap: 4, background: '#f0e8d8', padding: 4, borderRadius: 12, marginBottom: 14 }}>
        {[['geral','🔴 Geral'],['equipe','👥 Equipe'],['turnos','🌙 Turnos'],['setores','📁 Setores']].map(([id, label]) => (
          <button key={id} onClick={() => setSubTela(id)}
            style={{ flex: 1, padding: '8px 2px', border: 'none', borderRadius: 8, background: subTela === id ? '#fff' : 'transparent', cursor: 'pointer', fontSize: 11, fontWeight: subTela === id ? 700 : 400, color: subTela === id ? '#c9a96e' : '#999' }}>
            {label}
          </button>
        ))}
      </div>

      {/* ─── GERAL ─── */}
      {subTela === 'geral' && <>
        {/* Alertas */}
        {alertas.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            {alertas.map((a, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, background: a.cor + '15', border: `1px solid ${a.cor}44`, borderRadius: 8, padding: '8px 12px', marginBottom: 6 }}>
                <span style={{ fontSize: 16 }}>⚡</span>
                <span style={{ fontSize: 12, color: a.cor, fontWeight: 600 }}>{a.msg}</span>
              </div>
            ))}
          </div>
        )}

        {/* Cards principais */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
          <div style={{ ...S.card, margin: 0, textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: '#8a7355', textTransform: 'uppercase' }}>💰 Custo Total</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#c9a96e' }}>{fmt(totalCusto)}</div>
            {variacaoSem !== 0 && <div style={{ fontSize: 10, color: corVariacao, fontWeight: 600 }}>{variacaoSem > 0 ? '↑' : '↓'} {Math.abs(variacaoSem)}% vs sem. ant.</div>}
          </div>
          <div style={{ ...S.card, margin: 0, textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: '#8a7355', textTransform: 'uppercase' }}>👥 Extras</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#1a1a2e' }}>{pagos.length}</div>
            <div style={{ fontSize: 10, color: '#8a7355' }}>Média {mediaCustoPorDia > 0 ? fmt(mediaCustoPorDia) : '—'}/dia</div>
          </div>
          <div style={{ ...S.card, margin: 0, textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: '#8a7355', textTransform: 'uppercase' }}>🏠 Internos</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#3b82f6' }}>{internos.length}</div>
            <div style={{ fontSize: 10, color: pagos.length > 0 && (internos.length/pagos.length) > 0.4 ? '#f59e0b' : '#8a7355' }}>
              {pagos.length > 0 ? Math.round((internos.length/pagos.length)*100) : 0}% do total
            </div>
          </div>
          <div style={{ ...S.card, margin: 0, textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: '#8a7355', textTransform: 'uppercase' }}>🚶 Externos</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#8a7355' }}>{externos.length}</div>
            <div style={{ fontSize: 10, color: '#8a7355' }}>{pagos.length > 0 ? Math.round((externos.length/pagos.length)*100) : 0}% do total</div>
          </div>
        </div>

        {/* Pix vs Dinheiro */}
        <div style={S.card}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#8a7355', marginBottom: 10 }}>💳 Forma de Pagamento</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: '#22c55e' }}>💵 Dinheiro</div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{fmt(totalDin)}</div>
            </div>
            <div style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: '#3b82f6' }}>📱 Pix</div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{fmt(totalPix)}</div>
            </div>
          </div>
          {totalCusto > 0 && (
            <div style={{ height: 8, background: '#f0e8d8', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: (totalDin/totalCusto*100)+'%', background: '#22c55e', borderRadius: 4 }} />
            </div>
          )}
        </div>

        {/* Heatmap por dia da semana */}
        <div style={S.card}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#8a7355', marginBottom: 10 }}>📅 Custo por dia da semana</div>
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
      {subTela === 'turnos' && <>
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
      </>}

      {/* ─── SETORES ─── */}
      {subTela === 'setores' && <>
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
    </div>
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
  const [novoSetor, setNovoSetor] = useState('')
  const [nomeEstab, setNomeEstab] = useState(config.nome_estabelecimento)
  const [whatsapp, setWhatsapp] = useState(config.whatsapp_pix)
  const [horaVirada, setHoraVirada] = useState(String(config.horario_virada_h).padStart(2, '0'))
  const [minVirada, setMinVirada] = useState(String(config.horario_virada_m).padStart(2, '0'))
  const [savedMsg, setSavedMsg] = useState('')

  const salvarGeral = () => {
    updateConfig({
      nome_estabelecimento: nomeEstab.trim() || 'ARACÁ GRILL',
      whatsapp_pix: whatsapp.replace(/\D/g, ''),
      horario_virada_h: Math.min(23, Math.max(0, parseInt(horaVirada) || 2)),
      horario_virada_m: Math.min(59, Math.max(0, parseInt(minVirada) || 30)),
    })
    setSavedMsg('✓ Salvo!')
    setTimeout(() => setSavedMsg(''), 2500)
  }

  return (
    <div>
      <div style={S.card}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14 }}>🏠 Estabelecimento</div>
        <div style={{ marginBottom: 10 }}>
          <label style={S.label}>Nome do estabelecimento</label>
          <input value={nomeEstab} onChange={e => setNomeEstab(e.target.value)} style={S.input} placeholder="Ex: ARACÁ GRILL" />
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={S.label}>WhatsApp para envio do Pix</label>
          <input value={whatsapp} onChange={e => setWhatsapp(e.target.value)} style={S.input} placeholder="5518999999999" inputMode="numeric" />
          <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>Com DDI+DDD, sem espaços. Ex: 5518996530959</div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={S.label}>Horário de virada do dia operacional</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input value={horaVirada} onChange={e => setHoraVirada(e.target.value)} style={{ ...S.input, width: 64, textAlign: 'center' }} placeholder="02" inputMode="numeric" maxLength={2} />
            <span style={{ fontWeight: 700, color: '#8a7355' }}>:</span>
            <input value={minVirada} onChange={e => setMinVirada(e.target.value)} style={{ ...S.input, width: 64, textAlign: 'center' }} placeholder="30" inputMode="numeric" maxLength={2} />
            <span style={{ fontSize: 12, color: '#999' }}>horas</span>
          </div>
          <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>Antes desse horário o sistema usa a data do dia anterior.</div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={S.label}>Senha mestre de emergência</label>
          <input
            type="password"
            value={config.senha_mestre || ''}
            onChange={e => updateConfig({ senha_mestre: e.target.value })}
            style={S.input}
            placeholder="Deixe em branco para desativar"
          />
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
            Com essa senha qualquer usuário consegue logar como admin de emergência.
          </div>
        </div>
        <button onClick={salvarGeral} style={{ ...S.btn(savedMsg ? C.success : C.primary) }}>
          {savedMsg || 'Salvar configurações'}
        </button>
      </div>

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

      <div style={S.card}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>👥 Pessoas ({pessoas.length})</div>
        {pessoas.length === 0 && <div style={{ fontSize: 13, color: '#999', textAlign: 'center', padding: 16 }}>Nenhuma pessoa cadastrada</div>}
        {pessoas.map(p => (
          <div key={p.id} style={{ padding: '10px 0', borderBottom: '1px solid #f0e8d8' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{p.nome}</div>
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

      {/* Usuários */}
      <SecaoUsuarios />

      {/* Assinaturas */}
      <SecaoAssinaturas store={store} />

      {/* Zona de perigo */}
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

      <div style={{ ...S.card, background: C.bgCard2, border: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 12, color: C.secondary, fontWeight: 700 }}>ℹ️ {config.nome_estabelecimento} v2.0</div>
        <div style={{ fontSize: 12, color: C.textMuted }}>Sistema operacional de extras · Firebase Firestore</div>
      </div>
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
    const alteracoes = {
      valor_final: novoValor,
      forma_pagamento: forma,
      obs: obs.trim(),
      editado: true,
      editado_por: usuario?.nome || 'desconhecido',
      editado_em: new Date().toISOString(),
      motivo_edicao: motivoEdicao.trim(),
    }
    await updateExtra(extra.id, alteracoes)
    await registrarLog('edicao_pagamento', {
      extra_id: extra.id,
      nome: extra.nome,
      valor_anterior: extra.valor_final,
      valor_novo: novoValor,
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
