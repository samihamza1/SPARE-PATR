import { BRAND_KINDS, newId } from '@autoparts/shared';
import {
  Badge,
  Button,
  Checkbox,
  Group,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { useAuth } from '../../auth';
import {
  catalogKeys,
  categoryName,
  useBrands,
  useCategories,
  useCurrencies,
  usePriceLists,
} from '../../catalog/common';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Form, useRequired } from '../../forms';

function useSave(key: readonly unknown[]) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      method,
      path,
      body,
    }: {
      method: 'POST' | 'PATCH';
      path: string;
      body: object;
    }) => api(method, path, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

function Brands() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const brands = useBrands();
  const save = useSave(catalogKeys.brands);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<string | null>(null);
  const required = useRequired({ name, kind });
  return (
    <Stack>
      <Table>
        <Table.Tbody>
          {brands.data?.map((b) => (
            <Table.Tr key={b.id}>
              <Table.Td>{b.name}</Table.Td>
              <Table.Td>{t(`catalog.brandKind.${b.kind}`)}</Table.Td>
              <Table.Td>
                {can('catalog.manage') && (
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() => {
                      save.mutate({
                        method: 'PATCH',
                        path: `/catalog/brands/${b.id}`,
                        body: { archived: b.archivedAt === null },
                      });
                    }}
                  >
                    {b.archivedAt === null ? t('catalog.archive') : t('catalog.restore')}
                  </Button>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {can('catalog.manage') && (
        <Form
          onSubmit={() => {
            if (!required.ok()) return;
            save.mutate(
              {
                method: 'POST',
                path: '/catalog/brands',
                body: { id: newId(), name: name.trim(), kind },
              },
              {
                onSuccess: () => {
                  setName('');
                  required.reset();
                },
              },
            );
          }}
        >
          <Group align="flex-end">
            <TextInput
              label={t('fields.name')}
              required
              value={name}
              error={required.errors.name}
              onChange={(e) => {
                setName(e.currentTarget.value);
              }}
            />
            <Select
              label={t('setup.kind')}
              required
              value={kind}
              onChange={setKind}
              error={required.errors.kind}
              data={BRAND_KINDS.map((k) => ({ value: k, label: t(`catalog.brandKind.${k}`) }))}
            />
            <Button type="submit">{t('setup.add')}</Button>
          </Group>
        </Form>
      )}
      <ErrorAlert error={brands.error ?? save.error} />
    </Stack>
  );
}

function Categories() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const categories = useCategories();
  const save = useSave(catalogKeys.categories);
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const required = useRequired(
    { name: nameAr.trim() === '' ? nameEn : nameAr },
    { name: 'validation.name.required' },
  );
  const name = (id: string | null) => {
    const c = categories.data?.find((x) => x.id === id);
    return c === undefined ? '' : categoryName(c, i18n.language);
  };
  return (
    <Stack>
      <Table>
        <Table.Tbody>
          {categories.data?.map((c) => (
            <Table.Tr key={c.id}>
              <Table.Td>{c.nameAr}</Table.Td>
              <Table.Td dir="ltr">{c.nameEn}</Table.Td>
              <Table.Td>{name(c.parentId)}</Table.Td>
              <Table.Td>
                {c.archivedAt !== null && <Badge color="gray">{t('catalog.archived')}</Badge>}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {can('catalog.manage') && (
        <Form
          onSubmit={() => {
            if (!required.ok()) return;
            save.mutate(
              {
                method: 'POST',
                path: '/catalog/categories',
                body: {
                  id: newId(),
                  nameAr: nameAr.trim() === '' ? null : nameAr.trim(),
                  nameEn: nameEn.trim() === '' ? null : nameEn.trim(),
                  parentId,
                },
              },
              {
                onSuccess: () => {
                  setNameAr('');
                  setNameEn('');
                  required.reset();
                },
              },
            );
          }}
        >
          <Group align="flex-end">
            <TextInput
              label={t('catalog.nameAr')}
              value={nameAr}
              error={required.errors.name}
              onChange={(e) => {
                setNameAr(e.currentTarget.value);
              }}
            />
            <TextInput
              label={t('catalog.nameEn')}
              dir="ltr"
              value={nameEn}
              onChange={(e) => {
                setNameEn(e.currentTarget.value);
              }}
            />
            <Select
              label={t('setup.parent')}
              clearable
              value={parentId}
              onChange={setParentId}
              data={(categories.data ?? []).map((c) => ({
                value: c.id,
                label: categoryName(c, i18n.language),
              }))}
            />
            <Button type="submit">{t('setup.add')}</Button>
          </Group>
        </Form>
      )}
      <ErrorAlert error={categories.error ?? save.error} />
    </Stack>
  );
}

function PriceLists() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const lists = usePriceLists();
  const currencies = useCurrencies();
  const save = useSave(catalogKeys.priceLists);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState<string | null>(null);
  const [isDefault, setIsDefault] = useState(false);
  const required = useRequired({ name, currency });
  const manage = can('prices.manage');
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t('setup.defaultHint')}
      </Text>
      <Table>
        <Table.Tbody>
          {lists.data?.map((l) => (
            <Table.Tr key={l.id}>
              <Table.Td>{l.name}</Table.Td>
              <Table.Td dir="ltr">{l.currency}</Table.Td>
              <Table.Td>
                {l.isDefault && <Badge>{t('setup.default')}</Badge>}
                {l.archivedAt !== null && <Badge color="gray">{t('catalog.archived')}</Badge>}
              </Table.Td>
              <Table.Td>
                {manage && (
                  <Group gap="xs">
                    {!l.isDefault && l.archivedAt === null && (
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => {
                          save.mutate({
                            method: 'PATCH',
                            path: `/catalog/price-lists/${l.id}`,
                            body: { isDefault: true },
                          });
                        }}
                      >
                        {t('setup.makeDefault')}
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="subtle"
                      onClick={() => {
                        save.mutate({
                          method: 'PATCH',
                          path: `/catalog/price-lists/${l.id}`,
                          body: { archived: l.archivedAt === null },
                        });
                      }}
                    >
                      {l.archivedAt === null ? t('catalog.archive') : t('catalog.restore')}
                    </Button>
                  </Group>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {manage && (
        <Form
          onSubmit={() => {
            if (!required.ok()) return;
            save.mutate(
              {
                method: 'POST',
                path: '/catalog/price-lists',
                body: { id: newId(), name: name.trim(), currency, isDefault },
              },
              {
                onSuccess: () => {
                  setName('');
                  required.reset();
                },
              },
            );
          }}
        >
          <Group align="flex-end">
            <TextInput
              label={t('fields.name')}
              required
              value={name}
              error={required.errors.name}
              onChange={(e) => {
                setName(e.currentTarget.value);
              }}
            />
            <Select
              label={t('setup.currency')}
              required
              value={currency}
              onChange={setCurrency}
              error={required.errors.currency}
              data={(currencies.data ?? [])
                .filter((c) => c.isActive)
                .map((c) => ({ value: c.code, label: c.code }))}
            />
            <Checkbox
              label={t('setup.default')}
              checked={isDefault}
              onChange={(e) => {
                setIsDefault(e.currentTarget.checked);
              }}
            />
            <Button type="submit">{t('setup.add')}</Button>
          </Group>
        </Form>
      )}
      <ErrorAlert error={lists.error ?? save.error} />
    </Stack>
  );
}

export function SetupPage() {
  const { t } = useTranslation();
  return (
    <Stack>
      <Title order={2}>{t('setup.title')}</Title>
      <Tabs defaultValue="priceLists">
        <Tabs.List>
          <Tabs.Tab value="priceLists">{t('setup.priceLists')}</Tabs.Tab>
          <Tabs.Tab value="brands">{t('setup.brands')}</Tabs.Tab>
          <Tabs.Tab value="categories">{t('setup.categories')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="priceLists" pt="md">
          <PriceLists />
        </Tabs.Panel>
        <Tabs.Panel value="brands" pt="md">
          <Brands />
        </Tabs.Panel>
        <Tabs.Panel value="categories" pt="md">
          <Categories />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
