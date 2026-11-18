---
name: Spec + Plan
description: Thiết kế → duyệt → Plan (writing-plans) → duyệt → Build bằng lane theo plan → merge.
doc_label: Spec
docs_done: done
require_plugins: [superpowers]
rules: { priority_first: true, one_item_per_lane: true, outside_item_new_lane: true, no_recreate_cancelled: true, max_doc_sessions: 3 }
settled: "spec {path} xong hết mục. Ghi bảng mục cuối vào spec và plan, chuyển cả hai sang thư mục done/, merge, rồi spec_close {path: \"{path}\"}."
---
Rule order: cc-slaves rules (this text) > CLAUDE.md > skills. This project's flow: Thiết kế (brainstorming → spec, the user approves) → Plan (writing-plans → plan doc, the user approves) → Build (items → lanes → review → gate → merge).
