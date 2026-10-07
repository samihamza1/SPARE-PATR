import {
  IMPORT_FIELDS,
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_ROWS,
  PART_NUMBER_KINDS,
  importMappingSchema,
  newId,
} from '@autoparts/shared';
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
  NumberInput,
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
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { ApiRequestError, api } from '../../api';
import { useAuth } from '../../auth';
import { useCurrencies, usePriceLists } from '../../catalog/common';
import { ErrorAlert } from '../../components/ErrorAlert';
import { useFormatDateTime } from '../../format';
import { Form, useRequired } from '../../forms';

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

/** The upload limit in megabytes, in the user's language (e.g. "10 MB"). */
export function maxFileSize(language: string): string {
  return new Intl.NumberFormat(language, {
    style: 'unit',
    unit: 'megabyte',
    maximumFractionDigits: 1,
  }).format(IMPORT_MAX_FILE_BYTES / 1024 / 1024);
}

export function ImportsPage() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const hintId = useId();
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
      // Sheets past the size limits are listed but cannot be chosen.
      setSheetName(u.result.sheets.find((s) => !s.tooLarge)?.name ?? null);
      setHeaderRow(1);
      setColumns({});
      setStep(1);
    },
  });

  const required = useRequired({
    numberKind,
    ...(columns.sellPrice !== undefined && { priceListId }),
    ...(columns.cost !== undefined && { costCurrency }),
    ...(columns.sku === undefined && { skuPrefix }),
  });
  // The shared mapping rules (a column for the part's identity, one field per column), checked
  // here so the user sees them before the file is sent again.
  const [mappingError, setMappingError] = useState<ApiRequestError | null>(null);

  const stage = useMutation({
    mutationFn: (mapping: ImportMapping) => {
      if (upload === null || sheetName === null) throw new Error('no file');
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
  const columnOptions = Array.from({ length: sheet?.columnCount ?? 0 }, (_, i) => {
    const title = header[i] ?? '';
    return {
      value: String(i),
      label:
        title === ''
          ? columnLetter(i)
          : t('import.columnOption', { letter: columnLetter(i), title }),
    };
  });
  const limits = { rows: IMPORT_MAX_ROWS, columns: IMPORT_MAX_COLUMNS };
  const pickHeader = (row: number) => {
    setHeaderRow(row);
    setColumns({});
  };
  // Selling prices are set only by users who may change prices (prices.manage).
  const fields = IMPORT_FIELDS.filter((f) => f !== 'sellPrice' || can('prices.manage'));
  const tooLarge = file !== null && file.size > IMPORT_MAX_FILE_BYTES;

  return (
    <Stack>
      <Title order={2}>{t('import.title')}</Title>
      {/* A standing notice, not an error: screen readers should not announce it as an alert. */}
      <Alert color="blue" role="note">
        {t('import.privacy')}
      </Alert>
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
              error={
                tooLarge ? t('import.fileTooLarge', { max: maxFileSize(i18n.language) }) : undefined
              }
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
              allowDeselect={false}
              onChange={(v) => {
                setSheetName(v);
                pickHeader(1);
              }}
              data={(upload?.result.sheets ?? []).map((s) => ({
                value: s.name,
                label: s.tooLarge
                  ? t('import.sheetTooLarge', { name: s.name, ...limits })
                  : t('import.sheetOption', {
                      name: s.name,
                      rows: t('import.rows', { count: s.rowCount }),
                    }),
                disabled: s.tooLarge,
              }))}
            />
            {upload !== null && sheet === undefined && (
              <Alert color="red">{t('import.noReadableSheet', limits)}</Alert>
            )}
            <Text size="sm" id={hintId}>
              {t('import.headerHint')}
            </Text>
            <NumberInput
              label={t('import.headerRow')}
              aria-describedby={hintId}
              min={1}
              max={Math.max(1, sheet?.rows.length ?? 1)}
              allowDecimal={false}
              allowNegative={false}
              clampBehavior="strict"
              value={headerRow}
              onChange={(v) => {
                if (typeof v === 'number' && v >= 1) pickHeader(v);
              }}
              w={160}
            />
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
                        pickHeader(r + 1);
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
              <Button
                disabled={sheet === undefined}
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
          <Form
            onSubmit={() => {
              setMappingError(null);
              if (!required.ok()) return;
              const checked = importMappingSchema.safeParse({
                columns,
                numberKind,
                priceListId: columns.sellPrice === undefined ? null : priceListId,
                costCurrency: columns.cost === undefined ? null : costCurrency,
                skuPrefix: skuPrefix.trim() === '' ? null : skuPrefix.trim().toUpperCase(),
              });
              if (checked.success) {
                stage.mutate(checked.data);
              } else {
                const issues = checked.error.issues.map((i) => ({
                  path: ['mapping', ...i.path].join('.'),
                  message: i.message,
                }));
                setMappingError(new ApiRequestError(400, 'request.invalid', issues));
              }
            }}
          >
            <Stack mt="md">
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                {fields.map((field) => (
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
                  error={required.errors.numberKind}
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
                    error={required.errors.priceListId}
                    data={(priceLists.data ?? [])
                      .filter((l) => l.archivedAt === null)
                      .map((l) => ({
                        value: l.id,
                        label: t('catalog.priceListOption', { name: l.name, currency: l.currency }),
                      }))}
                  />
                )}
                {columns.cost !== undefined && (
                  <Select
                    label={t('import.costCurrency')}
                    required
                    value={costCurrency}
                    onChange={setCostCurrency}
                    error={required.errors.costCurrency}
                    data={(currencies.data ?? []).map((c) => ({ value: c.code, label: c.code }))}
                  />
                )}
                <TextInput
                  label={t('import.skuPrefix')}
                  description={t('import.skuPrefixHint')}
                  required={columns.sku === undefined}
                  dir="ltr"
                  value={skuPrefix}
                  error={required.errors.skuPrefix}
                  onChange={(e) => {
                    setSkuPrefix(e.currentTarget.value);
                  }}
                />
              </SimpleGrid>
              <ErrorAlert error={mappingError ?? stage.error} />
              <Group>
                <Button type="submit" loading={stage.isPending}>
                  {t('import.stage')}
                </Button>
              </Group>
            </Stack>
          </Form>
        </Stepper.Step>
      </Stepper>
      <History />
    </Stack>
  );
}
