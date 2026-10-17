import { createContext } from 'react'

export type MobileNativeChatViewedImage = { uri: string; label: string }

/** Opens an attachment full size. Held above the rows, so the picture stays open while the row
 *  under it is replaced (a sent message's echo by its transcript row). */
export const MobileNativeChatImageViewerContext = createContext<
  (image: MobileNativeChatViewedImage) => void
>(() => {})
