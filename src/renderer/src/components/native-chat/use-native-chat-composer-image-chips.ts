import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import {
  isKeptLocalPaste,
  readNativeChatComposerDraft,
  subscribeToNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { useRestoredNativeChatComposerDraftImageCheck } from './native-chat-composer-draft-image-check'
import { useNativeChatPendingAttachments } from './native-chat-pending-attachment-cache'
import { useNativeChatComposerAttachmentPreviews } from './use-native-chat-composer-attachment-previews'

/** The composer's image chips: the draft's settled images, then those still on their way. */
export function useNativeChatComposerImageChips(attachmentScopeKey: string): {
  imageAttachments: NativeChatComposerImageAttachment[]
} & Omit<ReturnType<typeof useNativeChatComposerAttachmentPreviews>, 'previews'> {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToNativeChatComposerDraft(attachmentScopeKey, listener),
    [attachmentScopeKey]
  )
  const settled = useSyncExternalStore(
    subscribe,
    () => readNativeChatComposerDraft(attachmentScopeKey).images
  )
  // Why: a restored paste shows only once main confirms it is still kept, so until the restore
  // check is done it waits like a chip still saving, instead of flashing before a placeholder.
  const restoring = useRestoredNativeChatComposerDraftImageCheck(attachmentScopeKey, subscribe)
  // Chips still on their way live outside the composer, so one a prompt card unmounted comes back
  // still pending and settles into the draft whichever composer is showing.
  const pending = useNativeChatPendingAttachments(attachmentScopeKey)
  const { previews, setPreview, releasePreview, releaseAllPreviews } =
    useNativeChatComposerAttachmentPreviews(settled, pending)
  const imageAttachments = useMemo(
    () => [
      ...settled.map((image) => {
        const previewUrl = previews.get(image.id)
        if (restoring && isKeptLocalPaste(image)) {
          return { ...image, pending: true }
        }
        return previewUrl ? { ...image, previewUrl } : image
      }),
      ...pending.map((chip) => {
        const previewUrl = previews.get(chip.id)
        return previewUrl ? { ...chip, previewUrl } : chip
      })
    ],
    [pending, previews, restoring, settled]
  )
  return { imageAttachments, setPreview, releasePreview, releaseAllPreviews }
}
