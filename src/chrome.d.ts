/**
 * The slice of the MV3 API this extension actually touches. Hand-written rather than
 * pulling in @types/chrome: the popup uses four calls, and the app shares a
 * node_modules with the web front-end that has no business growing a types package
 * for it.
 */
declare namespace chrome {
  namespace runtime {
    const id: string | undefined
    function getURL(path: string): string
    const lastError: { message?: string } | undefined
  }
  namespace tabs {
    function create(props: { url: string; active?: boolean }): Promise<unknown>
  }
  namespace storage {
    interface Area {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>
      set(items: Record<string, unknown>): Promise<void>
      remove(keys: string | string[]): Promise<void>
      clear(): Promise<void>
    }
    /** Survives a browser restart — the encrypted keystore lives here. */
    const local: Area
    /** In-memory only, wiped when the browser closes. The unlocked key lives here. */
    const session: Area
  }
}

declare const __EXTENSION__: boolean
