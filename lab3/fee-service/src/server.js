'use strict';
/**
 * FEE SERVICE (hệ thống của trường) - cổng 4001
 *
 *  GET  /students/:id/fees            công nợ
 *  POST /students/:id/payments        {"amount": 100000}  -> gọi cổng ngân hàng
 *  GET  /payments/:paymentId          xem một lệnh thanh toán
 *  POST /payments/:paymentId/reconcile  đối soát lệnh PENDING (hỏi lại ngân hàng bằng cùng Idempotency-Key)
 *  GET  /health
 *
 * MODE=robust (mặc định) | naive (cách viết trước khi sửa, chỉ để đo)
 */
const express = require('express');

const MODE = process.env.MODE === 'naive' ? 'naive' : 'robust';
const PORT = Number(process.env.PORT || 4001);
const bank = MODE === 'naive' ? require('./bankClientNaive') : require('./bankClient');

// ---------- Dữ liệu trong bộ nhớ ----------
const students = new Map([
  [1, { id: 1, debt: 50_000_000, reserved: 0 }],
  [2, { id: 2, debt: 0, reserved: 0 }],
  [3, { id: 3, debt: 3_200_000, reserved: 0 }],
]);
const payments = new Map();
let paymentSeq = 0;

/**
 * Chuyển trạng thái lệnh thanh toán. Chỉ đi từ PROCESSING/PENDING sang trạng thái mới,
 * nên công nợ CHỈ giảm đúng một lần và CHỈ khi ngân hàng đã trừ tiền.
 *  - 'reserved' là số tiền đang giữ chỗ cho lệnh chưa có kết quả cuối (PROCESSING/PENDING),
 *    để nhiều lệnh đồng thời không thể cùng vượt công nợ.
 */
function settle(payment, newStatus, extra = {}) {
  if (payment.status !== 'PROCESSING' && payment.status !== 'PENDING') return false;
  const st = students.get(payment.studentId);
  if (newStatus === 'PAID') {
    st.debt -= payment.amount;
    st.reserved -= payment.amount;
  } else if (newStatus === 'FAILED') {
    st.reserved -= payment.amount;
  } // PENDING: vẫn giữ chỗ
  Object.assign(payment, extra, { status: newStatus, updatedAt: new Date().toISOString() });
  return true;
}

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, mode: MODE }));

// Công nợ: KHÔNG phụ thuộc ngân hàng nên luôn trả nhanh
app.get('/students/:id/fees', (req, res) => {
  const st = students.get(Number(req.params.id));
  if (!st) return res.status(404).json({ error: 'Không tìm thấy sinh viên' });
  res.json({ studentId: st.id, debt: st.debt, pending: st.reserved, currency: 'VND' });
});

app.post('/students/:id/payments', async (req, res) => {
  const st = students.get(Number(req.params.id));
  if (!st) return res.status(404).json({ error: 'Không tìm thấy sinh viên' });

  const amount = req.body && req.body.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount phải là số nguyên dương' });
  }
  const available = st.debt - st.reserved;
  if (amount > available) {
    return res.status(400).json({
      error: `Số tiền ${amount} vượt công nợ còn có thể thanh toán (${available})`,
    });
  }

  // Tạo lệnh + giữ chỗ tiền
  const paymentId = `P${++paymentSeq}`;
  const payment = {
    paymentId, studentId: st.id, amount, status: 'PROCESSING',
    createdAt: new Date().toISOString(),
  };
  payments.set(paymentId, payment);
  st.reserved += amount;

  const fail = (code, status, error, extra = {}) => {
    settle(payment, status, { error, ...extra });
    return res.status(code).json({ error, paymentId, status });
  };

  // ---- MODE naive: cách viết "ngây thơ" ----
  if (MODE === 'naive') {
    try {
      const r = await bank.charge({ reference: paymentId, amount });
      if (r.status === 201) {
        settle(payment, 'PAID', { chargeId: r.body.chargeId });
        return res.status(201).json({ paymentId, studentId: st.id, amount, status: 'PAID', chargeId: r.body.chargeId, remainingDebt: st.debt });
      }
      return fail(r.status, 'FAILED', (r.body && (r.body.message || r.body.error)) || 'Ngân hàng từ chối', { bankStatus: r.status });
    } catch (e) {
      return fail(500, 'FAILED', 'Lỗi hệ thống: ' + e.message);
    }
  }

  // ---- MODE robust ----
  const r = await bank.charge({ reference: paymentId, amount, idempotencyKey: paymentId });
  switch (r.outcome) {
    case 'PAID':
      settle(payment, 'PAID', { chargeId: r.charge.chargeId, attempts: r.attempts });
      return res.status(201).json({
        paymentId, studentId: st.id, amount, status: 'PAID',
        chargeId: r.charge.chargeId, remainingDebt: st.debt,
      });
    case 'REJECTED': // ngân hàng từ chối rõ ràng: giữ mã của ngân hàng (400/402/422...)
      return fail(r.status, 'FAILED',
        (r.body && (r.body.message || r.body.error)) || 'Ngân hàng từ chối giao dịch', { bankStatus: r.status });
    case 'UNKNOWN': // hết thời gian chờ / đứt kết nối: KHÔNG biết đã trừ tiền hay chưa
      return fail(504, 'PENDING', 'Chưa xác định được kết quả từ ngân hàng, lệnh đang chờ đối soát', { reason: r.reason });
    case 'BANK_ERROR': // ngân hàng báo lỗi tạm thời (trước khi trừ tiền) và vẫn lỗi sau các lần thử lại
      return fail(503, 'FAILED', 'Ngân hàng đang lỗi tạm thời, chưa trừ tiền', { reason: `bank_${r.status}` });
    default: // UNREACHABLE: không kết nối được => chắc chắn chưa trừ tiền
      return fail(503, 'FAILED', 'Không kết nối được tới ngân hàng, chưa trừ tiền', { reason: r.reason });
  }
});

app.get('/payments/:paymentId', (req, res) => {
  const p = payments.get(req.params.paymentId);
  if (!p) return res.status(404).json({ error: 'Không tìm thấy lệnh thanh toán' });
  res.json(p);
});

// Đối soát lệnh PENDING: hỏi lại ngân hàng bằng CÙNG Idempotency-Key -> không bao giờ trừ hai lần
app.post('/payments/:paymentId/reconcile', async (req, res) => {
  const p = payments.get(req.params.paymentId);
  if (!p) return res.status(404).json({ error: 'Không tìm thấy lệnh thanh toán' });
  if (MODE === 'naive') return res.status(501).json({ error: 'naive mode không hỗ trợ đối soát' });
  if (p.status !== 'PENDING') return res.json({ paymentId: p.paymentId, status: p.status, note: 'Không còn ở trạng thái PENDING' });

  const r = await bank.charge({ reference: p.paymentId, amount: p.amount, idempotencyKey: p.paymentId });
  if (r.outcome === 'PAID') settle(p, 'PAID', { chargeId: r.charge.chargeId });
  else if (r.outcome === 'REJECTED') settle(p, 'FAILED', { error: 'Ngân hàng từ chối khi đối soát', bankStatus: r.status });
  // UNREACHABLE/UNKNOWN/BANK_ERROR: vẫn chưa biết -> giữ PENDING (KHÔNG được coi là FAILED)
  const st = students.get(p.studentId);
  res.json({ paymentId: p.paymentId, status: p.status, remainingDebt: st.debt });
});

// Lỗi không lường trước (JSON hỏng, ...) -> trả JSON, không sập
app.use((err, _req, res, _next) => {
  const code = err.status || err.statusCode || 500;
  res.status(code).json({ error: code === 400 ? 'JSON không hợp lệ' : 'Lỗi hệ thống' });
});

// Fee Service không được sập vì lỗi lọt lưới
process.on('unhandledRejection', (e) => console.error('[fee] unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('[fee] uncaughtException:', e));

const server = app.listen(PORT, () => {
  console.log(`[fee] listening on :${PORT} MODE=${MODE} BANK_URL=${process.env.BANK_URL || 'http://localhost:4002'}`);
});
// Không bind được cổng thì phải thoát hẳn (không được "sống" mà không phục vụ)
server.on('error', (e) => { console.error('[fee] cannot listen:', e.message); process.exit(1); });
