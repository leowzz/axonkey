import { RelayClient, RelayError } from './relayClient.ts'

export type CloudDocument = { key: string; kind: string; config: Record<string, unknown> }
export type CloudSnapshot = { documents: CloudDocument[]; settings: Record<string, unknown> }
type RemoteDocument = {
  id: string
  model_id: string
  instance_key: string
  schema_version: number
  revision: number
  config: Record<string, unknown>
}
type RemoteSettings = { schema_version: number; revision: number; settings: Record<string, unknown> }
export type SyncMemory = Record<string, { revision: number }>
export type CloudState = {
  models: { id: string; code: string }[]
  documents: RemoteDocument[]
  settings: RemoteSettings | null
}
export class SyncConflict extends Error {
  initial: boolean
  constructor(initial: boolean) {
    super('请选择要使用的配置')
    this.initial = initial
  }
}

export async function readCloud(client: RelayClient): Promise<CloudState> {
  const models = await client.request<{ items: CloudState['models'] }>('GET', '/device-models?app_id=axonkey')
  const documents = await client.request<{ items: RemoteDocument[] }>('GET', '/device-configs?app_id=axonkey')
  let settings: RemoteSettings | null
  try {
    settings = await client.request<RemoteSettings>('GET', '/app-settings/axonkey')
  } catch (error) {
    if (!(error instanceof RelayError) || error.status !== 404) throw error
    settings = null
  }
  if (documents.items.some(doc => doc.schema_version !== 1) || (settings && settings.schema_version !== 1))
    throw new Error('云端配置版本较新，请升级 Axonkey 后重试')
  return { models: models.items, documents: documents.items, settings }
}

export async function uploadCloud(
  client: RelayClient,
  snapshot: CloudSnapshot,
  memory: SyncMemory,
  saveMemory: (memory: SyncMemory) => void,
  overwrite = false,
) {
  const cloud = await readCloud(client)
  const plans = snapshot.documents.map(local => {
    const model = cloud.models.find(model => model.code === local.kind)
    if (!model) throw new Error(`云端尚未配置型号 ${local.kind}，请先更新 Relay 设备目录`)
    const remote = cloud.documents.find(doc => doc.model_id === model.id && doc.instance_key === local.key)
    return { local, model, remote, key: `${local.kind}/${local.key}` }
  })
  // Check every document before the first write so a known conflict never causes a partial upload.
  for (const { local, remote, key } of plans)
    checkConflict(local.config, remote?.config, remote?.revision, memory[key], overwrite)
  const settings = { ...cloud.settings?.settings, ...snapshot.settings }
  const changedCloudSettings =
    cloud.settings &&
    Object.keys(snapshot.settings).some(
      key =>
        Object.prototype.hasOwnProperty.call(cloud.settings!.settings, key) &&
        fingerprint(snapshot.settings[key]) !== fingerprint(cloud.settings!.settings[key]),
    )
  // A first upload can fill missing preferences without replacing any cloud value.
  if (memory.settings || changedCloudSettings)
    checkConflict(settings, cloud.settings?.settings, cloud.settings?.revision, memory.settings, overwrite)
  const remember = (key: string, revision: number) => {
    memory = { ...memory, [key]: { revision } }
    saveMemory(memory)
  }
  for (const { local, model, remote, key } of plans) {
    if (remote && fingerprint(local.config) === fingerprint(remote.config)) {
      remember(key, remote.revision)
      continue
    }
    const saved = await client.request<RemoteDocument>(
      remote ? 'PUT' : 'POST',
      remote ? `/device-configs/${remote.id}` : '/device-configs',
      {
        app_id: 'axonkey',
        model_id: model.id,
        instance_key: local.key,
        schema_version: 1,
        revision: remote?.revision ?? 0,
        config: local.config,
      },
    )
    remember(key, saved.revision)
  }
  if (cloud.settings && fingerprint(settings) === fingerprint(cloud.settings.settings)) {
    remember('settings', cloud.settings.revision)
  } else {
    const saved = await client.request<RemoteSettings>('PUT', '/app-settings/axonkey', {
      schema_version: 1,
      revision: cloud.settings?.revision ?? 0,
      settings,
    })
    remember('settings', saved.revision)
  }
}

function checkConflict(
  local: unknown,
  remote: unknown,
  revision: number | undefined,
  previous: SyncMemory[string] | undefined,
  overwrite: boolean,
) {
  if (overwrite || (remote !== undefined && fingerprint(local) === fingerprint(remote))) return
  if (remote === undefined ? !!previous : !previous || previous.revision !== revision) throw new SyncConflict(!previous)
}

export function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map(key => [key, entry[key]]),
        )
      : entry,
  )
}
