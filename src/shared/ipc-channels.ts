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

  // Local Model Deployment
  LOCAL_DETECT_ENGINES: 'local:detectEngines',
  LOCAL_LIST_ENGINES: 'local:listEngines',
  LOCAL_ADD_MANUAL_ENGINE: 'local:addManualEngine',
  LOCAL_REMOVE_ENGINE: 'local:removeEngine',
  LOCAL_LIST_MODELS: 'local:listModels',
  LOCAL_SEARCH_HF: 'local:searchHf',
  LOCAL_START_DOWNLOAD: 'local:startDownload',
  LOCAL_CANCEL_DOWNLOAD: 'local:cancelDownload',
  LOCAL_DELETE_MODEL: 'local:deleteModel',
  LOCAL_START_ENGINE: 'local:startEngine',
  LOCAL_STOP_ENGINE: 'local:stopEngine',
  LOCAL_GET_RUNTIME: 'local:getRuntime',
  LOCAL_ENSURE_RUNTIME: 'local:ensureRuntime',
} as const

export const IPC_EVENT = {
  MOA_SUB_OUTPUT_UPDATE: 'moa:subOutputUpdate',
  MOA_SUB_OUTPUT_ERROR: 'moa:subOutputError',
  MOA_AGGREGATION_START: 'moa:aggregationStart',
  MOA_AGGREGATION_CHUNK: 'moa:aggregationChunk',
  MOA_AGGREGATION_DONE: 'moa:aggregationDone',
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

  // Local model events
  LOCAL_ENGINE_STATUS_CHANGED: 'local:engineStatusChanged',
  LOCAL_DOWNLOAD_PROGRESS: 'local:downloadProgress',
} as const

export type IPCChannel = (typeof IPC)[keyof typeof IPC]
