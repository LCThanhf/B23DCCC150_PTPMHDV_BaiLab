'use strict';
/**
 * BANK CLIENT "NAIVE" - cách viết thường gặp trước khi sửa (chỉ dùng để ĐO "TRƯỚC KHI SỬA"):
 *  - mỗi lời gọi mở 1 kết nối TCP mới rồi đóng (agent:false, Connection: close)
 *  - không timeout (chờ bao lâu tùy ngân hàng)
 *  - không thử lại, không Idempotency-Key
 *  - mọi lỗi đều coi là "thất bại" chung chung
 * Bật bằng MODE=naive khi chạy Fee Service.
 */
const http = require('http');

const BANK_URL = process.env.BANK_URL || 'http://localhost:4002';
const target = new URL(BANK_URL);

function charge({ reference, amount }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ reference, amount }));
    const req = http.request({
      agent: false,
      hostname: target.hostname,
      port: target.port,
      path: '/charges',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, Connection: 'close' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

module.exports = { charge };
