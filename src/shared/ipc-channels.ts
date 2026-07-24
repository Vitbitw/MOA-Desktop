export const IPC = {
  // Config / Providers
  CONFIG_GET_PROVIDERS: 'config:getProviders',
  CONFIG_ADD_PROVIDER: 'config:addProvider',
  CONFIG_REMOVE_PROVIDER: 'config:removeProvider',
  CONFIG_GET_MODELS: 'config:getModels',

  // Conversations
  DB_GET_CONVERSATIONS: 'db:getConversations',
  DB_CREATE_CONVERSATION: 'db:createConversation',
  DB_DELETE_CONVERSATION: 'db:deleteConversation',
  DB_GET_MESSAGES: 'db:getMessages',
  DB_ADD_MESSAGE: 'db:addMessage',

  // Settings
  SETTINGS_GET_ALL: 'settings:getAll',
  SETTINGS_SET: 'settings:set',

  // App
  APP_GET_VERSION: 'app:getVersion',
} as const

export type IPCChannel = (typeof IPC)[keyof typeof IPC]
