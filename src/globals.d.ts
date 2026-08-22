/// <reference types="vite/client" />

// Env vars we read at build time (see src/lib/uniswapTokens.ts).
interface ImportMetaEnv {
  readonly VITE_UNISWAP_PROXY?: string
  readonly DEV: boolean
  readonly PROD: boolean
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module 'snarkjs'
declare module 'ffjavascript'
declare module 'poseidon-lite'
declare module 'fixed-merkle-tree' {
  export class MerkleTree {
    constructor(levels: number, elements?: any[], options?: any)
    root: any
    elements: any[]
    insert(element: any): void
    indexOf(element: any): number
    path(index: number): { pathElements: any[]; pathIndices: number[] }
  }
}
