import { RelayClient, RelayError } from './relayClient.ts'

export type CloudDocument = { key: string; kind: string; config: Record<string, unknown> }
export type SourcePlatform = 'windows' | 'macos' | 'unknown'
export type CloudSource = {
  source_platform: SourcePlatform
  source_installation_id: string | null
  source_computer_name: string | null
}
export type CloudSnapshot = { documents: CloudDocument[]; settings: Record<string, unknown>; source?: CloudSource }
export type RemoteDocument = Partial<CloudSource> & {
  etag?: string
  updated_at?: string
  id: string
  model_id: string
  instance_key: string
  schema_version: number
  revision: number
  config: Record<string, unknown>
}
type RemoteSettings = { etag?: string; schema_version: number; revision: number; settings: Record<string, unknown> }
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
  const models = await client.request<{ items: CloudState['models'] }>('GET', '/v2/device-models?app_id=axonkey')
  const documents: RemoteDocument[] = []
  for (let offset = 0; ; offset += 100) {
    const page = await client.request<{ items: RemoteDocument[]; total: number }>(
      'GET',
      `/v2/device-configs?app_id=axonkey&view=full&limit=100&offset=${offset}`,
    )
    documents.push(...page.items)
    if (offset + page.items.length >= page.total || page.items.length === 0) break
  }
  let settings: RemoteSettings | null
  try {
    const response = await client.resource<RemoteSettings>('GET', '/v2/app-settings/axonkey')
    settings = { ...response.body, etag: response.etag }
  } catch (error) {
    if (!(error instanceof RelayError) || error.status !== 404) throw error
    settings = null
  }
  if (documents.some(doc => ![1, 2].includes(doc.schema_version)) || (settings && settings.schema_version !== 1))
    throw new Error('云端配置版本较新，请升级 Axonkey 后重试')
  return { models: models.items, documents: [...new Map(documents.map(doc => [doc.id, doc])).values()], settings }
}

export async function readCloudDocument(client: RelayClient, id: string): Promise<RemoteDocument> {
  const response = await client.resource<RemoteDocument>('GET', `/v2/device-configs/${encodeURIComponent(id)}`)
  if (![1, 2].includes(response.body.schema_version)) throw new Error('云端配置版本较新，请升级 Axonkey 后重试')
  if (!response.etag) throw new Error('云端未返回配置版本标识，请更新 Relay 后重试')
  return { ...response.body, etag: response.etag }
}

export async function uploadCloud(
  client: RelayClient,
  snapshot: CloudSnapshot,
  memory: SyncMemory,
  saveMemory: (memory: SyncMemory) => void,
  overwrite = false,
) {
  if (!snapshot.source || snapshot.source.source_platform === 'unknown' || !snapshot.source.source_installation_id)
    throw new Error('无法确认本机系统，暂不能上传配置')
  const cloud = await readCloud(client)
  const owned = cloud.documents.filter(doc => doc.source_installation_id === snapshot.source!.source_installation_id)
  const details = await Promise.all(
    owned
      .filter(doc => snapshot.documents.some(local => local.key === doc.instance_key))
      .map(doc => readCloudDocument(client, doc.id)),
  )
  const plans = snapshot.documents.map(local => {
    const model = cloud.models.find(model => model.code === local.kind)
    if (!model) throw new Error(`云端尚未配置型号 ${local.kind}，请先更新 Relay 设备目录`)
    const remote = details.find(doc => doc.model_id === model.id && doc.instance_key === local.key)
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
  if (cloud.settings) requiredEtag(cloud.settings.etag)
  const remember = (key: string, revision: number) => {
    memory = { ...memory, [key]: { revision } }
    saveMemory(memory)
  }
  for (const { local, model, remote, key } of plans) {
    if (
      remote &&
      fingerprint(local.config) === fingerprint(remote.config) &&
      remote.source_computer_name === snapshot.source.source_computer_name
    ) {
      remember(key, remote.revision)
      continue
    }
    const saved = await client.request<RemoteDocument>(
      remote ? 'PUT' : 'POST',
      remote ? `/v2/device-configs/${remote.id}` : '/v2/device-configs',
      {
        app_id: 'axonkey',
        model_id: model.id,
        instance_key: local.key,
        schema_version: 2,
        ...snapshot.source,
        config: local.config,
      },
      true,
      remote ? { ifMatch: remote.etag! } : undefined,
    )
    remember(key, saved.revision)
  }
  if (cloud.settings && fingerprint(settings) === fingerprint(cloud.settings.settings)) {
    remember('settings', cloud.settings.revision)
  } else {
    const saved = await client.request<RemoteSettings>(
      'PUT',
      '/v2/app-settings/axonkey',
      {
        schema_version: 1,
        settings,
      },
      true,
      cloud.settings ? { ifMatch: requiredEtag(cloud.settings.etag) } : { ifNoneMatch: '*' },
    )
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

function requiredEtag(etag?: string): string {
  if (!etag) throw new Error('云端未返回设置版本标识，请更新 Relay 后重试')
  return etag
}
