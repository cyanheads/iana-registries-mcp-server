---
name: iana-registries-guide
description: Trace protocol assignments to their defining documents with iana_* tools. Use when resolving an unfamiliar registry or code-point namespace, auditing RFC and draft references, or checking the current members and status of a standards series.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use this keyless server for official protocol registrations and IETF document metadata. A port assignment does not identify a running service; an enterprise OID identifies the organization, not its privately assigned sub-arcs. Use the defining documents for protocol semantics and RDAP or whois for address-holder information. The server returns document metadata, not RFC text or errata contents.

## Identifiers

- Registry and subregistry IDs come from `iana_search_registries`. `iana_get_registry_records` also returns subregistry IDs when a registry or table contains several tables.
- Column IDs come from the returned `columns`; they are XML element names, which can differ from the headings on IANA's web page. Read the table's notes before interpreting abbreviated columns.
- Defining-document IDs come from registry search results and record references. RFC relations, draft replacements and publication links, and series membership returned by `iana_get_rfc_status` supply IDs for follow-up document lookups.

## Gates

1. Establish the registry, table, and value column before interpreting a code point. A DNS mnemonic and its number are different columns; the same number in another protocol registry is a different assignment. If a response lists subregistries, choose the relevant table before treating an empty record list as a miss.
2. Before claiming an enumeration is complete, follow its continuation until no page remains. For a document audit, account for both deferred IDs and failed IDs; an upstream failure is not evidence that a document does not exist. Report unresolved items if they cannot be recovered.
3. Before claiming a cited specification is current, inspect its current status and follow relevant replacement and update relations. Keep the registry entry's registration status separate from its defining RFC's status. An update relation is not an obsolescence relation.
4. Before claiming a series has no members or an RFC belongs to no series, distinguish an explicit empty result from unavailable metadata. An omitted `is_also` with an availability notice does not mean no membership; an unfound series can mean either an unassigned number or an emptied series.

## Core chain

For a question such as “What does this TLS code point name, and is its specification current?”, discover its registry with `iana_search_registries`, read the relevant table with `iana_get_registry_records`, and check the matching record and its references. Pass the RFC or draft references to `iana_get_rfc_status`. Resolve any relevant successor or updating documents before giving the assignment and the current document relationships together, with their source links.

## Workflows

**Known assignment, unfamiliar specification.** Start with the curated lookup when it covers the assignment. Follow the returned document references through `iana_get_rfc_status`; a registration can remain present while its defining document has been updated or obsoleted.

**Standards series.** Resolve the BCP, STD, or FYI series, then look up the returned member RFCs to assess their status. The series response supplies membership, not each member's status. For the reverse question, inspect an RFC's `is_also` and resolve those series when their other members matter.

**Draft citation.** Inspect the returned draft state, replacement links, and `became_rfc`. Follow a publication link to check the published RFC rather than treating a draft's intended status as its eventual publication status. Check revision guidance when the citation names a revision.
