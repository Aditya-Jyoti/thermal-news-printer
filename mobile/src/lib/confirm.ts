import { Alert } from 'react-native';

export function confirmDestructive(title: string, message: string, confirmLabel: string, onConfirm: () => void) {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: confirmLabel, style: 'destructive', onPress: onConfirm },
  ]);
}
