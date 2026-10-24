/// <reference types="vite/client" />

import type { DblionApi } from '@shared/types'

declare global {
  interface Window {
    dblion: DblionApi
  }
}

export {}
