'use strict';
/**
 * BANK CLIENT "CHUẨN" - dùng cho Fee Service.
 *
 *  - Duy trì kết nối: http.Agent keep-alive dùng chung, giới hạn số socket,
 *    chủ động đóng socket nhàn rỗi sau IDLE_MS (< 5s của ngân hàng) để không tái dùng
 *    kết nối đã bị ngân hàng đóng.
 *  - Không treo: connect timeout + tổng thời hạn (deadline) cho cả lời gọi.
 *  - Phân loại kết quả theo câu hỏi "tiền đã bị trừ chưa?":
 *        ok          : ngân hàng xác nhận đã trừ         -> PAID
 *        rejected    : ngân hàng từ chối rõ ràng (4xx)   -> FAILED (giữ mã), KHÔNG thử lại
 *        unreachable : chắc chắn chưa gửi / chưa trừ      -> FAILED 503
 *        server_error: 5xx/429 (ngân hàng báo lỗi, trước khi trừ) -> thử lại
 *        unknown     : timeout / đứt kết nối khi đang chờ -> không biết, thử lại với CÙNG
 *                      Idempotency-Key (an toàn, không trừ hai lần)
 *  - Retry chỉ an toàn vì mọi lần gửi đều mang cùng Idempotency-Key = paymentId.
 */
const http = require('http');

const cfg = {
  bankUrl: process.env.BANK_URL || 'http://localhost:4002',
  connectTimeoutMs: Number(process.env.CONNECT_TIMEOUT_MS || 1000),
  deadlineMs: Number(process.env.PAY_DEADLINE_MS || 4000),   // tổng thời gian tối đa cho 1 lần thanh toán
  maxAttempts: Number(process.env.MAX_ATTEMPTS || 5),
  idleMs: Number(process.env.POOL_IDLE_MS || 4000),          // < keepAliveTimeout 5s của ngân hàng
  maxSockets: Number(process.env.BANK_MAX_SOCKETS || 32),
  useIdempotency: (process.env.IDEMPOTENCY || 'on') !== 'off', // chỉ để minh họa "retry mù"
};

const target = new URL(cfg.bankUrl);
const agent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: cfg.maxSockets,
  maxFreeSockets: 16,
  scheduling: 'lifo',      // ưu tiên socket vừa dùng => các socket thừa nhàn rỗi và được đóng
  timeout: cfg.idleMs,     // socket NHÀN RỖI quá idleMs sẽ bị đóng phía client
});

const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);
const codesOf = (err) => [err && err.code, ...((err && err.errors) || []).map((e) => e && e.code)].filter(Boolean);

function attemptOnce(body, headers, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let connTimer = null;
    let gotSocket = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(connTimer);
      resolve(r);
    };

    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({
      agent,
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: '/charges',
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
        const s = res.statusCode;
        if (s >= 200 && s < 300) {
          return json && json.chargeId
            ? finish({ kind: 'ok', charge: json })
            : finish({ kind: 'unknown', reason: 'bad_success_body' });
        }
        if (s === 408 || s === 429 || s >= 500) return finish({ kind: 'server_error', status: s, body: json });
        return finish({ kind: 'rejected', status: s, body: json }); // 4xx còn lại: từ chối rõ ràng
      });
      res.on('aborted', () => finish({ kind: 'unknown', reason: 'response_aborted' }));
      res.on('error', () => finish({ kind: 'unknown', reason: 'response_error' }));
      res.on('close', () => finish({ kind: 'unknown', reason: 'closed_before_end' }));
    });

    // Tổng thời hạn cho lần thử này (gồm cả thời gian chờ socket rảnh)
    const timer = setTimeout(() => {
      req.destroy();
      // chưa nhận được socket => yêu cầu chưa từng được gửi đi => chắc chắn chưa trừ tiền
      finish(gotSocket ? { kind: 'unknown', reason: 'timeout' } : { kind: 'unreachable', reason: 'no_socket' });
    }, timeoutMs);

    req.on('socket', (sock) => {
      gotSocket = true;
      if (sock.connecting) {
        connTimer = setTimeout(() => {
          req.destroy();
          finish({ kind: 'unreachable', reason: 'connect_timeout' });
        }, cfg.connectTimeoutMs);
        sock.once('connect', () => clearTimeout(connTimer));
      }
    });

    req.on('error', (err) => {
      const codes = codesOf(err);
      if (codes.some((c) => NOT_SENT_CODES.has(c))) {
        return finish({ kind: 'unreachable', reason: codes.find((c) => NOT_SENT_CODES.has(c)) });
      }
      return finish({ kind: 'unknown', reason: codes[0] || err.message });
    });

    req.end(payload);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @returns {Promise<{outcome:'PAID'|'REJECTED'|'UNREACHABLE'|'UNKNOWN'|'BANK_ERROR', ...}>}
 */
async function charge({ reference, amount, idempotencyKey }) {
  const started = Date.now();
  const deadline = started + cfg.deadlineMs;
  const headers = {};
  if (cfg.useIdempotency && idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let uncertain = false;   // đã có lần thử mà kết quả "không biết"
  let last = null;
  let attempts = 0;

  while (attempts < cfg.maxAttempts) {
    const remaining = deadline - Date.now();
    if (remaining < 30) break;
    attempts++;
    last = await attemptOnce({ reference, amount }, headers, remaining);

    if (last.kind === 'ok') return { outcome: 'PAID', charge: last.charge, attempts, ms: Date.now() - started };
    if (last.kind === 'rejected') {
      // Bị từ chối rõ ràng: KHÔNG thử lại (kể cả khi trước đó có lần "không biết" - không thể xảy ra
      // với ngân hàng này vì kiểm tra hạn mức luôn chạy trước khi trừ tiền).
      return { outcome: 'REJECTED', status: last.status, body: last.body, attempts, ms: Date.now() - started };
    }
    if (last.kind === 'unknown') uncertain = true;
    if (last.kind === 'unreachable' && !uncertain) break;  // không kết nối được: báo ngay, không chờ

    // backoff nhỏ + jitter rồi thử lại (cùng Idempotency-Key)
    const pause = Math.min(50 * attempts + Math.random() * 50, Math.max(0, deadline - Date.now() - 30));
    if (pause > 0) await sleep(pause);
  }

  const ms = Date.now() - started;
  if (uncertain) return { outcome: 'UNKNOWN', reason: last && (last.reason || last.kind), attempts, ms };
  if (last && last.kind === 'server_error') return { outcome: 'BANK_ERROR', status: last.status, attempts, ms };
  return { outcome: 'UNREACHABLE', reason: last && last.reason, attempts, ms };
}

module.exports = { charge, cfg, agent };
