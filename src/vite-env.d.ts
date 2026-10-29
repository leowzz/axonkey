/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly TENCENT_RUM_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
