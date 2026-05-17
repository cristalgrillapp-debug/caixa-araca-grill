import { useState, useMemo } from 'react'

// ─── UTILITÁRIOS ──────────────────────────────────────────────────────────────

const fmt = (c) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((c || 0) / 100)
const fmtSimples = (c) => 'R$ ' + ((c || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

const DIAS_NOME  = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']
const DIAS_CURTO = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

const dowDe = (dateStr) => {
  if (!dateStr) return -1
  const [y, m, d] = dateStr.split('-')
  return new Date(Number(y), Number(m) - 1, Number(d)).getDay()
}

const labelData = (dateStr) => {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-')
  const dt = new Date(Number(y), Number(m) - 1, Number(d))
  return DIAS_CURTO[dt.getDay()] + ' ' + String(dt.getDate()).padStart(2, '0') + '/' + String(dt.getMonth() + 1).padStart(2, '0')
}

const subDias = (dateStr, n) => {
  const [y, m, d] = dateStr.split('-')
  const dt = new Date(Number(y), Number(m) - 1, Number(d))
  dt.setDate(dt.getDate() - n)
  return dt.toISOString().slice(0, 10).replace(/T.*/, '') || [
    dt.getFullYear(),
    String(dt.getMonth() + 1).padStart(2, '0'),
    String(dt.getDate()).padStart(2, '0'),
  ].join('-')
}

const variacao = (atual, anterior) => {
  if (!anterior || anterior === 0) return null
  return Math.round(((atual - anterior) / anterior) * 100)
}

const corVariacao = (pct, inverso = false) => {
  if (pct === null) return '#a8a09a'
  if (inverso) return pct > 0 ? '#22c55e' : '#ef4444'
  return pct > 15 ? '#ef4444' : pct > 0 ? '#f59e0b' : '#22c55e'
}

// ─── PALETA ───────────────────────────────────────────────────────────────────

const D = {
  bg:       '#0f0d0b',
  card:     '#1c1917',
  card2:    '#242018',
  border:   '#2d2420',
  gold:     '#c9a96e',
  goldDim:  '#9a7520',
  amber:    '#b5763a',
  text:     '#f5f0e8',
  textMuted:'#8a7a6a',
  textDim:  '#5a4a3a',
  green:    '#22c55e',
  red:      '#ef4444',
  yellow:   '#f59e0b',
  blue:     '#3b82f6',
  purple:   '#8b5cf6',
}

// ─── COMPONENTES BASE ─────────────────────────────────────────────────────────

const Pill = ({ label, ativo, onClick }) => (
  <button onClick={onClick} style={{
    padding: '7px 16px', border: 'none', borderRadius: 20, cursor: 'pointer',
    background: ativo ? D.gold : D.card2,
    color: ativo ? '#1a1200' : D.textMuted,
    fontSize: 12, fontWeight: ativo ? 800 : 500,
    transition: 'all 0.2s',
  }}>{label}</button>
)

const Tendencia = ({ pct, inverso = false, sufixo = '% vs anterior' }) => {
  if (pct === null) return null
  const cor = corVariacao(pct, inverso)
  const seta = pct > 0 ? '↑' : pct < 0 ? '↓' : '→'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
      <span style={{ fontSize: 13, color: cor, fontWeight: 700 }}>{seta} {Math.abs(pct)}%</span>
      <span style={{ fontSize: 11, color: D.textMuted }}>{sufixo}</span>
    </div>
  )
}

const CardBase = ({ children, onClick, destaque }) => (
  <div onClick={onClick} style={{
    background: destaque ? 'linear-gradient(135deg, #1a1200, #2d2000)' : D.card,
    borderRadius: 18,
    padding: '20px 18px',
    marginBottom: 12,
    border: `1px solid ${destaque ? '#3d3000' : D.border}`,
    cursor: onClick ? 'pointer' : 'default',
    boxShadow: destaque ? '0 4px 24px rgba(201,169,110,0.12)' : '0 1px 4px rgba(0,0,0,0.2)',
  }}>
    {children}
  </div>
)

const BarraHorizontal = ({ valor, max, cor = D.gold, altura = 8 }) => (
  <div style={{ height: altura, background: D.card2, borderRadius: altura / 2, overflow: 'hidden', marginTop: 6 }}>
    <div style={{
      height: '100%',
      width: max > 0 ? Math.min(100, Math.round(valor / max * 100)) + '%' : '0%',
      background: cor,
      borderRadius: altura / 2,
      transition: 'width 0.4s ease',
    }} />
  </div>
)

// ─── TELA 1: HOJE ─────────────────────────────────────────────────────────────

function TelaHoje({ extras, vales, despesas, setores, today }) {
  const extrasHoje    = useMemo(() => extras.filter(e => e.data_op === today && e.pago), [extras, today])
  const valesHoje     = useMemo(() => (vales||[]).filter(v => v.data_op === today), [vales, today])
  const despesasHoje  = useMemo(() => (despesas||[]).filter(d => d.data_op === today), [despesas, today])

  const totalExtras   = extrasHoje.reduce((a, e) => a + e.valor_final, 0)
  const totalVales    = valesHoje.reduce((a, v) => a + v.valor, 0)
  const totalDespesas = despesasHoje.reduce((a, d) => a + d.valor, 0)
  const totalHoje     = totalExtras + totalVales + totalDespesas

  const totalDin = [
    ...extrasHoje.filter(e => e.forma_pagamento === 'dinheiro'),
    ...valesHoje.filter(v => v.forma_pagamento === 'dinheiro'),
    ...despesasHoje.filter(d => (d.forma_pagamento||'dinheiro') === 'dinheiro'),
  ].reduce((a, x) => a + (x.valor_final || x.valor || 0), 0)

  const totalPix = totalHoje - totalDin
  const pctDin   = totalHoje > 0 ? Math.round(totalDin / totalHoje * 100) : 0

  // Compara com mesmo dia da semana passada
  const semanaAtras  = subDias(today, 7)
  const extrasSemAnt = extras.filter(e => e.data_op === semanaAtras && e.pago)
  const valesSemAnt  = (vales||[]).filter(v => v.data_op === semanaAtras)
  const despSemAnt   = (despesas||[]).filter(d => d.data_op === semanaAtras)
  const totalSemAnt  = extrasSemAnt.reduce((a,e)=>a+e.valor_final,0) + valesSemAnt.reduce((a,v)=>a+v.valor,0) + despSemAnt.reduce((a,d)=>a+d.valor,0)
  const pctVar       = variacao(totalHoje, totalSemAnt)

  // Setor mais caro hoje
  const porSetor = {}
  extrasHoje.forEach(e => {
    const s = setores.find(x => x.id === e.setor_id)
    const nome = s?.nome || 'Sem setor'
    if (!porSetor[nome]) porSetor[nome] = 0
    porSetor[nome] += e.valor_final
  })
  const setoresOrdem = Object.entries(porSetor).sort((a,b) => b[1]-a[1])
  const maxSetor = setoresOrdem[0]?.[1] || 1

  const diaNome = DIAS_NOME[dowDe(today)]
  const semanaPassadaLabel = labelData(semanaAtras)

  return (
    <div>
      {/* Card principal — total do dia */}
      <CardBase destaque>
        <div style={{ fontSize: 11, color: D.goldDim, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6 }}>
          Hoje saiu do caixa
        </div>
        <div style={{ fontSize: 42, fontWeight: 900, color: D.gold, letterSpacing: '-0.02em', lineHeight: 1 }}>
          {fmtSimples(totalHoje)}
        </div>
        {pctVar !== null && (
          <Tendencia pct={pctVar} sufixo={`vs ${diaNome} passado (${semanaPassadaLabel})`} />
        )}
        {totalSemAnt === 0 && (
          <div style={{ fontSize: 11, color: D.textMuted, marginTop: 4 }}>Primeiro {diaNome} com registro</div>
        )}

        {/* Breakdown */}
        <div style={{ display: 'flex', gap: 10, marginTop: 16, paddingTop: 14, borderTop: `1px solid #3d3000` }}>
          {[
            { emoji: '💼', label: 'Extras', valor: totalExtras, cor: D.amber },
            { emoji: '💸', label: 'Vales',  valor: totalVales,  cor: D.goldDim },
            { emoji: '🧾', label: 'Desp.',  valor: totalDespesas, cor: D.purple },
          ].map(item => (
            <div key={item.label} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontSize: 10, color: D.textMuted, marginBottom: 2 }}>{item.emoji} {item.label}</div>
              <div style={{ fontSize: 14, fontWeight: 800, color: item.cor }}>{fmtSimples(item.valor)}</div>
            </div>
          ))}
        </div>
      </CardBase>

      {/* Como saiu */}
      <CardBase>
        <div style={{ fontSize: 13, fontWeight: 700, color: D.text, marginBottom: 14 }}>
          Como o dinheiro saiu hoje
        </div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <div style={{ flex: 1, background: D.card2, borderRadius: 12, padding: '12px 10px', textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: '#22c55e', marginBottom: 3 }}>💵 Dinheiro</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: D.text }}>{pctDin}%</div>
            <div style={{ fontSize: 11, color: D.textMuted }}>{fmtSimples(totalDin)}</div>
          </div>
          <div style={{ flex: 1, background: D.card2, borderRadius: 12, padding: '12px 10px', textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: D.blue, marginBottom: 3 }}>📱 Pix</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: D.text }}>{100 - pctDin}%</div>
            <div style={{ fontSize: 11, color: D.textMuted }}>{fmtSimples(totalPix)}</div>
          </div>
        </div>
        {totalHoje > 0 && (
          <div style={{ height: 10, background: D.card2, borderRadius: 5, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: pctDin + '%', background: '#22c55e', borderRadius: 5, transition: 'width 0.4s' }} />
          </div>
        )}
        {totalHoje === 0 && (
          <div style={{ textAlign: 'center', color: D.textMuted, fontSize: 13, padding: 12 }}>Nenhum lançamento ainda</div>
        )}
      </CardBase>

      {/* Por setor hoje */}
      {setoresOrdem.length > 0 && (
        <CardBase>
          <div style={{ fontSize: 13, fontWeight: 700, color: D.text, marginBottom: 14 }}>
            Quanto saiu por setor hoje
          </div>
          {setoresOrdem.map(([nome, val]) => (
            <div key={nome} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                <span style={{ fontSize: 13, color: D.text }}>{nome}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: D.gold }}>{fmtSimples(val)}</span>
              </div>
              <BarraHorizontal valor={val} max={maxSetor} />
            </div>
          ))}
        </CardBase>
      )}

      {/* Pessoas hoje */}
      {extrasHoje.length > 0 && (
        <CardBase>
          <div style={{ fontSize: 13, fontWeight: 700, color: D.text, marginBottom: 14 }}>
            Quem foi pago hoje
          </div>
          {extrasHoje.sort((a,b) => b.valor_final - a.valor_final).map((e, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${D.border}` }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: D.text }}>{e.nome}</div>
                <div style={{ fontSize: 11, color: D.textMuted }}>{e.funcao}{e.turnos ? ' · ' + e.turnos : ''}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: D.gold }}>{fmtSimples(e.valor_final)}</div>
                <div style={{ fontSize: 10, color: e.forma_pagamento === 'pix' ? D.blue : '#22c55e' }}>
                  {e.forma_pagamento === 'pix' ? '📱 Pix' : '💵 Din'}
                </div>
              </div>
            </div>
          ))}
        </CardBase>
      )}

      {totalHoje === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: D.textMuted }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🌙</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: D.text }}>Turno ainda sem lançamentos</div>
          <div style={{ fontSize: 13, marginTop: 6 }}>Os dados vão aparecer assim que os pagamentos forem registrados</div>
        </div>
      )}
    </div>
  )
}

// ─── TELA 2: SEMANA ───────────────────────────────────────────────────────────

function TelaSemana({ extras, vales, despesas, setores, today }) {
  const [janela, setJanela] = useState('esta') // esta | passada | 4semanas

  const calcInicio = () => {
    const dow = dowDe(today)
    const diasAteSeg = dow === 0 ? 6 : dow - 1
    if (janela === 'esta') return subDias(today, diasAteSeg)
    if (janela === 'passada') return subDias(today, diasAteSeg + 7)
    return subDias(today, 27) // ~4 semanas
  }

  const inicio = calcInicio()
  const fim    = janela === 'passada' ? subDias(today, dowDe(today) === 0 ? 1 : dowDe(today)) : today

  const extrasP   = useMemo(() => extras.filter(e => e.pago && e.data_op >= inicio && e.data_op <= fim), [extras, inicio, fim])
  const valesP    = useMemo(() => (vales||[]).filter(v => v.data_op >= inicio && v.data_op <= fim), [vales, inicio, fim])
  const despesasP = useMemo(() => (despesas||[]).filter(d => d.data_op >= inicio && d.data_op <= fim), [despesas, inicio, fim])

  const totalP = extrasP.reduce((a,e)=>a+e.valor_final,0) + valesP.reduce((a,v)=>a+v.valor,0) + despesasP.reduce((a,d)=>a+d.valor,0)

  // Por dia
  const diasMap = {}
  const todos = [
    ...extrasP.map(e => ({ data: e.data_op, valor: e.valor_final })),
    ...valesP.map(v => ({ data: v.data_op, valor: v.valor })),
    ...despesasP.map(d => ({ data: d.data_op, valor: d.valor })),
  ]
  todos.forEach(({ data, valor }) => {
    if (!diasMap[data]) diasMap[data] = 0
    diasMap[data] += valor
  })
  const diasOrdem = Object.entries(diasMap).sort((a,b) => a[0].localeCompare(b[0]))
  const maxDia = Math.max(...diasOrdem.map(([,v]) => v), 1)

  // Pessoa mais frequente
  const pessoaMap = {}
  extrasP.forEach(e => {
    if (!pessoaMap[e.nome]) pessoaMap[e.nome] = { nome: e.nome, count: 0, total: 0 }
    pessoaMap[e.nome].count++
    pessoaMap[e.nome].total += e.valor_final
  })
  const topPessoa = Object.values(pessoaMap).sort((a,b) => b.count - a.count)[0]

  // Setor mais caro
  const setorMap = {}
  extrasP.forEach(e => {
    const s = setores.find(x => x.id === e.setor_id)
    const nome = s?.nome || 'Sem setor'
    if (!setorMap[nome]) setorMap[nome] = 0
    setorMap[nome] += e.valor_final
  })
  const topSetor = Object.entries(setorMap).sort((a,b) => b[1]-a[1])[0]

  // Jornadas duplas
  const jduplas = extrasP.filter(e => e.turnos === 'TD+TN')

  const janelaLabel = janela === 'esta' ? 'Esta semana' : janela === 'passada' ? 'Semana passada' : 'Últimas 4 semanas'

  return (
    <div>
      {/* Filtro janela */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {[['esta','Esta semana'],['passada','Semana passada'],['4semanas','Últimas 4 sem.']].map(([id,label]) => (
          <Pill key={id} label={label} ativo={janela===id} onClick={() => setJanela(id)} />
        ))}
      </div>

      {/* Total da semana */}
      <CardBase destaque>
        <div style={{ fontSize: 11, color: D.goldDim, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6 }}>
          {janelaLabel}
        </div>
        <div style={{ fontSize: 38, fontWeight: 900, color: D.gold, letterSpacing: '-0.02em' }}>
          {fmtSimples(totalP)}
        </div>
        <div style={{ fontSize: 12, color: D.textMuted, marginTop: 4 }}>
          {extrasP.length} extras · {valesP.length} vale{valesP.length !== 1 ? 's' : ''} · {despesasP.length} despesa{despesasP.length !== 1 ? 's' : ''}
        </div>
      </CardBase>

      {/* Barras por dia */}
      {diasOrdem.length > 0 && (
        <CardBase>
          <div style={{ fontSize: 13, fontWeight: 700, color: D.text, marginBottom: 14 }}>
            Quanto saiu por dia
          </div>
          {diasOrdem.map(([data, val]) => {
            const dow = dowDe(data)
            const fds = [0, 5, 6].includes(dow)
            return (
              <div key={data} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span style={{ fontSize: 12, color: fds ? D.gold : D.textMuted, fontWeight: fds ? 700 : 400 }}>
                    {labelData(data)}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: D.text }}>{fmtSimples(val)}</span>
                </div>
                <BarraHorizontal valor={val} max={maxDia} cor={fds ? D.gold : D.amber} />
              </div>
            )
          })}
          {diasOrdem.length === 0 && (
            <div style={{ textAlign: 'center', color: D.textMuted, fontSize: 13 }}>Sem dados no período</div>
          )}
        </CardBase>
      )}

      {/* Cards de destaque */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
        {topPessoa && (
          <div style={{ background: D.card, borderRadius: 14, padding: 14, border: `1px solid ${D.border}` }}>
            <div style={{ fontSize: 10, color: D.textMuted, marginBottom: 6 }}>👤 Mais escalado</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: D.text, lineHeight: 1.2, marginBottom: 4 }}>{topPessoa.nome}</div>
            <div style={{ fontSize: 12, color: D.gold, fontWeight: 700 }}>{topPessoa.count}× · {fmtSimples(topPessoa.total)}</div>
          </div>
        )}
        {topSetor && (
          <div style={{ background: D.card, borderRadius: 14, padding: 14, border: `1px solid ${D.border}` }}>
            <div style={{ fontSize: 10, color: D.textMuted, marginBottom: 6 }}>📍 Setor mais caro</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: D.text, lineHeight: 1.2, marginBottom: 4 }}>{topSetor[0]}</div>
            <div style={{ fontSize: 12, color: D.gold, fontWeight: 700 }}>{fmtSimples(topSetor[1])}</div>
          </div>
        )}
      </div>

      {/* Jornadas duplas */}
      {jduplas.length > 0 && (
        <CardBase>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: D.text }}>Jornadas duplas (TD+TN)</div>
              <div style={{ fontSize: 12, color: D.textMuted, marginTop: 3 }}>
                {jduplas.length} pessoa{jduplas.length !== 1 ? 's' : ''} · custam o dobro do turno simples
              </div>
            </div>
            <div style={{ fontSize: 24, fontWeight: 900, color: D.yellow }}>{jduplas.length}</div>
          </div>
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${D.border}` }}>
            {jduplas.map((e, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: `1px solid ${D.border}` }}>
                <span style={{ fontSize: 12, color: D.text }}>{e.nome}</span>
                <span style={{ fontSize: 12, color: D.yellow, fontWeight: 700 }}>{fmtSimples(e.valor_final)}</span>
              </div>
            ))}
          </div>
        </CardBase>
      )}

      {totalP === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: D.textMuted }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>📊</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: D.text }}>Sem dados no período</div>
        </div>
      )}
    </div>
  )
}

// ─── TELA 3: DESCOBERTAS ──────────────────────────────────────────────────────

function TelaDescobrei({ extras, vales, despesas, setores, today }) {
  const [expandido, setExpandido] = useState(null)

  const insights = useMemo(() => {
    const lista = []
    const extrasPagos = extras.filter(e => e.pago)

    // 1. Dia da semana mais caro
    const custoPorDow = Array(7).fill(0).map((_, i) => ({ dow: i, total: 0, count: 0, dias: new Set() }))
    extrasPagos.forEach(e => {
      const dow = dowDe(e.data_op)
      if (dow >= 0) {
        custoPorDow[dow].total += e.valor_final
        custoPorDow[dow].count++
        custoPorDow[dow].dias.add(e.data_op)
      }
    })
    const maxDow = custoPorDow.reduce((a, b) => b.total > a.total ? b : a)
    if (maxDow.dias.size >= 2) {
      const media = Math.round(maxDow.total / maxDow.dias.size)
      lista.push({
        emoji: '📅',
        titulo: `${DIAS_NOME[maxDow.dow]}s são seus dias mais caros`,
        resumo: `Em média ${fmtSimples(media)} por ${DIAS_NOME[maxDow.dow].toLowerCase()} nos últimos 60 dias`,
        detalhe: `Analisando ${maxDow.dias.size} ${DIAS_NOME[maxDow.dow].toLowerCase()}s com extras pagos, o custo médio foi de ${fmt(media)}. No total foram ${fmt(maxDow.total)} em ${maxDow.count} escalas.`,
        cor: D.gold,
      })
    }

    // 2. Pessoa mais escalada
    const pessoaMap = {}
    extrasPagos.forEach(e => {
      if (!e.nome) return
      if (!pessoaMap[e.nome]) pessoaMap[e.nome] = { nome: e.nome, count: 0, total: 0, dias: new Set(), funcoes: new Set() }
      pessoaMap[e.nome].count++
      pessoaMap[e.nome].total += e.valor_final
      pessoaMap[e.nome].dias.add(e.data_op)
      if (e.funcao) pessoaMap[e.nome].funcoes.add(e.funcao)
    })
    const topPessoa = Object.values(pessoaMap).sort((a,b) => b.count - a.count)[0]
    if (topPessoa && topPessoa.count >= 3) {
      lista.push({
        emoji: '👤',
        titulo: `${topPessoa.nome} foi sua pessoa mais escalada`,
        resumo: `${topPessoa.count} escalas · ${fmt(topPessoa.total)} nos últimos 60 dias`,
        detalhe: `${topPessoa.nome} trabalhou em ${topPessoa.dias.size} dias diferentes. Função: ${[...topPessoa.funcoes].join(', ')}. Total recebido: ${fmt(topPessoa.total)}.`,
        cor: D.amber,
      })
    }

    // 3. Custo oculto — trocos não descontados + despesas sem nota + vales não lançados
    const trocosNaoDescontados = extras
      .filter(e => !e.pago)
      .reduce((a, e) => a + ((e.pessoa_id ? 0 : 0)), 0) // placeholder
    const despSemNota = (despesas||[]).filter(d => !d.foto).reduce((a,d) => a+d.valor, 0)
    const valesNaoLancados = (vales||[]).filter(v => !v.lancado).reduce((a,v) => a+v.valor, 0)
    const custoOculto = despSemNota + valesNaoLancados
    if (custoOculto > 0) {
      lista.push({
        emoji: '⚠️',
        titulo: `Você tem ${fmt(custoOculto)} em saídas não totalmente documentadas`,
        resumo: `${fmtSimples(despSemNota)} sem nota fiscal · ${fmtSimples(valesNaoLancados)} em vales não lançados`,
        detalhe: `Despesas sem foto de nota: ${fmt(despSemNota)}. Vales registrados mas não lançados no sistema interno: ${fmt(valesNaoLancados)}. Esses valores existem mas não têm comprovação completa.`,
        cor: D.yellow,
      })
    }

    // 4. Jornadas duplas — custo e padrão
    const jduplas = extrasPagos.filter(e => e.turnos === 'TD+TN')
    if (jduplas.length >= 3) {
      const totalJD = jduplas.reduce((a,e) => a+e.valor_final, 0)
      const setoresJD = {}
      jduplas.forEach(e => {
        const s = setores.find(x => x.id === e.setor_id)
        const nome = s?.nome || 'Sem setor'
        setoresJD[nome] = (setoresJD[nome] || 0) + 1
      })
      const topSetorJD = Object.entries(setoresJD).sort((a,b)=>b[1]-a[1])[0]
      lista.push({
        emoji: '🌙',
        titulo: `${jduplas.length} jornadas duplas nos últimos 60 dias`,
        resumo: `${fmt(totalJD)} gastos em TD+TN · geralmente na ${topSetorJD?.[0] || 'cozinha'}`,
        detalhe: `Jornadas TD+TN custam o dobro. Nos últimos 60 dias foram ${jduplas.length} jornadas duplas totalizando ${fmt(totalJD)}. O setor com mais jornadas duplas foi ${topSetorJD?.[0] || '—'} (${topSetorJD?.[1] || 0} vezes).`,
        cor: D.purple,
      })
    }

    // 5. Categoria de despesa mais frequente
    const catMap = {}
    ;(despesas||[]).forEach(d => {
      const k = d.categoria_nome || 'Outros'
      if (!catMap[k]) catMap[k] = { emoji: d.categoria_emoji||'📝', nome: k, count: 0, total: 0 }
      catMap[k].count++
      catMap[k].total += d.valor
    })
    const topCat = Object.values(catMap).sort((a,b)=>b.count-a.count)[0]
    if (topCat && topCat.count >= 2) {
      lista.push({
        emoji: topCat.emoji,
        titulo: `"${topCat.nome}" é sua despesa mais recorrente`,
        resumo: `${topCat.count} lançamentos · ${fmt(topCat.total)} no total`,
        detalhe: `A categoria "${topCat.nome}" aparece ${topCat.count} vezes nos registros. Isso pode ser um custo fixo disfarçado de variável — vale considerar prever esse gasto na escala.`,
        cor: D.amber,
      })
    }

    // 6. Pix vs dinheiro por função
    const funcaoFormaMap = {}
    extrasPagos.forEach(e => {
      if (!e.funcao || !e.forma_pagamento) return
      if (!funcaoFormaMap[e.funcao]) funcaoFormaMap[e.funcao] = { pix: 0, din: 0 }
      if (e.forma_pagamento === 'pix') funcaoFormaMap[e.funcao].pix++
      else funcaoFormaMap[e.funcao].din++
    })
    const funcaoPix = Object.entries(funcaoFormaMap)
      .filter(([,v]) => v.pix + v.din >= 3)
      .map(([funcao, v]) => ({ funcao, pctPix: Math.round(v.pix / (v.pix+v.din)*100) }))
      .sort((a,b) => b.pctPix - a.pctPix)[0]
    if (funcaoPix && funcaoPix.pctPix >= 80) {
      lista.push({
        emoji: '📱',
        titulo: `${funcaoPix.funcao}s quase sempre recebem por Pix`,
        resumo: `${funcaoPix.pctPix}% dos pagamentos para essa função foram via Pix`,
        detalhe: `Dos extras com função "${funcaoPix.funcao}", ${funcaoPix.pctPix}% receberam por Pix. Pode valer já selecionar Pix por padrão ao escalar essa função, economizando tempo.`,
        cor: D.blue,
      })
    }

    // 7. Padrão do próximo sábado (baseado nos últimos sábados)
    const sabados = extrasPagos.filter(e => dowDe(e.data_op) === 6)
    const sabadosDias = [...new Set(sabados.map(e => e.data_op))]
    if (sabadosDias.length >= 2) {
      const mediaSab = sabados.reduce((a,e)=>a+e.valor_final,0) / sabadosDias.length
      const pessoasSab = {}
      sabados.forEach(e => { pessoasSab[e.nome] = (pessoasSab[e.nome]||0)+1 })
      const topSab = Object.entries(pessoasSab).sort((a,b)=>b[1]-a[1])[0]
      lista.push({
        emoji: '🔮',
        titulo: `Seus sábados custam em média ${fmtSimples(mediaSab)}`,
        resumo: `Baseado nos últimos ${sabadosDias.length} sábados registrados`,
        detalhe: `Analisando ${sabadosDias.length} sábados, o custo médio foi ${fmt(mediaSab)}. A pessoa mais frequente nos sábados foi ${topSab?.[0] || '—'} (presente em ${topSab?.[1] || 0} deles). Use isso para prever o orçamento do próximo sábado.`,
        cor: D.gold,
      })
    }

    // 8. Vale acumulado por pessoa
    const valesPorPessoa = {}
    ;(vales||[]).forEach(v => {
      if (!valesPorPessoa[v.nome]) valesPorPessoa[v.nome] = { nome: v.nome, total: 0, count: 0 }
      valesPorPessoa[v.nome].total += v.valor
      valesPorPessoa[v.nome].count++
    })
    const topVale = Object.values(valesPorPessoa).sort((a,b)=>b.total-a.total)[0]
    if (topVale && topVale.count >= 2) {
      lista.push({
        emoji: '💸',
        titulo: `${topVale.nome} retirou mais vales`,
        resumo: `${topVale.count} vales · ${fmt(topVale.total)} no total`,
        detalhe: `${topVale.nome} solicitou ${topVale.count} vales totalizando ${fmt(topVale.total)} nos últimos 60 dias. Esse valor sai do caixa antes do salário — vale monitorar para evitar adiantamentos excessivos.`,
        cor: D.goldDim,
      })
    }

    return lista
  }, [extras, vales, despesas, setores])

  if (insights.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '80px 20px', color: D.textMuted }}>
        <div style={{ fontSize: 56, marginBottom: 16 }}>🧠</div>
        <div style={{ fontSize: 17, fontWeight: 700, color: D.text, marginBottom: 8 }}>Ainda sem descobertas</div>
        <div style={{ fontSize: 13, lineHeight: 1.6 }}>
          As análises aparecem automaticamente conforme os dados do sistema acumulam. Com pelo menos 7 dias de lançamentos as primeiras descobertas vão surgir aqui.
        </div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: D.textMuted, marginBottom: 14, lineHeight: 1.5 }}>
        Análises geradas automaticamente com os dados dos últimos 60 dias. Toque em qualquer card para entender melhor.
      </div>

      {insights.map((ins, i) => (
        <div key={i} onClick={() => setExpandido(expandido === i ? null : i)}
          style={{
            background: D.card,
            borderRadius: 16,
            padding: '16px 16px',
            marginBottom: 10,
            border: `1px solid ${expandido === i ? ins.cor + '66' : D.border}`,
            cursor: 'pointer',
            transition: 'border-color 0.2s',
          }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 22 }}>{ins.emoji}</span>
                <span style={{ fontSize: 13, fontWeight: 800, color: D.text, lineHeight: 1.3 }}>{ins.titulo}</span>
              </div>
              <div style={{ fontSize: 12, color: ins.cor, fontWeight: 600 }}>{ins.resumo}</div>
            </div>
            <div style={{ fontSize: 16, color: D.textMuted, flexShrink: 0, marginTop: 2 }}>
              {expandido === i ? '▲' : '▼'}
            </div>
          </div>

          {expandido === i && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${D.border}`, fontSize: 13, color: D.textMuted, lineHeight: 1.6 }}>
              {ins.detalhe}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── COMPONENTE PRINCIPAL ─────────────────────────────────────────────────────

export default function Dashboard({ store }) {
  const { extras, vales, despesas, setores, config, turnoAtivo } = store
  const today = turnoAtivo?.data_op || new Date().toISOString().slice(0, 10)

  const [tela, setTela] = useState('hoje')

  return (
    <div style={{ minHeight: '100vh', background: D.bg, fontFamily: "'Inter', 'Geist', system-ui, sans-serif", maxWidth: 480, margin: '0 auto' }}>

      {/* Header do Dashboard */}
      <div style={{ background: D.card, borderBottom: `1px solid ${D.border}`, padding: '18px 18px 0', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ fontSize: 10, color: D.goldDim, textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: 4 }}>
          Inteligência Operacional
        </div>
        <div style={{ fontSize: 20, fontWeight: 900, color: D.text, marginBottom: 14, letterSpacing: '-0.02em' }}>
          {config?.nome_estabelecimento || 'Aracá Grill'}
        </div>

        {/* Navegação das 3 telas */}
        <div style={{ display: 'flex', gap: 0, borderBottom: `1px solid ${D.border}` }}>
          {[
            ['hoje', 'Hoje'],
            ['semana', 'Semana'],
            ['descobri', 'Descobri algo'],
          ].map(([id, label]) => (
            <button key={id} onClick={() => setTela(id)} style={{
              flex: 1, border: 'none', background: 'none', cursor: 'pointer',
              padding: '10px 4px 12px',
              fontSize: 12, fontWeight: tela === id ? 800 : 400,
              color: tela === id ? D.gold : D.textMuted,
              borderBottom: `3px solid ${tela === id ? D.gold : 'transparent'}`,
              marginBottom: -1,
              transition: 'color 0.2s',
            }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Conteúdo */}
      <div style={{ padding: '16px 16px 100px' }}>
        {tela === 'hoje'    && <TelaHoje extras={extras} vales={vales} despesas={despesas} setores={setores} today={today} />}
        {tela === 'semana'  && <TelaSemana extras={extras} vales={vales} despesas={despesas} setores={setores} today={today} />}
        {tela === 'descobri' && <TelaDescobrei extras={extras} vales={vales} despesas={despesas} setores={setores} today={today} />}
      </div>
    </div>
  )
}
