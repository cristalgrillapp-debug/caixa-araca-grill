import { imprimirRecibos } from './impressao'
import { useState, useEffect, useRef, useMemo } from 'react'
import { db } from './firebase'
import { collection, addDoc, updateDoc, setDoc, doc, onSnapshot, deleteDoc, runTransaction, getDoc, query, where, orderBy, limit, getDocs } from 'firebase/firestore'

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
    { id: 'relatorios', icon: '📊', label: 'Relatórios' },
    ...(usuario?.role === 'admin' ? [{ id: 'config', icon: '⚙️', label: 'Config' }] : []),
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
            <div style={{ fontSize: 10, color: '#ffffff50', marginTop: 2 }}>👤 {usuario.nome}</div>
            <button onClick={onLogout} style={{ background: 'none', border: '1px solid #ffffff30', borderRadius: 4, color: '#ffffff60', fontSize: 10, padding: '2px 6px', cursor: 'pointer', marginTop: 2 }}>Sair</button>
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
          <button key={t.id} onClick={() => setTab(t.id)} style={{ flex: 1, border: 'none', background: 'none', padding: '10px 4px 12px', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <span style={{ fontSize: 20 }}>{t.icon}</span>
            <span style={{ fontSize: 9, color: tab === t.id ? '#c9a96e' : '#999', fontWeight: tab === t.id ? 700 : 400, fontFamily: 'sans-serif', textTransform: 'uppercase' }}>{t.label}</span>
            {tab === t.id && <div style={{ width: 20, height: 2, background: '#c9a96e', borderRadius: 1 }} />}
          </button>
        ))}
      </div>
      {modal?.type === 'addExtra'   && <ModalAddExtra store={store} today={today} onClose={() => setModal(null)} />}
      {modal?.type === 'editExtra'  && <ModalEditExtra store={store} extra={modal.extra} onClose={() => setModal(null)} />}
      {modal?.type === 'pagar'      && <ModalPagar store={store} extra={modal.extra} today={today} onClose={() => setModal(null)} />}
      {modal?.type === 'addPessoa'  && <ModalAddPessoa store={store} onClose={() => setModal(null)} />}
      {modal?.type === 'editPessoa' && <ModalEditPessoa store={store} pessoa={modal.pessoa} onClose={() => setModal(null)} />}
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
        <button onClick={() => setModal({ type: 'addExtra' })} style={{ ...S.btn('#c9a96e'), flex: 3, fontWeight: 700 }}>+ Novo Extra</button>
        <button onClick={() => setModal({ type: 'addPessoa' })} style={{ ...S.btn('#6e7c8a'), flex: 2 }}>+ Pessoa</button>
        <button onClick={duplicar} style={{ ...S.btn('#8a7355'), flex: 2 }}>📋 Duplicar</button>
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
  const [nome, setNome] = useState('')
  const [funcao, setFuncao] = useState('')
  const [setorId, setSetorId] = useState('')
  const [turnos, setTurnos] = useState('')
  const [valorDisplay, setValorDisplay] = useState('')
  const [obs, setObs] = useState('')
  const pessoa = pessoas.find(p => p.id === pessoaId)

  useEffect(() => {
    if (!pessoa) return
    setNome(pessoa.nome); setFuncao(pessoa.funcao); setSetorId(pessoa.setor_id)
    const base = isWeekend(today) ? pessoa.val_sex_dom : pessoa.val_seg_qui
    const mult = turnos === 'TD+TN' ? 2 : 1
    setValorDisplay(fmt(base * mult))
  }, [pessoaId, turnos])

  const save = async () => {
    if (!nome.trim()) return alert('Nome obrigatório')
    const v = parseCents(valorDisplay)
    await addExtra({
      pessoa_id:          pessoaId || null,
      nome:               nome.trim(),
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
        <div><label style={S.label}>Pessoa cadastrada</label>
          <select value={pessoaId} onChange={e => setPessoaId(e.target.value)} style={S.input}>
            <option value="">— Selecionar —</option>
            {pessoas.map(p => <option key={p.id} value={p.id}>{p.nome}</option>)}
          </select>
        </div>
        <div><label style={S.label}>Nome *</label><input value={nome} onChange={e => setNome(e.target.value)} style={S.input} placeholder="Nome completo" /></div>
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
          <button onClick={onClose} style={S.btn('#999')}>Cancelar</button>
          <button onClick={save} style={{ ...S.btn('#c9a96e'), flex: 2, fontWeight: 700 }}>Salvar</button>
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
          <button onClick={onClose} style={S.btn('#999')}>Cancelar</button>
          <button onClick={save} style={{ ...S.btn('#c9a96e'), flex: 2, fontWeight: 700 }}>Salvar</button>
        </div>
      </div>
    </Modal>
  )
}

// ─── ABA PAGAMENTOS ───────────────────────────────────────────────────────────

function TabPagamentos({ store, today, setModal }) {
  const { extras, setores, pessoas, updateExtra, config } = store
  const pendentes = useMemo(() => extras.filter(e => e.data_op === today && !e.pago), [extras, today])
  const pagos = useMemo(() => extras.filter(e => e.data_op === today && e.pago), [extras, today])
  const dinheiroTotal = useMemo(() => pendentes.filter(e => e.previsao !== 'pix').reduce((a, e) => a + e.valor_final, 0), [pendentes])
  const pixTotal = useMemo(() => pendentes.filter(e => e.previsao === 'pix').reduce((a, e) => a + e.valor_final, 0), [pendentes])
  const notes = useMemo(() => calcNotes(dinheiroTotal), [dinheiroTotal])

  return (
    <div>
      <div style={{ ...S.card, background: 'linear-gradient(135deg,#1a1a2e,#2d2340)', color: '#fff' }}>
        <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}>
          <div style={{ flex: 1 }}><div style={{ fontSize: 10, color: '#c9a96e80', textTransform: 'uppercase' }}>💵 Dinheiro</div><div style={{ fontSize: 20, fontWeight: 700, color: '#c9a96e' }}>{fmt(dinheiroTotal)}</div></div>
          <div style={{ flex: 1 }}><div style={{ fontSize: 10, color: '#60a5fa80', textTransform: 'uppercase' }}>📱 Pix</div><div style={{ fontSize: 20, fontWeight: 700, color: '#60a5fa' }}>{fmt(pixTotal)}</div></div>
        </div>
        <div style={{ borderTop: '1px solid #ffffff15', paddingTop: 8 }}>
          <div style={{ fontSize: 11, color: '#c9a96e60', marginBottom: 4 }}>Notas necessárias</div>
          <div style={{ display: 'flex', gap: 10 }}>
            {Object.entries(notes).filter(([, q]) => q > 0).map(([n, q]) => (
              <div key={n} style={{ textAlign: 'center' }}><div style={{ fontSize: 16, fontWeight: 700, color: '#c9a96e' }}>{q}×</div><div style={{ fontSize: 10, color: '#ffffff60' }}>R${n}</div></div>
            ))}
            {Object.values(notes).every(q => q === 0) && <div style={{ fontSize: 12, color: '#ffffff40' }}>—</div>}
          </div>
        </div>
      </div>
      {/* Botões de impressão */}
      {pagos.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button
            onClick={() => imprimirRecibos(extras, pessoas, setores, config, 'dinheiro')}
            style={{ ...S.btn('#22c55e'), flex: 1, fontWeight: 700, fontSize: 13 }}>
            🖨️ Imprimir Dinheiro
          </button>
          <button
            onClick={() => imprimirRecibos(extras, pessoas, setores, config, 'pix')}
            style={{ ...S.btn('#3b82f6'), flex: 1, fontWeight: 700, fontSize: 13 }}>
            🖨️ Imprimir Pix
          </button>
        </div>
      )}
      {pendentes.map(e => {
        const setor = setores.find(s => s.id === e.setor_id)
        const pessoa = pessoas.find(p => p.id === e.pessoa_id)
        const trocosTotal = totalTrocos(pessoa?.trocos)
        const descontoAplicado = e.desconto_troco || 0
        return (
          <div key={e.id} style={{ ...S.card, borderLeft: '4px solid #c9a96e' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{e.nome}</div>
                <div style={{ fontSize: 12, color: '#8a7355' }}>{e.funcao}{e.turnos ? ' · ' + e.turnos : ''}{setor ? ' · ' + setor.nome : ''}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: '#c9a96e' }}>{fmt(e.valor_final)}</div>
                {descontoAplicado > 0 && (
                  <div style={{ fontSize: 11, color: '#22c55e', fontWeight: 600 }}>−{fmt(descontoAplicado)} desconto</div>
                )}
              </div>
            </div>

            {/* Troco pendente com botão de aplicar antes de pagar */}
            {trocosTotal > 0 && (
              <div style={{ background: '#fff5f5', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 10px', marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#ef4444', fontWeight: 700 }}>🔴 Troco a descontar</div>
                    {(pessoa?.trocos || []).map((t, i) => (
                      <div key={i} style={{ fontSize: 11, color: '#b91c1c' }}>• {dayLabel(t.data)}: {fmt(t.valor)}</div>
                    ))}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#b91c1c' }}>{fmt(trocosTotal)}</div>
                    <button
                      onClick={async () => {
                        if (!confirm(`Aplicar desconto de ${fmt(trocosTotal)} no valor de ${e.nome}?`)) return
                        const novoValor = Math.max(0, e.valor_final - trocosTotal)
                        await updateExtra(e.id, {
                          valor_final: novoValor,
                          desconto_troco: (e.desconto_troco || 0) + trocosTotal,
                          trocos_descontados: pessoa?.trocos || [],
                        })
                        if (pessoa) await store.updatePessoa(pessoa.id, { trocos: [] })
                      }}
                      style={{ marginTop: 4, background: '#ef4444', color: '#fff', border: 'none', borderRadius: 6, padding: '3px 8px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                      Aplicar −{fmt(trocosTotal)}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Forma de pagamento */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              {[['indefinido', '❓', '#999'], ['dinheiro', '💵', '#22c55e'], ['pix', '📱', '#3b82f6']].map(([v, icon, color]) => (
                <button key={v} onClick={() => updateExtra(e.id, { previsao: v })}
                  style={{ flex: 1, padding: '6px 4px', border: `2px solid ${e.previsao === v ? color : '#e0d5c5'}`, borderRadius: 8, background: e.previsao === v ? color + '20' : '#fff', cursor: 'pointer', fontSize: 11, color: e.previsao === v ? color : '#999', fontWeight: e.previsao === v ? 700 : 400 }}>
                  {icon} {v === 'indefinido' ? '?' : v.charAt(0).toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>

            <button onClick={() => setModal({ type: 'pagar', extra: e })}
              style={{ ...S.btn('#c9a96e'), fontWeight: 700, width: '100%', fontSize: 15 }}>
              💰 Pagar {fmt(e.valor_final)}
            </button>
          </div>
        )
      })}

      {/* ── PAGOS ── visual compacto e bem diferente */}
      {pagos.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 1, height: 1, background: '#22c55e40' }} />
            <span style={{ fontSize: 11, color: '#22c55e', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em' }}>✓ Pagos ({pagos.length})</span>
            <div style={{ flex: 1, height: 1, background: '#22c55e40' }} />
          </div>
          {pagos.map(e => (
            <div key={e.id} style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '8px 12px', marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: '#166534' }}>{e.nome}</div>
                <div style={{ fontSize: 11, color: '#15803d' }}>
                  {e.forma_pagamento === 'pix' ? '📱 Pix' : '💵 Dinheiro'}
                  {(e.trocos_descontados || []).length > 0 && ` · −${fmt(e.trocos_descontados.reduce((a, t) => a + t.valor, 0))} troco`}
                </div>
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#16a34a' }}>{fmt(e.valor_final)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── MODAL PAGAR ──────────────────────────────────────────────────────────────

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
          <button onClick={onClose} style={S.btn('#999')}>Cancelar</button>
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

function TabRelatorios({ store }) {
  const { extras, pessoas, setores, config } = store
  const [filtro, setFiltro] = useState('hoje')
  const [subTab, setSubTab] = useState('resumo')
  const [pessoaSelecionada, setPessoaSelecionada] = useState(null)
  const today = todayOp(config)
  const ontem = toDateStr(new Date(new Date(today + 'T12:00:00').getTime() - 86400000))
  const weekStart = toDateStr(new Date(new Date(today + 'T12:00:00').setDate(new Date(today + 'T12:00:00').getDate() - new Date(today + 'T12:00:00').getDay())))
  const monthStart = today.slice(0, 7) + '-01'

  // Datas livres
  const [dataInicio, setDataInicio] = useState(today)
  const [dataFim, setDataFim] = useState(today)

  const ranges = { hoje: [today, today], ontem: [ontem, ontem], semana: [weekStart, today], mes: [monthStart, today], livre: [dataInicio, dataFim] }
  const [from, to] = ranges[filtro] || [today, today]

  const filtered = useMemo(() =>
    extras.filter(e => e.data_op >= from && e.data_op <= to && e.pago),
  [extras, from, to])

  const total    = useMemo(() => filtered.reduce((a, e) => a + e.valor_final, 0), [filtered])
  const totalPix = useMemo(() => filtered.filter(e => e.forma_pagamento === 'pix').reduce((a, e) => a + e.valor_final, 0), [filtered])
  const totalDin = useMemo(() => filtered.filter(e => e.forma_pagamento === 'dinheiro').reduce((a, e) => a + e.valor_final, 0), [filtered])

  const porSetor = useMemo(() =>
    setores.map(s => ({
      nome:  s.nome,
      total: filtered.filter(e => e.setor_id === s.id).reduce((a, e) => a + e.valor_final, 0),
      qtd:   filtered.filter(e => e.setor_id === s.id).length,
    })).filter(s => s.qtd > 0).sort((a, b) => b.total - a.total),
  [filtered, setores])

  const porPessoa = useMemo(() =>
    pessoas.map(p => ({
      id:               p.id,
      nome:             p.nome,
      funcao:           p.funcao,
      pagamentos:       filtered.filter(e => e.pessoa_id === p.id).sort((a, b) => b.data_op.localeCompare(a.data_op)),
      total:            filtered.filter(e => e.pessoa_id === p.id).reduce((a, e) => a + e.valor_final, 0),
      qtd:              filtered.filter(e => e.pessoa_id === p.id).length,
      trocos:           totalTrocos(p.trocos),
      historico_trocos: p.trocos || [],
    })).filter(p => p.qtd > 0).sort((a, b) => b.total - a.total),
  [filtered, pessoas])

  return (
    <div>
      {/* Filtros rápidos */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {[['hoje','Hoje'],['ontem','Ontem'],['semana','Semana'],['mes','Mês'],['livre','📅 Livre']].map(([f, label]) => (
          <button key={f} onClick={() => setFiltro(f)}
            style={{ padding: '6px 12px', border: `2px solid ${filtro === f ? '#c9a96e' : '#e0d5c5'}`, borderRadius: 20, background: filtro === f ? '#c9a96e' : '#fff', color: filtro === f ? '#fff' : '#666', fontSize: 12, fontWeight: filtro === f ? 700 : 400, cursor: 'pointer' }}>
            {label}
          </button>
        ))}
      </div>

      {/* Datas livres */}
      {filtro === 'livre' && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <label style={S.label}>De</label>
            <input type="date" value={dataInicio} onChange={e => setDataInicio(e.target.value)} style={S.input} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Até</label>
            <input type="date" value={dataFim} onChange={e => setDataFim(e.target.value)} style={S.input} />
          </div>
        </div>
      )}

      {/* Sub abas */}
      <div style={{ display: 'flex', gap: 4, background: '#f0e8d8', padding: 4, borderRadius: 10, marginBottom: 12 }}>
        {['resumo', 'setor', 'funcionário'].map(t => (
          <button key={t} onClick={() => setSubTab(t)}
            style={{ flex: 1, padding: '8px 4px', border: 'none', borderRadius: 8, background: subTab === t ? '#fff' : 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: subTab === t ? 700 : 400, color: subTab === t ? '#c9a96e' : '#999' }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {subTab === 'resumo' && <>
        <div style={{ ...S.card, background: 'linear-gradient(135deg,#1a1a2e,#2d2340)', color: '#fff' }}>
          <div style={{ fontSize: 11, color: '#c9a96e60', textTransform: 'uppercase' }}>Total</div>
          <div style={{ fontSize: 32, fontWeight: 700, color: '#c9a96e' }}>{fmt(total)}</div>
          <div style={{ fontSize: 12, color: '#ffffff60' }}>{filtered.length} pagamentos</div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <div style={{ ...S.card, flex: 1, textAlign: 'center', margin: 0 }}><div style={{ fontSize: 11, color: '#22c55e' }}>💵</div><div style={{ fontSize: 18, fontWeight: 700 }}>{fmt(totalDin)}</div></div>
          <div style={{ ...S.card, flex: 1, textAlign: 'center', margin: 0 }}><div style={{ fontSize: 11, color: '#3b82f6' }}>📱</div><div style={{ fontSize: 18, fontWeight: 700 }}>{fmt(totalPix)}</div></div>
        </div>
        {filtered.slice().sort((a,b) => b.data_op.localeCompare(a.data_op)).slice(0, 20).map(e => {
          const setor = setores.find(s => s.id === e.setor_id)
          return <div key={e.id} style={{ ...S.card, padding: '10px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{e.nome}</div>
                <div style={{ fontSize: 11, color: '#8a7355' }}>{e.funcao}{setor ? ' · ' + setor.nome : ''} · {dayLabel(e.data_op)}</div>
                {e.troco_gerado > 0 && <div style={{ fontSize: 11, color: '#f59e0b' }}>+{fmt(e.troco_gerado)} troco gerado</div>}
                {(e.trocos_descontados || []).length > 0 && <div style={{ fontSize: 11, color: '#22c55e' }}>−{fmt(e.trocos_descontados.reduce((a, t) => a + t.valor, 0))} descontado</div>}
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#c9a96e' }}>{fmt(e.valor_final)}</div>
                {e.forma_pagamento === 'pix' ? <Badge color="#3b82f6">Pix</Badge> : <Badge color="#22c55e">Din</Badge>}
              </div>
            </div>
          </div>
        })}
      </>}

      {subTab === 'setor' && <>
        {porSetor.length === 0 && <div style={{ ...S.card, textAlign: 'center', padding: 32, color: '#999' }}>Sem dados</div>}
        {porSetor.map(s => <div key={s.nome} style={S.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div><div style={{ fontWeight: 700 }}>{s.nome}</div><div style={{ fontSize: 12, color: '#999' }}>{s.qtd} extras</div></div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#c9a96e' }}>{fmt(s.total)}</div>
          </div>
          <div style={{ marginTop: 8, height: 4, background: '#f0e8d8', borderRadius: 2 }}>
            <div style={{ height: '100%', background: '#c9a96e', borderRadius: 2, width: total ? ((s.total / total) * 100) + '%' : '0%' }} />
          </div>
        </div>)}
      </>}

      {subTab === 'funcionário' && <>
        {porPessoa.length === 0 && <div style={{ ...S.card, textAlign: 'center', padding: 32, color: '#999' }}>Sem dados</div>}
        <div style={{ fontSize: 12, color: '#8a7355', marginBottom: 8 }}>Toque num funcionário para ver o histórico completo</div>
        {porPessoa.map((p, i) => (
          <div key={p.nome} style={{ ...S.card, cursor: 'pointer' }} onClick={() => setPessoaSelecionada(p)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 16, fontWeight: 800, color: '#c9a96e' }}>#{i + 1}</span>
                  <span style={{ fontWeight: 700 }}>{p.nome}</span>
                </div>
                <div style={{ fontSize: 12, color: '#999' }}>{p.qtd} pagamentos · Média: {fmt(p.qtd ? Math.round(p.total / p.qtd) : 0)}</div>
                {p.trocos > 0 && <div style={{ fontSize: 11, color: '#ef4444', fontWeight: 600, marginTop: 2 }}>🔴 Troco pendente: {fmt(p.trocos)}</div>}
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#c9a96e' }}>{fmt(p.total)}</div>
                <div style={{ fontSize: 11, color: '#c9a96e' }}>Ver histórico →</div>
              </div>
            </div>
          </div>
        ))}
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
                  {desconto > 0 && <div style={{ fontSize: 11, color: '#22c55e' }}>−{fmt(desconto)} troco descontado</div>}
                  {e.troco_gerado > 0 && <div style={{ fontSize: 11, color: '#f59e0b' }}>+{fmt(e.troco_gerado)} troco gerado</div>}
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

        <button onClick={imprimir} style={{ ...S.btn('#1a1a2e'), fontWeight: 700, marginTop: 16 }}>
          🖨️ Imprimir histórico
        </button>
      </div>
    </Modal>
  )
}

// ─── MODAL ADICIONAR PESSOA ───────────────────────────────────────────────────

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

  const save = async () => {
    if (!nome.trim()) return alert('Nome obrigatório')
    await addPessoa({ nome: nome.trim(), funcao, telefone: tel, setor_id: setorId, val_seg_qui: parseCents(valSQ), val_sex_dom: parseCents(valSD), tipo_pix: tipoPix, chave_pix: chavePix.trim() })
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
          <div style={{ flex: 2 }}><label style={S.label}>Chave Pix</label><input value={chavePix} onChange={e => setChavePix(e.target.value)} style={S.input} /></div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={S.btn('#999')}>Cancelar</button>
          <button onClick={save} style={{ ...S.btn('#c9a96e'), flex: 2, fontWeight: 700 }}>Salvar</button>
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

  const save = async () => {
    if (!nome.trim()) return alert('Nome obrigatório')
    await updatePessoa(pessoa.id, { nome: nome.trim(), funcao, telefone: tel, setor_id: setorId, val_seg_qui: parseCents(valSQ), val_sex_dom: parseCents(valSD), tipo_pix: tipoPix, chave_pix: chavePix.trim() })
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
          <div style={{ flex: 2 }}><label style={S.label}>Chave Pix</label><input value={chavePix} onChange={e => setChavePix(e.target.value)} style={S.input} /></div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={S.btn('#999')}>Cancelar</button>
          <button onClick={save} style={{ ...S.btn('#c9a96e'), flex: 2, fontWeight: 700 }}>Salvar</button>
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
        <button onClick={salvarGeral} style={{ ...S.btn(savedMsg ? '#22c55e' : '#c9a96e'), fontWeight: 700 }}>
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
            style={{ ...S.btn('#c9a96e'), flex: 'none', padding: '10px 18px' }}>+</button>
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
        <button onClick={() => setModal({ type: 'addPessoa' })} style={{ ...S.btn('#6e7c8a'), marginTop: 12 }}>+ Nova Pessoa</button>
      </div>

      {/* Usuários */}
      <SecaoUsuarios />

      {/* Assinaturas */}
      <SecaoAssinaturas store={store} />

      <div style={{ ...S.card, background: '#fef3c7', border: '1px solid #f59e0b' }}>
        <div style={{ fontSize: 12, color: '#92400e', fontWeight: 700 }}>ℹ️ {config.nome_estabelecimento} v1.2</div>
        <div style={{ fontSize: 12, color: '#92400e80' }}>Sistema operacional de extras · Firebase Firestore</div>
      </div>
    </div>
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
    tela: { minHeight: '100vh', background: 'linear-gradient(135deg,#1a1a2e,#2d2340)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'Georgia, serif' },
    card: { background: '#fff', borderRadius: 20, padding: 28, width: '100%', maxWidth: 380, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' },
    input: { width: '100%', padding: '12px 14px', border: '1.5px solid #e0d5c5', borderRadius: 10, fontFamily: 'inherit', fontSize: 15, background: '#fefcf8', boxSizing: 'border-box', marginBottom: 12 },
    btn: (bg) => ({ width: '100%', padding: '13px', background: bg, color: '#fff', border: 'none', borderRadius: 10, fontFamily: 'inherit', fontSize: 15, fontWeight: 700, cursor: 'pointer', marginBottom: 8 }),
    erro: { color: '#ef4444', fontSize: 13, textAlign: 'center', marginBottom: 10 },
    link: { color: '#c9a96e', fontSize: 13, textAlign: 'center', cursor: 'pointer', textDecoration: 'underline' },
  }

  if (modo === 'aguardando') return (
    <div style={S2.tela}>
      <div style={S2.card}>
        <div style={{ textAlign: 'center', fontSize: 40, marginBottom: 12 }}>⏳</div>
        <div style={{ fontWeight: 700, fontSize: 18, textAlign: 'center', marginBottom: 8 }}>Cadastro enviado!</div>
        <div style={{ fontSize: 14, color: '#8a7355', textAlign: 'center', marginBottom: 20 }}>Aguarde o administrador aprovar seu acesso. Volte em breve.</div>
        <button onClick={() => setModo('login')} style={S2.btn('#c9a96e')}>Voltar ao login</button>
      </div>
    </div>
  )

  return (
    <div style={S2.tela}>
      <div style={{ textAlign: 'center', marginBottom: 24 }}>
        <div style={{ fontSize: 11, color: '#c9a96e', letterSpacing: '0.2em', textTransform: 'uppercase' }}>Sistema Operacional</div>
        <div style={{ fontSize: 28, fontWeight: 700, color: '#fff' }}>ARACÁ GRILL</div>
      </div>
      <div style={S2.card}>
        <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 20, textAlign: 'center', color: '#1a1a2e' }}>
          {modo === 'login' ? 'Entrar' : 'Solicitar Acesso'}
        </div>
        {modo === 'cadastro' && (
          <input value={nome} onChange={e => setNome(e.target.value)} style={S2.input} placeholder="Seu nome completo" />
        )}
        <input value={login} onChange={e => setLogin(e.target.value)} style={S2.input} placeholder="Usuário" autoCapitalize="none" />
        <input value={senha} onChange={e => setSenha(e.target.value)} style={S2.input} placeholder="Senha" type="password" />
        {erro ? <div style={S2.erro}>{erro}</div> : null}
        <button onClick={modo === 'login' ? entrar : cadastrar} disabled={loading}
          style={S2.btn(loading ? '#ccc' : '#c9a96e')}>
          {loading ? 'Aguarde...' : modo === 'login' ? 'Entrar' : 'Solicitar Acesso'}
        </button>
        <div style={S2.link} onClick={() => { setErro(''); setModo(modo === 'login' ? 'cadastro' : 'login') }}>
          {modo === 'login' ? 'Não tenho acesso — Solicitar cadastro' : 'Já tenho cadastro — Entrar'}
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
