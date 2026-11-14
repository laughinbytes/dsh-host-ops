/**
 * 正例 fixture —— 事故修复后的写入/读取形状（工作区 `plugins/dsh-channels/index.js`
 * 的 `hydrateCredentials` / `saveCreds` 同款）。
 *
 * 契约来源：`@deepseek-ai/dsh-credentials/src/types.ts`
 *   CredentialRecord = ApiKeyRecord { kind: 'api-key', key?, env? } | GrantRecord { kind: 'grant', payload }
 * 规则：R-CRED-01 / R-CRED-03 / R-CRED-04 全通过。
 *
 * 本文件**不参与运行**，只给 scripts/check-plugin-compliance.mjs --self-test 用。
 */
export async function hydrateCredentials(credentials, state) {
  const key = 'dsh-channels/default'
  const record = await credentials.readRecord(key)
  // 记录是带判别的联合：只有 grant 才有 payload 归 owner 解释。
  const fromRecord = record && record.kind === 'grant' ? record.payload : null
  if (fromRecord) {
    state.creds = fromRecord
    return state.creds
  }
  return credentials.modifyRecord(key, () => ({ kind: 'grant', payload: state.creds }))
}

export function saveCreds(credentials, creds) {
  // api-key 记录：key/env 二选一或都没有（声明 owner 确认走环境认证）。
  return credentials.modifyRecord('dsh-channels/default', () => ({ kind: 'api-key', env: { DSH_CHANNELS_TOKEN: creds.token } }))
}
