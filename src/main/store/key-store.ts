import Store from 'electron-store'

interface KeyStoreSchema {
  providerKeys: Record<string, string>
}

let store: Store<KeyStoreSchema> | null = null

export function getKeyStore(): Store<KeyStoreSchema> {
  if (!store) {
    store = new Store<KeyStoreSchema>({
      name: 'moa-keys',
      encryptionKey: 'moa-desktop-v1-key-store'
    })
  }
  return store
}

export function saveProviderKey(providerId: string, apiKey: string): void {
  const s = getKeyStore()
  const keys = s.get('providerKeys', {})
  keys[providerId] = apiKey
  s.set('providerKeys', keys)
}

export function getProviderKey(providerId: string): string | undefined {
  const s = getKeyStore()
  const keys = s.get('providerKeys', {})
  return keys[providerId]
}

export function removeProviderKey(providerId: string): void {
  const s = getKeyStore()
  const keys = s.get('providerKeys', {})
  delete keys[providerId]
  s.set('providerKeys', keys)
}
