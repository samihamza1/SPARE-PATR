import { IMPORT_FIELDS, IMPORT_MAX_FILE_BYTES, PART_NUMBER_KINDS, newId } from '@autoparts/shared';
import type {
  ImportBatch,
  ImportBatchDetail,
  ImportField,
  ImportMapping,
  InspectImportResult,
} from '@autoparts/shared';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  FileInput,
  Group,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Stepper,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { api } from '../../api';
import { useCurrencies, usePriceLists } from '../../catalog/common';
import { ErrorAlert } from '../../components/ErrorAlert';
import { useFormatDateTime } from '../../format';

/** Spreadsheet column letters: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

interface Upload {
  fileName: string;
  contentBase64: string;
  result: InspectImportResult;
}

function History() {
  const { t } = useTranslation();
  const formatDateTime = useFormatDateTime();
  const batches = useQuery({
    queryKey: ['catalog', 'imports'],
    queryFn: () => api<ImportBatch[]>('GET', '/catalog/imports'),
  });
  if ((batches.data?.length ?? 0) === 0) return null;
  return (
    <Card withBorder>
      <Title order={4}>{t('import.history')}</Title>
      <Table>
        <Table.Tbody>
          {batches.data?.map((b) => (
            <Table.Tr key={b.id}>
              <Table.Td>
                <Anchor component={Link} to={`/catalog/imports/${b.id}`} dir="ltr">
                  {b.fileName}
                </Anchor>
              </Table.Td>
              <Table.Td>{b.sheet}</Table.Td>
              <Table.Td>
                <Badge variant="light">{t(`import.status.${b.status}`)}</Badge>
              </Table.Td>
              <Table.Td>{formatDateTime(b.createdAt)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  );
}

export function ImportsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const priceLists = usePriceLists();
  const currencies = useCurrencies();
  const [step, setStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [sheetName, setSheetName] = useState<string | null>(null);
  const [headerRow, setHeaderRow] = useState(1);
  const [columns, setColumns] = useState<Partial<Record<ImportField, number>>>({});
  const [numberKind, setNumberKind] = useState<string | null>(null);
  const [priceListId, setPriceListId] = useState<string | null>(null);
  const [costCurrency, setCostCurrency] = useState<string | null>(null);
  const [skuPrefix, setSkuPrefix] = useState('');

  const inspect = useMutation({
    mutationFn: async (f: File) => {
      const contentBase64 = await fileToBase64(f);
      const result = await api<InspectImportResult>('POST', '/catalog/imports/inspect', {
        fileName: f.name,
        contentBase64,
      });
      return { fileName: f.name, contentBase64, result };
    },
    onSuccess: (u) => {
      setUpload(u);
      setSheetName(u.result.sheets[0]?.name ?? null);
      setHeaderRow(1);
      setColumns({});
      setStep(1);
    },
  });

  const stage = useMutation({
    mutationFn: () => {
      if (upload === null || sheetName === null) throw new Error('no file');
      const mapping: ImportMapping = {
        columns,
        numberKind: numberKind as ImportMapping['numberKind'],
        priceListId: columns.sellPrice === undefined ? null : priceListId,
        costCurrency: columns.cost === undefined ? null : costCurrency,
        skuPrefix: skuPrefix.trim() === '' ? null : skuPrefix.trim().toUpperCase(),
      };
      return api<ImportBatchDetail>('POST', '/catalog/imports', {
        id: newId(),
        fileName: upload.fileName,
        contentBase64: upload.contentBase64,
        sheet: sheetName,
        headerRow,
        mapping,
      });
    },
    onSuccess: (batch) => {
      void navigate(`/catalog/imports/${batch.id}`);
    },
  });

  const sheet = upload?.result.sheets.find((s) => s.name === sheetName);
  const header = sheet?.rows[headerRow - 1] ?? [];
  const columnOptions = Array.from({ length: sheet?.columnCount ?? 0 }, (_, i) => ({
    value: String(i),
    label: `${columnLetter(i)} — ${header[i] ?? ''}`,
  }));
  const tooLarge = file !== null && file.size > IMPORT_MAX_FILE_BYTES;

  return (
    <Stack>
      <Title order={2}>{t('import.title')}</Title>
      <Alert color="blue">{t('import.privacy')}</Alert>
      <Stepper
        active={step}
        onStepClick={(s) => {
          if (s < step) setStep(s);
        }}
      >
        <Stepper.Step label={t('import.steps.file')}>
          <Group align="flex-end" mt="md">
            <FileInput
              style={{ flex: 1 }}
              label={t('import.file')}
              accept=".xlsx,.csv"
              value={file}
              onChange={setFile}
              error={tooLarge ? t('errors.import.unreadable_file') : undefined}
            />
            <Button
              disabled={file === null || tooLarge}
              loading={inspect.isPending}
              onClick={() => {
                if (file !== null) inspect.mutate(file);
              }}
            >
              {t('import.read')}
            </Button>
          </Group>
          <ErrorAlert error={inspect.error} />
        </Stepper.Step>

        <Stepper.Step label={t('import.steps.sheet')}>
          <Stack mt="md">
            <Select
              label={t('import.sheet')}
              value={sheetName}
              onChange={(v) => {
                setSheetName(v);
                setHeaderRow(1);
                setColumns({});
              }}
              data={(upload?.result.sheets ?? []).map((s) => ({
                value: s.name,
                label: `${s.name} (${t('import.rows', { count: s.rowCount })})`,
              }))}
            />
            <Text size="sm">{t('import.headerHint')}</Text>
            <ScrollArea h={360}>
              <Table withTableBorder highlightOnHover dir="ltr" fz="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('import.row')}</Table.Th>
                    {columnOptions.map((c, i) => (
                      <Table.Th key={c.value}>{columnLetter(i)}</Table.Th>
                    ))}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {sheet?.rows.map((row, r) => (
                    <Table.Tr
                      key={r}
                      data-testid={`sheet-row-${String(r + 1)}`}
                      style={{
                        cursor: 'pointer',
                        ...(r + 1 === headerRow && {
                          background: 'var(--mantine-color-blue-light)',
                        }),
                      }}
                      aria-selected={r + 1 === headerRow}
                      onClick={() => {
                        setHeaderRow(r + 1);
                        setColumns({});
                      }}
                    >
                      <Table.Td>{r + 1}</Table.Td>
                      {columnOptions.map((c, i) => (
                        <Table.Td key={c.value}>{row[i] ?? ''}</Table.Td>
                      ))}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
            <Group>
              <Text>
                {t('import.headerRow')}: {headerRow}
              </Text>
              <Button
                onClick={() => {
                  setStep(2);
                }}
              >
                {t('import.next')}
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>

        <Stepper.Step label={t('import.steps.columns')}>
          <Stack
            mt="md"
            component="form"
            onSubmit={(e) => {
              e.preventDefault();
              stage.mutate();
            }}
          >
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              {IMPORT_FIELDS.map((field) => (
                <Select
                  key={field}
                  label={t(`import.field.${field}`)}
                  placeholder={t('import.notMapped')}
                  clearable
                  value={columns[field] === undefined ? null : String(columns[field])}
                  onChange={(v) => {
                    const others = Object.fromEntries(
                      Object.entries(columns).filter(([f]) => f !== field),
                    );
                    setColumns(v === null ? others : { ...others, [field]: Number(v) });
                  }}
                  data={columnOptions}
                />
              ))}
            </SimpleGrid>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Select
                label={t('import.numberKind')}
                required
                value={numberKind}
                onChange={setNumberKind}
                data={PART_NUMBER_KINDS.map((k) => ({
                  value: k,
                  label: t(`catalog.numberKind.${k}`),
                }))}
              />
              {columns.sellPrice !== undefined && (
                <Select
                  label={t('import.priceList')}
                  required
                  value={priceListId}
                  onChange={setPriceListId}
                  data={(priceLists.data ?? [])
                    .filter((l) => l.archivedAt === null)
                    .map((l) => ({ value: l.id, label: `${l.name} (${l.currency})` }))}
                />
              )}
              {columns.cost !== undefined && (
                <Select
                  label={t('import.costCurrency')}
                  required
                  value={costCurrency}
                  onChange={setCostCurrency}
                  data={(currencies.data ?? []).map((c) => ({ value: c.code, label: c.code }))}
                />
              )}
              <TextInput
                label={t('import.skuPrefix')}
                description={t('import.skuPrefixHint')}
                required={columns.sku === undefined}
                dir="ltr"
                value={skuPrefix}
                onChange={(e) => {
                  setSkuPrefix(e.currentTarget.value);
                }}
              />
            </SimpleGrid>
            <ErrorAlert error={stage.error} />
            <Group>
              <Button type="submit" loading={stage.isPending} disabled={numberKind === null}>
                {t('import.stage')}
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>
      </Stepper>
      <History />
    </Stack>
  );
}
