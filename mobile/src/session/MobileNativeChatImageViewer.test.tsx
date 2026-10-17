import { useContext } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileNativeChatImageViewerHost } from './MobileNativeChatImageViewer'
import {
  MobileNativeChatImageViewerContext,
  type MobileNativeChatViewedImage
} from './mobile-native-chat-image-viewer-context'
import type { MobileNativeChatConversation } from './use-mobile-native-chat-conversation-state'

vi.mock('react-native', () => ({
  Image: 'Image',
  Modal: 'Modal',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles }
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('lucide-react-native', () => ({ X: 'X' }))

let openImage: ((image: MobileNativeChatViewedImage) => void) | null = null
function Row(): null {
  openImage = useContext(MobileNativeChatImageViewerContext)
  return null
}
const chat = (conversation: MobileNativeChatConversation) => (
  <MobileNativeChatImageViewerHost conversation={conversation}>
    <Row />
  </MobileNativeChatImageViewerHost>
)

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

/** Opens a picture in the first conversation, then moves through the rest; one open flag each. */
function viewerAcross(conversations: MobileNativeChatConversation[]): boolean[] {
  const [first, ...rest] = conversations
  act(() => {
    renderer = create(chat(first!))
  })
  act(() => openImage!({ uri: 'file:///a.jpg', label: 'a photo' }))
  const open = () => renderer!.root.findAll((node) => String(node.type) === 'Modal').length === 1
  return [open()].concat(
    rest.map((conversation) => {
      act(() => renderer!.update(chat(conversation)))
      return open()
    })
  )
}

it('closes a picture when a notification switches the tab, and does not reopen it', () => {
  expect(
    viewerAcross([
      { surfaceId: 'tab-a', sessionId: 's1' },
      { surfaceId: 'tab-b', sessionId: 's1' },
      { surfaceId: 'tab-a', sessionId: 's1' }
    ])
  ).toEqual([true, false, false])
})

it("closes a picture when the tab's agent session is replaced", () => {
  expect(
    viewerAcross([
      { surfaceId: 'tab-a', sessionId: 's1' },
      { surfaceId: 'tab-a', sessionId: 's2' }
    ])
  ).toEqual([true, false])
})

it("keeps a picture open when the tab's first session id arrives, then closes on a replacement", () => {
  expect(
    viewerAcross([
      { surfaceId: 'tab-a', sessionId: null },
      { surfaceId: 'tab-a', sessionId: 's1' },
      { surfaceId: 'tab-a', sessionId: 's2' }
    ])
  ).toEqual([true, true, false])
})
