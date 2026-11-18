---
name: Quy trình PO
description: Thiết kế → duyệt → Build bằng lane → review nhóm → gate → merge. Không plan doc.
doc_label: Spec
docs_done: done
require_plugins: [superpowers]
rules: { priority_first: true, one_item_per_lane: true, outside_item_new_lane: true, no_recreate_cancelled: true, max_doc_sessions: 3 }
settled: "spec {path} xong hết mục. Ghi bảng mục cuối vào spec §\"Nhóm việc\", chuyển file sang docs/specs/done/, merge, rồi spec_close {path: \"{path}\"}."
---
