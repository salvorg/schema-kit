import { equals, filled, oneOf, type SchemaDocument } from '../../index.js';

export const REGISTRATION: SchemaDocument = {
  id: 'urn:example:schema:sole-proprietor-registration:1.0.0',
  title: { ru: 'Регистрация ИП', ky: 'ЖИни каттоо', en: 'Sole proprietor registration' },
  locales: ['ru', 'ky', 'en'],
  model: { code: 'SOLE_PROPRIETOR', version: '1.0.0' },
  xml: {
    rootElement: 'registerRequest',
    targetNamespace: 'urn:example:sole-proprietor',
    wrapper: [{ name: 'body', title: { ru: 'Тело запроса' } }],
  },
  definitions: {
    Tin: { kind: 'string', pattern: '^\\d{14}$', xml: { type: 'TaxIdentificationNumber' } },
    Address: {
      kind: 'object',
      properties: [
        {
          name: 'region',
          node: { kind: 'string', minLength: 1 },
          required: true,
          title: { ru: 'Область' },
        },
        { name: 'street', node: { kind: 'string', maxLength: 200 }, title: { ru: 'Улица' } },
      ],
    },
  },
  root: {
    kind: 'object',
    properties: [
      {
        name: 'tin',
        node: { kind: 'ref', ref: '#/$defs/Tin' },
        required: true,
        title: { ru: 'ИНН', ky: 'ИНН', en: 'TIN' },
        placeholder: { ru: '21505200250230' },
        binding: { model: 'PERSON', version: '2.1.0', pointer: '/tin' },
        dataClass: 'PERSONAL',
      },
      {
        name: 'fullName',
        node: { kind: 'string', minLength: 1, maxLength: 150 },
        required: true,
        title: { ru: 'ФИО', ky: 'Аты-жөнү', en: 'Full name' },
      },
      {
        name: 'birthDate',
        node: { kind: 'string', format: 'date' },
        title: { ru: 'Дата рождения' },
        control: 'date',
      },
      {
        name: 'taxMode',
        node: {
          kind: 'integer',
          options: {
            kind: 'inline',
            options: [
              { value: 1, label: { ru: 'Общий' } },
              { value: 2, label: { ru: 'Упрощённый' } },
              { value: 5, label: { ru: 'Патент' }, image: '/images/patent.svg' },
            ],
          },
        },
        required: true,
        control: 'radio',
        title: { ru: 'Налоговый режим' },
      },
      {
        name: 'patentKinds',
        node: {
          kind: 'array',
          items: {
            kind: 'string',
            options: {
              kind: 'inline',
              options: [
                { value: 'TRADE' },
                { value: 'SERVICE' },
                { value: 'VAT_A' },
                { value: 'VAT_B' },
              ],
            },
          },
          minItems: 1,
          uniqueItems: true,
          optionGroups: [
            { values: ['TRADE', 'SERVICE'], select: 'many' },
            { values: ['VAT_A', 'VAT_B'], select: 'one' },
          ],
        },
        required: true,
        visibleIf: equals('taxMode', 5),
        control: 'multiselect',
        title: { ru: 'Виды патента' },
      },
      {
        name: 'activityCode',
        node: {
          kind: 'string',
          options: {
            kind: 'service',
            serviceId: 'dict-activities',
            itemsPointer: '/data',
            valuePointer: '/code',
            labelPointer: '/name',
            fill: { activityName: '/name' },
            params: { Tin: 'tin' },
          },
        },
        required: true,
        title: { ru: 'Вид деятельности' },
      },
      {
        name: 'activityName',
        node: { kind: 'string' },
        title: { ru: 'Наименование деятельности' },
      },
      {
        name: 'employees',
        node: { kind: 'integer', minimum: 0, maximum: 1000, xml: { base: 'int' } },
        requiredIf: oneOf('taxMode', [1, 2]),
        title: { ru: 'Число работников' },
      },
      {
        name: 'phone',
        node: { kind: 'string', format: 'tel', pattern: '^\\+996\\d{9}$' },
        title: { ru: 'Телефон' },
      },
      {
        name: 'email',
        node: { kind: 'string', format: 'email' },
        title: { ru: 'Эл. почта' },
      },
      {
        name: 'consent',
        node: { kind: 'boolean', const: true },
        required: true,
        title: { ru: 'Согласие' },
      },
      {
        name: 'captcha',
        node: { kind: 'string' },
        transient: true,
        title: { ru: 'Капча' },
      },
      {
        name: 'legalAddress',
        node: { kind: 'ref', ref: '#/$defs/Address' },
        required: true,
        title: { ru: 'Юридический адрес' },
      },
      {
        name: 'actualAddress',
        node: { kind: 'ref', ref: '#/$defs/Address' },
        visibleIf: filled('legalAddress'),
        title: { ru: 'Фактический адрес' },
      },
      {
        name: 'founders',
        node: {
          kind: 'array',
          maxItems: 5,
          items: {
            kind: 'object',
            properties: [
              {
                name: 'founderTin',
                node: { kind: 'ref', ref: '#/$defs/Tin' },
                required: true,
                title: { ru: 'ИНН учредителя' },
              },
              {
                name: 'isResident',
                node: { kind: 'boolean', default: true },
                title: { ru: 'Резидент' },
              },
              {
                name: 'passport',
                node: { kind: 'string', pattern: '^[A-Z]{2}\\d{7}$' },
                required: true,
                visibleIf: equals('isResident', false),
                title: { ru: 'Паспорт' },
              },
            ],
          },
        },
        title: { ru: 'Учредители' },
      },
      { name: 'passportNumber', node: { kind: 'string' }, title: { ru: 'Номер паспорта' } },
      { name: 'idCardNumber', node: { kind: 'string' }, title: { ru: 'Номер ID-карты' } },
    ],
    choices: [{ id: 'identity', required: true, members: ['passportNumber', 'idCardNumber'] }],
  },
};
