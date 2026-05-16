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

    const editadoHTML = e.editado
      ? `<div class="editado">Editado: ${e.editado_por || '?'} - Motivo: ${e.motivo_edicao || '?'}</div>`
      : ''

    return `
      <div class="recibo">
        <div class="centro negrito titulo">${nomeEstab}</div>
        <div class="centro subtitulo">RECIBO DE PAGAMENTO</div>
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

        <div class="row negrito total">
          <span>TOTAL PAGO:</span>
          <span>${fmt(e.valor_final)}</span>
        </div>

        ${forma === 'pix' && pessoa?.chave_pix ? `
          <div class="sep">${linha()}</div>
          <div class="info">Tipo Pix: ${pessoa.tipo_pix}</div>
          <div class="info">Chave: ${pessoa.chave_pix}</div>
        ` : ''}

        ${editadoHTML}
        <div class="sep">${linha()}</div>
        <div class="centro info">Assinatura do funcionario:</div>
        <div class="centro" style="margin-top:6px;">
          ${assinaturaHTML}
        </div>
        <div class="centro info" style="margin-top:4px;">${e.nome}</div>
        <div style="margin-top:10px;"></div>
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
          font-size: 13px;
          font-weight: 700;
          width: 72mm;
          margin: 0 auto;
          padding: 0 3mm;
          color: #000;
          background: #fff;
        }

        .recibo {
          width: 100%;
          padding: 3mm 0;
        }

        .centro { text-align: center; }

        .negrito { font-weight: 900; }

        /* Título do estabelecimento */
        .titulo {
          font-size: 16px;
          font-weight: 900;
          letter-spacing: 1px;
          margin-bottom: 1px;
        }

        /* Subtítulo */
        .subtitulo {
          font-size: 12px;
          font-weight: 700;
          margin-bottom: 2px;
        }

        /* Nome do funcionário */
        .nome {
          font-size: 15px;
          font-weight: 900;
          margin: 3px 0;
        }

        /* Linhas de informação */
        .info {
          font-size: 12px;
          font-weight: 700;
          line-height: 1.4;
        }

        /* Total */
        .total {
          font-size: 16px;
          font-weight: 900;
          margin: 2px 0;
        }

        .row {
          display: flex;
          justify-content: space-between;
          width: 100%;
        }

        .sep {
          font-size: 10px;
          font-weight: 400;
          margin: 2px 0;
          overflow: hidden;
          letter-spacing: 0;
        }

        .assinatura {
          max-width: 58mm;
          max-height: 18mm;
          object-fit: contain;
        }

        .editado {
          font-size: 10px;
          font-weight: 700;
          color: #333;
          margin: 2px 0;
        }

        .linha-assinatura {
          width: 55mm;
          border-bottom: 2px solid #000;
          margin: 10mm auto 0;
        }

        .corte {
          border-top: 1px dashed #000;
          margin: 3mm 0;
        }

        @media print {
          body { width: 72mm; margin: 0; }
          .corte { border-top: 1px dashed #000; }
          @page {
            size: 80mm auto;
            margin: 2mm 4mm;
          }
        }
      </style>
    </head>
    <body>
      ${recibosHTML}
      <script>
        window.onload = function() { window.print() }
      <\/script>
    </body>
    </html>
  `

  const janela = window.open('', '_blank', 'width=400,height=600')
  janela.document.write(html)
  janela.document.close()
}
