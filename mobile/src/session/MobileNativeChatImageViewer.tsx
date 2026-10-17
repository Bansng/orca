import { Image, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { X } from 'lucide-react-native'
import { useWindowSafeAreaInsets } from '../layout/side-safe-area'
import { colors, spacing } from '../theme/mobile-theme'
import {
  MobileNativeChatImageViewerContext,
  type MobileNativeChatViewedImage
} from './mobile-native-chat-image-viewer-context'
import {
  useMobileNativeChatConversationState,
  type MobileNativeChatConversation
} from './use-mobile-native-chat-conversation-state'

/** The chat surface, from which any row can open an attachment full size. */
export function MobileNativeChatImageViewerHost({
  conversation,
  children
}: {
  conversation: MobileNativeChatConversation
  children: React.ReactNode
}): React.JSX.Element {
  // A picture belongs to the conversation it was opened in.
  const [image, setImage] =
    useMobileNativeChatConversationState<MobileNativeChatViewedImage>(conversation)
  return (
    <MobileNativeChatImageViewerContext.Provider value={setImage}>
      {children}
      {image ? <MobileNativeChatImageViewer {...image} onClose={() => setImage(null)} /> : null}
    </MobileNativeChatImageViewerContext.Provider>
  )
}

/** An attached image at full size, over everything, until closed. Desktop opens the same
 *  picture in its full-size preview dialog. iOS also zooms it with a pinch. */
function MobileNativeChatImageViewer({
  uri,
  label,
  onClose
}: {
  uri: string
  label: string
  onClose: () => void
}): React.JSX.Element {
  const insets = useWindowSafeAreaInsets()
  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <ScrollView
          contentContainerStyle={styles.stage}
          maximumZoomScale={4}
          minimumZoomScale={1}
          centerContent
        >
          <Image
            source={{ uri }}
            style={styles.image}
            resizeMode="contain"
            accessibilityLabel={label}
          />
        </ScrollView>
        <Pressable
          style={[styles.close, { top: insets.top + spacing.sm }]}
          onPress={onClose}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Close image"
        >
          <X size={22} color={colors.textPrimary} strokeWidth={2} />
        </Pressable>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  stage: {
    flexGrow: 1
  },
  image: {
    flex: 1,
    width: '100%'
  },
  close: {
    position: 'absolute',
    right: spacing.lg,
    padding: spacing.sm,
    borderRadius: 999,
    backgroundColor: colors.bgRaised
  }
})
