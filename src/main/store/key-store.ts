import Store from 'electron-store'
import { safeStorage } from 'electron'

interface KeyStoreSchema {
  providerKeys: Record<string, string>
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
  } catch {
    // 加密失败回退明文
  }
  return plain
}

function decryptValue(stored: string): string {
  if (stored.startsWith('enc:')) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
      }
    } catch {
      // 解密失败回退原值（避免崩溃）
    }
    return ''
  }
  return stored
}

export function getKeyStore(): Store<KeyStoreSchema> {
  if (!store) {
    store = new Store<KeyStoreSchema>({
      name: 'moa-keys'
    })
  }
  return store
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
