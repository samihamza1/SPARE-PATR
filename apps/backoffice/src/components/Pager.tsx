import { Button, Group } from '@mantine/core';
import { useTranslation } from 'react-i18next';

/** Previous and next page buttons for a paged list. */
export function Pager({
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: {
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  if (!hasPrevious && !hasNext) return null;
  return (
    <Group>
      <Button variant="default" disabled={!hasPrevious} onClick={onPrevious}>
        {t('common.previous')}
      </Button>
      <Button variant="default" disabled={!hasNext} onClick={onNext}>
        {t('common.next')}
      </Button>
    </Group>
  );
}
