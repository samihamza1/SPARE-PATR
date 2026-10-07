import type { SearchResult } from '@autoparts/shared';
import {
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api } from '../../api';
import { GradeBadge, Price, partName } from '../../catalog/common';
import { ErrorAlert } from '../../components/ErrorAlert';
import { StockBadges } from '../../inventory/common';

/** The salesperson's search (BRIEF scenario 1): one box, results with ranked alternatives. */
export function SearchPage() {
  const { t, i18n } = useTranslation();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const result = useQuery({
    queryKey: ['catalog', 'search', q],
    queryFn: () => api<SearchResult>('GET', `/catalog/search?q=${encodeURIComponent(q)}`),
    enabled: q !== '',
  });
  const data = result.data;
  const lang = i18n.language;

  return (
    <Stack>
      <Title order={2}>{t('search.title')}</Title>
      <Group
        component="form"
        align="flex-end"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(text.trim());
        }}
      >
        <TextInput
          style={{ flex: 1 }}
          aria-label={t('search.title')}
          placeholder={t('search.placeholder')}
          value={text}
          onChange={(e) => {
            setText(e.currentTarget.value);
          }}
          autoFocus
        />
        <Button type="submit" loading={result.isFetching}>
          {t('search.submit')}
        </Button>
      </Group>
      <ErrorAlert error={result.error} />
      {data !== undefined && (
        <Group gap="xs" aria-label={t('search.understood')}>
          <Text size="sm" c="dimmed">
            {t('search.understood')}:
          </Text>
          {data.interpretation.vehicles.map((v) => (
            <Badge key={v.id} variant="light">
              {t(`catalog.level.${v.level}`)}: {v.name}
            </Badge>
          ))}
          {data.interpretation.year !== null && (
            <Badge variant="light">{t('search.year', { year: data.interpretation.year })}</Badge>
          )}
          {data.interpretation.partNumber !== null && (
            <Badge variant="light" dir="ltr">
              {t('search.number', { number: data.interpretation.partNumber })}
            </Badge>
          )}
          {data.interpretation.text.map((w) => (
            <Badge key={w} variant="outline">
              {w}
            </Badge>
          ))}
        </Group>
      )}
      {data?.results.length === 0 && <Text>{t('search.noResults')}</Text>}
      {data?.results.map((r) => (
        <Card key={r.part.id} withBorder data-testid="search-result">
          <Group justify="space-between">
            <Group>
              <Anchor component={Link} to={`/catalog/parts/${r.part.id}`} dir="ltr" fw={700}>
                {r.part.sku}
              </Anchor>
              <Text fw={600}>{partName(r.part, lang)}</Text>
              <GradeBadge grade={r.part.qualityGrade} />
              <Badge variant="dot">{t(`search.matchedBy.${r.matchedBy}`)}</Badge>
            </Group>
            <Group gap="xs">
              <StockBadges locations={r.stock.locations} />
              <Price price={r.price} />
            </Group>
          </Group>
          <Text size="sm" fw={600} mt="sm">
            {t('search.alternatives')}
          </Text>
          {r.alternatives.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('search.noAlternatives')}
            </Text>
          ) : (
            <Table>
              <Table.Tbody>
                {r.alternatives.map((a) => (
                  <Table.Tr key={a.part.id} data-testid="alternative">
                    <Table.Td>
                      <Anchor component={Link} to={`/catalog/parts/${a.part.id}`} dir="ltr">
                        {a.part.sku}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>{partName(a.part, lang)}</Table.Td>
                    <Table.Td>
                      <GradeBadge grade={a.part.qualityGrade} />
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="light" color="gray">
                        {t(`catalog.relation.${a.relation}`)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <StockBadges locations={a.stock.locations} />
                    </Table.Td>
                    <Table.Td>
                      <Price price={a.price} />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Card>
      ))}
    </Stack>
  );
}
