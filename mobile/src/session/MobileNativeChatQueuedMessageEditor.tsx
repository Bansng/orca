import { useEffect, useRef } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
import type { MobileQueuedMessageInlineEditor } from './use-mobile-structured-queued-edit'

export function MobileNativeChatQueuedMessageEditor({
  editor
}: {
  editor: MobileQueuedMessageInlineEditor
}): React.JSX.Element {
  const input = useRef<TextInput>(null)
  useEffect(() => {
    input.current?.focus()
  }, [])
  return (
    <View style={styles.editor} testID="queued-card-editor">
      <TextInput
        ref={input}
        accessibilityLabel="Edit queued message"
        value={editor.text}
        editable={!editor.saving}
        multiline
        style={styles.input}
        onChangeText={editor.change}
      />
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel editing queued message"
          accessibilityState={{ disabled: editor.saving }}
          disabled={editor.saving}
          style={({ pressed }) => [
            styles.action,
            pressed && styles.pressed,
            editor.saving && styles.disabled
          ]}
          onPress={editor.cancel}
        >
          <Text style={styles.label}>Cancel</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save queued message"
          accessibilityState={{ disabled: editor.saving || !editor.canSave }}
          disabled={editor.saving || !editor.canSave}
          style={({ pressed }) => [
            styles.action,
            styles.save,
            pressed && styles.pressed,
            (editor.saving || !editor.canSave) && styles.disabled
          ]}
          onPress={() => void editor.save()}
        >
          <Text style={styles.label}>Save</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  editor: { gap: spacing.xs },
  input: {
    minHeight: 44,
    maxHeight: 160,
    padding: spacing.sm,
    color: colors.textPrimary,
    fontSize: TEXT_INPUT_FONT_SIZE,
    backgroundColor: colors.bgBase,
    borderRadius: radii.input,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.xs },
  action: {
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radii.button
  },
  save: { backgroundColor: colors.bgRaised },
  label: { color: colors.textPrimary, fontSize: typography.metaSize, fontWeight: '500' },
  pressed: { backgroundColor: colors.bgPanel },
  disabled: { opacity: 0.5 }
})
