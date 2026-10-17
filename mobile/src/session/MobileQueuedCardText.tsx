import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { colors, typography } from '../theme/mobile-theme'

/** Two lines, opening on tap when it clips: a card can hold another agent's message the person
 *  never read, and Steer or Delete must not be a blind choice. Opened, a long one scrolls in a
 *  capped box. */
export function MobileQueuedCardText({ text }: { text: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [clipped, setClipped] = useState(false)
  // The whole text laid out unseen at the card's width: more than two lines is what clips.
  const measure = (
    <Text
      style={[styles.body, styles.measure]}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onTextLayout={(event) => setClipped(event.nativeEvent.lines.length > 2)}
    >
      {text}
    </Text>
  )
  if (!clipped && !expanded) {
    return (
      <View>
        {measure}
        <Text style={styles.body} numberOfLines={2}>
          {text}
        </Text>
      </View>
    )
  }
  const toggle = (
    <Pressable
      testID="queued-card-text"
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityHint={expanded ? 'Shows less of the message' : 'Shows the whole message'}
      onPress={() => setExpanded(!expanded)}
    >
      <Text style={styles.body} numberOfLines={expanded ? undefined : 2}>
        {text}
      </Text>
      <Text style={styles.caption}>{expanded ? 'Show less' : 'Show more'}</Text>
    </Pressable>
  )
  // The press sits inside the scroll, so a drag scrolls and only a tap folds it.
  return expanded ? (
    <ScrollView style={styles.expandedBody} nestedScrollEnabled>
      {toggle}
    </ScrollView>
  ) : (
    <View>
      {measure}
      {toggle}
    </View>
  )
}

const styles = StyleSheet.create({
  body: {
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  expandedBody: {
    maxHeight: 240
  },
  measure: {
    position: 'absolute',
    left: 0,
    right: 0,
    opacity: 0
  },
  caption: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  }
})
