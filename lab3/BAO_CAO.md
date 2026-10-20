# Lab 3 – Cách chạy và kết quả

## Cách chạy project

Yêu cầu Node.js 18 trở lên.

```bash
npm install
```

### Chạy từng service

Mở hai terminal riêng:

```bash
npm run bank
```

Ngân hàng giả lập chạy tại `http://localhost:4002`.

```bash
npm run fee
```

Fee Service chạy tại `http://localhost:4001`.

### Chạy bản đo tự động

```bash
npm run lab
```

Lệnh này tự động chạy 4 tình huống kiểm thử, đo trước/sau và ghi kết quả vào:

- `results/results.json`
- `results/checks.md`

Chỉ chạy tình huống 3:

```bash
node scripts/run-lab.js 3
```

Chạy bản Fee Service trước khi sửa để đối chiếu:

```bash
npm run fee:naive
```

## Kết quả

Kết quả tự kiểm gần nhất: **30/30 tiêu chí đạt**.

| Nhóm kiểm thử | Kết quả chính |
|---|---|
| Ngân hàng tắt/bật lại | Trả `503` khi ngân hàng tắt, Fee Service vẫn hoạt động, trả `201` sau khi ngân hàng bật lại |
| Ngân hàng phản hồi chậm | Trả `504 PENDING` trong khoảng 4 giây, không vượt quá 4,5 giây; 20/20 lệnh được xử lý đúng |
| Duy trì kết nối | 200/200 thanh toán thành công; số kết nối TCP tối đa là 10, không vượt yêu cầu 20 |
| Đứt kết nối/lỗi tạm thời | 60/60 thanh toán thành công trong các ca kiểm thử; `duplicates = 0` |
| Đối soát | Các lệnh `PENDING` được đối soát thành công; số lần trừ tiền khớp số lệnh đã thanh toán |
| Từ chối thanh toán | Trả `402`, trạng thái `FAILED`, chỉ gửi đúng 1 yêu cầu đến ngân hàng |
