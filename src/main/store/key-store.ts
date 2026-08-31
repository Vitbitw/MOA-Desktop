import fs from 'node:fs'
import path from 'node:path'
import Store from 'electron-store'
import { safeStorage, app } from 'electron'

interface KeyStoreSchema {
  providerKeys: Record<string, string>
  /** 云端用量监控凭证：key 为监控源 id（session token）或 `id.apiKey`（Provider API Key） */
  usageCredentials: Record<string, string>
}

let store: Store<KeyStoreSchema> | null = null

/**
 * 密钥存储：用 Electron safeStorage 加密后落盘（Windows DPAPI / macOS Keychain / Linux libsecret）。
 *
 * 注意：electron-store 8.x 已移除 encryptionKey 选项（8.x 起无内置加密），
 * 旧代码传入的 encryptionKey 实际无效——密钥明文写入 moa-keys.json。
 * 这里改为：值先 safeStorage.encryptString → base64，落盘的是密文；
 * 读取时 base64 → decryptString。safeStorage 不可用时（Linux 无 keyring）回退明文。
 */
function encryptValue(plain: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return `enc:${safeStorage.encryptString(plain).toString('base64')}`
    }
  } catch (err) {
    // 加密失败回退明文
    console.warn('[KeyStore] safeStorage encryption failed, API key stored in plaintext:', err)
  }
  return plain
}

function decryptValue(stored: unknown): string {
  if (typeof stored !== 'string') return ''
  if (stored.startsWith('enc:')) {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        // 系统密钥库不可用（如 Linux 无 keyring）：无法解密，明确提示，避免静默显示「未配置 Key」
        console.warn('[KeyStore] safeStorage unavailable, cannot decrypt API key (please re-enter)')
        return ''
      }
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    } catch (err) {
      // 解密失败（如系统密钥变化）：无法恢复旧密文，提示用户重新填写
      console.warn('[KeyStore] API key decryption failed (system credentials may have changed), please re-enter:', err)
      return ''
    }
  }
  return stored
}

export function getKeyStore(): Store<KeyStoreSchema> {
  if (!store) {
    healCorruptStore()
    store = new Store<KeyStoreSchema>({
      name: 'moa-keys'
    })
  }
  return store
}

/**
 * electron-store 构造时会 `JSON.parse` 存储文件；文件损坏（如写入被中断、被二进制覆盖）
 * 会让 getKeyStore() 直接抛错、拖垮整个应用。这里在构造前自检：
 * 非法 JSON → 备份为 `moa-keys.json.corrupt-<ts>` 后重建，旧凭据不可恢复（仅能重新填写）。
 */
function healCorruptStore(): void {
  const p = path.join(app.getPath('userData'), 'moa-keys.json')
  try {
    if (!fs.existsSync(p)) return
    const raw = fs.readFileSync(p, 'utf8')
    JSON.parse(raw)
  } catch {
    try {
      fs.renameSync(p, `${p}.corrupt-${Date.now()}`)
      console.warn('[KeyStore] moa-keys.json corrupted, backed up and rebuilt, please re-enter API key')
    } catch (err) {
      console.error('[KeyStore] failed to back up corrupted file:', err)
    }
  }
}

export function saveProviderKey(providerId: string, apiKey: string): void {
  const s = getKeyStore()
  const keys = s.get('providerKeys', {})
  keys[providerId] = encryptValue(apiKey)
  s.set('providerKeys', keys)
}

export function getProviderKey(providerId: string): string | undefined {
  const s = getKeyStore()
  const keys = s.get('providerKeys', {})
  const stored = keys[providerId]
  if (stored == null) return undefined
  return decryptValue(stored)
}

export function removeProviderKey(providerId: string): void {
  const s = getKeyStore()
  const keys = s.get('providerKeys', {})
  delete keys[providerId]
  s.set('providerKeys', keys)
}

// ─── 云端用量监控凭证（按监控源 id 存取，safeStorage 加密）───

export function saveUsageCredential(key: string, value: string): void {
  const s = getKeyStore()
  const creds = s.get('usageCredentials', {})
  creds[key] = encryptValue(value)
  s.set('usageCredentials', creds)
}

export function getUsageCredential(key: string): string | undefined {
  const s = getKeyStore()
  const creds = s.get('usageCredentials', {})
  const stored = creds[key]
  if (stored == null) return undefined
  return decryptValue(stored)
}

export function removeUsageCredential(key: string): void {
  const s = getKeyStore()
  const creds = s.get('usageCredentials', {})
  delete creds[key]
  s.set('usageCredentials', creds)
}
