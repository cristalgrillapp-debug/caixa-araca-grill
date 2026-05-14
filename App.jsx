import { useState, useEffect, useRef } from 'react'
import { db } from './firebase'
import { collection, addDoc, updateDoc, doc, onSnapshot, deleteDoc } from 'firebase/firestore'

const fmt = (cents) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((cents || 0) / 100)
const parseCents = (str) => parseInt(String(str).replace(/\D/g, '') || '0', 10)
const DIAS = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB']
const toDateStr = (d) => d.toISOString().slice(0, 10)
const todayOp = () => {
  const now = new Date()
  const h = now.getHours(), m = now.getMinutes()
  if (h < 2 || (h === 2 && m <= 30)) {
    const y = new Date(now); y.setDate(y.getDate() - 1); return toDateStr(y)
  }
  return toDateStr(now)
}
const dayLabel = (dateStr) => {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T12:00:00')
  return DIAS[d.getDay()] + ' ' + String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0')
}
const isWeekend = (dateStr) => { const d = new Date(dateStr + 'T12:00:00'); return [5, 6, 0].includes(d.getDay()) }
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
  const [tab, setTab] = useState('extras')
  const [extras, setExtras] = useState([])
  const [pessoas, setPessoas] = useState([])
  const [setores, setSetores] = useState([])
  const [modal, setModal] = useState(null)
  const today = todayOp()

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

  const store = { extras, pessoas, setores, addExtra, updateExtra, removeExtra, addPessoa, updatePessoa, removePessoa, addSetor }
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
            <div style={{ fontSize: 22, fontWeight: 700 }}>ARACÁ GRILL</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: '#c9a96e80' }}>Data operacional</div>
            <div style={{ fontSize: 14, color: '#c9a96e', fontWeight: 600 }}>{dayLabel(today)}</div>
          </div>
        </div>
      </div>
      <div style={S.content}>
        {tab === 'extras' && <TabExtras store={store} today={today} setModal={setModal} />}
        {tab === 'pagamentos' && <TabPagamentos store={store} today={today} setModal={setModal} />}
        {tab === 'lancamentos' && <TabLancamentos store={store} today={today} />}
        {tab === 'relatorios' && <TabRelatorios store={store} />}
        {tab === 'config' && <TabConfig store={store} />}
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
      {modal?.type === 'addExtra' && <ModalAddExtra store={store} today={today} onClose={() => setModal(null)} />}
      {modal?.type === 'pagar' && <ModalPagar store={store} extra={modal.extra} onClose={() => setModal(null)} />}
      {modal?.type === 'addPessoa' && <ModalAddPessoa store={store} onClose={() => setModal(null)} />}
    </div>
  )
}

function TabExtras({ store, today, setModal }) {
  const { extras, pessoas, setores, removeExtra, addExtra } = store
  const todayExtras = extras.filter(e => e.data_op === today)
  const total = todayExtras.reduce((a, e) => a + e.valor_final, 0)

  const duplicar = async () => {
    const ontem = toDateStr(new Date(new Date(today + 'T12:00:00').getTime() - 86400000))
    const ontemExtras = extras.filter(e => e.data_op === ontem)
    for (const e of ontemExtras) {
      const p = pessoas.find(x => x.id === e.pessoa_id)
      const val = p ? (isWeekend(today) ? p.val_sex_dom : p.val_seg_qui) : e.valor_final
      await addExtra({ ...e, id: undefined, data_op: today, data_real: toDateStr(new Date()), valor_final: val, valor_original: val, pago: false, previsao: 'indefinido', assinatura: null, lancado: false })
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
        return (
          <div key={e.id} style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{e.nome}</div>
                <div style={{ fontSize: 13, color: '#8a7355' }}>{e.funcao}{setor ? ' · ' + setor.nome : ''}</div>
                {e.turnos && <Badge>{e.turnos}</Badge>}
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#c9a96e' }}>{fmt(e.valor_final)}</div>
                {e.pago ? <Badge color="#22c55e">✓ Pago</Badge> : <Badge color="#f59e0b">Pendente</Badge>}
              </div>
            </div>
            {!e.pago && <button onClick={() => removeExtra(e.id)} style={{ marginTop: 10, background: 'none', border: '1px solid #f0e8d8', borderRadius: 6, padding: '4px 10px', fontSize: 12, color: '#999', cursor: 'pointer' }}>Remover</button>}
          </div>
        )
      })}
    </div>
  )
}

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
    await addExtra({ pessoa_id: pessoaId || null, nome: nome.trim(), funcao, setor_id: setorId, data_op: today, data_real: toDateStr(new Date()), turnos, valor_original: v, valor_final: v, obs, pago: false, previsao: 'indefinido', assinatura: null, forma_pagamento: null, lancado: false })
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

function TabPagamentos({ store, today, setModal }) {
  const { extras, setores, pessoas, updateExtra } = store
  const pendentes = extras.filter(e => e.data_op === today && !e.pago)
  const pagos = extras.filter(e => e.data_op === today && e.pago)
  const dinheiroTotal = pendentes.filter(e => e.previsao !== 'pix').reduce((a, e) => a + e.valor_final, 0)
  const pixTotal = pendentes.filter(e => e.previsao === 'pix').reduce((a, e) => a + e.valor_final, 0)
  const notes = calcNotes(dinheiroTotal)

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
      {pendentes.map(e => {
        const setor = setores.find(s => s.id === e.setor_id)
        const pessoa = pessoas.find(p => p.id === e.pessoa_id)
        return (
          <div key={e.id} style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
              <div>
                <div style={{ fontWeight: 700 }}>{e.nome}</div>
                <div style={{ fontSize: 12, color: '#8a7355' }}>{e.funcao}{e.turnos ? ' · ' + e.turnos : ''}{setor ? ' · ' + setor.nome : ''}</div>
                {pessoa?.ajuste_pendente > 0 && <div style={{ fontSize: 12, color: '#f59e0b' }}>⚠ Ajuste: {fmt(pessoa.ajuste_pendente)}</div>}
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#c9a96e' }}>{fmt(e.valor_final)}</div>
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              {[['indefinido', '❓', '#999'], ['dinheiro', '💵', '#22c55e'], ['pix', '📱', '#3b82f6']].map(([v, icon, color]) => (
                <button key={v} onClick={() => updateExtra(e.id, { previsao: v })} style={{ flex: 1, padding: '6px 4px', border: `2px solid ${e.previsao === v ? color : '#e0d5c5'}`, borderRadius: 8, background: e.previsao === v ? color + '20' : '#fff', cursor: 'pointer', fontSize: 11, color: e.previsao === v ? color : '#999', fontWeight: e.previsao === v ? 700 : 400 }}>
                  {icon} {v === 'indefinido' ? '?' : v.charAt(0).toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
            <button onClick={() => setModal({ type: 'pagar', extra: e })} style={{ ...S.btn('#c9a96e'), fontWeight: 700, width: '100%' }}>Efetuar Pagamento</button>
          </div>
        )
      })}
      {pagos.length > 0 && <>
        <div style={{ fontSize: 12, color: '#999', textAlign: 'center', padding: '4px 0' }}>— Pagos —</div>
        {pagos.map(e => (
          <div key={e.id} style={{ ...S.card, opacity: 0.7 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{e.nome}</div>
                <div style={{ fontSize: 12, color: '#8a7355' }}>{e.funcao}{e.turnos ? ' · ' + e.turnos : ''}</div>
                {e.forma_pagamento === 'pix' ? <Badge color="#3b82f6">📱 Pix</Badge> : <Badge color="#22c55e">💵 Dinheiro</Badge>}
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#22c55e' }}>{fmt(e.valor_final)}</div>
            </div>
          </div>
        ))}
      </>}
    </div>
  )
}

function ModalPagar({ store, extra, onClose }) {
  const { pessoas, updateExtra, updatePessoa } = store
  const pessoa = pessoas.find(p => p.id === extra.pessoa_id)
  const [step, setStep] = useState('escolha')
  const [forma, setForma] = useState(extra.previsao === 'pix' ? 'pix' : 'dinheiro')
  const [valorDisplay, setValorDisplay] = useState(fmt(extra.valor_final))
  const [assinatura, setAssinatura] = useState(null)
  const [aplicarAjuste, setAplicarAjuste] = useState(false)
  const ajuste = pessoa?.ajuste_pendente || 0
  const valorCents = parseCents(valorDisplay)

  const buildPixMsg = () => {
    const ref = dayLabel(extra.data_op)
    return `Pagar ${extra.nome} referente a extra de ${extra.funcao}${extra.turnos ? ' — ' + extra.turnos : ''} — valor ${fmt(extra.valor_final)}.\n\nREF: ${ref}\nTipo da chave: ${pessoa?.tipo_pix || '—'}\n\nCHAVE PIX:\n${pessoa?.chave_pix || '—'}`
  }

  const finalizar = async () => {
    await updateExtra(extra.id, { pago: true, forma_pagamento: forma, valor_final: valorCents, assinatura, data_pagamento: new Date().toISOString() })
    const diff = valorCents - extra.valor_final
    if (diff !== 0 && pessoa) await updatePessoa(pessoa.id, { ajuste_pendente: Math.max(0, ajuste + diff) })
    if (aplicarAjuste && pessoa && ajuste > 0) await updatePessoa(pessoa.id, { ajuste_pendente: Math.max(0, ajuste - Math.min(ajuste, extra.valor_final)) })
    if (forma === 'pix') window.open(`https://wa.me/5518996530959?text=${encodeURIComponent(buildPixMsg())}`, '_blank')
    onClose()
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
        <div style={{ ...S.card, background: '#f5f0e8' }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{extra.nome}</div>
          <div style={{ fontSize: 13, color: '#8a7355' }}>{extra.funcao}{extra.turnos ? ' · ' + extra.turnos : ''}</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#c9a96e' }}>{fmt(extra.valor_final)}</div>
          {ajuste > 0 && <div style={{ marginTop: 8, padding: 8, background: '#fef3c7', borderRadius: 6, fontSize: 12 }}>
            ⚠ Ajuste pendente: <strong>{fmt(ajuste)}</strong>
            <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={aplicarAjuste} onChange={e => setAplicarAjuste(e.target.checked)} />
              <span>Aplicar desconto (sugerido: {fmt(Math.max(0, extra.valor_final - ajuste))})</span>
            </div>
          </div>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setForma('dinheiro')} style={{ flex: 1, padding: '12px', border: `2px solid ${forma === 'dinheiro' ? '#22c55e' : '#e0d5c5'}`, borderRadius: 10, background: forma === 'dinheiro' ? '#22c55e20' : '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: forma === 'dinheiro' ? '#22c55e' : '#999' }}>💵 Dinheiro</button>
          <button onClick={() => setForma('pix')} style={{ flex: 1, padding: '12px', border: `2px solid ${forma === 'pix' ? '#3b82f6' : '#e0d5c5'}`, borderRadius: 10, background: forma === 'pix' ? '#3b82f620' : '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: forma === 'pix' ? '#3b82f6' : '#999' }}>📱 Pix</button>
        </div>
        <div><label style={S.label}>Valor pago</label>
          <input value={valorDisplay} onChange={e => { const r = e.target.value.replace(/\D/g, ''); setValorDisplay(r ? fmt(parseInt(r)) : '') }} style={{ ...S.input, fontSize: 18, fontWeight: 700 }} inputMode="numeric" />
        </div>
        {forma === 'pix' && pessoa && <div style={{ ...S.card, background: '#eff6ff', border: '1px solid #bfdbfe' }}>
          <div style={{ fontSize: 12, color: '#1e40af', fontWeight: 600, marginBottom: 4 }}>Dados do Pix</div>
          <div style={{ fontSize: 13 }}><strong>Tipo:</strong> {pessoa.tipo_pix}</div>
          <div style={{ fontSize: 13 }}><strong>Chave:</strong> {pessoa.chave_pix}</div>
        </div>}
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

function TabLancamentos({ store, today }) {
  const { extras, updateExtra } = store
  const todayExtras = extras.filter(e => e.data_op === today)
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

function TabRelatorios({ store }) {
  const { extras, pessoas, setores } = store
  const [filtro, setFiltro] = useState('hoje')
  const [subTab, setSubTab] = useState('resumo')
  const today = todayOp()
  const ontem = toDateStr(new Date(new Date(today + 'T12:00:00').getTime() - 86400000))
  const weekStart = toDateStr(new Date(new Date(today + 'T12:00:00').setDate(new Date(today + 'T12:00:00').getDate() - new Date(today + 'T12:00:00').getDay())))
  const monthStart = today.slice(0, 7) + '-01'
  const ranges = { hoje: [today, today], ontem: [ontem, ontem], semana: [weekStart, today], mes: [monthStart, today] }
  const [from, to] = ranges[filtro] || [today, today]
  const filtered = extras.filter(e => e.data_op >= from && e.data_op <= to && e.pago)
  const total = filtered.reduce((a, e) => a + e.valor_final, 0)
  const totalPix = filtered.filter(e => e.forma_pagamento === 'pix').reduce((a, e) => a + e.valor_final, 0)
  const totalDin = filtered.filter(e => e.forma_pagamento === 'dinheiro').reduce((a, e) => a + e.valor_final, 0)
  const porSetor = setores.map(s => ({ nome: s.nome, total: filtered.filter(e => e.setor_id === s.id).reduce((a, e) => a + e.valor_final, 0), qtd: filtered.filter(e => e.setor_id === s.id).length })).filter(s => s.qtd > 0).sort((a, b) => b.total - a.total)
  const porPessoa = pessoas.map(p => ({ nome: p.nome, total: filtered.filter(e => e.pessoa_id === p.id).reduce((a, e) => a + e.valor_final, 0), qtd: filtered.filter(e => e.pessoa_id === p.id).length, ajuste: p.ajuste_pendente })).filter(p => p.qtd > 0).sort((a, b) => b.total - a.total)

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {['hoje', 'ontem', 'semana', 'mes'].map(f => (
          <button key={f} onClick={() => setFiltro(f)} style={{ padding: '6px 12px', border: `2px solid ${filtro === f ? '#c9a96e' : '#e0d5c5'}`, borderRadius: 20, background: filtro === f ? '#c9a96e' : '#fff', color: filtro === f ? '#fff' : '#666', fontSize: 12, fontWeight: filtro === f ? 700 : 400, cursor: 'pointer' }}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 4, background: '#f0e8d8', padding: 4, borderRadius: 10, marginBottom: 12 }}>
        {['resumo', 'setor', 'funcionário'].map(t => (
          <button key={t} onClick={() => setSubTab(t)} style={{ flex: 1, padding: '8px 4px', border: 'none', borderRadius: 8, background: subTab === t ? '#fff' : 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: subTab === t ? 700 : 400, color: subTab === t ? '#c9a96e' : '#999' }}>
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
        {filtered.slice(-10).reverse().map(e => {
          const setor = setores.find(s => s.id === e.setor_id)
          return <div key={e.id} style={{ ...S.card, padding: '10px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <div><div style={{ fontWeight: 600, fontSize: 14 }}>{e.nome}</div><div style={{ fontSize: 11, color: '#8a7355' }}>{e.funcao}{setor ? ' · ' + setor.nome : ''} · {dayLabel(e.data_op)}</div></div>
              <div style={{ textAlign: 'right' }}><div style={{ fontSize: 15, fontWeight: 700, color: '#c9a96e' }}>{fmt(e.valor_final)}</div>{e.forma_pagamento === 'pix' ? <Badge color="#3b82f6">Pix</Badge> : <Badge color="#22c55e">Din</Badge>}</div>
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
          <div style={{ marginTop: 8, height: 4, background: '#f0e8d8', borderRadius: 2 }}><div style={{ height: '100%', background: '#c9a96e', borderRadius: 2, width: total ? ((s.total / total) * 100) + '%' : '0%' }} /></div>
        </div>)}
      </>}
      {subTab === 'funcionário' && <>
        {porPessoa.length === 0 && <div style={{ ...S.card, textAlign: 'center', padding: 32, color: '#999' }}>Sem dados</div>}
        {porPessoa.map((p, i) => <div key={p.nome} style={S.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span style={{ fontSize: 16, fontWeight: 800, color: '#c9a96e' }}>#{i + 1}</span><span style={{ fontWeight: 700 }}>{p.nome}</span></div>
              <div style={{ fontSize: 12, color: '#999' }}>{p.qtd} extras · Média: {fmt(p.qtd ? Math.round(p.total / p.qtd) : 0)}</div>
              {p.ajuste > 0 && <div style={{ fontSize: 12, color: '#f59e0b' }}>⚠ Ajuste: {fmt(p.ajuste)}</div>}
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#c9a96e' }}>{fmt(p.total)}</div>
          </div>
        </div>)}
      </>}
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

function TabConfig({ store }) {
  const { setores, addSetor, pessoas, removePessoa } = store
  const [novoSetor, setNovoSetor] = useState('')
  return (
    <div>
      <div style={S.card}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>📁 Setores</div>
        {setores.map(s => <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f0e8d8' }}>
          <span style={{ fontSize: 14 }}>{s.nome}</span>
          <Badge color={s.ativo ? '#22c55e' : '#999'}>{s.ativo ? 'Ativo' : 'Inativo'}</Badge>
        </div>)}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input value={novoSetor} onChange={e => setNovoSetor(e.target.value)} style={{ ...S.input, flex: 1 }} placeholder="Novo setor..." />
          <button onClick={() => { if (novoSetor.trim()) { addSetor({ nome: novoSetor.trim(), ativo: true }); setNovoSetor('') } }} style={{ ...S.btn('#c9a96e'), flex: 'none' }}>+</button>
        </div>
      </div>
      <div style={S.card}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>👥 Pessoas ({pessoas.length})</div>
        {pessoas.map(p => <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f0e8d8' }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{p.nome}</div>
            <div style={{ fontSize: 12, color: '#8a7355' }}>{p.funcao} · {p.tipo_pix}: {p.chave_pix}</div>
            {p.telefone && <div style={{ fontSize: 12, color: '#3b82f6' }}>📱 {p.telefone}</div>}
            {p.ajuste_pendente > 0 && <div style={{ fontSize: 11, color: '#f59e0b' }}>⚠ Ajuste: {fmt(p.ajuste_pendente)}</div>}
          </div>
          <button onClick={() => { if (confirm('Remover ' + p.nome + '?')) removePessoa(p.id) }} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: 18, cursor: 'pointer' }}>🗑</button>
        </div>)}
      </div>
      <div style={{ ...S.card, background: '#fef3c7', border: '1px solid #f59e0b' }}>
        <div style={{ fontSize: 12, color: '#92400e', fontWeight: 700 }}>ℹ️ ARACÁ GRILL v1.0</div>
        <div style={{ fontSize: 12, color: '#92400e80' }}>Sistema operacional de extras · Firebase Firestore</div>
      </div>
    </div>
  )
}
