import { useState, useEffect, useRef } from 'react'
import { db } from './firebase'
import { collection, addDoc, updateDoc, doc, onSnapshot, deleteDoc } from 'firebase/firestore'

const fmt = (cents) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((cents || 0) / 100)
const parseCents = (str) => parseInt(String(str).replace(/\D/g, '') || '0', 10)
const DIAS = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB']
const toDateStr = (d) => d.toISOString().slice(0, 10)

const DEFAULT_CONFIG = {
  nome_estabelecimento: 'ARACÁ GRILL',
  whatsapp_pix: '5518996530959',
  horario_virada_h: 2,
  horario_virada_m: 30,
}

const getConfig = () => {
  try {
    const saved = localStorage.getItem('araca_config')
    return saved ? { ...DEFAULT_CONFIG, ...JSON.parse(saved) } : { ...DEFAULT_CONFIG }
  } catch { return { ...DEFAULT_CONFIG } }
}

const saveConfig = (cfg) => {
  try { localStorage.setItem('araca_config', JSON.stringify(cfg)) } catch {}
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
  const d = new Date(dateStr + 'T12:00:00')
  return DIAS[d.getDay()] + ' ' + String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0')
}

const isWeekend = (dateStr) => {
  const d = new Date(dateStr + 'T12:00:00')
  return [5, 6, 0].includes(d.getDay())
}

const calcNotes = (cents) => {
  let rem = cents
  const n = { 100: 0, 50: 0, 20: 0, 10: 0 }
  ;[100, 50, 20, 10].forEach(v => { n[v] = Math.floor(rem / (v * 100)); rem = rem % (v * 100) })
  return n
}

const S = {
  app: { minHeight: '100vh', background: '#f5f0e8', fontFamily: 'Georgia, serif', maxWidth: 480, margin: '0 auto' },
  header: { background: 'linear-gradient(135deg,#1a1a2e,#2d2340)', padding: '16px 20px 12px', color: '#fff', position: 'sticky', top: 0, zIndex: 100 },
  content: { padding: 16, paddingBottom: 90 },
  nav: { position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '100%', maxWidth: 480, background: '#fff', borderTop: '1px solid #e8dfd0', display: 'flex', zIndex: 100 },
  card: { background: '#fff', borderRadius: 14, padding: 16, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', border: '1px solid #f0e8d8', marginBottom: 12 },
  input: { width: '100%', padding: '10px 12px', border: '1.5px solid #e0d5c5', borderRadius: 8, fontFamily: 'inherit', fontSize: 14, background: '#fefcf8', boxSizing: 'border-box', color: '#2d2d2d' },
  label: { fontSize: 12, fontWeight: 600, color: '#8a7355', marginBottom: 4, display: 'block', textTransform: 'uppercase', letterSpacing: '0.05em' },
  btn: (bg) => ({ background: bg, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 16px', fontFamily: 'inherit', fontSize: 14, cursor: 'pointer', flex: 1 }),
  modal: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modalBox: { background: '#fff', borderRadius: '20px 20px 0 0', padding: '20px 20px 32px', width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto' },
}

const Badge = ({ children, color = '#c9a96e' }) => (
  <span style={{ background: color + '22', color, border: `1px solid ${color}44`, borderRadius: 20, padding: '2px 8px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{children}</span>
)

const Modal = ({ children, onClose, title }) => (
  <div style={S.modal}>
    <div style={S.modalBox}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 17 }}>{title}</h3>
        <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#999' }}>✕</button>
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
      <canvas ref={ref} width={320} height={150}
        style={{ border: '2px solid #c9a96e', borderRadius: 8, background: '#fafafa', touchAction: 'none', width: '100%', height: 150 }}
        onMouseDown={start} onMouseMove={draw} onMouseUp={end}
        onTouchStart={start} onTouchMove={draw} onTouchEnd={end} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={clear} style={S.btn('#999')}>Limpar</button>
        <button onClick={onCancel} style={S.btn('#666')}>Cancelar</button>
        <button onClick={() => onSave(ref.current.toDataURL())} style={{ ...S.btn('#c9a96e'), flex: 2, fontWeight: 700 }}>Confirmar</button>
      </div>
    </div>
  )
}

// ─── APP PRINCIPAL ────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState('extras')
  const [extras, setExtras] = useState([])
  const [pessoas, setPessoas] = useState([])
  const [setores, setSetores] = useState([])
  const [modal, setModal] = useState(null)
  const [config, setConfig] = useState(getConfig)

  const today = todayOp(config)

  const updateConfig = (changes) => {
    const novo = { ...config, ...changes }
    setConfig(novo)
    saveConfig(novo)
  }

  useEffect(() => {
    const unsubs = [
      onSnapshot(collection(db, 'extras'), s => setExtras(s.docs.map(d => ({ id: d.id, ...d.data() })))),
      onSnapshot(collection(db, 'pessoas'), s => setPessoas(s.docs.map(d => ({ id: d.id, ...d.data() })))),
      onSnapshot(collection(db, 'setores'), s => {
        const data = s.docs.map(d => ({ id: d.id, ...d.data() }))
        if (data.length === 0) {
          ['Cozinha', 'Churrasqueira', 'Atendimento', 'Bar', 'Limpeza', 'Música'].forEach(nome =>
            addDoc(collection(db, 'setores'), { nome, ativo: true })
          )
        } else setSetores(data)
      }),
    ]
    return () => unsubs.forEach(u => u())
  }, [])

  const addExtra = async (data) => await addDoc(collection(db, 'extras'), data)
  const updateExtra = async (id, data) => await updateDoc(doc(db, 'extras', id), data)
  const removeExtra = async (id) => await deleteDoc(doc(db, 'extras', id))
  const addPessoa = async (data) => await addDoc(collection(db, 'pessoas'), { ...data, ajuste_pendente: 0 })
  const updatePessoa = async (id, data) => await updateDoc(doc(db, 'pessoas', id), data)
  const removePessoa = async (id) => await deleteDoc(doc(db, 'pessoas', id))
  const addSetor = async (data) => await addDoc(collection(db, 'setores'), data)
  const updateSetor = async (id, data) => await updateDoc(doc(db, 'setores', id), data)
  const removeSetor = async (id) => await deleteDoc(doc(db, 'setores', id))

  const store = {
    extras, pessoas, setores, config, updateConfig,
    addExtra, updateExtra, removeExtra,
    addPessoa, updatePessoa, removePessoa,
    addSetor, updateSetor, removeSetor,
  }

  const tabs = [
    { id: 'extras', icon: '👤', label: 'Extras' },
    { id: 'pagamentos', icon: '💳', label: 'Pagamentos' },
    { id: 'lancamentos', icon: '📋', label: 'Lançamentos' },
    { id: 'relatorios', icon: '📊', label: 'Relatórios' },
    { id: 'config', icon: '⚙️', label: 'Config' },
  ]

  return (
    <div style={S.app}>
      <div style={S.header}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 11, color: '#c9a96e', letterSpacing: '0.15em', textTransform: 'uppercase' }}>Sistema Operacional</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{config.nome_estabelecimento}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: '#c9a96e80' }}>Data operacional</div>
            <div style={{ fontSize: 14, color: '#c9a96e', fontWeight: 600 }}>{dayLabel(today)}</div>
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
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ flex: 1, border: 'none', background: 'none', padding: '10px 4px 12px', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <span style={{ fontSize: 20 }}>{t.icon}</span>
            <span style={{ fontSize: 9, color: tab === t.id ? '#c9a96e' : '#999', fontWeight: tab === t.id ? 700 : 400, fontFamily: 'sans-serif', textTransform: 'uppercase' }}>{t.label}</span>
            {tab === t.id && <div style={{ width: 20, height: 2, background: '#c9a96e', borderRadius: 1 }} />}
          </button>
        ))}
      </div>

      {modal?.type === 'addExtra'   && <ModalAddExtra store={store} today={today} onClose={() => setModal(null)} />}
      {modal?.type === 'editExtra'  && <ModalEditExtra store={store} extra={modal.extra} onClose={() => setModal(null)} />}
      {modal?.type === 'pagar'      && <ModalPagar store={store} extra={modal.extra} onClose={() => setModal(null)} />}
      {modal?.type === 'addPessoa'  && <ModalAddPessoa store={store} onClose={() => setModal(null)} />}
      {modal?.type === 'editPessoa' && <ModalEditPessoa store={store} pessoa={modal.pessoa} onClose={() => setModal(null)} />}
    </div>
  )
}

// ─── ABA EXTRAS ───────────────────────────────────────────────────────────────

function TabExtras({ store, today, setModal }) {
  const { extras, pessoas, setores, removeExtra, addExtra } = store
  const todayExtras = extras.filter(e => e.data_op === today)
  const total = todayExtras.reduce((a, e) => a + e.valor_final, 0)

  const duplicar = async () => {
    const ontem
