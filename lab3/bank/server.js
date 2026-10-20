'use strict';
/**
 * NGÂN HÀNG GIẢ LẬP (bên thứ ba) - cổng 4002
 *
 * POST /charges {reference, amount}
 *   201 {chargeId,...}   400 số tiền/ tham chiếu không hợp lệ   402 vượt hạn mức 20.000.000đ
 *   Header Idempotency-Key: cùng khóa => trả lại giao dịch cũ, KHÔNG trừ thêm.
 * GET /stats -> {connections, requests, charges, duplicates}
 *
 * Biến môi trường (khởi động lại để áp dụng):
 *   PORT       (mặc định 4002)
 *   DELAY_MS   trễ thêm ngần ấy ms trước khi xử lý mỗi yêu cầu POST /charges
 *   FAIL_RATE  0..1  tỉ lệ trả 500 TRƯỚC khi trừ tiền
 *   DROP_RATE  0..1  tỉ lệ TRỪ TIỀN XONG rồi cắt kết nối trước khi trả lời
 */
const express = require('express');

const PORT = Number(process.env.PORT || 4002);
const DELAY_MS = Number(process.env.DELAY_MS || 0);
const FAIL_RATE = Number(process.env.FAIL_RATE || 0);
const DROP_RATE = Number(process.env.DROP_RATE || 0);
const LIMIT = 20_000_000;

const stats = { connections: 0, requests: 0, charges: 0, duplicates: 0 };
const byKey = new Map();        // Idempotency-Key -> { fingerprint, charge }
const chargedRefs = new Map();  // reference -> số lần đã trừ tiền thật sự
let chargeSeq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 23);

const app = express();
app.disable('x-powered-by');
app.use(express.json());

app.get('/stats', (_req, res) => res.json(stats));

app.post('/charges', async (req, res) => {
  stats.requests++;
  const { reference, amount } = req.body || {};
  const key = req.get('Idempotency-Key');

  if (DELAY_MS > 0) await sleep(DELAY_MS);

  // 1) Kiểm tra hợp lệ / hạn mức (xác định, không ngẫu nhiên)
  if (typeof reference !== 'string' || !reference ||
      typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'invalid_request', message: 'reference/amount không hợp lệ' });
  }
  if (amount > LIMIT) {
    return res.status(402).json({ error: 'limit_exceeded', message: `Vượt hạn mức ${LIMIT}đ` });
  }

  // 2) Lỗi tạm thời: 500 TRƯỚC khi trừ tiền
  if (FAIL_RATE > 0 && Math.random() < FAIL_RATE) {
    return res.status(500).json({ error: 'temporary_failure' });
  }

  // 3) Idempotency + trừ tiền (đồng bộ, không có await => không race)
  let charge;
  let replayed = false;
  const fingerprint = `${reference}|${amount}`;
  if (key && byKey.has(key)) {
    const old = byKey.get(key);
    if (old.fingerprint !== fingerprint) {
      return res.status(422).json({ error: 'idempotency_key_reuse', message: 'Khóa đã dùng cho yêu cầu khác' });
    }
    charge = old.charge;
    replayed = true;
  } else {
    const n = (chargedRefs.get(reference) || 0) + 1;
    chargedRefs.set(reference, n);
    if (n > 1) stats.duplicates++;           // trừ tiền trùng cho cùng một reference
    stats.charges++;
    charge = { chargeId: `C${++chargeSeq}`, reference, amount, status: 'CHARGED' };
    if (key) byKey.set(key, { fingerprint, charge });
  }

  // 4) Trừ xong rồi cắt kết nối trước khi trả lời
  if (DROP_RATE > 0 && Math.random() < DROP_RATE) {
    return req.socket.destroy();
  }

  if (res.destroyed || res.writableEnded || req.socket.destroyed) return; // client đã bỏ đi
  if (replayed) res.set('Idempotent-Replayed', 'true');
  res.status(201).json(charge);
});

const server = app.listen(PORT, () => {
  console.log(`[bank] listening on :${PORT}  DELAY_MS=${DELAY_MS} FAIL_RATE=${FAIL_RATE} DROP_RATE=${DROP_RATE}`);
});
server.keepAliveTimeout = 5000; // giữ kết nối nhàn rỗi tối đa 5 giây (mặc định Node.js)
server.on('connection', (socket) => {
  stats.connections++;
  console.log(`[bank ${ts()}] new TCP connection #${stats.connections} (remote port ${socket.remotePort})`);
});
