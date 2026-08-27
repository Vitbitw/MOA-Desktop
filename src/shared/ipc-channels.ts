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

  // MoA Config
  MOA_GET_CONFIG: 'moa:getConfig',
  MOA_SET_CONFIG: 'moa:setConfig',

  // MoA Execution
  MOA_SEND_MESSAGE: 'moa:sendMessage',

  // Title
  TITLE_GENERATE: 'title:generate',
  DB_UPDATE_CONVERSATION_TITLE: 'db:updateConversationTitle',

  // App
  APP_GET_VERSION: 'app:getVersion',

  // Usage Monitoring
  USAGE_GET_SUMMARY: 'usage:getSummary',
  USAGE_GET_TODAY: 'usage:getToday',

  // Cloud Usage Monitoring
  MONITOR_GET_STATUS: 'monitor:getStatus',
  MONITOR_LOGIN: 'monitor:login',
  MONITOR_LOGOUT: 'monitor:logout',
  MONITOR_SET_API_KEY: 'monitor:setApiKey',
  MONITOR_REFRESH: 'monitor:refresh',
} as const

export const IPC_EVENT = {
  MOA_SUB_OUTPUT_UPDATE: 'moa:subOutputUpdate',
  MOA_AGGREGATION_START: 'moa:aggregationStart',
  MOA_AGGREGATION_CHUNK: 'moa:aggregationChunk',
  MOA_ALL_DONE: 'moa:allDone',

  // Menu events
  MENU_NEW_CONVERSATION: 'menu:newConversation',
  MENU_COPY_PROXY_URL: 'menu:copyProxyUrl',
  MENU_OPEN_SETTINGS: 'menu:openSettings',

  // 用量悬浮窗右键「打开用量页」→ 主窗口切换到用量视图
  USAGE_OPEN: 'usage:open',

  // Title events
  TITLE_UPDATED: 'title:updated',

  // Usage events
  USAGE_UPDATED: 'usage:updated',
} as const

export type IPCChannel = (typeof IPC)[keyof typeof IPC]
