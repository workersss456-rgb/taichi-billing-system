const express = require('express');
const { pool } = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

// 登入檢查（前端拿來驗證密碼）
router.post('/login', auth, (req, res) => res.json({ ok: true }));

// 這個系統牽涉金額與銀行帳戶，所有 API 都要密碼
router.use(auth);

// ============================================================
// 共用小工具
// ============================================================
function num(v) {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function nullableDate(v) {
  return v && String(v).trim() ? v : null;
}
function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
async function log(requestId, action, detail) {
  try {
    await pool.query('INSERT INTO audit_logs (request_id, action, detail) VALUES ($1,$2,$3)',
      [requestId, action, detail || '']);
  } catch (err) { console.error('寫入操作紀錄失敗：', err.message); }
}

// ============================================================
// 主檔：公司 / 廠商客戶 / 申請人 / 案場
// ============================================================
const MASTERS = {
  companies: { table: 'companies', label: '公司', fields: ['name', 'tax_id', 'bank', 'account', 'address', 'active'] },
  counterparties: { table: 'counterparties', label: '廠商／客戶', fields: ['name', 'role', 'tax_id', 'bank', 'account', 'contact_person', 'phone', 'address', 'active'] },
  applicants: { table: 'applicants', label: '申請人', fields: ['employee_no', 'name', 'phone', 'active'] },
  sites: { table: 'sites', label: '案場', fields: ['name', 'address', 'scope', 'supervisor', 'active'] },
};

router.get('/masters', async (req, res) => {
  try {
    const out = {};
    for (const [key, m] of Object.entries(MASTERS)) {
      out[key] = (await pool.query(`SELECT * FROM ${m.table} ORDER BY active DESC, sort_order, id`)).rows;
    }
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '讀取主檔失敗' });
  }
});

router.post('/masters/:type', async (req, res) => {
  const m = MASTERS[req.params.type];
  if (!m) return res.status(400).json({ error: '主檔類型不正確' });
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: `請填寫${m.label}名稱` });
    const cols = m.fields.filter((f) => req.body[f] !== undefined);
    const vals = cols.map((f) => (f === 'active' ? !!req.body[f] : (req.body[f] ?? '')));
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
    const row = (await pool.query(
      `INSERT INTO ${m.table} (${cols.join(',')}) VALUES (${placeholders}) RETURNING *`, vals
    )).rows[0];
    res.status(201).json(row);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: `已經有同名的${m.label}了` });
    console.error(err);
    res.status(500).json({ error: `新增${m.label}失敗` });
  }
});

router.put('/masters/:type/:id', async (req, res) => {
  const m = MASTERS[req.params.type];
  if (!m) return res.status(400).json({ error: '主檔類型不正確' });
  try {
    const cols = m.fields.filter((f) => req.body[f] !== undefined);
    if (!cols.length) return res.status(400).json({ error: '沒有要更新的欄位' });
    const sets = cols.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const vals = cols.map((f) => (f === 'active' ? !!req.body[f] : (req.body[f] ?? '')));
    vals.push(req.params.id);
    const row = (await pool.query(
      `UPDATE ${m.table} SET ${sets} WHERE id = $${vals.length} RETURNING *`, vals
    )).rows[0];
    if (!row) return res.status(404).json({ error: `找不到這筆${m.label}` });
    res.json(row);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: `已經有同名的${m.label}了` });
    console.error(err);
    res.status(500).json({ error: `更新${m.label}失敗` });
  }
});

// 主檔不提供刪除：歷史單據會引用。改成停用（active = false）
router.put('/masters/:type/:id/toggle', async (req, res) => {
  const m = MASTERS[req.params.type];
  if (!m) return res.status(400).json({ error: '主檔類型不正確' });
  try {
    const row = (await pool.query(
      `UPDATE ${m.table} SET active = NOT active WHERE id = $1 RETURNING *`, [req.params.id]
    )).rows[0];
    if (!row) return res.status(404).json({ error: `找不到這筆${m.label}` });
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '切換狀態失敗' });
  }
});

// ============================================================
// 申請單
// ============================================================
const REQUEST_TYPES = ['一般工程款', '點工費用', '材料採購', '零用金核銷'];

// 單號：請款 B-2026-0001、付款 P-2026-0001，各自依年度流水
async function nextDocNo(client, kind) {
  const prefix = kind === 'billing' ? 'B' : 'P';
  const year = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }).slice(0, 4);
  const like = `${prefix}-${year}-%`;
  const row = (await client.query(
    `SELECT doc_no FROM requests WHERE doc_no LIKE $1 ORDER BY doc_no DESC LIMIT 1`, [like]
  )).rows[0];
  const seq = row ? Number(row.doc_no.split('-')[2]) + 1 : 1;
  return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

// 由明細與各項扣抵重算金額，一律以後端算的為準
function calcAmounts(body) {
  const isTaxFree = !!body.is_tax_free;
  const items = (body.items || []).map((it, i) => {
    const quantity = num(it.quantity);
    const unitPrice = num(it.unit_price);
    const subtotal = Math.round(quantity * unitPrice);
    const total = isTaxFree ? subtotal : Math.round(subtotal * 1.05);
    return { item_name: (it.item_name || '').trim(), quantity, unit: it.unit || '式', unit_price: unitPrice, subtotal, total, sort_order: i };
  });
  const subtotal = items.reduce((s, it) => s + it.subtotal, 0);
  const total = items.reduce((s, it) => s + it.total, 0);
  const retention = num(body.retention_amount);
  const deduction = num(body.deduction_amount);
  const prepaid = num(body.prepaid_offset);
  return {
    items, isTaxFree, subtotal, tax: total - subtotal, total,
    retention, deduction, prepaid,
    net: total - retention - deduction - prepaid,
  };
}

async function replaceChildren(client, requestId, items, photos) {
  await client.query('DELETE FROM request_items WHERE request_id = $1', [requestId]);
  for (const it of items) {
    await client.query(
      `INSERT INTO request_items (request_id, item_name, quantity, unit, unit_price, subtotal, total, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [requestId, it.item_name, it.quantity, it.unit, it.unit_price, it.subtotal, it.total, it.sort_order]
    );
  }
  if (Array.isArray(photos)) {
    // 只有前端明確送 photos 才重建；沒送代表這次不動附件
    await client.query('DELETE FROM request_photos WHERE request_id = $1', [requestId]);
    for (const p of photos) {
      if (!p || !p.data) continue;
      await client.query('INSERT INTO request_photos (request_id, file_name, data) VALUES ($1,$2,$3)',
        [requestId, p.file_name || p.name || '', p.data]);
    }
  }
}

router.post('/requests', async (req, res) => {
  const body = req.body || {};
  if (!['billing', 'payment'].includes(body.kind)) return res.status(400).json({ error: '請選擇請款或付款' });
  if (!REQUEST_TYPES.includes(body.request_type)) return res.status(400).json({ error: '申請類型不正確' });
  if (!body.company_id) return res.status(400).json({ error: '請選擇歸屬公司' });
  if (!body.counterparty_id) return res.status(400).json({ error: body.kind === 'billing' ? '請選擇請款對象' : '請選擇付款對象' });
  if (!body.applicant_id) return res.status(400).json({ error: '請選擇申請人' });
  const amounts = calcAmounts(body);
  if (!amounts.items.length || amounts.items.some((it) => !it.item_name)) {
    return res.status(400).json({ error: '請至少填寫一筆品項明細' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const company = (await client.query('SELECT * FROM companies WHERE id = $1', [body.company_id])).rows[0];
    const party = (await client.query('SELECT * FROM counterparties WHERE id = $1', [body.counterparty_id])).rows[0];
    const site = body.site_id ? (await client.query('SELECT * FROM sites WHERE id = $1', [body.site_id])).rows[0] : null;
    const applicant = (await client.query('SELECT * FROM applicants WHERE id = $1', [body.applicant_id])).rows[0];
    if (!company || !party || !applicant) throw new Error('主檔資料不存在，請重新整理後再試');

    // 請款（應收）收款帳戶＝本公司；付款（應付）＝廠商帳戶
    const bankSource = body.kind === 'billing' ? company : party;
    const docNo = await nextDocNo(client, body.kind);

    const row = (await client.query(
      `INSERT INTO requests (
         doc_no, kind, request_type, company_id, company_name, counterparty_id, counterparty_name,
         site_id, site_name, applicant_id, applicant_name, invoice_no, invoice_date, is_tax_free,
         subtotal, tax, total, retention_amount, deduction_amount, deduction_note, prepaid_offset,
         net_amount, bank_name, bank_account, due_date, status, note
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       RETURNING *`,
      [
        docNo, body.kind, body.request_type, company.id, company.name, party.id, party.name,
        site ? site.id : null, site ? site.name : '', applicant.id, applicant.name,
        (body.invoice_no || '').trim(), nullableDate(body.invoice_date), amounts.isTaxFree,
        amounts.subtotal, amounts.tax, amounts.total, amounts.retention, amounts.deduction,
        (body.deduction_note || '').trim(), amounts.prepaid, amounts.net,
        bankSource.bank || '', bankSource.account || '', nullableDate(body.due_date),
        body.status === 'draft' ? 'draft' : 'pending_approval', (body.note || '').trim(),
      ]
    )).rows[0];

    await replaceChildren(client, row.id, amounts.items, body.photos || []);
    await client.query('COMMIT');
    await log(row.id, '建立申請單', `${row.doc_no}　${row.counterparty_name}　NT$ ${row.net_amount}`);
    res.status(201).json(row);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message || '建立申請單失敗' });
  } finally {
    client.release();
  }
});

router.put('/requests/:id', async (req, res) => {
  const body = req.body || {};
  const client = await pool.connect();
  try {
    const current = (await client.query('SELECT * FROM requests WHERE id = $1', [req.params.id])).rows[0];
    if (!current) return res.status(404).json({ error: '找不到這張申請單' });
    if (current.voided) return res.status(400).json({ error: '已作廢的申請單不能修改' });

    const amounts = calcAmounts(body);
    if (!amounts.items.length || amounts.items.some((it) => !it.item_name)) {
      return res.status(400).json({ error: '請至少填寫一筆品項明細' });
    }

    await client.query('BEGIN');
    const company = (await client.query('SELECT * FROM companies WHERE id = $1', [body.company_id || current.company_id])).rows[0];
    const party = (await client.query('SELECT * FROM counterparties WHERE id = $1', [body.counterparty_id || current.counterparty_id])).rows[0];
    const site = body.site_id ? (await client.query('SELECT * FROM sites WHERE id = $1', [body.site_id])).rows[0] : null;
    const applicant = (await client.query('SELECT * FROM applicants WHERE id = $1', [body.applicant_id || current.applicant_id])).rows[0];
    const bankSource = current.kind === 'billing' ? company : party;

    const row = (await client.query(
      `UPDATE requests SET request_type=$1, company_id=$2, company_name=$3, counterparty_id=$4, counterparty_name=$5,
         site_id=$6, site_name=$7, applicant_id=$8, applicant_name=$9, invoice_no=$10, invoice_date=$11,
         is_tax_free=$12, subtotal=$13, tax=$14, total=$15, retention_amount=$16, deduction_amount=$17,
         deduction_note=$18, prepaid_offset=$19, net_amount=$20, bank_name=$21, bank_account=$22,
         due_date=$23, note=$24, updated_at=NOW()
       WHERE id=$25 RETURNING *`,
      [
        body.request_type || current.request_type, company.id, company.name, party.id, party.name,
        site ? site.id : null, site ? site.name : '', applicant.id, applicant.name,
        (body.invoice_no || '').trim(), nullableDate(body.invoice_date), amounts.isTaxFree,
        amounts.subtotal, amounts.tax, amounts.total, amounts.retention, amounts.deduction,
        (body.deduction_note || '').trim(), amounts.prepaid, amounts.net,
        bankSource.bank || '', bankSource.account || '', nullableDate(body.due_date),
        (body.note || '').trim(), req.params.id,
      ]
    )).rows[0];

    await replaceChildren(client, row.id, amounts.items, body.photos);
    await client.query('COMMIT');
    await log(row.id, '修改申請單', `${row.doc_no}　淨額 NT$ ${row.net_amount}`);
    res.json(row);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message || '修改申請單失敗' });
  } finally {
    client.release();
  }
});

// 查詢：kind / status / 對象 / 案場 / 日期區間 / 關鍵字
router.get('/requests', async (req, res) => {
  try {
    const { kind, status, counterparty_id, site_id, from, to, keyword, include_voided } = req.query;
    const params = [];
    let sql = `SELECT r.*,
                 COALESCE((SELECT SUM(s.amount) FROM settlements s WHERE s.request_id = r.id), 0) AS paid_amount,
                 TO_CHAR(r.created_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') AS created_date,
                 TO_CHAR(r.invoice_date, 'YYYY-MM-DD') AS invoice_date_fmt,
                 TO_CHAR(r.due_date, 'YYYY-MM-DD') AS due_date_fmt
               FROM requests r WHERE 1=1`;
    if (include_voided !== '1') sql += ' AND r.voided IS NOT TRUE';
    if (kind) { params.push(kind); sql += ` AND r.kind = $${params.length}`; }
    if (status) { params.push(status); sql += ` AND r.status = $${params.length}`; }
    if (counterparty_id) { params.push(counterparty_id); sql += ` AND r.counterparty_id = $${params.length}`; }
    if (site_id) { params.push(site_id); sql += ` AND r.site_id = $${params.length}`; }
    if (from) { params.push(from); sql += ` AND r.created_at AT TIME ZONE 'Asia/Taipei' >= $${params.length}::date`; }
    if (to) { params.push(to); sql += ` AND r.created_at AT TIME ZONE 'Asia/Taipei' < ($${params.length}::date + INTERVAL '1 day')`; }
    if (keyword) {
      params.push(`%${keyword}%`);
      sql += ` AND (r.doc_no ILIKE $${params.length} OR r.invoice_no ILIKE $${params.length}
                    OR r.counterparty_name ILIKE $${params.length} OR r.site_name ILIKE $${params.length}
                    OR r.applicant_name ILIKE $${params.length})`;
    }
    sql += ' ORDER BY r.id DESC LIMIT 500';

    const rows = (await pool.query(sql, params)).rows.map((r) => ({
      ...r,
      invoice_date: r.invoice_date_fmt, due_date: r.due_date_fmt,
      paid_amount: Number(r.paid_amount),
      outstanding: Number(r.net_amount) - Number(r.paid_amount),
    }));
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '查詢申請單失敗' });
  }
});

router.get('/requests/:id', async (req, res) => {
  try {
    const row = (await pool.query(
      `SELECT r.*, TO_CHAR(r.invoice_date, 'YYYY-MM-DD') AS invoice_date_fmt,
              TO_CHAR(r.due_date, 'YYYY-MM-DD') AS due_date_fmt,
              TO_CHAR(r.created_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') AS created_date
       FROM requests r WHERE r.id = $1`, [req.params.id]
    )).rows[0];
    if (!row) return res.status(404).json({ error: '找不到這張申請單' });
    row.invoice_date = row.invoice_date_fmt;
    row.due_date = row.due_date_fmt;
    row.items = (await pool.query('SELECT * FROM request_items WHERE request_id = $1 ORDER BY sort_order, id', [row.id])).rows;
    row.photos = (await pool.query('SELECT id, file_name, data FROM request_photos WHERE request_id = $1 ORDER BY id', [row.id])).rows;
    row.settlements = (await pool.query(
      `SELECT *, TO_CHAR(paid_date, 'YYYY-MM-DD') AS paid_date_fmt FROM settlements WHERE request_id = $1 ORDER BY paid_date, id`,
      [row.id]
    )).rows.map((s) => ({ ...s, paid_date: s.paid_date_fmt }));
    row.paid_amount = row.settlements.reduce((sum, s) => sum + Number(s.amount), 0);
    row.outstanding = Number(row.net_amount) - row.paid_amount;
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '讀取申請單失敗' });
  }
});

// ---------- 狀態 ----------
// 付款：draft 草稿 → pending_approval 待核簽 → approved 已核准 → scheduled 已排款 → partial 部分付款 → settled 付款完成
// 請款：draft → pending_approval → approved → invoiced 已開票 → partial 部分收款 → settled 收款完成
const STATUSES = ['draft', 'pending_approval', 'approved', 'scheduled', 'invoiced', 'partial', 'settled'];

router.put('/requests/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: '狀態不正確' });
    const row = (await pool.query('UPDATE requests SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *', [status, req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: '找不到這張申請單' });
    await log(row.id, '狀態變更', `${row.doc_no} → ${status}`);
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '更新狀態失敗' });
  }
});

router.put('/requests/:id/void', async (req, res) => {
  try {
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: '請填寫作廢原因' });
    const current = (await pool.query('SELECT status, voided FROM requests WHERE id=$1', [req.params.id])).rows[0];
    if (!current) return res.status(404).json({ error: '找不到這張申請單' });
    if (current.voided) return res.status(400).json({ error: '這張單已經作廢了' });
    const paid = (await pool.query('SELECT COUNT(*)::int AS c FROM settlements WHERE request_id=$1', [req.params.id])).rows[0].c;
    if (paid) return res.status(400).json({ error: '已經有收付紀錄，請先刪除紀錄再作廢' });
    const row = (await pool.query(
      'UPDATE requests SET voided=true, void_reason=$1, voided_at=NOW() WHERE id=$2 RETURNING *', [reason, req.params.id]
    )).rows[0];
    await log(row.id, '作廢', `${row.doc_no}　原因：${reason}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '作廢失敗' });
  }
});

router.put('/requests/:id/restore', async (req, res) => {
  try {
    const row = (await pool.query(
      'UPDATE requests SET voided=false, void_reason=NULL, voided_at=NULL WHERE id=$1 RETURNING *', [req.params.id]
    )).rows[0];
    if (!row) return res.status(404).json({ error: '找不到這張申請單' });
    await log(row.id, '還原', row.doc_no);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '還原失敗' });
  }
});

// ---------- 收付紀錄 ----------
// 新增或刪除紀錄後，自動依已付金額調整狀態（部分 / 完成）
async function syncSettleStatus(client, requestId) {
  const r = (await client.query('SELECT * FROM requests WHERE id=$1', [requestId])).rows[0];
  const paid = Number((await client.query(
    'SELECT COALESCE(SUM(amount),0) AS s FROM settlements WHERE request_id=$1', [requestId]
  )).rows[0].s);
  let status = r.status;
  if (paid <= 0) {
    if (['partial', 'settled'].includes(r.status)) status = r.kind === 'billing' ? 'invoiced' : 'scheduled';
  } else if (paid + 0.001 >= Number(r.net_amount)) {
    status = 'settled';
  } else {
    status = 'partial';
  }
  if (status !== r.status) {
    await client.query('UPDATE requests SET status=$1, updated_at=NOW() WHERE id=$2', [status, requestId]);
  }
  return { paid, status };
}

router.post('/requests/:id/settlements', async (req, res) => {
  const client = await pool.connect();
  try {
    const amount = num(req.body.amount);
    if (amount <= 0) return res.status(400).json({ error: '請填寫金額' });
    if (!req.body.paid_date) return res.status(400).json({ error: '請填寫撥款／收款日期' });
    await client.query('BEGIN');
    const row = (await client.query(
      `INSERT INTO settlements (request_id, paid_date, amount, bank, method, note)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, req.body.paid_date, amount, (req.body.bank || '').trim(),
        req.body.method || '匯款', (req.body.note || '').trim()]
    )).rows[0];
    const info = await syncSettleStatus(client, req.params.id);
    await client.query('COMMIT');
    await log(req.params.id, '登記收付', `NT$ ${amount}　累計 NT$ ${info.paid}　狀態 ${info.status}`);
    res.status(201).json(row);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: '登記收付失敗' });
  } finally {
    client.release();
  }
});

router.delete('/settlements/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('DELETE FROM settlements WHERE id=$1 RETURNING *', [req.params.id])).rows[0];
    if (!row) { await client.query('ROLLBACK'); return res.status(404).json({ error: '找不到這筆收付紀錄' }); }
    await syncSettleStatus(client, row.request_id);
    await client.query('COMMIT');
    await log(row.request_id, '刪除收付紀錄', `NT$ ${row.amount}`);
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: '刪除收付紀錄失敗' });
  } finally {
    client.release();
  }
});

// ============================================================
// 報表
// ============================================================
// 未付／未收清單：依對象彙總，含帳齡
router.get('/reports/outstanding', async (req, res) => {
  try {
    const kind = req.query.kind === 'billing' ? 'billing' : 'payment';
    const rows = (await pool.query(
      `SELECT r.id, r.doc_no, r.counterparty_name, r.site_name, r.invoice_no, r.status,
              r.net_amount, r.due_date,
              TO_CHAR(r.invoice_date, 'YYYY-MM-DD') AS invoice_date,
              TO_CHAR(r.due_date, 'YYYY-MM-DD') AS due_date_fmt,
              TO_CHAR(r.created_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') AS created_date,
              (CURRENT_DATE - (r.created_at AT TIME ZONE 'Asia/Taipei')::date) AS age_days,
              COALESCE((SELECT SUM(s.amount) FROM settlements s WHERE s.request_id = r.id), 0) AS paid_amount
       FROM requests r
       WHERE r.kind = $1 AND r.voided IS NOT TRUE AND r.status <> 'settled'
       ORDER BY r.counterparty_name, r.created_at`, [kind]
    )).rows;

    const parties = [];
    let grand = 0;
    for (const r of rows) {
      const outstanding = Number(r.net_amount) - Number(r.paid_amount);
      if (outstanding <= 0) continue;
      grand += outstanding;
      let p = parties.find((x) => x.name === r.counterparty_name);
      if (!p) { p = { name: r.counterparty_name, total: 0, buckets: { d30: 0, d60: 0, d90: 0, over: 0 }, items: [] }; parties.push(p); }
      p.total += outstanding;
      const age = Number(r.age_days);
      if (age <= 30) p.buckets.d30 += outstanding;
      else if (age <= 60) p.buckets.d60 += outstanding;
      else if (age <= 90) p.buckets.d90 += outstanding;
      else p.buckets.over += outstanding;
      p.items.push({
        id: r.id, doc_no: r.doc_no, site_name: r.site_name, invoice_no: r.invoice_no,
        status: r.status, created_date: r.created_date, due_date: r.due_date_fmt,
        net_amount: Number(r.net_amount), paid_amount: Number(r.paid_amount), outstanding, age_days: age,
        overdue: !!(r.due_date_fmt && r.due_date_fmt < new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' })),
      });
    }
    parties.sort((a, b) => b.total - a.total);
    res.json({ kind, grand_total: grand, parties });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '讀取未結清單失敗' });
  }
});

// 月結：某月的應收、應付、已收、已付
router.get('/reports/monthly', async (req, res) => {
  try {
    const month = req.query.month;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) return res.status(400).json({ error: '月份格式不正確（YYYY-MM）' });
    const created = (await pool.query(
      `SELECT kind, COUNT(*)::int AS count, COALESCE(SUM(net_amount),0) AS amount
       FROM requests
       WHERE TO_CHAR(created_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM') = $1 AND voided IS NOT TRUE
       GROUP BY kind`, [month]
    )).rows;
    const settled = (await pool.query(
      `SELECT r.kind, COUNT(*)::int AS count, COALESCE(SUM(s.amount),0) AS amount
       FROM settlements s JOIN requests r ON r.id = s.request_id
       WHERE TO_CHAR(s.paid_date, 'YYYY-MM') = $1 AND r.voided IS NOT TRUE
       GROUP BY r.kind`, [month]
    )).rows;
    const bySite = (await pool.query(
      `SELECT COALESCE(NULLIF(site_name,''), '（未填案場）') AS site_name, kind,
              COUNT(*)::int AS count, COALESCE(SUM(net_amount),0) AS amount
       FROM requests
       WHERE TO_CHAR(created_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM') = $1 AND voided IS NOT TRUE
       GROUP BY 1,2 ORDER BY 1`, [month]
    )).rows;
    const pick = (arr, kind) => {
      const r = arr.find((x) => x.kind === kind);
      return { count: r ? r.count : 0, amount: r ? Number(r.amount) : 0 };
    };
    res.json({
      month,
      billing: { created: pick(created, 'billing'), settled: pick(settled, 'billing') },
      payment: { created: pick(created, 'payment'), settled: pick(settled, 'payment') },
      sites: bySite.map((s) => ({ ...s, amount: Number(s.amount) })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '讀取月結資料失敗' });
  }
});

// CSV 匯出（給會計做樞紐分析）
router.get('/reports/export.csv', async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT r.*, TO_CHAR(r.invoice_date,'YYYY-MM-DD') AS invoice_date_fmt,
              TO_CHAR(r.due_date,'YYYY-MM-DD') AS due_date_fmt,
              TO_CHAR(r.created_at AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') AS created_date,
              COALESCE((SELECT SUM(s.amount) FROM settlements s WHERE s.request_id=r.id),0) AS paid_amount
       FROM requests r WHERE r.voided IS NOT TRUE ORDER BY r.id`
    )).rows;
    const STATUS_TEXT = {
      draft: '草稿', pending_approval: '待核簽', approved: '已核准', scheduled: '已排款',
      invoiced: '已開票', partial: '部分收付', settled: '已完成',
    };
    const out = [['單號', '類別', '申請類型', '公司', '對象', '案場', '申請人', '發票號', '發票日', '稅別',
      '未稅', '稅額', '含稅', '保留款', '扣款', '預付沖抵', '淨額', '已收付', '未結', '狀態', '預計日', '建立日', '備註']];
    for (const r of rows) {
      const paid = Number(r.paid_amount);
      out.push([
        r.doc_no, r.kind === 'billing' ? '請款' : '付款', r.request_type, r.company_name, r.counterparty_name,
        r.site_name, r.applicant_name, r.invoice_no, r.invoice_date_fmt, r.is_tax_free ? '免稅' : '應稅',
        r.subtotal, r.tax, r.total, r.retention_amount, r.deduction_amount, r.prepaid_offset, r.net_amount,
        paid, Number(r.net_amount) - paid, STATUS_TEXT[r.status] || r.status,
        r.due_date_fmt || '', r.created_date, (r.note || '').replace(/\n/g, ' '),
      ]);
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="requests.csv"');
    res.send('\uFEFF' + out.map((r) => r.map(csvEscape).join(',')).join('\n'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '匯出失敗' });
  }
});

router.get('/logs', async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT *, TO_CHAR(created_at AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD HH24:MI') AS time_fmt
       FROM audit_logs ORDER BY id DESC LIMIT 200`
    )).rows;
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '讀取操作紀錄失敗' });
  }
});

module.exports = router;
