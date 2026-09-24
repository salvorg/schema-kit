const i18n = (en: string, ru: string) => ({ en, ru });

export const INVOICE_WITH_LINES = {
  type: 'object',
  properties: {
    sentByBranch: {
      type: 'boolean',
      'x-i18n-title': i18n('Sent by a branch', 'Отправлено филиалом'),
    },
    counterpartyTaxId: {
      type: 'string',
      pattern: '^\\d{14}$',
      'x-i18n-placeholder': i18n('12345678901234', '12345678901234'),
      'x-i18n-title': i18n('Counterparty tax ID', 'ИНН контрагента'),
    },
    currency: { type: 'string', 'x-i18n-title': i18n('Currency', 'Валюта') },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          quantity: { type: 'number', exclusiveMinimum: 0 },
          price: { type: 'number', minimum: 0 },
        },
      },
      'x-i18n-title': i18n('Lines', 'Позиции'),
    },
  },
};

export const DOCUMENT_BATCH = {
  type: 'object',
  properties: {
    status: { type: 'string', 'x-i18n-title': i18n('Status', 'Статус') },
    documentIds: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
      minItems: 1,
      'x-i18n-title': i18n('Document IDs', 'Идентификаторы документов'),
    },
  },
};

export const PAYMENT_LIST = {
  type: 'array',
  minItems: 1,
  items: {
    type: 'object',
    required: ['districtCode', 'taxCode', 'classificationCode', 'amount', 'taxId'],
    properties: {
      taxId: {
        type: 'string',
        pattern: '^\\d{14}$',
        'x-transient': true,
        'x-i18n-title': i18n('Payer tax ID', 'ИНН плательщика'),
      },
      districtCode: {
        type: 'string',
        minLength: 1,
        'x-options': {
          kind: 'service',
          serviceId: 'dict-districts',
          itemsPointer: '/data',
          valuePointer: '/id',
          labelPointer: '/displayText',
          fill: { districtName: '/displayText' },
          params: { TaxId: 'taxId' },
        },
      },
      districtName: { type: 'string' },
      taxCode: {
        type: 'string',
        minLength: 1,
        'x-options': {
          kind: 'service',
          serviceId: 'dict-tax-types',
          itemsPointer: '/data',
          valuePointer: '/code',
          labelPointer: '/name',
        },
      },
      classificationCode: {
        type: 'string',
        'x-options': {
          kind: 'service',
          serviceId: 'dict-classification',
          valuePointer: '/code',
          labelPointer: '/name',
          filterBy: { field: 'taxCode', pointer: '/taxCode' },
        },
      },
      amount: { type: 'number', exclusiveMinimum: 0 },
    },
  },
};

export const HAND_WRITTEN_RULES = {
  type: 'object',
  properties: {
    mode: { type: 'integer', enum: [1, 2, 5] },
    extras: { type: 'array', items: { type: 'string', enum: ['A', 'B'] } },
  },
  allOf: [
    {
      if: { required: ['mode'], properties: { mode: { const: 5 } } },
      else: { properties: { extras: { maxItems: 0 } } },
    },
  ],
};
