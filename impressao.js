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

export function imprimirRecibos(extras, pessoas, setores, config, forma) {
  const pagos = extras.filter(e => e.pago && e.forma_pagamento === forma)

  if (pagos.length === 0) {
    alert(`Nenhum pagamento em ${forma === 'pix' ? 'Pix' : 'Dinheiro'} encontrado.`)
    return
  }

  const nomeEstab = config?.nome_estabelecimento || 'ARACÁ GRILL'
  const formaLabel = forma === 'pix' ? 'PIX' : 'DINHEIRO'

  // Monta HTML de cada recibo
  const recibosHTML = pagos.map(e => {
    const setor  = setores.find(s => s.id === e.setor_id)
    const pessoa = pessoas.find(p => p.id === e.pessoa_id)
    const trocosDescontados = e.trocos_descontados || []
    const trocoGerado = e.troco_gerado || 0
    const valorOriginal = e.valor_original || e.valor_final

    const linhasTrocos = trocosDescontados.map(t =>
      `<div class="row"><span>  Troco ${dayLabel(t.data)}</span><span>-${fmt(t.valor)}</span></div>`
    ).join('')

    const assinaturaHTML = e.assinatura && e.assinatura.startsWith('data:image')
      ? `<img src="${e.assinatura}" class="assinatura" />`
      : `<div class="linha-assinatura"></div>`

    return `
      <div class="recibo">
        <div class="centro negrito grande">${nomeEstab}</div>
        <div class="centro">RECIBO DE PAGAMENTO</div>
        <div class="separador">${linha('=')}</div>

        <div class="row"><span>Data:</span><span>${dayLabel(e.data_op)}</span></div>
        <div class="row"><span>Forma:</span><span>${formaLabel}</span></div>
        <div class="separador">${linha()}</div>

        <div class="negrito grande">${e.nome}</div>
        ${e.funcao  ? `<div>Funcao: ${e.funcao}</div>`    : ''}
        ${e.turnos  ? `<div>Turno:  ${e.turnos}</div>`    : ''}
        ${setor     ? `<div>Setor:  ${setor.nome}</div>`  : ''}
        ${e.obs     ? `<div>Obs:    ${e.obs}</div>`       : ''}
        <div class="separador">${linha()}</div>

        <div class="row"><span>Valor do extra:</span><span>${fmt(valorOriginal)}</span></div>
        ${linhasTrocos}
        ${trocoGerado > 0 ? `<div class="row"><span>Troco gerado:</span><span>+${fmt(trocoGerado)}</span></div>` : ''}
        <div class="separador">${linha()}</div>

        <div class="row negrito grande">
          <span>TOTAL:</span>
          <span>${fmt(e.valor_final)}</span>
        </div>

        ${forma === 'pix' && pessoa?.chave_pix ? `
          <div class="separador">${linha()}</div>
          <div>Tipo Pix: ${pessoa.tipo_pix}</div>
          <div>Chave: ${pessoa.chave_pix}</div>
        ` : ''}

        <div class="separador">${linha()}</div>
        <div class="centro">Assinatura do funcionario:</div>
        <div class="centro" style="margin-top:6px;">
          ${assinaturaHTML}
        </div>
        <div class="centro" style="margin-top:4px; font-size:10px;">${e.nome}</div>

        <div style="margin-top:16px;"></div>
      </div>
    `
  }).join('<div class="corte"></div>')

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Recibos ${formaLabel} - ${dayLabel(pagos[0]?.data_op || '')}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
          font-family: 'Courier New', Courier, monospace;
          font-size: 11px;
          width: 72mm;
          margin: 0 auto;
          color: #000;
          background: #fff;
        }

        .recibo {
          width: 100%;
          padding: 4mm 0;
        }

        .centro { text-align: center; }
        .negrito { font-weight: bold; }
        .grande { font-size: 13px; }

        .row {
          display: flex;
          justify-content: space-between;
          width: 100%;
        }

        .separador {
          letter-spacing: 0;
          font-size: 10px;
          margin: 3px 0;
          overflow: hidden;
        }

        .assinatura {
          max-width: 60mm;
          max-height: 20mm;
          object-fit: contain;
        }

        .linha-assinatura {
          width: 55mm;
          border-bottom: 1px solid #000;
          margin: 12mm auto 0;
        }

        .corte {
          border-top: 1px dashed #000;
          margin: 4mm 0;
        }

        @media print {
          body { width: 72mm; margin: 0; }
          .corte { border-top: 1px dashed #000; }
          @page {
            size: 80mm auto;
            margin: 2mm;
          }
        }
      </style>
    </head>
    <body>
      ${recibosHTML}
      <script>
        window.onload = function() {
          window.print()
        }
      <\/script>
    </body>
    </html>
  `

  const janela = window.open('', '_blank', 'width=400,height=600')
  janela.document.write(html)
  janela.document.close()
}
