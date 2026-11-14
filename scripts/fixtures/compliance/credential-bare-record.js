/**
 * 反例 fixture —— 2026-11-14 启动事故的写入形状。
 *
 * 摘自提交 6f349a3 的 `plugins/dsh-channels/index.js`（当时 00:29 的"朝合规方向改造"）：
 * `modifyRecord` 的 mutate 返回裸对象。`dsh-credentials-local` 在 boot 解析
 * `.credentials.yaml` 时遇到无 `kind` 的记录会抛
 * `credentials-local: record "dsh-channels/wechat" … has no kind`，
 * provider 未激活 → 必需插件 `credentials` 不激活 → host 拒绝启动。
 *
 * 本文件**不参与运行**，只给 scripts/check-plugin-compliance.mjs --self-test 用。
 * 规则：R-CRED-01（A）。读侧同时缺 kind 判别 → 顺带触发 R-CRED-04（B）。
 */
export function hydrateCredentials(credentials, state) {
  return credentials.readRecord('dsh-channels/default').then((record) => {
    const fromRecord = record ? record.payload : null
    if (fromRecord) state.creds = fromRecord
    return credentials.modifyRecord('dsh-channels/default', () => state.creds)
  })
}

export function saveCreds(credentials, creds) {
  return credentials.modifyRecord('dsh-channels/default', () => creds)
}
