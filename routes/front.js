const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// ============================================================
// 前台 API：不需要密碼，用手機號碼辨識身分
// 一律不回傳銀行帳戶、保留款、扣款等財務欄位
// ============================================================
function normPhone(v) {
  return String(v || '').replace(/[^0-9]/g, '');
}
function num(v) {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function nullableDate(v) { return v && String(v).trim() ? v : null; }

// 前台看得到的欄位（刻意不含 bank_name / bank_account / 扣抵項目）
function frontView(r) {
  return {
    id: r.id, doc_no: r.doc_no, kind: r.kind, request_type: r.request_type,
    company_name: r.company_name, counterparty_name: r.counterparty_name,
    site_name: r.site_name, applicant_name: r.applicant_name,
    invoice_no: r.invoice_no, invoice_date: r.invoice_date_fmt || r.invoice_date,
    due_date: r.due_date_fmt || r.due_date, is_tax_free: r.is_tax_free,
    subtotal: r.subtotal, tax: r.tax, total: r.total,
    status: r.status, voided: r.voided, note: r.note,
    created_date: r.created_date,
  };
}

// ---------- 身分 ----------
router.post('/users/lookup', async (req, res) => {
  try {
    const phone = normPhone(req.body.phone);
    if (phone.length < 8) return res.status(400).json({ error: '請輸入正確的手機號碼' });
    const row = (await pool.query(
      `SELECT id, name, employee_no, phone FROM applicants
       WHERE REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $1 AND active IS NOT FALSE
       ORDER BY id LIMIT 1`, [phone]
    )).rows[0];
    res.json({ found: !!row, user: row || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

router.post('/users/register', async (req, res) => {
  try {
    const phone = normPhone(req.body.phone);
    const name = (req.body.name || '').trim();
    if (phone.length < 8) return res.status(400).json({ error: '請輸入正確的手機號碼' });
    if (!name) return res.status(400).json({ error: '請填寫姓名' });

    // 同名但沒填手機的舊資料，直接補上手機，不另外開一筆
    const same = (await pool.query('SELECT * FROM applicants WHERE name = $1', [name])).rows[0];
    if (same) {
      const row = (await pool.query(
        'UPDATE applicants SET phone = $1, employee_no = COALESCE(NULLIF($2,\'\'), employee_no) WHERE id = $3 RETURNING id, name, employee_no, phone',
        [phone, (req.body.employee_no || '').trim(), same.id]
      )).rows[0];
      return res.json({ user: row });
    }
    const row = (await pool.query(
      'INSERT INTO applicants (name, phone, employee_no) VALUES ($1,$2,$3) RETURNING id, name, employee_no, phone',
      [name, phone, (req.body.employee_no || '').trim()]
    )).rows[0];
    res.status(201).json({ user: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '建檔失敗' });
  }
});

// 依手機確認身分，回傳申請人資料（每個前台動作都會先驗這一關）
async function requireUser(req, res) {
  const phone = normPhone(req.body.phone || req.query.phone);
  if (!phone) { res.status(401).json({ error: '請先以手機號碼登入' }); return null; }
  const row = (await pool.query(
    `SELECT * FROM applicants WHERE REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $1 ORDER BY id LIMIT 1`, [phone]
  )).rows[0];
  if (!row) { res.status(401).json({ error: '查不到這組手機，請重新登入' }); return null; }
  return row;
}

// ---------- 下拉選項 ----------
router.get('/options', async (req, res) => {
  try {
    const companies = (await pool.query('SELECT id, name FROM companies WHERE active IS NOT FALSE ORDER BY sort_order, id')).rows;
    const sites = (await pool.query('SELECT id, name FROM sites WHERE active IS NOT FALSE ORDER BY sort_order, id')).rows;
    res.json({ companies, sites });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '讀取選項失敗' });
  }
});

// 廠商／客戶搜尋：公司名稱或統一編號都可以查（不回傳銀行資料）
router.get('/counterparties', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 1) return res.json([]);
    const rows = (await pool.query(
      `SELECT id, name, tax_id, contact_person FROM counterparties
       WHERE active IS NOT FALSE AND (name ILIKE $1 OR REPLACE(COALESCE(tax_id,''),'-','') ILIKE $2)
       ORDER BY name LIMIT 20`,
      [`%${q}%`, `%${q.replace(/-/g, '')}%`]
    )).rows;
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '搜尋失敗' });
  }
});

// 查無資料時，前台可以直接建立（只建基本資料，銀行帳戶留給財務）
router.post('/counterparties', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: '請填寫公司名稱' });
    const taxId = (req.body.tax_id || '').trim();

    const dup = (await pool.query(
      `SELECT id, name, tax_id FROM counterparties
       WHERE name = $1 OR (COALESCE(tax_id,'') <> '' AND tax_id = $2) LIMIT 1`, [name, taxId]
    )).rows[0];
    if (dup) return res.status(200).json({ ...dup, existed: true });

    const row = (await pool.query(
      `INSERT INTO counterparties (name, role, tax_id, contact_person, phone)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, name, tax_id`,
      [name, req.body.role === 'customer' ? 'customer' : 'vendor', taxId,
        (req.body.contact_person || '').trim(), (req.body.phone_no || '').trim()]
    )).rows[0];
    await pool.query('INSERT INTO audit_logs (action, detail) VALUES ($1,$2)',
      ['前台建立對象', `${row.name}　建立人：${user.name}`]);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: '已經有同名的資料了，請用搜尋選取' });
    console.error(err);
    res.status(500).json({ error: '建立失敗' });
  }
});

// ---------- 建立申請單 ----------
router.post('/requests', async (req, res) => {
  const body = req.body || {};
  const client = await pool.connect();
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!['billing', 'payment'].includes(body.kind)) return res.status(400).json({ error: '請選擇請款或付款' });
    if (!body.company_id) return res.status(400).json({ error: '請選擇歸屬公司' });
    if (!body.counterparty_id) return res.status(400).json({ error: '請選擇對象' });

    const isTaxFree = !!body.is_tax_free;
    const items = (body.items || []).map((it, i) => {
      const quantity = num(it.quantity);
      const unitPrice = num(it.unit_price);
      const subtotal = Math.round(quantity * unitPrice);
      return {
        item_name: (it.item_name || '').trim(), quantity, unit: it.unit || '式', unit_price: unitPrice,
        subtotal, total: isTaxFree ? subtotal : Math.round(subtotal * 1.05), sort_order: i,
      };
    }).filter((it) => it.item_name);
    if (!items.length) return res.status(400).json({ error: '請至少填寫一筆品項明細' });

    const subtotal = items.reduce((s, it) => s + it.subtotal, 0);
    const total = items.reduce((s, it) => s + it.total, 0);

    await client.query('BEGIN');
    const company = (await client.query('SELECT * FROM companies WHERE id=$1', [body.company_id])).rows[0];
    const party = (await client.query('SELECT * FROM counterparties WHERE id=$1', [body.counterparty_id])).rows[0];
    const site = body.site_id ? (await client.query('SELECT * FROM sites WHERE id=$1', [body.site_id])).rows[0] : null;
    if (!company || !party) throw new Error('資料不存在，請重新整理後再試');

    const prefix = body.kind === 'billing' ? 'B' : 'P';
    const year = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }).slice(0, 4);
    const last = (await client.query(
      'SELECT doc_no FROM requests WHERE doc_no LIKE $1 ORDER BY doc_no DESC LIMIT 1', [`${prefix}-${year}-%`]
    )).rows[0];
    const docNo = `${prefix}-${year}-${String(last ? Number(last.doc_no.split('-')[2]) + 1 : 1).padStart(4, '0')}`;

    // 銀行帳戶留空，由後台核簽時帶入
    const row = (await client.query(
      `INSERT INTO requests (
         doc_no, kind, request_type, company_id, company_name, counterparty_id, counterparty_name,
         site_id, site_name, applicant_id, applicant_name, invoice_no, invoice_date, is_tax_free,
         subtotal, tax, total, net_amount, due_date, status, note
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'pending_approval',$20)
       RETURNING *`,
      [
        docNo, body.kind, body.request_type || '一般工程款', company.id, company.name, party.id, party.name,
        site ? site.id : null, site ? site.name : '', user.id, user.name,
        (body.invoice_no || '').trim(), nullableDate(body.invoice_date), isTaxFree,
        subtotal, total - subtotal, total, total, nullableDate(body.due_date), (body.note || '').trim(),
      ]
    )).rows[0];

    for (const it of items) {
      await client.query(
        `INSERT INTO request_items (request_id, item_name, quantity, unit, unit_price, subtotal, total, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [row.id, it.item_name, it.quantity, it.unit, it.unit_price, it.subtotal, it.total, it.sort_order]
      );
    }
    for (const p of (body.photos || [])) {
      if (p && p.data) {
        await client.query('INSERT INTO request_photos (request_id, file_name, data) VALUES ($1,$2,$3)',
          [row.id, p.file_name || '', p.data]);
      }
    }
    await client.query('INSERT INTO audit_logs (request_id, action, detail) VALUES ($1,$2,$3)',
      [row.id, '前台送出申請單', `${row.doc_no}　${row.counterparty_name}　NT$ ${row.total}　申請人：${user.name}`]);
    await client.query('COMMIT');
    res.status(201).json(frontView({ ...row, created_date: '' }));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message || '送出失敗' });
  } finally {
    client.release();
  }
});

// ---------- 我的申請單 ----------
router.get('/requests', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const params = [user.id];
    let sql = `SELECT r.*, TO_CHAR(r.created_at AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') AS created_date,
                      TO_CHAR(r.invoice_date,'YYYY-MM-DD') AS invoice_date_fmt,
                      TO_CHAR(r.due_date,'YYYY-MM-DD') AS due_date_fmt
               FROM requests r WHERE r.applicant_id = $1`;
    if (req.query.kind) { params.push(req.query.kind); sql += ` AND r.kind = $${params.length}`; }
    if (req.query.keyword) {
      params.push(`%${req.query.keyword}%`);
      sql += ` AND (r.doc_no ILIKE $${params.length} OR r.invoice_no ILIKE $${params.length}
                    OR r.counterparty_name ILIKE $${params.length} OR r.site_name ILIKE $${params.length})`;
    }
    sql += ' ORDER BY r.id DESC LIMIT 200';
    res.json((await pool.query(sql, params)).rows.map(frontView));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

router.get('/requests/:id', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const row = (await pool.query(
      `SELECT r.*, TO_CHAR(r.created_at AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') AS created_date,
              TO_CHAR(r.invoice_date,'YYYY-MM-DD') AS invoice_date_fmt,
              TO_CHAR(r.due_date,'YYYY-MM-DD') AS due_date_fmt
       FROM requests r WHERE r.id = $1 AND r.applicant_id = $2`, [req.params.id, user.id]
    )).rows[0];
    if (!row) return res.status(404).json({ error: '查不到這張單，或這張單不是您送出的' });
    const view = frontView(row);
    view.items = (await pool.query(
      'SELECT item_name, quantity, unit, unit_price, subtotal, total FROM request_items WHERE request_id=$1 ORDER BY sort_order, id',
      [row.id]
    )).rows;
    view.photos = (await pool.query('SELECT id, data FROM request_photos WHERE request_id=$1 ORDER BY id', [row.id])).rows;
    res.json(view);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '讀取失敗' });
  }
});

module.exports = router;
