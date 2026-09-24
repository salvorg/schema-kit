const head =
  '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns="urn:example:registry" xmlns:la="urn:example:legacy-annotations" targetNamespace="urn:example:registry" elementFormDefault="qualified">';

const title = (ru: string, ky: string, en: string): string =>
  `<la:i18n-title xml:lang="ru">${ru}</la:i18n-title><la:i18n-title xml:lang="ky">${ky}</la:i18n-title><la:i18n-title xml:lang="en">${en}</la:i18n-title>`;

const annotated = (inner: string): string =>
  `<xs:annotation><xs:appinfo>${inner}</xs:appinfo></xs:annotation>`;

const nonEmpty =
  '<xs:simpleType name="NonEmptyString"><xs:restriction base="xs:string"><xs:minLength value="1"/><xs:pattern value=".*[^\\s].*"/></xs:restriction></xs:simpleType>';

export const LEGACY_ANNOTATIONS = 'urn:example:legacy-annotations';

export const BY_TAX_ID = `${head}<xs:element name="findCompanyByTaxIdRequest" type="findCompanyByTaxIdRequest"/><xs:complexType name="findCompanyByTaxIdRequest"><xs:sequence><xs:element name="taxId" type="TaxIdentificationNumber">${annotated(`${title('ИНН', 'ИНН', 'Tax ID')}<la:i18n-description xml:lang="en">14 digits</la:i18n-description>`)}</xs:element></xs:sequence></xs:complexType><xs:simpleType name="TaxIdentificationNumber"><xs:restriction base="xs:string"><xs:pattern value="\\d{14}"/></xs:restriction></xs:simpleType></xs:schema>`;

export const BY_NAME = `${head}<xs:element name="findCompanyByNameRequest" type="findCompanyByNameRequest"/><xs:complexType name="findCompanyByNameRequest"><xs:sequence><xs:element name="name" type="NonEmptyString">${annotated(title('Наименование', 'Аталышы', 'Name'))}</xs:element></xs:sequence></xs:complexType>${nonEmpty}</xs:schema>`;

export const SEARCH = `${head}<xs:element name="searchCompaniesRequest" type="searchCompaniesRequest"/><xs:complexType name="searchCompaniesRequest"><xs:sequence><xs:element name="query" type="NonEmptyString">${annotated(title('Строка поиска', 'Издөө сабы', 'Query'))}</xs:element><xs:element name="type" type="QueryType">${annotated(title('Тип поиска', 'Издөө түрү', 'Query type'))}</xs:element></xs:sequence></xs:complexType>${nonEmpty}<xs:simpleType name="QueryType"><xs:restriction base="xs:string"><xs:enumeration value="NAME"/><xs:enumeration value="TAX_ID"/><xs:enumeration value="REGISTRY_CODE"/><xs:enumeration value="OWNER"/></xs:restriction></xs:simpleType></xs:schema>`;
