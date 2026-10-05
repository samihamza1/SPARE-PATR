import { BLOCKING_IMPORT_ISSUES, IMPORT_DECISIONS, newId } from '@autoparts/shared';
import type {
  ImportBatchDetail,
  ImportDecision,
  ImportIssue,
  ImportRow,
  Vehicle,
} from '@autoparts/shared';
import {
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  Select,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { VehiclePicker, catalogKeys, categoryName, useCategories } from '../../catalog/common';
import { ErrorAlert } from '../../components/ErrorAlert';

type Code = ImportBatchDetail['vehicleCodes'][number];

const DECISION_COLORS: Record<ImportDecision, string> = {
  create: 'green',
  update: 'blue',
  merge: 'grape',
  skip: 'gray',
};
const issueColor = (i: ImportIssue) =>
  BLOCKING_IMPORT_ISSUES.includes(i)
    ? 'red'
    : ['duplicate_row', 'shared_number', 'existing_part'].includes(i)
      ? 'gray'
      : 'yellow';

/** Maps one file code to vehicles, a category, or nothing, as tenant vehicle aliases. */
function MapCode({
  code,
  onClose,
  onSaved,
}: {
  code: Code;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, i18n } = useTranslation();
  const categories = useCategories();
  const [target, setTarget] = useState<string | null>('vehicle');
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const post = (body: object) =>
        api('POST', '/catalog/vehicle-aliases', { id: newId(), alias: code.code, target, ...body });
      if (target === 'vehicle') {
        for (const v of vehicles) await post({ vehicleId: v.id });
      } else if (target === 'category') {
        await post({ categoryId });
      } else {
        await post({});
      }
    },
    onSuccess: onSaved,
  });
  const ready =
    (target === 'vehicle' && vehicles.length > 0) ||
    (target === 'category' && categoryId !== null) ||
    target === 'ignore';
  return (
    <Modal opened onClose={onClose} title={`${t('import.mapCode')}: ${code.code}`}>
      <Stack>
        <Select
          label={t('import.mapping')}
          value={target}
          onChange={setTarget}
          data={(['vehicle', 'category', 'ignore'] as const).map((x) => ({
            value: x,
            label: t(`vehicles.target.${x}`),
          }))}
        />
        {target === 'vehicle' && (
          <>
            <Group gap="xs">
              {vehicles.map((v) => (
                <Badge
                  key={v.id}
                  variant="light"
                  onClick={() => {
                    setVehicles(vehicles.filter((x) => x.id !== v.id));
                  }}
                >
                  {v.name} ×
                </Badge>
              ))}
            </Group>
            <VehiclePicker
              onPick={(v) => {
                if (!vehicles.some((x) => x.id === v.id)) setVehicles([...vehicles, v]);
              }}
            />
          </>
        )}
        {target === 'category' && (
          <Select
            label={t('catalog.category')}
            value={categoryId}
            onChange={setCategoryId}
            data={(categories.data ?? []).map((c) => ({
              value: c.id,
              label: categoryName(c, i18n.language),
            }))}
          />
        )}
        <ErrorAlert error={save.error} />
        <Button
          disabled={!ready}
          loading={save.isPending}
          onClick={() => {
            save.mutate();
          }}
        >
          {t('common.save')}
        </Button>
      </Stack>
    </Modal>
  );
}

export function ImportBatchPage() {
  const { t, i18n } = useTranslation();
  const { id = '' } = useParams();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const key = ['catalog', 'import', id] as const;
  const batch = useQuery({
    queryKey: key,
    queryFn: () => api<ImportBatchDetail>('GET', `/catalog/imports/${id}`),
  });
  const [issue, setIssue] = useState<ImportIssue | null>(null);
  const [decision, setDecision] = useState<ImportDecision | null>(null);
  const [mapping, setMapping] = useState<Code | null>(null);
  const rowsKey = [...key, 'rows', issue, decision] as const;
  const rows = useQuery({
    queryKey: rowsKey,
    queryFn: () => {
      const params = new URLSearchParams({ limit: '500' });
      if (issue !== null) params.set('issue', issue);
      if (decision !== null) params.set('decision', decision);
      return api<ImportRow[]>('GET', `/catalog/imports/${id}/rows?${params.toString()}`);
    },
  });

  const refresh = async (detail?: ImportBatchDetail) => {
    if (detail !== undefined) queryClient.setQueryData(key, detail);
    await queryClient.invalidateQueries({ queryKey: key });
  };
  const post = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: object }) =>
      api<ImportBatchDetail>('POST', `/catalog/imports/${id}${path}`, body ?? {}),
    onSuccess: async (detail) => {
      await refresh(detail);
      await queryClient.invalidateQueries({ queryKey: catalogKeys.parts });
      await queryClient.invalidateQueries({ queryKey: catalogKeys.aliases });
    },
  });

  if (batch.data === undefined) return <ErrorAlert error={batch.error} />;
  const b = batch.data;
  const editable = b.status === 'draft' || b.status === 'previewed';
  const importing = (b.stats?.rows ?? 0) - (b.stats?.byDecision.skip ?? 0);

  return (
    <Stack>
      <Anchor component={Link} to="/catalog/imports">
        {t('import.title')}
      </Anchor>
      <Group>
        <Title order={2} dir="ltr">
          {b.fileName}
        </Title>
        <Text>
          {t('import.sheet')}: {b.sheet}
        </Text>
        <Badge size="lg" variant="light">
          {t(`import.status.${b.status}`)}
        </Badge>
      </Group>
      <ErrorAlert error={post.error ?? rows.error} />

      <Card withBorder>
        <Title order={4}>{t('import.summary')}</Title>
        <Group gap="xs" mt="xs">
          <Text>{t('import.rows', { count: b.stats?.rows ?? 0 })}:</Text>
          {IMPORT_DECISIONS.map((d) =>
            (b.stats?.byDecision[d] ?? 0) === 0 ? null : (
              <Badge
                key={d}
                color={DECISION_COLORS[d]}
                variant={decision === d ? 'filled' : 'light'}
                style={{ cursor: 'pointer' }}
                onClick={() => {
                  setDecision(decision === d ? null : d);
                }}
              >
                {t(`import.decision.${d}`)}: {b.stats?.byDecision[d]}
              </Badge>
            ),
          )}
        </Group>
        <Group gap="xs" mt="xs">
          {Object.entries(b.stats?.byIssue ?? {}).map(([i, count]) => (
            <Badge
              key={i}
              color={issueColor(i as ImportIssue)}
              variant={issue === i ? 'filled' : 'light'}
              style={{ cursor: 'pointer' }}
              onClick={() => {
                setIssue(issue === i ? null : (i as ImportIssue));
              }}
            >
              {t(`import.issue.${i}`)}: {count}
            </Badge>
          ))}
        </Group>
        {b.status === 'applied' && (
          <Group mt="sm">
            <Text>
              {t('import.pricesSet')}: {b.stats?.pricesSet ?? 0} · {t('import.fitmentsAdded')}:{' '}
              {b.stats?.fitmentsAdded ?? 0}
            </Text>
            <Anchor component={Link} to="/catalog/parts">
              {t('import.openParts')}
            </Anchor>
          </Group>
        )}
        {editable && can('catalog.import') && (
          <Group mt="md">
            <Button
              variant="light"
              loading={post.isPending}
              onClick={() => {
                post.mutate({ path: '/analyse' });
              }}
            >
              {t('import.analyse')}
            </Button>
            <Button
              loading={post.isPending}
              onClick={() => {
                if (window.confirm(t('import.applyConfirm', { count: importing })))
                  post.mutate({ path: '/apply' });
              }}
            >
              {t('import.apply')}
            </Button>
            <Button
              variant="subtle"
              color="red"
              onClick={() => {
                if (window.confirm(t('import.discardConfirm'))) post.mutate({ path: '/discard' });
              }}
            >
              {t('import.discard')}
            </Button>
          </Group>
        )}
      </Card>

      {b.vehicleCodes.length > 0 && (
        <Card withBorder>
          <Title order={4}>{t('import.steps.codes')}</Title>
          <Text size="sm" c="dimmed">
            {t('import.codesHint')}
          </Text>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('import.code')}</Table.Th>
                <Table.Th>{t('import.row')}</Table.Th>
                <Table.Th>{t('import.mapping')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {b.vehicleCodes.map((c) => (
                <Table.Tr key={c.codeNorm} data-testid={`code-${c.codeNorm}`}>
                  <Table.Td dir="ltr">{c.code}</Table.Td>
                  <Table.Td>{c.rows}</Table.Td>
                  <Table.Td>
                    {c.mapping === null ? (
                      <Badge color="yellow" variant="light">
                        {t('import.unmapped')}
                      </Badge>
                    ) : (
                      <Text size="sm">
                        {t(`vehicles.target.${c.mapping.target}`)}
                        {c.mapping.vehicles.length > 0 &&
                          `: ${new Intl.ListFormat(i18n.language).format(
                            c.mapping.vehicles.map((v) => v.name),
                          )}`}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {editable && c.mapping === null && can('catalog.manage') && (
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => {
                          setMapping(c);
                        }}
                      >
                        {t('import.mapCode')}
                      </Button>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      )}

      <Card withBorder>
        <Group justify="space-between">
          <Title order={4}>{t('import.steps.preview')}</Title>
          {(issue !== null || decision !== null) && (
            <Button
              size="xs"
              variant="subtle"
              onClick={() => {
                setIssue(null);
                setDecision(null);
              }}
            >
              {t('import.allRows')}
            </Button>
          )}
        </Group>
        <Table striped fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('import.row')}</Table.Th>
              <Table.Th>{t('import.field.partNumber')}</Table.Th>
              <Table.Th>{t('catalog.name')}</Table.Th>
              <Table.Th>{t('import.field.vehicleCode')}</Table.Th>
              <Table.Th>{t('import.field.sellPrice')}</Table.Th>
              <Table.Th>{t('import.result')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.data?.map((r) => (
              <Table.Tr key={r.id} data-testid={`import-row-${String(r.rowNumber)}`}>
                <Table.Td>{r.rowNumber}</Table.Td>
                <Table.Td dir="ltr">{r.parsed.partNumber}</Table.Td>
                <Table.Td>
                  {i18n.language === 'ar'
                    ? (r.parsed.nameAr ?? r.parsed.nameEn)
                    : (r.parsed.nameEn ?? r.parsed.nameAr)}
                </Table.Td>
                <Table.Td dir="ltr">{r.parsed.vehicleCode}</Table.Td>
                <Table.Td dir="ltr">{r.parsed.sellPrice}</Table.Td>
                <Table.Td>
                  <Stack gap={2}>
                    {r.decision !== null && (
                      <Badge color={DECISION_COLORS[r.decision]} variant="light">
                        {t(`import.decision.${r.decision}`)}
                      </Badge>
                    )}
                    {r.skippedByUser && <Text size="xs">{t('import.skippedByUser')}</Text>}
                    {r.issues.map((i) => (
                      <Badge key={i} size="xs" color={issueColor(i)} variant="outline">
                        {t(`import.issue.${i}`)}
                      </Badge>
                    ))}
                  </Stack>
                </Table.Td>
                <Table.Td>
                  {editable && (
                    <Button
                      size="xs"
                      variant="subtle"
                      onClick={() => {
                        post.mutate(
                          {
                            path: '/rows/skip',
                            body: { rowIds: [r.id], skipped: !r.skippedByUser },
                          },
                          {
                            onSuccess: () => {
                              void queryClient.invalidateQueries({ queryKey: rowsKey });
                            },
                          },
                        );
                      }}
                    >
                      {r.skippedByUser ? t('import.unskip') : t('import.skip')}
                    </Button>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>

      {mapping !== null && (
        <MapCode
          code={mapping}
          onClose={() => {
            setMapping(null);
          }}
          onSaved={() => {
            setMapping(null);
            post.mutate({ path: '/analyse' });
          }}
        />
      )}
    </Stack>
  );
}
