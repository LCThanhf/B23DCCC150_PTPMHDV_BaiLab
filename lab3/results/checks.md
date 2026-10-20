| TH | Tiêu chí | Kết quả | Số liệu |
|---|---|---|---|
| 1 | ngân hàng tắt -> 503 + JSON có error trong < 1,5 s | ✅ Đạt | 503, 38 ms |
| 1 | Fee không sập, GET fees trả 200 nhanh | ✅ Đạt | 200, 3 ms |
| 1 | ngân hàng chạy lại -> 201 không cần khởi động lại Fee | ✅ Đạt | 201 |
| 1 | BANK_URL=:4999 -> hành vi vẫn giống (503, < 1,5 s) | ✅ Đạt | 503, 37 ms |
| 2 | 1 thanh toán trả 504 + PENDING | ✅ Đạt | 504 PENDING |
| 2 | thời gian trả lời ≤ 4,5 s | ✅ Đạt | 1 lệnh 4.04 s, 20 lệnh chậm nhất 4.03 s |
| 2 | 20 thanh toán đều 504 + PENDING | ✅ Đạt | {"504 PENDING":20} |
| 2 | GET fees khi 20 lệnh đang chờ < 300 ms | ✅ Đạt | max 2 ms |
| 2 | công nợ chỉ giảm theo lệnh PAID (ở đây = 0 lệnh) | ✅ Đạt | debt=50.000.000đ |
| 3 | 200/200 thanh toán thành công | ✅ Đạt | 200/200 |
| 3 | số kết nối TCP ≤ 20 | ✅ Đạt | 10 |
| 3 | sau nhàn rỗi 6 s vẫn thành công | ✅ Đạt | 5/5 |
| 3 | không trừ tiền trùng | ✅ Đạt |  |
| 4a | duplicates = 0 | ✅ Đạt | 0 |
| 4a | ≥ 54/60 thanh toán thành công | ✅ Đạt | 60/60 |
| 4a | lệnh không thành công đều trả 504 + PENDING | ✅ Đạt | không có lệnh lỗi |
| 4a | công nợ chỉ giảm đúng tiền của các lệnh PAID | ✅ Đạt | 44.000.000đ |
| 4a | mỗi lệnh ≤ 4,5 s | ✅ Đạt | 657 ms |
| 4a-stress | duplicates = 0 dù ngân hàng đứt 70% | ✅ Đạt | 0 |
| 4a-stress | lệnh không thành công đều là 504 + PENDING | ✅ Đạt | 9 lệnh PENDING |
| 4a-stress | công nợ chỉ giảm đúng tiền của các lệnh PAID | ✅ Đạt | 44.900.000đ |
| 4a-stress | mỗi lệnh ≤ 4,5 s | ✅ Đạt | 936 ms |
| 4a-stress | sau đối soát: charges = số lệnh PAID, duplicates = 0 | ✅ Đạt | charges=60, PAID=60 |
| 4b | ≥ 54/60 thanh toán thành công | ✅ Đạt | 60/60 |
| 4b | không trừ tiền hai lần (duplicates = 0) | ✅ Đạt | 0 |
| 4b | charges = số lệnh PAID, công nợ đúng | ✅ Đạt | charges=60, PAID=60 |
| 4b | mỗi lệnh ≤ 4,5 s | ✅ Đạt | 219 ms |
| 4c | trả 402 | ✅ Đạt | 402 |
| 4c | ngân hàng chỉ nhận đúng 1 yêu cầu (không thử lại lỗi bị từ chối) | ✅ Đạt | 1 |
| 4c | status FAILED, không trừ tiền | ✅ Đạt |  |
