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
    interface MessageSender {
      id?: string
      origin?: string
      url?: string
      tab?: { id?: number; url?: string }
    }
    /** Overloads: callback form (returns void, `true` from the listener keeps the channel
     *  open) and promise form used by the popup/background. */
    function sendMessage(message: unknown, responseCallback?: (response: any) => void): void
    const onMessage: {
      addListener(
        callback: (message: any, sender: MessageSender, sendResponse: (response?: any) => void) => boolean | void,
      ): void
      removeListener(callback: (...args: any[]) => any): void
    }
  }
  namespace tabs {
    interface Tab {
      id?: number
      url?: string
    }
    function create(props: { url: string; active?: boolean }): Promise<unknown>
    function query(queryInfo: Record<string, unknown>): Promise<Tab[]>
    function sendMessage(tabId: number, message: unknown, responseCallback?: (response: any) => void): void
  }
  namespace windows {
    interface Window {
      id?: number
    }
    function create(
      props: { url?: string; type?: string; width?: number; height?: number; focused?: boolean },
      callback?: (window?: Window) => void,
    ): void
    function remove(windowId: number): Promise<void>
    const onRemoved: {
      addListener(callback: (windowId: number) => void): void
    }
  }
  namespace permissions {
    interface Permissions {
      origins?: string[]
      permissions?: string[]
    }
    function request(permissions: Permissions): Promise<boolean>
    function contains(permissions: Permissions): Promise<boolean>
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
