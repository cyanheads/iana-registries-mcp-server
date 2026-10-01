/**
 * @fileoverview Tool definition barrel — the array passed to `createApp({ tools })`,
 * in the design's surface order.
 * @module mcp-server/tools/definitions
 */

import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core/tools';
import { getRegistryRecords } from './get-registry-records.tool.js';
import { getRfcStatus } from './get-rfc-status.tool.js';
import { lookupHttpField } from './lookup-http-field.tool.js';
import { lookupHttpStatus } from './lookup-http-status.tool.js';
import { lookupLanguageTag } from './lookup-language-tag.tool.js';
import { lookupMediaType } from './lookup-media-type.tool.js';
import { lookupPen } from './lookup-pen.tool.js';
import { lookupPort } from './lookup-port.tool.js';
import { lookupUriScheme } from './lookup-uri-scheme.tool.js';
import { searchRegistries } from './search-registries.tool.js';

/** Every tool the server registers. */
export const allToolDefinitions: AnyToolDefinition[] = [
  lookupPort,
  lookupMediaType,
  lookupHttpStatus,
  lookupHttpField,
  lookupUriScheme,
  lookupPen,
  lookupLanguageTag,
  getRfcStatus,
  searchRegistries,
  getRegistryRecords,
];
