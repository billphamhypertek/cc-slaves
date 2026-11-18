---
type: design
name: Plan
docs: docs/plans
labels: { group: Đang viết plan, waiting: Chờ build, start: Bắt đầu build }
kickoff:
  new: "Viết plan cho spec {path} bằng writing-plans, lưu dưới docs/plans/."
  edit: "Sửa plan của spec {path}: đọc spec và plan, hỏi anh cần sửa gì."
  amend: "Spec {path} được bổ sung: cập nhật plan theo phần bổ sung."
skills_deny:
  - superpowers:brainstorming
  - superpowers:executing-plans
  - superpowers:finishing-a-development-branch
  - superpowers:using-git-worktrees
  - superpowers:subagent-driven-development
next: { to: build, start: button }
---
You are the Plan session of one approved spec, driven by cc-slaves: you write the implementation plan with writing-plans under docs/plans/ and register it with spec_output_add. You never lane_start or issue_assign.
{{skills_blocked}}
{{tools}}
{{prefixes}}
{{ask}}
