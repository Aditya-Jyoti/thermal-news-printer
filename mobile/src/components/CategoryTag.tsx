import React, { useCallback, useMemo } from 'react';
import { Chip, useTheme } from 'react-native-paper';

import type { Category } from '@/api/types';
import { categoryColor } from '@/lib/format';
import { paletteFor } from '@/theme';

/** Returns a resolver giving every category a color (explicit, else from the dynamic theme palette). */
export function useCategoryColor() {
  const theme = useTheme();
  const palette = useMemo(() => paletteFor(theme), [theme]);
  return useCallback((c: Pick<Category, 'id' | 'color'>) => categoryColor(c, palette), [palette]);
}

interface Props {
  category: Pick<Category, 'id' | 'name' | 'color'>;
  selected?: boolean;
  onPress?: () => void;
  compact?: boolean;
}

/** Tag pill for a category; tinted with the category color. */
export function CategoryTag({ category, selected, onPress, compact }: Props) {
  const color = useCategoryColor()(category);
  return (
    <Chip
      compact={compact}
      selected={selected}
      onPress={onPress}
      style={{ backgroundColor: `${color}26`, borderColor: color, borderWidth: 1, alignSelf: 'flex-start' }}
      textStyle={{ color }}
      selectedColor={color}
    >
      {category.name}
    </Chip>
  );
}
