// 列印頁：以單號讀取單據，畫成 A4 版面。需要登入過（密碼存在 sessionStorage）
(async function () {
  const root = document.getElementById('root');
  const id = new URLSearchParams(location.search).get('id');
  if (!id) { root.innerHTML = '<p>缺少單號參數</p>'; return; }
  if (!sessionStorage.getItem('appPassword')) {
    root.innerHTML = '<p style="text-align:center;padding:40px;">請先回到系統主畫面登入，再從單據列表按「列印申請單」開啟。</p>';
    return;
  }
  try {
    const r = await Api.get(`/api/requests/${id}`);
    document.title = `${r.doc_no}_${r.counterparty_name}`;
    root.innerHTML = render(r);
  } catch (err) {
    root.innerHTML = `<p style="text-align:center;padding:40px;">${escapeHtml(err.message)}</p>`;
  }
})();

function render(r) {
  const billing = r.kind === 'billing';
  const title = billing ? '工 程 請 款 申 請 單' : '工 程 付 款 申 請 單';
  const partyLabel = billing ? '請款對象（客戶）' : '付款對象（廠商）';
  const bankLabel = billing ? '本公司收款銀行' : '廠商收款銀行';
  const deductions = [
    ['保留款', r.retention_amount],
    ['扣款', r.deduction_amount],
    ['預付沖抵', r.prepaid_offset],
  ].filter(([, v]) => Number(v) > 0);

  return `
  <div class="head">
    <div class="company">${escapeHtml(r.company_name || '')}</div>
    <div class="doc-title">${title}</div>
  </div>
  <div class="gold-line"></div>

  <table class="info">
    <tr>
      <td class="label">單號</td><td style="font-weight:700;">${escapeHtml(r.doc_no)}</td>
      <td class="label">申請類型</td><td>${escapeHtml(r.request_type)}</td>
    </tr>
    <tr>
      <td class="label">${partyLabel}</td><td style="font-weight:700;">${escapeHtml(r.counterparty_name)}</td>
      <td class="label">建立日期</td><td>${r.created_date || ''}</td>
    </tr>
    <tr>
      <td class="label">工程／案場</td><td>${escapeHtml(r.site_name || '—')}</td>
      <td class="label">發票／憑證號</td><td>${escapeHtml(r.invoice_no || '—')}</td>
    </tr>
    <tr>
      <td class="label">申請人</td><td>${escapeHtml(r.applicant_name || '')}</td>
      <td class="label">憑證開立日</td><td>${r.invoice_date || '—'}</td>
    </tr>
    <tr>
      <td class="label">${bankLabel}</td>
      <td colspan="3" style="color:#1d4ed8; font-weight:700;">
        ${escapeHtml(r.bank_name || '無資料')} ／ 帳號：${escapeHtml(r.bank_account || '無資料')}
        ${r.due_date ? `　　預計${billing ? '收款' : '撥款'}日：${r.due_date}` : ''}
      </td>
    </tr>
  </table>

  <table class="items">
    <thead><tr>
      <th style="width:6%;">項次</th><th style="width:38%;">品名規格</th><th style="width:9%;">數量</th>
      <th style="width:8%;">單位</th><th style="width:13%;">單價</th><th style="width:13%;">小計(未稅)</th><th style="width:13%;">含稅金額</th>
    </tr></thead>
    <tbody>
      ${r.items.map((it, i) => `<tr>
        <td class="center">${i + 1}</td>
        <td>${escapeHtml(it.item_name)}</td>
        <td class="num">${Number(it.quantity)}</td>
        <td class="center">${escapeHtml(it.unit || '')}</td>
        <td class="num">$${money(it.unit_price)}</td>
        <td class="num">$${money(it.subtotal)}</td>
        <td class="num">$${money(it.total)}</td>
      </tr>`).join('')}
    </tbody>
  </table>

  <table class="summary">
    <tr><td class="label">銷售額（未稅）</td><td>$${money(r.subtotal)}</td></tr>
    <tr><td class="label">營業稅 ${r.is_tax_free ? '（免稅）' : '（5%）'}</td><td>$${money(r.tax)}</td></tr>
    <tr><td class="label">含稅總計</td><td>$${money(r.total)}</td></tr>
    ${deductions.map(([label, v]) => `<tr><td class="label">${label}</td><td>−$${money(v)}</td></tr>`).join('')}
    <tr class="net"><td class="label">本期${billing ? '應收' : '應付'}淨額</td><td>$${money(r.net_amount)}</td></tr>
    ${Number(r.paid_amount) > 0 ? `<tr><td class="label">已${billing ? '收' : '付'}</td><td>$${money(r.paid_amount)}</td></tr>
      <tr><td class="label">未結</td><td>$${money(r.outstanding)}</td></tr>` : ''}
  </table>
  <div style="clear:both;"></div>

  ${r.deduction_note ? `<div class="memo"><strong>扣款原因：</strong>${escapeHtml(r.deduction_note)}</div>` : ''}
  ${r.note ? `<div class="memo"><strong>備註說明：</strong><br>${escapeHtml(r.note).replace(/\n/g, '<br>')}</div>` : ''}

  <table class="sign">
    <thead><tr>
      <th style="width:20%;">出納會計</th><th style="width:20%;">總經理</th><th style="width:20%;">覆核</th>
      <th style="width:20%;">工務主任</th><th style="width:20%;">經辦人</th>
    </tr></thead>
    <tbody><tr>
      <td></td><td></td><td></td><td></td><td>${escapeHtml(r.applicant_name || '')}</td>
    </tr></tbody>
  </table>

  ${r.photos.length ? `<div class="photos">
    <h4>單據與現場附件</h4>
    <div class="photo-grid">
      ${r.photos.map((p, i) => `<figure><img src="${p.data}"><figcaption>附件 #${i + 1}</figcaption></figure>`).join('')}
    </div>
  </div>` : ''}`;
}

function money(n) { return (Number(n) || 0).toLocaleString('zh-TW', { maximumFractionDigits: 0 }); }
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
