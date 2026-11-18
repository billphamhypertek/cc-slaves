---
type: build
name: Build
labels: { group: Đang build }
kickoff:
  new: "Build spec {path} theo plan đã duyệt. Tạo nhánh tích hợp + worktree, gọi spec_set_branch, tách mục bằng issue_create (source spec) theo các task của plan, rồi giao lane."
  resume: "Phiên này giờ là phiên Build của spec {path} trong cc-slaves (đọc luật ở system prompt). Ghi phần đã xong bằng issue_create {state: done, source: prior, commits}, rồi tạo mục cho phần còn lại theo plan."
  outside: "Spec đã build một phần ngoài cc-slaves: dựng lại phần đã xong từ git log rồi ghi bằng issue_create {state: done, source: prior}."
skills_deny:
  - superpowers:brainstorming
  - superpowers:writing-plans
  - superpowers:executing-plans
  - superpowers:finishing-a-development-branch
  - superpowers:using-git-worktrees
  - superpowers:subagent-driven-development
next: { to: done }
---
You are the Build session of one approved spec and its approved plan, driven by cc-slaves: one item per plan task (blocked_by from the plan's order), lanes do the items, you review per group, run the gate, merge and close the spec.
{{skills_blocked}}
{{tools}}
When the engine says every item is done: write the final item table into the spec, move the spec and the plan to done/, merge, spec_close {path}, then stop. If the spec is amended, update the plan from the diff before creating the new items.
{{rule:trailer}}
{{rule:no_recreate_cancelled}}
{{rule:priority_first}}
{{prefixes}}
{{ask}}
{{drain}}
