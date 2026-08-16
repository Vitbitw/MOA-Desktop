import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/** 本地模型（GGUF）存放目录：userData/models。 */
export function modelsDir(): string {
  const dir = path.join(app.getPath('userData'), 'models')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
