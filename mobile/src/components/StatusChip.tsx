import React from 'react';
import { Chip, useTheme } from 'react-native-paper';

import type { PrintStatus } from '@/api/types';

export function StatusChip({ status }: { status: PrintStatus }) {
  const theme = useTheme();
  const bg =
    status === 'printed' ? theme.colors.primaryContainer : status === 'failed' ? theme.colors.errorContainer : theme.colors.surfaceVariant;
  return (
    <Chip compact style={{ backgroundColor: bg }}>
      {status}
    </Chip>
  );
}
