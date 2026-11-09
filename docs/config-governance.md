# 配置写面治理（dsh_config_manage）

> 目标：让 Agent 改 DSH 配置这件事从"能改"升级为"可管"——**预览 → 凭证 → 审批 → 写入 → 审计 → 可回滚**，每一步都有据可查。

## 1. 完整流程

```
预览（不带 apply）
  └─ 输出 before → after 的逐字段 diff、后果说明、预览凭证 previewToken
        │
        ▼
写入（apply: true + previewToken）
  ├─ 1. 凭证校验：用"当前状态"重算 token；不匹配 = 预览之后配置被改过（TOCTOU）→ 拒绝
  ├─ 2. 审批门：approval.request(...) → 只有 allowed-once 才继续；否则拒绝（fail closed）
  ├─ 3. 执行官方 configEditor.edit()（与设置界面同一条通道）
  └─ 4. 审计：记录 id / 时间 / 行 / 字段 diff / 操作者 / callId
        │
        ▼
回滚（revert + auditId，同样是两步）
  ├─ 冲突检测：自那次写入后字段又被改过 → 拒绝，并列出冲突字段
  ├─ 预览 + previewToken + 审批
  └─ 恢复成写入前的覆盖值（写入前没有覆盖的字段 → 删除覆盖）
```

## 2. 三个动作

| action | 作用 |
|---|---|
| `set` / `reset` | 预览返回 `previewToken`；apply 时必须带 token，并会被要求审批。 |
| `revert`（entry + auditId） | 按审计记录回滚；先预览拿 token，再 apply；写入前同样审批。 |
| `history` | 最近 100 条配置写入（id、时间、动作、行、字段 diff、回滚提示）；敏感字段（key/token/secret/password/credential/env）自动掩码。 |

## 3. 配置项

```yaml
config:
  approval: ask        # ask（默认，每次写入要用户批准）| never（只读，拒绝一切写入）
  requirePreview: true # 默认 true：apply 必须带预览凭证
```

## 4. 安全性质

- **fail-closed**：没有审批通道（服务不可用）、缺 agent/callId、审批被拒/取消/不可用 → 一律拒绝写入，未做任何修改。
- **TOCTOU 防护**：预览凭证绑定"行 + 预览时覆盖值 + 目标覆盖值"；写入时重算，任何人期间改过该行都会导致凭证失效。
- **冲突不覆盖**：回滚前检查字段现状；不一致就拒绝并列出差异，绝不静默覆盖别人的改动。
- **只走官方通道**：仍然是 `configEditor.edit()`（完整候选校验 → profile 文件锁 → 原子替换 → Loader 协调该行），不手改 patch 文件。
- **写失败不产生审计**：只有 `edit()` 成功后才记录审计；审批拒绝/凭证失败都不留"假成功"记录。

## 4.5 危险行预警与写后收据（2026-11-09 补）

- **启动必需行**（官方 `dsh-app-boot` required list）在预览与写入回执里强提示"改坏会让 App 打不开"，并给出应急恢复步骤。
- **写后收据**：写入成功即输出"原始覆盖值 + 恢复命令"，不依赖内存审计；审计丢失时照收据可手工恢复。
- **敏感掩码**：预览/回执/审批文案/审计展示对敏感字段（key/token/secret/password/credential/env，含值里嵌套的敏感键，如 `providers[].apiKey`）统一掩码成 `***`；`get` 读取原始值仍可用（显式读取动作）。

## 5. 已知限制（v1）

- **审计是内存环形（100 条）**：插件重挂/App 重启后清空；回滚只在插件存活期间可用。
  持久化（官方 `storageDomain` + 自有 domain）留作后续版本，避免 v1 引入 zod/domain 声明复杂度。
- **审批策略是插件级**，不是按行：`approval: never` 会把整个配置工具变成只读。
- 单测覆盖了审批拒绝、fail-closed、凭证不匹配、回滚冲突、never 模式；真机验证覆盖预览/凭证拒绝/只读查询 + 一次真实写入（自动审查回答者批准）+ 危险行预警 + 敏感掩码。
- headless 部署的边界说明（没有审批回答者时写入 fail-closed）留到发布 README 里写。

## 6. 测试证据

- 逻辑测试：**404/404**（新增治理用例：缺凭证、凭证不匹配、审批拒绝、审批通过、审计 history、回滚成功、冲突拒绝、never 只读、fail-closed 无审批通道）；
- schema 测试：**64/64**。
