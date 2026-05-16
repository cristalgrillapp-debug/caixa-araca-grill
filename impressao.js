// ─── MÓDULO DE IMPRESSÃO TÉRMICA (navegador) ─────────────────────────────────
// Papel 80mm (~72mm útil), fonte monoespaçada, sem margens

const DIAS = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB']

const dayLabel = (dateStr) => {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T12:00:00')
  return DIAS[d.getDay()] + ' ' + String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0')
}

const fmt = (cents) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((cents || 0) / 100)

const linha = (char = '-', qtd = 32) => char.repeat(qtd)

// ─── RECIBO DE EXTRA ──────────────────────────────────────────────────────────

function reciboExtra(e, setores, pessoas, formaLabel) {
  const setor   = setores.find(s => s.id === e.setor_id)
  const pessoa  = pessoas.find(p => p.id === e.pessoa_id)
  const trocosDescontados = e.trocos_descontados || []
  const trocoGerado = e.troco_gerado || 0
  const valorOriginal = e.valor_original || e.valor_final

  const linhasTrocos = trocosDescontados.map(t =>
    `<div class="row"><span>  Troco ${dayLabel(t.data)}</span><span>-${fmt(t.valor)}</span></div>`
  ).join('')

  const assinaturaHTML = e.assinatura && e.assinatura.startsWith('data:image')
    ? `<img src="${e.assinatura}" class="assinatura" />`
    : `<div class="linha-assinatura"></div>`

  const editadoHTML = e.editado
    ? `<div class="editado">Editado: ${e.editado_por || '?'} - ${e.motivo_edicao || '?'}</div>`
    : ''

  const pixHTML = formaLabel === 'PIX' && pessoa?.chave_pix ? `
    <div class="sep">${linha()}</div>
    <div class="info">Tipo Pix: ${pessoa.tipo_pix}</div>
    <div class="info">Chave: ${pessoa.chave_pix}</div>
  ` : ''

  return `
    <div class="recibo">
      <div class="centro negrito titulo">EXTRA</div>
      <div class="sep">${linha('=')}</div>
      <div class="row"><span>Data:</span><span>${dayLabel(e.data_op)}</span></div>
      <div class="row"><span>Forma:</span><span>${formaLabel}</span></div>
      <div class="sep">${linha()}</div>
      <div class="negrito nome">${e.nome}</div>
      ${e.funcao  ? `<div class="info">Funcao: ${e.funcao}</div>`   : ''}
      ${e.turnos  ? `<div class="info">Turno:  ${e.turnos}</div>`   : ''}
      ${setor     ? `<div class="info">Setor:  ${setor.nome}</div>` : ''}
      ${e.obs     ? `<div class="info">Obs:    ${e.obs}</div>`      : ''}
      <div class="sep">${linha()}</div>
      <div class="row info"><span>Valor combinado:</span><span>${fmt(valorOriginal)}</span></div>
      ${linhasTrocos}
      ${trocoGerado > 0 ? `<div class="row info"><span>Troco gerado:</span><span>+${fmt(trocoGerado)}</span></div>` : ''}
      <div class="sep">${linha()}</div>
      <div class="row negrito total"><span>TOTAL PAGO:</span><span>${fmt(e.valor_final)}</span></div>
      ${pixHTML}
      ${editadoHTML}
      <div class="sep">${linha()}</div>
      <div class="centro info">Assinatura do funcionario:</div>
      <div class="centro" style="margin-top:6px;">${assinaturaHTML}</div>
      <div class="centro info" style="margin-top:4px;">${e.nome}</div>
      <div style="margin-top:10px;"></div>
    </div>
  `
}

// ─── RECIBO DE VALE ───────────────────────────────────────────────────────────

function reciboVale(v, setores, formaLabel) {
  const setor = setores.find(s => s.id === v.setor_id)

  const assinaturaHTML = v.assinatura && v.assinatura.startsWith('data:image')
    ? `<img src="${v.assinatura}" class="assinatura" />`
    : `<div class="linha-assinatura"></div>`

  return `
    <div class="recibo">
      <div class="centro negrito titulo">VALE</div>
      <div class="sep">${linha('=')}</div>
      <div class="row"><span>Data:</span><span>${dayLabel(v.data_op)}</span></div>
      <div class="row"><span>Forma:</span><span>${formaLabel}</span></div>
      <div class="sep">${linha()}</div>
      <div class="negrito nome">${v.nome}</div>
      ${v.funcao ? `<div class="info">Funcao: ${v.funcao}</div>` : ''}
      ${setor    ? `<div class="info">Setor:  ${setor.nome}</div>` : ''}
      ${v.obs    ? `<div class="info">Obs:    ${v.obs}</div>` : ''}
      <div class="sep">${linha()}</div>
      <div class="row negrito total"><span>VALE:</span><span>${fmt(v.valor)}</span></div>
      <div class="sep">${linha()}</div>
      <div class="centro info">Assinatura do funcionario:</div>
      <div class="centro" style="margin-top:6px;">${assinaturaHTML}</div>
      <div class="centro info" style="margin-top:4px;">${v.nome}</div>
      <div style="margin-top:10px;"></div>
    </div>
  `
}

// ─── RECIBO DE DESPESA ────────────────────────────────────────────────────────

function reciboDespesa(d, setores) {
  const setor = setores.find(s => s.id === d.setor_id)

  const fotoHTML = d.foto && d.foto.startsWith('data:image')
    ? `<div class="sep">${linha()}</div><div class="centro info">Nota fiscal:</div><img src="${d.foto}" class="nota-fiscal" />`
    : `<div class="sem-nota">SEM NOTA FISCAL${d.obs ? ': ' + d.obs : ''}</div>`

  return `
    <div class="recibo">
      <div class="centro negrito titulo">${d.categoria_emoji || ''} ${(d.categoria_nome || 'DESPESA').toUpperCase()}</div>
      <div class="sep">${linha('=')}</div>
      <div class="row"><span>Data:</span><span>${dayLabel(d.data_op)}</span></div>
      <div class="row"><span>Forma:</span><span>DINHEIRO</span></div>
      <div class="sep">${linha()}</div>
      <div class="negrito nome">${d.descricao}</div>
      ${setor  ? `<div class="info">Setor: ${setor.nome}</div>` : ''}
      ${d.obs && d.foto ? `<div class="info">Obs: ${d.obs}</div>` : ''}
      <div class="sep">${linha()}</div>
      <div class="row negrito total"><span>VALOR:</span><span>${fmt(d.valor)}</span></div>
      ${fotoHTML}
      <div style="margin-top:10px;"></div>
    </div>
  `
}

// ─── SUMÁRIO GERAL NO FINAL ───────────────────────────────────────────────────

function sumario(extras, vales, despesas, formaLabel) {
  const totalExtras   = extras.reduce((a, e) => a + e.valor_final, 0)
  const totalVales    = vales.reduce((a, v) => a + v.valor, 0)
  const totalDespesas = despesas.reduce((a, d) => a + d.valor, 0)
  const totalGeral    = totalExtras + totalVales + totalDespesas

  const linhasExtras   = extras.length   > 0 ? `<div class="row info"><span>  Extras (${extras.length}):</span><span>${fmt(totalExtras)}</span></div>` : ''
  const linhasVales    = vales.length    > 0 ? `<div class="row info"><span>  Vales (${vales.length}):</span><span>${fmt(totalVales)}</span></div>` : ''
  const linhasDespesas = despesas.length > 0 ? `<div class="row info"><span>  Despesas (${despesas.length}):</span><span>${fmt(totalDespesas)}</span></div>` : ''

  return `
    <div class="recibo">
      <div class="centro negrito titulo">RESUMO DO TURNO</div>
      <div class="centro subtitulo">${formaLabel}</div>
      <div class="sep">${linha('=')}</div>
      ${linhasExtras}
      ${linhasVales}
      ${linhasDespesas}
      <div class="sep">${linha()}</div>
      <div class="row negrito total"><span>TOTAL SAIDAS:</span><span>${fmt(totalGeral)}</span></div>
      <div style="margin-top:10px;"></div>
    </div>
  `
}

// ─── FUNÇÃO PRINCIPAL ─────────────────────────────────────────────────────────

export function imprimirRecibos(extras, vales, despesas, pessoas, setores, config, forma) {
  const nomeEstab  = config?.nome_estabelecimento || 'ARACÁ GRILL'
  const formaLabel = forma === 'pix' ? 'PIX' : 'DINHEIRO'

  // Filtra por forma de pagamento
  const extrasFiltrados   = (extras   || []).filter(e => e.pago && e.forma_pagamento === forma)
  const valesFiltrados    = (vales    || []).filter(v => v.forma_pagamento === forma)
  const despesasFiltradas = (despesas || []).filter(d => d.forma_pagamento === forma)

  if (extrasFiltrados.length === 0 && valesFiltrados.length === 0 && despesasFiltradas.length === 0) {
    alert(`Nenhum lançamento em ${formaLabel} encontrado.`)
    return
  }

  // Monta recibos: extras → vales → despesas → sumário
  const blocos = [
    ...extrasFiltrados.map(e => reciboExtra(e, setores, pessoas, formaLabel)),
    ...valesFiltrados.map(v => reciboVale(v, setores, formaLabel)),
    ...despesasFiltradas.map(d => reciboDespesa(d, setores)),
    sumario(extrasFiltrados, valesFiltrados, despesasFiltradas, formaLabel),
  ]

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>${nomeEstab} - ${formaLabel}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Courier New', Courier, monospace;
          font-size: 13px;
          font-weight: 700;
          width: 72mm;
          margin: 0 auto;
          padding: 0 3mm;
          color: #000;
          background: #fff;
        }
        .cabecalho {
          text-align: center;
          padding: 4mm 0 2mm;
          border-bottom: 2px solid #000;
          margin-bottom: 3mm;
        }
        .cabecalho-nome { font-size: 16px; font-weight: 900; letter-spacing: 1px; }
        .cabecalho-sub  { font-size: 11px; font-weight: 700; }
        .recibo  { width: 100%; padding: 3mm 0; }
        .centro  { text-align: center; }
        .negrito { font-weight: 900; }
        .titulo  { font-size: 14px; font-weight: 900; letter-spacing: 1px; margin-bottom: 1px; }
        .subtitulo { font-size: 12px; font-weight: 700; margin-bottom: 2px; }
        .nome  { font-size: 15px; font-weight: 900; margin: 3px 0; }
        .info  { font-size: 12px; font-weight: 700; line-height: 1.4; }
        .total { font-size: 16px; font-weight: 900; margin: 2px 0; }
        .row   { display: flex; justify-content: space-between; width: 100%; }
        .sep   { font-size: 10px; font-weight: 400; margin: 2px 0; overflow: hidden; }
        .assinatura    { max-width: 58mm; max-height: 18mm; object-fit: contain; }
        .nota-fiscal   { max-width: 60mm; max-height: 40mm; object-fit: contain; margin-top: 4px; }
        .linha-assinatura { width: 55mm; border-bottom: 2px solid #000; margin: 10mm auto 0; }
        .editado  { font-size: 10px; font-weight: 700; color: #333; margin: 2px 0; }
        .sem-nota { font-size: 11px; font-weight: 700; color: #333; margin: 4px 0; text-align: center; border: 1px dashed #999; padding: 4px; }
        .corte    { border-top: 1px dashed #000; margin: 3mm 0; }
        @media print {
          body { width: 72mm; margin: 0; }
          @page { size: 80mm auto; margin: 2mm 4mm; }
        }
      </style>
    </head>
    <body>
      <div class="cabecalho">
        <div class="cabecalho-nome">${nomeEstab}</div>
        <div class="cabecalho-sub">FECHAMENTO DE CAIXA — ${formaLabel}</div>
      </div>
      ${blocos.join('<div class="corte"></div>')}
      <script>window.onload = function() { window.print() }<\/script>
    </body>
    </html>
  `

  const janela = window.open('', '_blank', 'width=400,height=600')
  janela.document.write(html)
  janela.document.close()
}
