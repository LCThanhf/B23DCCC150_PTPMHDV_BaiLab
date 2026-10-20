'use strict';
/**
 * Chạy tự động 4 tình huống của Lab 3, đo "TRƯỚC" (MODE=naive) và "SAU" (MODE=robust).
 *   node scripts/run-lab.js            # chạy tất cả
 *   node scripts/run-lab.js 1 3        # chỉ chạy tình huống 1 và 3
 * Kết quả: in ra màn hình + results/results.json + results/results.md
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BANK_FILE = path.join(ROOT, 'bank', 'server.js');
const FEE_FILE = path.join(ROOT, 'fee-service', 'src', 'server.js');
const FEE = 'http://localhost:4001';
const BANK = 'http://localhost:4002';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : Math.round(ms) + ' ms');
const money = (n) => n.toLocaleString('vi-VN') + 'đ';

let statsCalls = 0;
// ---------------- Quản lý tiến trình ----------------
const procs = [];
function start(file, env = {}, label = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.label = label;
    child.logs = [];
    procs.push(child);
    const onData = (d) => {
      const s = d.toString();
      child.logs.push(s);
      if (/listening/.test(s)) resolve(child);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => child.logs.push(d.toString()));
    child.on('exit', (code) => { child.exited = true; if (!child.ready) child.ready = true; });
    setTimeout(() => reject(new Error('timeout starting ' + label)), 8000);
  });
}
function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.exited) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}
async function stopAll() { await Promise.all(procs.splice(0).map(stop)); }
const startBank = (env = {}) => { statsCalls = 0; return start(BANK_FILE, env, 'bank'); };
const startFee = (env = {}) => start(FEE_FILE, env, 'fee');

// ---------------- HTTP helpers ----------------
async function call(method, url, body) {
  const t = now();
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    let json = null;
    try { json = await res.json(); } catch { /* ignore */ }
    return { status: res.status, body: json, ms: now() - t };
  } catch (e) {
    return { status: 0, body: { error: e.message }, ms: now() - t };
  }
}
const pay = (id, amount) => call('POST', `${FEE}/students/${id}/payments`, { amount });
const fees = (id) => call('GET', `${FEE}/students/${id}/fees`);

// /stats mở đúng 1 kết nối riêng (agent:false) => trừ lại số lần đã gọi để không tính vào "connections"
function bankStats() {
  return new Promise((resolve, reject) => {
    http.get(`${BANK}/stats`, { agent: false, headers: { Connection: 'close' } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => {
        statsCalls++;
        const j = JSON.parse(s);
        j.connections -= statsCalls;   // loại kết nối của chính các lệnh gọi /stats
        j.requests -= 0;
        resolve(j);
      });
    }).on('error', reject);
  });
}

async function pool(n, concurrency, worker) {
  const out = new Array(n);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = next++;
      if (i >= n) return;
      out[i] = await worker(i);
    }
  }));
  return out;
}

// ---------------- Báo cáo ----------------
const results = {};
const checks = [];
function check(scn, label, ok, detail = '') {
  checks.push({ scn, label, ok, detail });
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
}
function tally(rs) {
  const m = {};
  for (const r of rs) {
    const k = `${r.status}${r.body && r.body.status ? ' ' + r.body.status : ''}`;
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

// ================= TÌNH HUỐNG 1 =================
async function scenario1(label, env) {
  console.log(`\n[TH1][${label}] ngân hàng tắt -> bật lại`);
  const out = {};
  let fee = await startFee(env);
  out.down = await pay(1, 100000);
  out.feesWhileDown = await fees(1);
  const alive = (await call('GET', `${FEE}/health`)).status === 200;
  out.feeAlive = alive;
  const bank = await startBank();
  out.up = await pay(1, 100000);                       // KHÔNG khởi động lại Fee
  await stop(fee);
  fee = await startFee({ ...env, BANK_URL: 'http://localhost:4999' }); // địa chỉ khác, không có ai lắng nghe
  out.otherUrl = await pay(1, 100000);
  await stopAll();
  console.log(`   ngân hàng tắt : ${out.down.status} ${JSON.stringify(out.down.body)} (${fmtMs(out.down.ms)})`);
  console.log(`   GET fees      : ${out.feesWhileDown.status} (${fmtMs(out.feesWhileDown.ms)}), Fee còn sống: ${alive}`);
  console.log(`   bank bật lại  : ${out.up.status} (${fmtMs(out.up.ms)})`);
  console.log(`   BANK_URL :4999: ${out.otherUrl.status} (${fmtMs(out.otherUrl.ms)})`);
  if (label === 'sau') {
    check(1, 'ngân hàng tắt -> 503 + JSON có error trong < 1,5 s', out.down.status === 503 && !!(out.down.body && out.down.body.error) && out.down.ms < 1500, `${out.down.status}, ${fmtMs(out.down.ms)}`);
    check(1, 'Fee không sập, GET fees trả 200 nhanh', alive && out.feesWhileDown.status === 200 && out.feesWhileDown.ms < 300, `${out.feesWhileDown.status}, ${fmtMs(out.feesWhileDown.ms)}`);
    check(1, 'ngân hàng chạy lại -> 201 không cần khởi động lại Fee', out.up.status === 201, `${out.up.status}`);
    check(1, 'BANK_URL=:4999 -> hành vi vẫn giống (503, < 1,5 s)', out.otherUrl.status === 503 && out.otherUrl.ms < 1500, `${out.otherUrl.status}, ${fmtMs(out.otherUrl.ms)}`);
  }
  return out;
}

// ================= TÌNH HUỐNG 2 =================
async function scenario2(label, env) {
  console.log(`\n[TH2][${label}] ngân hàng chậm DELAY_MS=5000`);
  await startBank({ DELAY_MS: '5000' });
  await startFee(env);
  const out = {};
  out.single = await pay(1, 100000);
  console.log(`   1 thanh toán: ${out.single.status} ${out.single.body.status || ''} (${fmtMs(out.single.ms)})`);

  const samples = [];
  let running = true;
  const sampler = (async () => {
    await sleep(300);
    while (running) { samples.push((await fees(1)).ms); await sleep(150); }
  })();
  const t0 = now();
  const wave = await Promise.all(Array.from({ length: 20 }, () => pay(1, 100000)));
  out.waveTotalMs = now() - t0;
  running = false; await sampler;
  out.waveTally = tally(wave);
  out.waveMaxMs = Math.max(...wave.map((r) => r.ms));
  out.feesMaxMs = Math.max(...samples);
  out.feesAvgMs = samples.reduce((a, b) => a + b, 0) / samples.length;
  out.feesSamples = samples.length;
  const f = (await fees(1)).body;
  const paid = wave.concat(out.single).filter((r) => r.status === 201).length;
  out.debtOk = f.debt === 50_000_000 - paid * 100000;
  console.log(`   20 đồng thời : ${JSON.stringify(out.waveTally)}, chậm nhất ${fmtMs(out.waveMaxMs)}`);
  console.log(`   GET fees khi 20 lệnh đang chờ: max ${fmtMs(out.feesMaxMs)}, TB ${fmtMs(out.feesAvgMs)} (${samples.length} lần)`);
  if (label === 'sau') {
    check(2, '1 thanh toán trả 504 + PENDING', out.single.status === 504 && out.single.body.status === 'PENDING', `${out.single.status} ${out.single.body.status}`);
    check(2, 'thời gian trả lời ≤ 4,5 s', out.single.ms <= 4500 && out.waveMaxMs <= 4500, `1 lệnh ${fmtMs(out.single.ms)}, 20 lệnh chậm nhất ${fmtMs(out.waveMaxMs)}`);
    check(2, '20 thanh toán đều 504 + PENDING', out.waveTally['504 PENDING'] === 20, JSON.stringify(out.waveTally));
    check(2, 'GET fees khi 20 lệnh đang chờ < 300 ms', out.feesMaxMs < 300, `max ${fmtMs(out.feesMaxMs)}`);
    check(2, 'công nợ chỉ giảm theo lệnh PAID (ở đây = 0 lệnh)', out.debtOk, `debt=${money(f.debt)}`);
  }
  await stopAll();
  return out;
}

// ================= TÌNH HUỐNG 3 =================
async function scenario3(label, env) {
  console.log(`\n[TH3][${label}] 200 thanh toán, 10 đồng thời`);
  await startBank();
  await startFee(env);
  const out = {};
  const t0 = now();
  const rs = await pool(200, 10, () => pay(1, 1000));
  out.totalMs = now() - t0;
  out.ok = rs.filter((r) => r.status === 201).length;
  out.tally = tally(rs);
  const s1 = await bankStats();
  out.connections = s1.connections;
  out.requests = s1.requests;
  out.duplicates = s1.duplicates;
  console.log(`   ${out.ok}/200 thành công, tổng ${fmtMs(out.totalMs)}, kết nối TCP mở: ${out.connections}, duplicates=${out.duplicates}`);
  console.log('   ...nhàn rỗi 6 giây (ngân hàng đóng kết nối cũ)...');
  await sleep(6000);
  const after = await pool(5, 1, () => pay(1, 1000));
  out.afterIdleOk = after.filter((r) => r.status === 201).length;
  const s2 = await bankStats();
  out.connectionsAfterIdle = s2.connections - out.connections;
  console.log(`   sau nhàn rỗi: ${out.afterIdleOk}/5 thành công, mở thêm ${out.connectionsAfterIdle} kết nối`);
  if (label === 'sau') {
    check(3, '200/200 thanh toán thành công', out.ok === 200, `${out.ok}/200`);
    check(3, 'số kết nối TCP ≤ 20', out.connections <= 20, `${out.connections}`);
    check(3, 'sau nhàn rỗi 6 s vẫn thành công', out.afterIdleOk === 5, `${out.afterIdleOk}/5`);
    check(3, 'không trừ tiền trùng', out.duplicates === 0);
  }
  await stopAll();
  return out;
}

// ================= TÌNH HUỐNG 4 =================
async function runBatch60(bankEnv, feeEnv) {
  await startBank(bankEnv);
  await startFee(feeEnv);
  const rs = [];
  for (let i = 0; i < 60; i++) rs.push(await pay(1, 100000));     // lần lượt
  const s = await bankStats();
  const f = (await fees(1)).body;
  const paid = rs.filter((r) => r.status === 201).length;
  const out = {
    tally: tally(rs), paid, maxMs: Math.max(...rs.map((r) => r.ms)),
    charges: s.charges, duplicates: s.duplicates, requests: s.requests, connections: s.connections,
    debt: f.debt, debtExpected: 50_000_000 - paid * 100000,
    pendingCodes: rs.filter((r) => r.status !== 201).map((r) => `${r.status}/${r.body.status}`),
    paymentIds: rs.map((r) => r.body && r.body.paymentId).filter(Boolean),
  };
  out.debtOk = out.debt === out.debtExpected;
  return out;
}

async function reconcileAll(out) {
  // Đối soát các lệnh PENDING bằng cùng Idempotency-Key (chạy khi fee/bank còn sống)
  const pend = [];
  for (const id of out.paymentIds) {
    const p = (await call('GET', `${FEE}/payments/${id}`)).body;
    if (p && p.status === 'PENDING') pend.push(id);
  }
  out.pendingBefore = pend.length;
  for (let round = 0; round < 8 && pend.length; round++) {
    for (const id of [...pend]) {
      const r = (await call('POST', `${FEE}/payments/${id}/reconcile`)).body;
      if (r && r.status !== 'PENDING') pend.splice(pend.indexOf(id), 1);
    }
  }
  out.pendingAfterReconcile = pend.length;
  const s = await bankStats();
  const f = (await fees(1)).body;
  out.afterReconcile = { charges: s.charges, duplicates: s.duplicates, debt: f.debt };
  const paidNow = (50_000_000 - f.debt) / 100000;
  out.afterReconcile.paid = paidNow;
}

async function scenario4a(label, env, tag) {
  console.log(`\n[TH4a][${label}${tag ? ' ' + tag : ''}] DROP_RATE=0.3 (trừ tiền xong rồi đứt)`);
  const out = await runBatch60({ DROP_RATE: '0.3' }, env);
  console.log(`   PAID ${out.paid}/60  ${JSON.stringify(out.tally)}  chậm nhất ${fmtMs(out.maxMs)}`);
  console.log(`   bank: charges=${out.charges} duplicates=${out.duplicates} requests=${out.requests} | debt=${money(out.debt)} (kỳ vọng ${money(out.debtExpected)})`);
  if (label === 'sau' && !tag) {
    const nonPaidOk = out.pendingCodes.every((c) => c === '504/PENDING');
    check('4a', 'duplicates = 0', out.duplicates === 0, `${out.duplicates}`);
    check('4a', '≥ 54/60 thanh toán thành công', out.paid >= 54, `${out.paid}/60`);
    check('4a', 'lệnh không thành công đều trả 504 + PENDING', nonPaidOk, out.pendingCodes.join(', ') || 'không có lệnh lỗi');
    check('4a', 'công nợ chỉ giảm đúng tiền của các lệnh PAID', out.debtOk, `${money(out.debt)}`);
    check('4a', 'mỗi lệnh ≤ 4,5 s', out.maxMs <= 4500, fmtMs(out.maxMs));
    await reconcileAll(out);
    console.log(`   đối soát: PENDING ${out.pendingBefore} -> ${out.pendingAfterReconcile}; bank charges=${out.afterReconcile.charges}, PAID=${out.afterReconcile.paid}, duplicates=${out.afterReconcile.duplicates}`);
  }
  await stopAll();
  return out;
}


// Ca stress: DROP_RATE=0.7 -> chắc chắn có lệnh PENDING, kiểm chứng 504 + đối soát
async function scenario4aStress() {
  console.log('\n[TH4a-stress][sau] DROP_RATE=0.7 (ép nhánh 504/PENDING + đối soát)');
  const out = await runBatch60({ DROP_RATE: '0.7' }, { MODE: 'robust' });
  console.log(`   PAID ${out.paid}/60  ${JSON.stringify(out.tally)}  chậm nhất ${fmtMs(out.maxMs)}`);
  console.log(`   bank: charges=${out.charges} duplicates=${out.duplicates} | debt đúng: ${out.debtOk}`);
  const nonPaidOk = out.pendingCodes.every((c) => c === '504/PENDING');
  check('4a-stress', 'duplicates = 0 dù ngân hàng đứt 70%', out.duplicates === 0, `${out.duplicates}`);
  check('4a-stress', 'lệnh không thành công đều là 504 + PENDING', nonPaidOk && out.pendingCodes.length > 0, `${out.pendingCodes.length} lệnh PENDING`);
  check('4a-stress', 'công nợ chỉ giảm đúng tiền của các lệnh PAID', out.debtOk, money(out.debt));
  check('4a-stress', 'mỗi lệnh ≤ 4,5 s', out.maxMs <= 4500, fmtMs(out.maxMs));
  await reconcileAll(out);
  console.log(`   đối soát: PENDING ${out.pendingBefore} -> ${out.pendingAfterReconcile}; bank charges=${out.afterReconcile.charges}, PAID=${out.afterReconcile.paid}, duplicates=${out.afterReconcile.duplicates}`);
  check('4a-stress', 'sau đối soát: charges = số lệnh PAID, duplicates = 0', out.afterReconcile.charges === out.afterReconcile.paid && out.afterReconcile.duplicates === 0, `charges=${out.afterReconcile.charges}, PAID=${out.afterReconcile.paid}`);
  await stopAll();
  return out;
}

async function scenario4b(label, env) {
  console.log(`\n[TH4b][${label}] FAIL_RATE=0.3 (lỗi 500 tạm thời trước khi trừ)`);
  const out = await runBatch60({ FAIL_RATE: '0.3' }, env);
  console.log(`   PAID ${out.paid}/60  ${JSON.stringify(out.tally)}  chậm nhất ${fmtMs(out.maxMs)}`);
  console.log(`   bank: charges=${out.charges} duplicates=${out.duplicates} requests=${out.requests} | debt đúng: ${out.debtOk}`);
  if (label === 'sau') {
    check('4b', '≥ 54/60 thanh toán thành công', out.paid >= 54, `${out.paid}/60`);
    check('4b', 'không trừ tiền hai lần (duplicates = 0)', out.duplicates === 0, `${out.duplicates}`);
    check('4b', 'charges = số lệnh PAID, công nợ đúng', out.charges === out.paid && out.debtOk, `charges=${out.charges}, PAID=${out.paid}`);
    check('4b', 'mỗi lệnh ≤ 4,5 s', out.maxMs <= 4500, fmtMs(out.maxMs));
  }
  await stopAll();
  return out;
}

async function scenario4c(label, env) {
  console.log(`\n[TH4c][${label}] thanh toán 25.000.000đ (vượt hạn mức)`);
  await startBank();
  await startFee(env);
  const r = await pay(1, 25_000_000);
  const s = await bankStats();
  const out = { status: r.status, body: r.body, ms: r.ms, bankRequests: s.requests, charges: s.charges };
  console.log(`   ${r.status} ${JSON.stringify(r.body)} (${fmtMs(r.ms)}), ngân hàng nhận ${s.requests} yêu cầu`);
  if (label === 'sau') {
    check('4c', 'trả 402', r.status === 402, `${r.status}`);
    check('4c', 'ngân hàng chỉ nhận đúng 1 yêu cầu (không thử lại lỗi bị từ chối)', s.requests === 1, `${s.requests}`);
    check('4c', 'status FAILED, không trừ tiền', r.body.status === 'FAILED' && s.charges === 0);
  }
  await stopAll();
  return out;
}

// ---------------- Main ----------------
(async () => {
  const want = process.argv.slice(2);
  const run = (n) => want.length === 0 || want.includes(String(n));
  const before = { MODE: 'naive' };
  const after = { MODE: 'robust' };
  try {
    if (run(1)) results.s1 = { truoc: await scenario1('trước', before), sau: await scenario1('sau', after) };
    if (run(2)) results.s2 = { truoc: await scenario2('trước', before), sau: await scenario2('sau', after) };
    if (run(3)) results.s3 = { truoc: await scenario3('trước', before), sau: await scenario3('sau', after) };
    if (run(4)) {
      results.s4a = {
        truoc: await scenario4a('trước', before),
        retryMu: await scenario4a('sau', { MODE: 'robust', IDEMPOTENCY: 'off' }, '(retry KHÔNG idempotency)'),
        sau: await scenario4a('sau', after),
      };
      results.s4aStress = { sau: await scenario4aStress() };
      results.s4b = { truoc: await scenario4b('trước', before), sau: await scenario4b('sau', after) };
      results.s4c = { truoc: await scenario4c('trước', before), sau: await scenario4c('sau', after) };
    }
  } finally {
    await stopAll();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('\n================ TỔNG KẾT ================');
  console.log(`Đạt ${checks.length - failed.length}/${checks.length} tiêu chí`);
  failed.forEach((c) => console.log(`❌ TH${c.scn}: ${c.label} — ${c.detail}`));

  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'results', 'results.json'), JSON.stringify({ results, checks }, null, 2));
  fs.writeFileSync(path.join(ROOT, 'results', 'checks.md'),
    '| TH | Tiêu chí | Kết quả | Số liệu |\n|---|---|---|---|\n' +
    checks.map((c) => `| ${c.scn} | ${c.label} | ${c.ok ? '✅ Đạt' : '❌ Chưa đạt'} | ${c.detail} |`).join('\n') + '\n');
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => { console.error(e); await stopAll(); process.exit(2); });
