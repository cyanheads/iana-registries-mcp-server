/**
 * @fileoverview Synthetic Language Subtag Registry record-jar: `File-Date`
 * header, `%%` separators, repeatable `Description`/`Prefix`/`Comments`,
 * continuation lines, a subtag shared by two types, whole-tag records, and a
 * private-use range. Names and addresses are invented.
 * @module tests/fixtures/language-registry
 */

/** The default fixture, LF line endings. */
export const LANGUAGE_REGISTRY_TEXT = `File-Date: 2026-09-17
%%
Type: language
Subtag: aa
Description: Afar
Added: 2005-10-16
Suppress-Script: Latn
Scope: individual
%%
Type: language
Subtag: tw
Description: Twi
Added: 2005-10-16
Macrolanguage: ak
%%
Type: extlang
Subtag: tw
Description: Example Twi Extension
Added: 2009-07-29
Prefix: zh
Preferred-Value: tw
%%
Type: language
Subtag: sh
Description: Serbo-Croatian
Added: 2005-10-16
Deprecated: 2000-02-18
Comments: Sometimes written to person@example.org for corrections
Prefix: sr
Prefix: hr
%%
Type: language
Subtag: qaa..qtz
Description: Private use
Added: 2005-10-16
%%
Type: script
Subtag: Latn
Description: Latin
Description: Roman
  alphabet
Added: 2005-10-16
%%
Type: region
Subtag: DE
Description: Germany
Added: 2005-10-16
%%
Type: variant
Subtag: 1901
Description: Traditional German orthography
Added: 2005-10-16
Prefix: de
Comments: Contact person@example.org
  for details
%%
Type: grandfathered
Tag: i-example
Description: Example grandfathered tag
Added: 2001-01-01
Deprecated: 2002-02-02
Preferred-Value: ex
%%
Type: redundant
Tag: zh-Hant
Description: Chinese written using the Traditional Chinese script
Added: 2005-10-16
%%
Type: mystery
Subtag: zz
Description: Unknown type is skipped
%%
Subtag: orphan
Description: No type is skipped
`;

/** The same registry with CRLF line endings. */
export const LANGUAGE_REGISTRY_CRLF = LANGUAGE_REGISTRY_TEXT.replace(/\n/g, '\r\n');

/** Live-derived extension records with invented contacts that must be discarded. */
export const LANGUAGE_EXTENSIONS_TEXT = `File-Date: 2014-04-02
%%
Identifier: t
Description: Specifying Transformed Content
RFC: [RFC6497]
Authority: Unicode Consortium
Contact_Email: private&example.org
Mailing_List: private@example.org
%%
Identifier: u
Description: Unicode Locale
RFC: [RFC6067]
Authority: Unicode Consortium
Contact_Email: private&example.org
Mailing_List: private@example.org
%%
`;
